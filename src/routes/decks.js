import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { broadcast, broadcastDeck } from "../ws.js";
import { LIMITS, invalidString, invalidBoolean, invalidTags, firstError } from "../utils/validate.js";
import {
  canReadDeckSql,
  isDeckOwnerSql,
  deckShareColumnsSql,
  ownerJoinSql,
  shapeDeckRow,
  orphanDecks,
} from "../utils/deckAccess.js";

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Gedeelde veldvalidatie voor POST en PUT; geeft een 400-melding of null.
function invalidDeckFields({ title, description, tags, is_public, inactive, core_only }, { titleRequired }) {
  return firstError(
    invalidString(title, "title", LIMITS.TITLE_MAX, { required: titleRequired }),
    invalidString(description, "description", LIMITS.DESCRIPTION_MAX),
    invalidTags(tags),
    invalidBoolean(is_public, "is_public"),
    invalidBoolean(inactive, "inactive"),
    invalidBoolean(core_only, "core_only"),
  );
}

// Maximale batchgrootte voor /bulk-delete.
const MAX_BULK_DECKS = 100;

// ========================
// GET ALL DECKS (eigen + met mij gedeeld)
// ========================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, ${deckShareColumnsSql("d", "$1")}
       FROM decks d
       ${ownerJoinSql("d")}
       WHERE ${canReadDeckSql("d", "$1")}
         AND d.deleted_at IS NULL
       ORDER BY d.created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows.map(shapeDeckRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// GET SINGLE DECK
// ========================
router.get("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  // Malformed id zou anders als 22P02 in Postgres stranden (500 i.p.v. 404).
  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Deck not found" });
  }

  try {
    const result = await pool.query(
      `SELECT d.*, ${deckShareColumnsSql("d", "$2")}
       FROM decks d
       ${ownerJoinSql("d")}
       WHERE d.id = $1 AND ${canReadDeckSql("d", "$2")} AND d.deleted_at IS NULL`,
      [id, req.user.id]
    );

    const deck = result.rows[0];

    if (!deck) {
      return res.status(404).json({ error: "Deck not found" });
    }

    res.json(shapeDeckRow(deck));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// CREATE DECK
// ========================
router.post("/", authMiddleware, async (req, res) => {
  const { title, description, is_public, tags, inactive, core_only } = req.body;

  if (!title) {
    return res.status(400).json({ error: "Title is required" });
  }

  const invalid = invalidDeckFields(req.body, { titleRequired: true });
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  try {
    const result = await pool.query(
      `INSERT INTO decks (user_id, title, description, is_public, tags, inactive, core_only)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.user.id,
        title,
        description || null,
        is_public ?? false,
        tags ?? [],
        inactive ?? false,
        core_only ?? false
      ]
    );

    const deck = result.rows[0];
    broadcast(req.user.id, "deck_created", deck);
    res.status(201).json(deck);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// UPDATE DECK
// ========================
router.put("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { title, description, is_public, tags, inactive, core_only, client_updated_at } = req.body;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Deck not found" });
  }

  const invalid = invalidDeckFields(req.body, { titleRequired: false });
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  // Check-then-write in één transactie met een rij-lock: twee devices die
  // tegelijk schrijven kunnen anders tussen de 409-check en de UPDATE
  // interleaven en elkaars write alsnog stilzwijgend overschrijven.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT d.*, _ou.username AS owner_username FROM decks d
       ${ownerJoinSql("d")}
       WHERE d.id = $1 AND ${isDeckOwnerSql("d", "$2")} AND d.deleted_at IS NULL
       FOR UPDATE OF d`,
      [id, req.user.id]
    );

    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deck not found" });
    }

    const { owner_username, ...deck } = current.rows[0];
    // Alleen de schrijver (owner) komt hier; shape zoals GET /decks/:id zodat
    // de client één deck-vorm kent (óók in de 409-current).
    const shape = (row) => ({ ...row, role: "owner", owner_username, can_edit: true });

    // Publiek maken is onomkeerbaar (PUBLIC_DECKS_PLAN.md): de UI biedt geen
    // uit-knop, en ook een directe API-call mag een eenmaal publiek deck niet
    // terug privé zetten. true → true blijft idempotent oké.
    if (deck.is_public && is_public === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "is_public_irreversible" });
    }

    if (client_updated_at && deck.updated_at > new Date(client_updated_at)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "stale_write", current: shape(deck) });
    }

    const result = await client.query(
      `UPDATE decks d
       SET title = $1,
           description = $2,
           is_public = $3,
           tags = $4,
           inactive = $5,
           core_only = $6
       WHERE d.id = $7 AND ${isDeckOwnerSql("d", "$8")}
       RETURNING *`,
      [
        title ?? deck.title,
        description !== undefined ? description : deck.description,
        is_public ?? deck.is_public,
        tags !== undefined ? tags : deck.tags,
        inactive !== undefined ? inactive : deck.inactive,
        core_only !== undefined ? core_only : deck.core_only,
        id,
        req.user.id
      ]
    );

    await client.query("COMMIT");

    const updated = result.rows[0];
    // Ook recipients zien de wijziging live. De payload is de kale deck-rij
    // (owner-perspectief); de client behoudt bij de merge zijn eigen
    // role/can_edit/inactive-velden.
    broadcastDeck(id, "deck_updated", updated)
      .catch((err) => console.error("[decks] broadcast failed:", err));
    res.json(shape(updated));

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});


