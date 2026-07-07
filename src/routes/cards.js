import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { broadcast } from "../ws.js";
import { LIMITS, invalidString, firstError } from "../utils/validate.js";

const router = express.Router();

// Gedeelde veldvalidatie voor create/update; geeft een 400-melding of null.
function invalidCardFields({ question, answer }, { required }) {
  return firstError(
    invalidString(question, "question", LIMITS.QUESTION_MAX, { required }),
    invalidString(answer, "answer", LIMITS.ANSWER_MAX, { required }),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maximale batchgrootte voor /bulk en /bulk-delete.
const MAX_BULK_CARDS = 500;

// Optionele client-timestamp voor offline aangemaakte kaarten: geldige ISO-string
// → gebruiken, ontbreekt of ongeldig → null (de DB-klok neemt het dan over).
function parseCreatedAt(value) {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}


// ========================
// GET ALL CARDS (optioneel per deck)
// ========================
router.get("/", authMiddleware, async (req, res) => {
  const { deck_id } = req.query;

  try {
    let query = `
      SELECT c.*
      FROM cards c
      JOIN decks d ON c.deck_id = d.id
      WHERE d.user_id = $1
        AND c.deleted_at IS NULL
        AND d.deleted_at IS NULL
    `;

    const values = [req.user.id];

    if (deck_id) {
      // Malformed filter = onbekend deck: leeg resultaat i.p.v. 22P02 → 500.
      if (!UUID_RE.test(deck_id)) return res.json([]);
      query += " AND c.deck_id = $2";
      values.push(deck_id);
    }

    query += " ORDER BY c.created_at DESC";

    const result = await pool.query(query, values);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// GET SINGLE CARD
// ========================
router.get("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  // Malformed id zou anders als 22P02 in Postgres stranden (500 i.p.v. 404).
  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Card not found" });
  }

  try {
    const result = await pool.query(
      `SELECT c.*
       FROM cards c
       JOIN decks d ON c.deck_id = d.id
       WHERE c.id = $1 AND d.user_id = $2
         AND c.deleted_at IS NULL AND d.deleted_at IS NULL`,
      [id, req.user.id]
    );

    const card = result.rows[0];

    if (!card) {
      return res.status(404).json({ error: "Card not found" });
    }

    res.json(card);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// CREATE CARD
// ========================
router.post("/", authMiddleware, async (req, res) => {
  const { deck_id, question, answer, created_at } = req.body;

  if (!deck_id || !question || !answer) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Malformed deck_id = onbekend deck (zelfde uitkomst als de ownercheck),
  // maar zonder 22P02 → 500.
  if (!UUID_RE.test(deck_id)) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const invalid = invalidCardFields(req.body, { required: true });
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  try {
    const deckCheck = await pool.query(
      `SELECT id FROM decks
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [deck_id, req.user.id]
    );

    if (deckCheck.rowCount === 0) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const result = await pool.query(
      `INSERT INTO cards (deck_id, question, answer, created_at)
       VALUES ($1, $2, $3, COALESCE($4, NOW()))
       RETURNING *`,
      [deck_id, question, answer, parseCreatedAt(created_at)]
    );

    const card = result.rows[0];
    broadcast(req.user.id, "card_created", card);
    res.status(201).json(card);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// BULK CREATE CARDS
// ========================
router.post("/bulk", authMiddleware, async (req, res) => {
  const { deck_id, cards } = req.body;

  if (!deck_id || !Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: "Missing fields" });
  }

  if (cards.length > MAX_BULK_CARDS) {
    return res.status(400).json({ error: `Too many cards (max ${MAX_BULK_CARDS})` });
  }

  if (!UUID_RE.test(deck_id)) {
    return res.status(403).json({ error: "Not allowed" });
  }

  for (const c of cards) {
    if (!c || !c.question || !c.answer) {
      return res.status(400).json({ error: "Each card requires question and answer" });
    }
    const invalid = invalidCardFields(c, { required: true });
    if (invalid) {
      return res.status(400).json({ error: invalid });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const deckCheck = await client.query(
      `SELECT id FROM decks WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [deck_id, req.user.id]
    );

    if (deckCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Not allowed" });
    }

    // Hard contract: de response-array heeft dezelfde volgorde als de
    // cards-array in de request — de client mapt op index zijn lokale
    // temp-ids naar de server-ids. Eén multi-row insert i.p.v. een insert per
    // rij; unnest WITH ORDINALITY + ORDER BY houdt de invoegvolgorde (en dus
    // de RETURNING-volgorde) gelijk aan de request-volgorde.
    const result = await client.query(
      `INSERT INTO cards (deck_id, question, answer, created_at)
       SELECT $1, t.question, t.answer, COALESCE(t.created_at, NOW())
       FROM unnest($2::text[], $3::text[], $4::timestamptz[])
         WITH ORDINALITY AS t(question, answer, created_at, ord)
       ORDER BY t.ord
       RETURNING *`,
      [
        deck_id,
        cards.map((c) => c.question),
        cards.map((c) => c.answer),
        cards.map((c) => parseCreatedAt(c.created_at)),
      ]
    );
    const created = result.rows;

    await client.query("COMMIT");

    broadcast(req.user.id, "card_created", created);
    res.status(201).json(created);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});


// ========================
// BULK DELETE CARDS
// ========================
// Idempotent en tolerant: ids die niet bestaan, al soft-deleted zijn of van
// een andere gebruiker zijn worden stilzwijgend genegeerd (zelfde stijl als
// het ids-filter van GET /stats/decks) — de client behandelt de hele batch
// als geslaagd bij een 200.
router.post("/bulk-delete", authMiddleware, async (req, res) => {
  const { card_ids } = req.body;

  if (!Array.isArray(card_ids) || card_ids.length === 0) {
    return res.status(400).json({ error: "card_ids is required" });
  }

  if (card_ids.length > MAX_BULK_CARDS) {
    return res.status(400).json({ error: `Too many ids (max ${MAX_BULK_CARDS})` });
  }

  // Niet-UUID waarden zouden de ::uuid[]-cast laten falen; behandel ze als
  // onbekende ids en negeer ze dus stilzwijgend.
  const ids = [...new Set(card_ids.filter((id) => typeof id === "string" && UUID_RE.test(id)))];

  if (ids.length === 0) {
    return res.json({ deleted: 0, ids: [] });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE cards c SET deleted_at = NOW()
       FROM decks d
       WHERE c.id = ANY($1::uuid[])
         AND c.deck_id = d.id
         AND d.user_id = $2
         AND c.deleted_at IS NULL
       RETURNING c.id, c.deck_id, c.deleted_at`,
      [ids, req.user.id]
    );

    // Cascade: voortgangsrecords van deze kaarten mee-softdeleten zodat ze
    // niet als wees-records (met is_core = true) in de core-stats blijven
    // hangen — identiek aan DELETE /cards/:id.
    if (result.rowCount > 0) {
      await client.query(
        `UPDATE user_card_progress SET deleted_at = NOW()
         WHERE card_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [result.rows.map((r) => r.id)]
      );
    }

    await client.query("COMMIT");

    broadcast(req.user.id, "card_deleted", result.rows);
    res.json({ deleted: result.rowCount, ids: result.rows.map((r) => r.id) });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});


// ========================
// UPDATE CARD
// ========================
router.put("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { question, answer, client_updated_at } = req.body;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Card not found" });
  }

  const invalid = invalidCardFields(req.body, { required: false });
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  // Check-then-write in één transactie met een rij-lock (FOR UPDATE OF c):
  // twee devices kunnen anders tussen de 409-check en de UPDATE interleaven
  // en elkaars write alsnog stilzwijgend overschrijven.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT c.* FROM cards c
       JOIN decks d ON c.deck_id = d.id
       WHERE c.id = $1 AND d.user_id = $2
         AND c.deleted_at IS NULL AND d.deleted_at IS NULL
       FOR UPDATE OF c`,
      [id, req.user.id]
    );

    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Card not found" });
    }

    const card = current.rows[0];

    if (client_updated_at && card.updated_at > new Date(client_updated_at)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "stale_write", current: card });
    }

    const result = await client.query(
      `UPDATE cards c
       SET question = $1,
           answer = $2
       FROM decks d
       WHERE c.id = $3
         AND c.deck_id = d.id
         AND d.user_id = $4
       RETURNING c.*`,
      [
        question ?? card.question,
        answer ?? card.answer,
        id,
        req.user.id
      ]
    );

    await client.query("COMMIT");

    const updated = result.rows[0];
    broadcast(req.user.id, "card_updated", updated);
    res.json(updated);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});


// ========================
// DELETE CARD
// ========================
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Card not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE cards c SET deleted_at = NOW()
       FROM decks d
       WHERE c.id = $1
         AND c.deck_id = d.id
         AND d.user_id = $2
         AND c.deleted_at IS NULL
       RETURNING c.id, c.deck_id, c.deleted_at`,
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Card not found" });
    }

    // Cascade: voortgangsrecords van deze kaart mee-softdeleten zodat ze niet
    // als wees-records (met is_core = true) in de core-stats blijven hangen.
    await client.query(
      `UPDATE user_card_progress SET deleted_at = NOW()
       WHERE card_id = $1 AND deleted_at IS NULL`,
      [id]
    );

    await client.query("COMMIT");

    // deleted_at mee in de payload: broadcast() gebruikt de DB-timestamp als
    // server_time, zodat WS- en REST-sync dezelfde klokbron delen.
    const { deck_id, deleted_at } = result.rows[0];
    broadcast(req.user.id, "card_deleted", { id, deck_id, deleted_at });
    res.json({ message: "Card deleted" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
