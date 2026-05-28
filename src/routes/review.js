import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { broadcast } from "../ws.js";

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (v) => UUID_RE.test(v);


// ========================
// GET DUE CARDS
// ========================
router.get("/due", authMiddleware, async (req, res) => {
  const { deck_id, core } = req.query;

  try {
    let query = `
      SELECT c.id, c.deck_id, c.question, c.answer, c.created_at, c.updated_at,
             ucp.id AS progress_id, ucp.ltm_score, ucp.stm_score, ucp.due_date,
             ucp.repetitions, ucp.is_core, ucp.updated_at AS progress_updated_at
      FROM cards c
      JOIN user_card_progress ucp ON c.id = ucp.card_id
      JOIN decks d ON c.deck_id = d.id
      WHERE ucp.user_id = $1
        AND ucp.due_date <= CURRENT_DATE
        AND c.deleted_at IS NULL
        AND d.deleted_at IS NULL
    `;

    const values = [req.user.id];

    if (deck_id) {
      if (!isUUID(deck_id)) return res.json([]);
      query += ` AND c.deck_id = $${values.length + 1}`;
      values.push(deck_id);
    }

    if (core === "true") {
      query += ` AND ucp.is_core = true`;
    }

    query += ` ORDER BY ucp.due_date ASC LIMIT 50`;

    const result = await pool.query(query, values);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// GET NEW CARDS
// ========================
router.get("/new", authMiddleware, async (req, res) => {
  const { deck_id } = req.query;

  if (!deck_id) {
    return res.status(400).json({ error: "deck_id required" });
  }

  if (!isUUID(deck_id)) return res.json([]);

  try {
    const result = await pool.query(
      `SELECT c.*
       FROM cards c
       JOIN decks d ON c.deck_id = d.id
       LEFT JOIN user_card_progress ucp
         ON c.id = ucp.card_id
         AND ucp.user_id = $1
       WHERE c.deck_id = $2
         AND d.user_id = $1
         AND c.deleted_at IS NULL
         AND d.deleted_at IS NULL
         AND (ucp.id IS NULL OR ucp.repetitions = '')
       LIMIT 50`,
      [req.user.id, deck_id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// GET CARDS WITH PROGRESS
// ========================
router.get("/deck/:deck_id", authMiddleware, async (req, res) => {
  const { deck_id } = req.params;

  if (!isUUID(deck_id)) return res.json([]);

  try {
    const result = await pool.query(
      `SELECT c.id, c.deck_id, c.question, c.answer, c.created_at, c.updated_at,
              ucp.id AS progress_id, ucp.ltm_score, ucp.stm_score, ucp.due_date,
              ucp.repetitions, ucp.is_core, ucp.updated_at AS progress_updated_at
       FROM cards c
       JOIN decks d ON c.deck_id = d.id
       LEFT JOIN user_card_progress ucp
         ON c.id = ucp.card_id
         AND ucp.user_id = $1
       WHERE c.deck_id = $2
         AND d.user_id = $1
         AND c.deleted_at IS NULL
         AND d.deleted_at IS NULL`,
      [req.user.id, deck_id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// UPSERT PROGRESS (frontend bepaalt alles)
// ========================
router.post("/progress", authMiddleware, async (req, res) => {
  const { card_id, ltm_score, stm_score, due_date, repetitions, is_core, client_updated_at } = req.body;

  if (!card_id) {
    return res.status(400).json({ error: "Missing fields" });
  }

  if (!isUUID(card_id)) {
    return res.status(404).json({ error: "Card not found" });
  }

  const coreOnly = ltm_score === undefined && stm_score === undefined && !due_date && is_core !== undefined;

  if (!coreOnly && (ltm_score === undefined || !due_date)) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const ownerCheck = await pool.query(
      `SELECT c.id FROM cards c
       JOIN decks d ON c.deck_id = d.id
       WHERE c.id = $1 AND d.user_id = $2
         AND c.deleted_at IS NULL AND d.deleted_at IS NULL`,
      [card_id, req.user.id]
    );

    if (ownerCheck.rowCount === 0) {
      return res.status(403).json({ error: "Not allowed" });
    }

    // Conflict check — fetch current progress record once for both modes
    if (client_updated_at) {
      const existing = await pool.query(
        `SELECT * FROM user_card_progress WHERE card_id = $1 AND user_id = $2`,
        [card_id, req.user.id]
      );
      if (existing.rowCount > 0 && existing.rows[0].updated_at > new Date(client_updated_at)) {
        return res.status(409).json({ error: "stale_write", current: existing.rows[0] });
      }
    }

    let result;

    if (coreOnly) {
      result = await pool.query(
        `UPDATE user_card_progress
         SET is_core = $1
         WHERE card_id = $2 AND user_id = $3
         RETURNING *`,
        [is_core, card_id, req.user.id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "No progress found for this card" });
      }

      broadcast(req.user.id, "core_set", result.rows[0]);
    } else {
      const coreParam = is_core !== undefined ? is_core : null;

      result = await pool.query(
        `INSERT INTO user_card_progress
         (user_id, card_id, ltm_score, stm_score, due_date, repetitions, is_core)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::boolean, false))
         ON CONFLICT (user_id, card_id)
         DO UPDATE SET
           ltm_score = EXCLUDED.ltm_score,
           stm_score = EXCLUDED.stm_score,
           due_date = EXCLUDED.due_date,
           repetitions = EXCLUDED.repetitions,
           is_core = COALESCE($7::boolean, user_card_progress.is_core)
         RETURNING *`,
        [req.user.id, card_id, ltm_score, stm_score ?? 0, due_date, repetitions || "", coreParam]
      );

      broadcast(req.user.id, "progress_saved", result.rows[0]);
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/decks/summary", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        d.id,
        d.title,
        d.tags,
        d.created_at,

        COUNT(ucp.card_id) FILTER (
          WHERE ucp.due_date <= CURRENT_DATE
        ) AS due_count,

        COUNT(c.id) FILTER (
          WHERE ucp.repetitions IS NULL OR ucp.repetitions = ''
        ) AS new_count,

        COUNT(c.id) AS total_count,
        ROUND(AVG(ucp.ltm_score)::numeric, 2) AS avg_ltm_score,
        ROUND(AVG(ucp.stm_score)::numeric, 2) AS avg_stm_score,

        (
          SELECT MAX(ds.date)
          FROM deck_stats ds
          WHERE ds.deck_id = d.id
        ) AS last_reviewed_at

      FROM decks d
      LEFT JOIN cards c ON c.deck_id = d.id
      LEFT JOIN user_card_progress ucp
        ON c.id = ucp.card_id
        AND ucp.user_id = $1

      WHERE d.user_id = $1
        AND d.deleted_at IS NULL
        AND (c.id IS NULL OR c.deleted_at IS NULL)

      GROUP BY d.id
      ORDER BY d.created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// GET LTM SUMMARY
// ========================
router.get("/ltm/summary", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        COUNT(*) AS total_ltm_count,
        COUNT(*) FILTER (WHERE ucp.due_date <= CURRENT_DATE) AS due_count,
        ROUND(AVG(ucp.ltm_score)::numeric, 2) AS avg_ltm_score,
        ROUND(AVG(ucp.stm_score)::numeric, 2) AS avg_stm_score
       FROM user_card_progress ucp
       WHERE ucp.user_id = $1
         AND ucp.is_core = true`,
      [req.user.id]
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