// ========================
// DELETE DECK
// ========================
// Heeft het deck actieve, geaccepteerde subscribers, dan wordt het niet
// verwijderd maar geörphand (ACCOUNT_DELETION_PLAN.md §5): user_id NULL,
// subscribers en editors merken niets behalve owner_username = NULL. Voor de
// ex-eigenaar verdwijnt het deck (synthetische tombstone voor zijn sync).
// Zonder subscribers: het vertrouwde soft-delete-pad.
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Deck not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Rij-lock: de subscriber-telling en de orphan/delete-keuze mogen niet
    // interleaven met een gelijktijdige follow/accept.
    const deckRes = await client.query(
      `SELECT id FROM decks
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [id, req.user.id]
    );

    if (deckRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deck not found" });
    }

    const subs = await client.query(
      `SELECT COUNT(*)::int AS n FROM deck_shares
       WHERE deck_id = $1 AND revoked_at IS NULL AND accepted_at IS NOT NULL`,
      [id]
    );
    const subscribers = subs.rows[0].n;

    if (subscribers > 0) {
      await orphanDecks(client, [id], req.user.id, { withOwnerTombstone: true });
      await client.query("COMMIT");

      // Eigen devices ruimen het deck op; subscribers krijgen géén removal —
      // hun eerstvolgende sync levert het deck met owner_username = NULL.
      broadcast(req.user.id, "deck_removed", [{ id }]);
      return res.json({ message: "Deck released", orphaned: true, subscribers });
    }

    const result = await client.query(
      `UPDATE decks SET deleted_at = NOW()
       WHERE id = $1
       RETURNING id, deleted_at`,
      [id]
    );

    // Cascade: voortgangsrecords van alle kaarten in dit deck mee-softdeleten,
    // zodat ze niet als wees-records (met is_core = true) in de core-stats
    // blijven hangen.
    await client.query(
      `UPDATE user_card_progress SET deleted_at = NOW()
       WHERE deleted_at IS NULL
         AND card_id IN (SELECT id FROM cards WHERE deck_id = $1)`,
      [id]
    );

    await client.query("COMMIT");

    // deleted_at mee in de payload: broadcast() gebruikt de DB-timestamp als
    // server_time, zodat WS- en REST-sync dezelfde klokbron delen. Recipients
    // zien het deck zo ook meteen verdwijnen.
    broadcastDeck(id, "deck_deleted", { id, deleted_at: result.rows[0].deleted_at })
      .catch((err) => console.error("[decks] broadcast failed:", err));
    res.json({ message: "Deck deleted", orphaned: false, subscribers: 0 });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});


// ========================
// BULK DELETE DECKS
// ========================
// Idempotent en tolerant: ids die niet bestaan, al soft-deleted zijn of van
// een andere gebruiker zijn worden stilzwijgend genegeerd (zelfde stijl als
// het ids-filter van GET /stats/decks) — de client behandelt de hele batch
// als geslaagd bij een 200.
router.post("/bulk-delete", authMiddleware, async (req, res) => {
  const { deck_ids } = req.body;

  if (!Array.isArray(deck_ids) || deck_ids.length === 0) {
    return res.status(400).json({ error: "deck_ids is required" });
  }

  if (deck_ids.length > MAX_BULK_DECKS) {
    return res.status(400).json({ error: `Too many ids (max ${MAX_BULK_DECKS})` });
  }

  // Niet-UUID waarden zouden de ::uuid[]-cast laten falen; behandel ze als
  // onbekende ids en negeer ze dus stilzwijgend.
  const ids = [...new Set(deck_ids.filter((id) => typeof id === "string" && UUID_RE.test(id)))];

  if (ids.length === 0) {
    return res.json({ deleted: 0, ids: [] });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Zelfde splitsing als DELETE /decks/:id: decks met actieve geaccepteerde
    // subscribers worden geörphand, de rest soft-deleted. Rij-locks tegen
    // gelijktijdige follow/accept.
    const targets = await client.query(
      `SELECT id, EXISTS (
         SELECT 1 FROM deck_shares s
         WHERE s.deck_id = decks.id
           AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL
       ) AS has_subscribers
       FROM decks
       WHERE id = ANY($1::uuid[]) AND user_id = $2 AND deleted_at IS NULL
       FOR UPDATE OF decks`,
      [ids, req.user.id]
    );

    const orphanIds = targets.rows.filter((r) => r.has_subscribers).map((r) => r.id);
    const deleteIds = targets.rows.filter((r) => !r.has_subscribers).map((r) => r.id);

    await orphanDecks(client, orphanIds, req.user.id, { withOwnerTombstone: true });

    let deletedRows = [];
    if (deleteIds.length > 0) {
      const result = await client.query(
        `UPDATE decks SET deleted_at = NOW()
         WHERE id = ANY($1::uuid[])
         RETURNING id, deleted_at`,
        [deleteIds]
      );
      deletedRows = result.rows;

      // Cascade: voortgangsrecords van alle kaarten in deze decks
      // mee-softdeleten, zodat ze niet als wees-records (met is_core = true)
      // in de core-stats blijven hangen — identiek aan DELETE /decks/:id.
      await client.query(
        `UPDATE user_card_progress SET deleted_at = NOW()
         WHERE deleted_at IS NULL
           AND card_id IN (SELECT id FROM cards WHERE deck_id = ANY($1::uuid[]))`,
        [deleteIds]
      );
    }

    await client.query("COMMIT");

    // Owner (alle devices) krijgt de hele batch in één event; recipients per
    // deck apart — de ontvangerskring verschilt per deck. Geörphande decks
    // verdwijnen bij de owner via deck_removed; hun subscribers krijgen géén
    // removal (het deck blijft voor hen bestaan).
    broadcast(req.user.id, "deck_deleted", deletedRows);
    broadcast(req.user.id, "deck_removed", orphanIds.map((id) => ({ id })));
    for (const row of deletedRows) {
      broadcastDeck(row.id, "deck_deleted", [row], { excludeUserId: req.user.id })
        .catch((err) => console.error("[decks] broadcast failed:", err));
    }
    const processedIds = targets.rows.map((r) => r.id);
    res.json({ deleted: processedIds.length, ids: processedIds, orphaned_ids: orphanIds });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
