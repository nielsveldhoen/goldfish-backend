import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();


// ========================
// POST UPDATE STATS
// ========================
router.post("/update", authMiddleware, async (req, res) => {
  const { date, deck_id, deck_delta, daily_delta, daily_snapshot } = req.body;

  if (!date || !deck_id || !deck_delta || !daily_delta || !daily_snapshot) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const {
    cards_practiced = 0,
    cards_correct_first_try = 0,
    core_cards_practiced = 0,
    core_correct_first_try = 0,
    avg_remote_score: deck_avg_remote = null,
    avg_stable_score: deck_avg_stable = null,
    avg_recent_score: deck_avg_recent = null,
    avg_core_remote_score: deck_avg_core_remote = null,
    avg_core_stable_score: deck_avg_core_stable = null,
    avg_core_recent_score: deck_avg_core_recent = null,
  } = deck_delta;

  const {
    cards_practiced_today = 0,
    correct_first_try_today = 0,
    core_practiced_today = 0,
    core_correct_first_try_today = 0,
  } = daily_delta;

  const {
    total_cards = null,
    total_core_cards = null,
    avg_remote_score = null,
    avg_stable_score = null,
    avg_recent_score = null,
    avg_core_remote_score = null,
    avg_core_stable_score = null,
    avg_core_recent_score = null,
  } = daily_snapshot;

  try {
    const ownerCheck = await pool.query(
      `SELECT id FROM decks WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [deck_id, req.user.id]
    );

    if (ownerCheck.rowCount === 0) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const deckStatsResult = await pool.query(
      `INSERT INTO deck_stats
         (user_id, deck_id, date, cards_practiced, cards_correct_first_try, core_cards_practiced, core_correct_first_try,
          avg_remote_score, avg_stable_score, avg_recent_score,
          avg_core_remote_score, avg_core_stable_score, avg_core_recent_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (user_id, deck_id, date) DO UPDATE SET
         cards_practiced          = deck_stats.cards_practiced          + EXCLUDED.cards_practiced,
         cards_correct_first_try  = deck_stats.cards_correct_first_try  + EXCLUDED.cards_correct_first_try,
         core_cards_practiced     = deck_stats.core_cards_practiced     + EXCLUDED.core_cards_practiced,
         core_correct_first_try   = deck_stats.core_correct_first_try   + EXCLUDED.core_correct_first_try,
         avg_remote_score         = EXCLUDED.avg_remote_score,
         avg_stable_score         = EXCLUDED.avg_stable_score,
         avg_recent_score         = COALESCE(EXCLUDED.avg_recent_score, deck_stats.avg_recent_score),
         avg_core_remote_score    = COALESCE(EXCLUDED.avg_core_remote_score, deck_stats.avg_core_remote_score),
         avg_core_stable_score    = COALESCE(EXCLUDED.avg_core_stable_score, deck_stats.avg_core_stable_score),
         avg_core_recent_score    = COALESCE(EXCLUDED.avg_core_recent_score, deck_stats.avg_core_recent_score),
         updated_at               = NOW()
       RETURNING *`,
      [req.user.id, deck_id, date, cards_practiced, cards_correct_first_try, core_cards_practiced, core_correct_first_try,
       deck_avg_remote, deck_avg_stable, deck_avg_recent,
       deck_avg_core_remote, deck_avg_core_stable, deck_avg_core_recent]
    );

    const snapshotResult = await pool.query(
      `INSERT INTO user_daily_snapshot
         (user_id, date, total_cards, total_core_cards, cards_practiced_today, correct_first_try_today,
          core_practiced_today, core_correct_first_try_today,
          avg_remote_score, avg_stable_score, avg_recent_score,
          avg_core_remote_score, avg_core_stable_score, avg_core_recent_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (user_id, date) DO UPDATE SET
         total_cards                 = COALESCE(EXCLUDED.total_cards,      user_daily_snapshot.total_cards),
         total_core_cards            = COALESCE(EXCLUDED.total_core_cards, user_daily_snapshot.total_core_cards),
         cards_practiced_today       = user_daily_snapshot.cards_practiced_today       + EXCLUDED.cards_practiced_today,
         correct_first_try_today     = user_daily_snapshot.correct_first_try_today     + EXCLUDED.correct_first_try_today,
         core_practiced_today         = user_daily_snapshot.core_practiced_today         + EXCLUDED.core_practiced_today,
         core_correct_first_try_today = user_daily_snapshot.core_correct_first_try_today + EXCLUDED.core_correct_first_try_today,
         avg_remote_score            = EXCLUDED.avg_remote_score,
         avg_stable_score            = EXCLUDED.avg_stable_score,
         avg_recent_score            = COALESCE(EXCLUDED.avg_recent_score, user_daily_snapshot.avg_recent_score),
         avg_core_remote_score       = COALESCE(EXCLUDED.avg_core_remote_score, user_daily_snapshot.avg_core_remote_score),
         avg_core_stable_score       = COALESCE(EXCLUDED.avg_core_stable_score, user_daily_snapshot.avg_core_stable_score),
         avg_core_recent_score       = COALESCE(EXCLUDED.avg_core_recent_score, user_daily_snapshot.avg_core_recent_score),
         updated_at                  = NOW()
       RETURNING *`,
      [req.user.id, date, total_cards, total_core_cards, cards_practiced_today, correct_first_try_today,
       core_practiced_today, core_correct_first_try_today,
       avg_remote_score, avg_stable_score, avg_recent_score,
       avg_core_remote_score, avg_core_stable_score, avg_core_recent_score]
    );

    res.json({
      deck_stats: deckStatsResult.rows[0],
      daily_snapshot: snapshotResult.rows[0],
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// GET STATS CHANGES (incrementele stats-delta sinds `since`)
// ========================
// Aparte delta-cursor voor deck_stats + user_daily_snapshot, in de stijl van
// GET /review/core: filter op updated_at > since (strikt >), server_time =
// DB NOW() bij query-start als volgend watermerk. `since` leeg/weg → epoch
// (eerste sync → volledige historie).
//
// Alleen levende rijen — soft-delete bestaat hier niet. De client leidt
// verwijderde stats zelf af uit de los-gesyncte deck-deletes en ruimt lokale
// orphans op. Loopt bewust NIET mee op /sync/changes.
router.get("/changes", authMiddleware, async (req, res) => {
  const { since } = req.query;

  let sinceDate;
  if (since === undefined || since === "") {
    sinceDate = new Date(0);
  } else {
    sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      return res.status(400).json({ error: "Invalid since format — use ISO 8601" });
    }
  }

  try {
    const [serverTimeResult, deckStatsResult, snapshotsResult] = await Promise.all([
      pool.query(`SELECT NOW() AS now`),
      pool.query(
        `SELECT * FROM deck_stats
         WHERE user_id = $1 AND updated_at > $2
         ORDER BY updated_at ASC`,
        [req.user.id, sinceDate]
      ),
      pool.query(
        `SELECT * FROM user_daily_snapshot
         WHERE user_id = $1 AND updated_at > $2
         ORDER BY updated_at ASC`,
        [req.user.id, sinceDate]
      ),
    ]);

    res.json({
      deck_stats: deckStatsResult.rows,
      daily_snapshots: snapshotsResult.rows,
      server_time: serverTimeResult.rows[0].now,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// GET DECK STATS
// ========================
router.get("/deck/:deckId", authMiddleware, async (req, res) => {
  const { deckId } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM deck_stats
       WHERE user_id = $1 AND deck_id = $2
       ORDER BY date DESC`,
      [req.user.id, deckId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// GET DAILY SNAPSHOTS
// ========================
router.get("/daily", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM user_daily_snapshot
       WHERE user_id = $1
       ORDER BY date DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
