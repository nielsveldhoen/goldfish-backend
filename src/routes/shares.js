// Deck-sharing-routes (SHARING_PLAN.md, Release A): delen met contacten,
// publieke bibliotheek + volgen, share-state van de ontvanger. Dit router
// wordt in app.js vóór het decks-router gemount zodat GET /decks/public niet
// door GET /decks/:id wordt opgeslokt.
import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { inviteLimiter, publicSearchLimiter } from "../middleware/limiters.js";
import { broadcast, broadcastDeck } from "../ws.js";
import { LIMITS } from "../utils/validate.js";
import { isDeckOwnerSql, revokeShares } from "../utils/deckAccess.js";

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PUBLIC_PAGE_MAX = 50;

// Meldt aan de recipient (al zijn devices) dat een deck van zijn dashboard
// verdween. Fire-and-forget: WS-bezorging mag de response nooit ophouden.
function notifyRemoved(removedPairs) {
  for (const { deck_id, recipient_id } of removedPairs) {
    broadcast(recipient_id, "deck_removed", [{ id: deck_id }]);
  }
}

// ========================
// POST /decks/:id/share — delen met een geaccepteerd contact
// ========================
router.post("/decks/:id/share", authMiddleware, inviteLimiter, async (req, res) => {
  const { id } = req.params;
  const { recipient_id } = req.body;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Deck not found" });
  }
  if (typeof recipient_id !== "string" || !UUID_RE.test(recipient_id)) {
    return res.status(400).json({ error: "recipient_id is required" });
  }
  if (recipient_id === req.user.id) {
    return res.status(400).json({ error: "cannot_share_with_self" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Alleen de eigenaar deelt; onbekend/andermans deck → 404 (zoals PUT).
    const deckCheck = await client.query(
      `SELECT d.id, d.title FROM decks d
       WHERE d.id = $1 AND ${isDeckOwnerSql("d", "$2")} AND d.deleted_at IS NULL`,
      [id, req.user.id]
    );
    if (deckCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deck not found" });
    }

    // Delen kan alleen met een wederzijds geaccepteerd contact — dat is de
    // hele reden dat delen-op-e-mail (en anti-enumeratie) niet meer nodig is.
    const contactCheck = await client.query(
      `SELECT 1 FROM contacts
       WHERE status = 'accepted'
         AND least(requester_id, addressee_id) = least($1::uuid, $2::uuid)
         AND greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`,
      [req.user.id, recipient_id]
    );
    if (contactCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "not_a_contact" });
    }

    // Upsert op de directe rij. Een nieuwe share begint als uitnodiging
    // (accepted_at = NULL): nog géén toegang, de ontvanger accepteert eerst.
    // Was de rij al actief (pending óf geaccepteerd), dan blijft die status
    // staan — dubbel delen degradeert een geaccepteerde share niet. Her-delen
    // na revoke wordt weer een verse uitnodiging, mét gereset edit-recht
    // (intrekken = vertrouwen intrekken); op een actieve rij blijft het
    // recht staan.
    const share = await client.query(
      `INSERT INTO deck_shares (deck_id, owner_id, recipient_id, kind, accepted_at)
       VALUES ($1, $2, $3, 'invited', NULL)
       ON CONFLICT (deck_id, recipient_id) WHERE group_id IS NULL
       DO UPDATE SET
         accepted_at = CASE WHEN deck_shares.revoked_at IS NULL
                            THEN deck_shares.accepted_at ELSE NULL END,
         can_edit = CASE WHEN deck_shares.revoked_at IS NULL
                         THEN deck_shares.can_edit ELSE false END,
         revoked_at = NULL, inactive = false, kind = 'invited', updated_at = NOW()
       RETURNING *`,
      [id, req.user.id, recipient_id]
    );

    await client.query("COMMIT");

    // Alleen melden zolang het een openstaande uitnodiging is; een al
    // geaccepteerde share opnieuw delen verandert niets bij de ontvanger.
    if (share.rows[0].accepted_at === null) {
      const meRes = await pool.query(`SELECT username FROM users WHERE id = $1`, [req.user.id]);
      broadcast(recipient_id, "share_received", [
        { deck_id: id, title: deckCheck.rows[0].title, owner_username: meRes.rows[0].username },
      ]);
    }

    res.status(201).json(share.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// POST /decks/:id/share/accept — ontvanger accepteert een uitnodiging
// ========================
// Zet accepted_at; updated_at = NOW() laat de rij in het nieuw-gedeeld-venster
// van /sync/changes vallen, dus de eerstvolgende sync levert deck + kaarten
// integraal. Afwijzen = DELETE /decks/:id/follow (ontvanger haakt af).
router.post("/decks/:id/share/accept", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Share not found" });
  }

  try {
    const result = await pool.query(
      `UPDATE deck_shares
       SET accepted_at = NOW(), updated_at = NOW()
       WHERE deck_id = $1 AND recipient_id = $2
         AND revoked_at IS NULL AND accepted_at IS NULL
       RETURNING *`,
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Share not found" });
    }

    // Eigen andere devices: uitnodiging uit de lijst halen en bijsyncen.
    broadcast(req.user.id, "share_resolved", [{ deck_id: id }]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// GET /shares/received — openstaande deck-uitnodigingen voor mij
// ========================
// De accepteer/afwijs-lijst van de ontvanger. Alleen pending directe shares;
// geaccepteerde shares staan gewoon als deck op het dashboard.
router.get("/shares/received", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.deck_id, d.title AS deck_title, d.description,
              u.username AS owner_username, s.created_at,
              (SELECT COUNT(*) FROM cards c
               WHERE c.deck_id = d.id AND c.deleted_at IS NULL) AS card_count
       FROM deck_shares s
       JOIN decks d ON d.id = s.deck_id
       JOIN users u ON u.id = s.owner_id
       WHERE s.recipient_id = $1
         AND s.revoked_at IS NULL
         AND s.accepted_at IS NULL
         AND d.deleted_at IS NULL
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// DELETE /decks/:id/share/:recipient_id — owner trekt een directe share in
// ========================
router.delete("/decks/:id/share/:recipient_id", authMiddleware, async (req, res) => {
  const { id, recipient_id } = req.params;

  if (!UUID_RE.test(id) || !UUID_RE.test(recipient_id)) {
    return res.status(404).json({ error: "Share not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Owner-check via de deck-rij (share-rijen dragen owner_id, maar de
    // deck-rij is de waarheid). Deck mag soft-deleted zijn: intrekken van een
    // share op een verwijderd deck is gewoon opruimen.
    const deckCheck = await client.query(
      `SELECT d.id FROM decks d WHERE d.id = $1 AND ${isDeckOwnerSql("d", "$2")}`,
      [id, req.user.id]
    );
    if (deckCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Share not found" });
    }

    // Alleen de directe rij (invited/subscribed); groepsshares beheert de
    // groep (deck uit de catalogus halen).
    const removed = await revokeShares(client, {
      deckId: id,
      recipientId: recipient_id,
      directOnly: true,
    });

    await client.query("COMMIT");

    // Idempotent: bestond de share niet (meer), dan is het doel al bereikt.
    // removed is leeg wanneer een groepsshare de toegang nog draagt — dan
    // blijft het deck bij de recipient staan en is er niets te melden.
    notifyRemoved(removed);
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// GET /shares/sent — wie heeft toegang tot mijn decks (directe shares)
// ========================
// Usernames, geen e-mailadressen. Groepsshares lopen via de groep zelf.
router.get("/shares/sent", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.deck_id, d.title AS deck_title, s.recipient_id,
              u.username AS recipient_username, s.kind, s.created_at,
              (s.accepted_at IS NULL) AS pending, s.can_edit
       FROM deck_shares s
       JOIN decks d ON d.id = s.deck_id
       JOIN users u ON u.id = s.recipient_id
       WHERE s.owner_id = $1
         AND s.revoked_at IS NULL
         AND s.group_id IS NULL
         AND d.deleted_at IS NULL
       ORDER BY d.title ASC, u.username ASC`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// GET /shares/overview — met wie (personen/groepen) deel ik welke decks
// ========================
// Owner-perspectief voor het "Gedeeld met"-paneel: per gedeeld deck de
// personen (gededupliceerd over hun rijen, effectief can_edit = bool_or,
// met bron "via groep X"), de groepen uit de catalogus en het aantal
// publieke volgers. Usernames, nooit e-mailadressen. Online-only.
router.get("/shares/overview", authMiddleware, async (req, res) => {
  try {
    const [peopleRes, groupsRes, followersRes] = await Promise.all([
      // Alle actieve niet-volger-rijen op mijn decks (invited + group),
      // inclusief pending uitnodigingen — de owner ziet wat er uitstaat.
      pool.query(
        `SELECT s.deck_id, d.title AS deck_title, d.is_public,
                s.recipient_id, u.username, s.kind, s.can_edit,
                (s.accepted_at IS NULL) AS pending, g.name AS group_name
         FROM deck_shares s
         JOIN decks d ON d.id = s.deck_id
         JOIN users u ON u.id = s.recipient_id
         LEFT JOIN groups g ON g.id = s.group_id
         WHERE d.user_id = $1
           AND s.revoked_at IS NULL
           AND s.kind <> 'subscribed'
           AND d.deleted_at IS NULL
         ORDER BY d.title ASC, u.username ASC`,
        [req.user.id]
      ),
      // Catalogus-vermeldingen van mijn decks: in welke groepen staan ze en
      // hoeveel leden hebben het deck daadwerkelijk toegevoegd.
      pool.query(
        `SELECT gd.deck_id, d.title AS deck_title, d.is_public,
                g.id AS group_id, g.name,
                (SELECT COUNT(*)::int FROM deck_shares s
                 WHERE s.deck_id = gd.deck_id AND s.group_id = g.id
                   AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL)
                  AS members_with_deck,
                (SELECT COUNT(*)::int FROM group_members gm
                 WHERE gm.group_id = g.id AND gm.status = 'active')
                  AS member_count
         FROM group_decks gd
         JOIN groups g ON g.id = gd.group_id AND g.deleted_at IS NULL
         JOIN decks d ON d.id = gd.deck_id
         WHERE d.user_id = $1 AND d.deleted_at IS NULL
         ORDER BY d.title ASC, g.name ASC`,
        [req.user.id]
      ),
      // Publieke volgers: alleen een aantal (vreemden krijgen geen naam of
      // rechten in dit overzicht).
      pool.query(
        `SELECT s.deck_id, d.title AS deck_title, d.is_public,
                COUNT(*)::int AS follower_count
         FROM deck_shares s
         JOIN decks d ON d.id = s.deck_id
         WHERE d.user_id = $1
           AND s.revoked_at IS NULL
           AND s.accepted_at IS NOT NULL
           AND s.kind = 'subscribed'
           AND d.deleted_at IS NULL
         GROUP BY s.deck_id, d.title, d.is_public`,
        [req.user.id]
      ),
    ]);

    // Samenvoegen per deck; personen dedupliceren over directe + groepsrijen.
    const byDeck = new Map();
    const deckEntry = (row) => {
      let entry = byDeck.get(row.deck_id);
      if (!entry) {
        entry = {
          deck_id: row.deck_id,
          deck_title: row.deck_title,
          is_public: row.is_public,
          people: [],
          groups: [],
          follower_count: 0,
        };
        byDeck.set(row.deck_id, entry);
      }
      return entry;
    };

    const personKey = new Map();
    for (const row of peopleRes.rows) {
      const entry = deckEntry(row);
      const key = `${row.deck_id}:${row.recipient_id}`;
      let person = personKey.get(key);
      if (!person) {
        person = {
          user_id: row.recipient_id,
          username: row.username,
          direct: false,
          // pending = nog géén enkele rij geaccepteerd (dus nog geen toegang)
          pending: true,
          can_edit: false,
          via_groups: [],
        };
        personKey.set(key, person);
        entry.people.push(person);
      }
      if (row.kind === "group") person.via_groups.push(row.group_name);
      else person.direct = true;
      if (!row.pending) person.pending = false;
      if (row.can_edit) person.can_edit = true;
    }

    for (const row of groupsRes.rows) {
      deckEntry(row).groups.push({
        group_id: row.group_id,
        name: row.name,
        members_with_deck: row.members_with_deck,
        member_count: row.member_count,
      });
    }

    for (const row of followersRes.rows) {
      deckEntry(row).follower_count = row.follower_count;
    }

    res.json([...byDeck.values()].sort((a, b) =>
      a.deck_title.localeCompare(b.deck_title)
    ));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// PUT /decks/:id/permissions/:user_id — owner togglet het edit-recht
// ========================
// Zet can_edit op ál iemands niet-gerevokete rijen (direct + groep) tegelijk,
// zodat het effectieve recht (bool_or) eenduidig blijft — zelfde patroon als
// share-state. Pending rijen tellen mee: het recht gaat in bij acceptatie.
// Volger-rijen (kind='subscribed') zijn uitgesloten: vreemden krijgen geen
// schrijfrecht — edit loopt via een contact-share of groep.
router.put("/decks/:id/permissions/:user_id", authMiddleware, async (req, res) => {
  const { id, user_id } = req.params;
  const { can_edit } = req.body;

  if (!UUID_RE.test(id) || !UUID_RE.test(user_id)) {
    return res.status(404).json({ error: "Share not found" });
  }
  if (typeof can_edit !== "boolean") {
    return res.status(400).json({ error: "can_edit must be a boolean" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Alleen de eigenaar deelt rechten uit; levend deck vereist.
    const deckCheck = await client.query(
      `SELECT d.id FROM decks d
       WHERE d.id = $1 AND ${isDeckOwnerSql("d", "$2")} AND d.deleted_at IS NULL`,
      [id, req.user.id]
    );
    if (deckCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Share not found" });
    }

    const result = await client.query(
      `UPDATE deck_shares
       SET can_edit = $1, updated_at = NOW()
       WHERE deck_id = $2 AND recipient_id = $3
         AND revoked_at IS NULL AND kind <> 'subscribed'
       RETURNING accepted_at`,
      [can_edit, id, user_id]
    );

    await client.query("COMMIT");

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Share not found" });
    }

    // De updated_at-bump levert het deck met de nieuwe can_edit ook via de
    // eerstvolgende sync-delta; dit event is de directe hint. Alleen sturen
    // als de recipient het deck al heeft (een pending invite heeft lokaal
    // nog geen deck om bij te werken).
    if (result.rows.some((r) => r.accepted_at !== null)) {
      broadcast(user_id, "deck_access_changed", [{ deck_id: id, can_edit }]);
    }
    // Eigen andere devices kunnen een open "Gedeeld met"-paneel verversen.
    broadcast(req.user.id, "shares_updated", [{ deck_id: id }]);

    res.json({
      deck_id: id,
      user_id,
      can_edit,
      pending: result.rows.every((r) => r.accepted_at === null),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// GET /decks/public — publieke bibliotheek (discovery, gepagineerd)
// ========================
// Staat vóór GET /decks/:id (routevolgorde: dit router mount eerst in app.js).
// Eigen decks worden uitgesloten — die staan al op het dashboard.
router.get("/decks/public", authMiddleware, publicSearchLimiter, async (req, res) => {
  const { search } = req.query;

  let limit = Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PUBLIC_PAGE_MAX) limit = 20;
  let offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;

  if (search !== undefined && (typeof search !== "string" || search.length > LIMITS.TITLE_MAX)) {
    return res.status(400).json({ error: "Invalid search" });
  }

  // Zonder zoekterm geen catalogus (PUBLIC_DECKS_PLAN.md): browsen door
  // álle publieke decks is de duurste variant van deze query en de client
  // toont bewust geen standaardlijst. Minimaal 2 tekens, net als de client.
  const term = typeof search === "string" ? search.trim() : "";
  if (term.length < 2) {
    return res.status(400).json({ error: "search_required" });
  }

  const params = [req.user.id];
  params.push(`%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  const searchCond = `AND (d.title ILIKE $${params.length}
                   OR EXISTS (SELECT 1 FROM unnest(d.tags) t WHERE t ILIKE $${params.length}))`;
  params.push(limit, offset);

  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.title, d.description, d.tags, d.created_at,
              u.username AS owner_username,
              (SELECT COUNT(*) FROM cards c
               WHERE c.deck_id = d.id AND c.deleted_at IS NULL) AS card_count
       FROM decks d
       JOIN users u ON u.id = d.user_id
       WHERE d.is_public = true
         AND d.deleted_at IS NULL
         AND d.user_id <> $1
         ${searchCond}
       ORDER BY d.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// POST /decks/:id/follow — publiek deck volgen
// ========================
router.post("/decks/:id/follow", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Deck not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Alleen levende, publieke decks van iemand anders; anders 404 (geen
    // onderscheid tussen "bestaat niet" en "niet publiek").
    const deckCheck = await client.query(
      `SELECT user_id FROM decks
       WHERE id = $1 AND is_public = true AND deleted_at IS NULL AND user_id <> $2`,
      [id, req.user.id]
    );
    if (deckCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deck not found" });
    }

    // Her-volgen na revoke/unfollow reset het edit-recht (zelfde regel als
    // her-delen); volgen op een al actieve rij verandert niets aan het recht.
    const share = await client.query(
      `INSERT INTO deck_shares (deck_id, owner_id, recipient_id, kind)
       VALUES ($1, $2, $3, 'subscribed')
       ON CONFLICT (deck_id, recipient_id) WHERE group_id IS NULL
       DO UPDATE SET revoked_at = NULL, inactive = false, updated_at = NOW(),
         accepted_at = COALESCE(deck_shares.accepted_at, NOW()),
         can_edit = CASE WHEN deck_shares.revoked_at IS NULL
                         THEN deck_shares.can_edit ELSE false END
       RETURNING *`,
      [id, deckCheck.rows[0].user_id, req.user.id]
    );

    await client.query("COMMIT");

    res.status(201).json(share.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// DELETE /decks/:id/follow — recipient haalt het deck van zijn dashboard
// ========================
// Geldt voor élke bron (invited, subscribed én group): een ontvanger mag
// altijd zelf afhaken. Een groepsdeck kan daarna opnieuw uit de catalogus
// worden toegevoegd. Ook het afwijzen van een openstaande uitnodiging loopt
// hierlangs (pending rij wordt gerevoket).
router.delete("/decks/:id/follow", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Deck not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const removed = await revokeShares(client, { deckId: id, recipientId: req.user.id });

    await client.query("COMMIT");

    if (removed.length === 0) {
      return res.status(404).json({ error: "Deck not found" });
    }

    // Eigen andere devices ruimen het deck ook op.
    notifyRemoved(removed);
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// PUT /decks/:id/share-state — archiefvlag van de ONTVANGER
// ========================
// Het enige dat een recipient aan een gedeeld deck "schrijft". Zet de vlag op
// al zijn actieve share-rijen tegelijk (contact- én groepsbron), zodat de
// effectieve inactive (bool_and) eenduidig blijft.
router.put("/decks/:id/share-state", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { inactive } = req.body;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Deck not found" });
  }
  if (typeof inactive !== "boolean") {
    return res.status(400).json({ error: "inactive must be a boolean" });
  }

  try {
    const result = await pool.query(
      `UPDATE deck_shares
       SET inactive = $1, updated_at = NOW()
       WHERE deck_id = $2 AND recipient_id = $3
         AND revoked_at IS NULL AND accepted_at IS NOT NULL
       RETURNING deck_id, inactive`,
      [inactive, id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Deck not found" });
    }

    // Andere devices van de recipient zien de vlag via de sync (share.updated_at
    // valt in de delta) — en direct via een lichte deck_updated-hint.
    broadcast(req.user.id, "shared_deck_state", [{ id, inactive }]);

    res.json({ deck_id: id, inactive });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
