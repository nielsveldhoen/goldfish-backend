import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { broadcast } from "../ws.js";

const router = express.Router();


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
  const { deck_id, question, answer } = req.body;

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
      `INSERT INTO cards (deck_id, question, answer)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [deck_id, question, answer]
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

    const created = [];
    for (const c of cards) {
      const result = await client.query(
        `INSERT INTO cards (deck_id, question, answer) VALUES ($1, $2, $3) RETURNING *`,
        [deck_id, c.question, c.answer]
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
