import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { broadcast } from "../ws.js";

const router = express.Router();

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

  for (const c of cards) {
    if (!c.question || !c.answer) {
      return res.status(400).json({ error: "Each card requires question and answer" });
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
    // temp-ids naar de server-ids.
    const created = [];
    for (const c of cards) {
      const result = await client.query(
        `INSERT INTO cards (deck_id, question, answer, created_at)
         VALUES ($1, $2, $3, COALESCE($4, NOW())) RETURNING *`,
        [deck_id, c.question, c.answer, parseCreatedAt(c.created_at)]
      );
      created.push(result.rows[0]);
    }

    await client.query("COMMIT");

    for (const card of created) broadcast(req.user.id, "card_created", card);
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
       RETURNING c.id, c.deck_id`,
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

    for (const { id, deck_id } of result.rows) {
      broadcast(req.user.id, "card_deleted", { id, deck_id });
    }
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

  try {
    const current = await pool.query(
      `SELECT c.* FROM cards c
       JOIN decks d ON c.deck_id = d.id
       WHERE c.id = $1 AND d.user_id = $2
         AND c.deleted_at IS NULL AND d.deleted_at IS NULL`,
      [id, req.user.id]
    );

    if (current.rowCount === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    const card = current.rows[0];

    if (client_updated_at && card.updated_at > new Date(client_updated_at)) {
      return res.status(409).json({ error: "stale_write", current: card });
    }

    const result = await pool.query(
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

    const updated = result.rows[0];
    broadcast(req.user.id, "card_updated", updated);
    res.json(updated);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// DELETE CARD
// ========================
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

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
       RETURNING c.id, c.deck_id`,
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

    const { deck_id } = result.rows[0];
    broadcast(req.user.id, "card_deleted", { id, deck_id });
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
