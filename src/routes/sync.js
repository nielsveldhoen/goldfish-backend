import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

// ========================
// GET /sync/changes 🔒
// ========================
router.get("/changes", authMiddleware, async (req, res) => {
  const { since } = req.query;

  if (!since) {
    return res.status(400).json({ error: "Missing required query param: since" });
  }

  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) {
    return res.status(400).json({ error: "Invalid since format — use ISO 8601" });
  }

  try {
    const [serverTimeResult, decksResult, cardsResult, progressResult] = await Promise.all([
      pool.query(`SELECT NOW() AS now`),
      pool.query(
        `SELECT * FROM decks
         WHERE user_id = $1 AND updated_at > $2
         ORDER BY updated_at ASC`,
        [req.user.id, sinceDate]
      ),
      pool.query(
        `SELECT c.* FROM cards c
         WHERE c.deck_id IN (SELECT id FROM decks WHERE user_id = $1)
           AND c.updated_at > $2
         ORDER BY c.updated_at ASC`,
        [req.user.id, sinceDate]
      ),
      pool.query(
        `SELECT * FROM user_card_progress
         WHERE user_id = $1 AND updated_at > $2
         ORDER BY updated_at ASC`,
        [req.user.id, sinceDate]
      ),
    ]);

    res.json({
      server_time: serverTimeResult.rows[0].now,
      decks: decksResult.rows,
      cards: cardsResult.rows,
      progress: progressResult.rows,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
