import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { broadcast } from "../ws.js";

const router = express.Router();

// ========================
// GET ALL DECKS (van user)
// ========================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM decks
       WHERE user_id = $1
         AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
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

  try {
    const result = await pool.query(
      `SELECT * FROM decks
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, req.user.id]
    );

    const deck = result.rows[0];

    if (!deck) {
      return res.status(404).json({ error: "Deck not found" });
    }

    res.json(deck);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// CREATE DECK
// ========================
router.post("/", authMiddleware, async (req, res) => {
  const { title, description, is_public, tags } = req.body;

  if (!title) {
    return res.status(400).json({ error: "Title is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO decks (user_id, title, description, is_public, tags)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        req.user.id,
        title,
        description || null,
        is_public ?? false,
        tags ?? []
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
  const { title, description, is_public, tags, client_updated_at } = req.body;

  try {
    const current = await pool.query(
      `SELECT * FROM decks WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, req.user.id]
    );

    if (current.rowCount === 0) {
      return res.status(404).json({ error: "Deck not found" });
    }

    const deck = current.rows[0];

    if (client_updated_at && deck.updated_at > new Date(client_updated_at)) {
      return res.status(409).json({ error: "stale_write", current: deck });
    }

    const result = await pool.query(
      `UPDATE decks
       SET title = $1,
           description = $2,
           is_public = $3,
           tags = $4
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [
        title ?? deck.title,
        description !== undefined ? description : deck.description,
        is_public ?? deck.is_public,
        tags !== undefined ? tags : deck.tags,
        id,
        req.user.id
      ]
    );

    const updated = result.rows[0];
    broadcast(req.user.id, "deck_updated", updated);
    res.json(updated);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// DELETE DECK
// ========================
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE decks SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deck not found" });
    }

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

    broadcast(req.user.id, "deck_deleted", { id });
    res.json({ message: "Deck deleted" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
