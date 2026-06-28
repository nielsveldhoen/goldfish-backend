import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { SYNC_RESYNC_HORIZON_DAYS } from "../config/retention.js";

const router = express.Router();

// ========================
// GET /sync/changes 🔒
// ========================
router.get("/changes", authMiddleware, async (req, res) => {
  const { since } = req.query;

  // Geldig ISO-formaat blijft vereist als `since` is meegegeven (behoud 400).
  let sinceDate = null;
  if (since !== undefined && since !== "") {
    sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      return res.status(400).json({ error: "Invalid since format — use ISO 8601" });
    }
  }

  // Full-resync-guard: is `since` ouder dan de horizon (of ontbreekt/leeg →
  // epoch, dus nieuwe installaties), dan kunnen tombstones in dat venster al
  // gepurged zijn. Geef dan geen delta maar een full-resync-signaal. server_time
  // komt uit dezelfde DB-klokbron als de normale response, zodat de
  // client-cursor consistent blijft.
  const horizon = new Date(Date.now() - SYNC_RESYNC_HORIZON_DAYS * 864e5);
  if (!sinceDate || sinceDate < horizon) {
    try {
      const { rows } = await pool.query(`SELECT NOW() AS now`);
      return res.status(200).json({ full_resync: true, server_time: rows[0].now });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Server error" });
    }
  }

  try {
    const [serverTimeResult, decksResult, cardsResult, progressResult] = await Promise.all([
      pool.query(`SELECT NOW() AS now`),
      pool.query(
        `SELECT d.*,
           (SELECT COUNT(*) FROM cards c
              JOIN user_card_progress ucp
                ON ucp.card_id = c.id
               AND ucp.user_id = $1
               AND ucp.deleted_at IS NULL
             WHERE c.deck_id = d.id
               AND c.deleted_at IS NULL
               AND ucp.is_core = true
           ) AS core_total_count,
           (SELECT COUNT(*) FROM cards c
              JOIN user_card_progress ucp
                ON ucp.card_id = c.id
               AND ucp.user_id = $1
               AND ucp.deleted_at IS NULL
             WHERE c.deck_id = d.id
               AND c.deleted_at IS NULL
               AND ucp.is_core = true
               AND ucp.due_date <= CURRENT_DATE
           ) AS core_due_count,
           (SELECT COUNT(*) FROM cards c
              JOIN user_card_progress ucp
                ON ucp.card_id = c.id
               AND ucp.user_id = $1
               AND ucp.deleted_at IS NULL
             WHERE c.deck_id = d.id
               AND c.deleted_at IS NULL
               AND ucp.is_core = true
               AND (ucp.repetitions IS NULL OR ucp.repetitions = '')
           ) AS core_new_count
         FROM decks d
         WHERE d.user_id = $1 AND d.updated_at > $2
         ORDER BY d.updated_at ASC`,
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
