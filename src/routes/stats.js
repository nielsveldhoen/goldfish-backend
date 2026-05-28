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
    ltm_cards_practiced = 0,
    ltm_correct_first_try = 0,
    avg_ltm_score: deck_avg_ltm = null,
    avg_stm_score: deck_avg_stm = null,
  } = deck_delta;

  const {
    cards_practiced_today = 0,
    correct_first_try_today = 0,
    core_practiced_today = 0,
    core_correct_first_try_today = 0,
  } = daily_delta;

  const {
    total_cards = null,
    total_ltm_cards = null,
    avg_ltm_score = null,
    avg_stm_score = null,
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
         (user_id, deck_id, date, cards_practiced, cards_correct_first_try, ltm_cards_practiced, ltm_correct_first_try, avg_ltm_score, avg_stm_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, deck_id, date) DO UPDATE SET
         cards_practiced         = deck_stats.cards_practiced         + EXCLUDED.cards_practiced,
         cards_correct_first_try = deck_stats.cards_correct_first_try + EXCLUDED.cards_correct_first_try,
         ltm_cards_practiced     = deck_stats.ltm_cards_practiced     + EXCLUDED.ltm_cards_practiced,
         ltm_correct_first_try   = deck_stats.ltm_correct_first_try   + EXCLUDED.ltm_correct_first_try,
         avg_ltm_score           = EXCLUDED.avg_ltm_score,
         avg_stm_score           = EXCLUDED.avg_stm_score,
         updated_at              = NOW()
       RETURNING *`,
      [req.user.id, deck_id, date, cards_practiced, cards_correct_first_try, ltm_cards_practiced, ltm_correct_first_try, deck_avg_ltm, deck_avg_stm]
    ); 

    const snapshotResult = await pool.query(
      `INSERT INTO user_daily_snapshot
         (user_id, date, total_cards, total_ltm_cards, cards_practiced_today, correct_first_try_today,
          core_practiced_today, core_correct_first_try_today, avg_ltm_score, avg_stm_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, date) DO UPDATE SET
         total_cards                 = COALESCE(EXCLUDED.total_cards,     user_daily_snapshot.total_cards),
         total_ltm_cards             = COALESCE(EXCLUDED.total_ltm_cards, user_daily_snapshot.total_ltm_cards),
         cards_practiced_today       = user_daily_snapshot.cards_practiced_today       + EXCLUDED.cards_practiced_today,
         correct_first_try_today     = user_daily_snapshot.correct_first_try_today     + EXCLUDED.correct_first_try_today,
         core_practiced_today         = user_daily_snapshot.core_practiced_today         + EXCLUDED.core_practiced_today,
         core_correct_first_try_today = user_daily_snapshot.core_correct_first_try_today + EXCLUDED.core_correct_first_try_today,
         avg_ltm_score               = EXCLUDED.avg_ltm_score,
         avg_stm_score               = EXCLUDED.avg_stm_score,
         updated_at                  = NOW()
       RETURNING *`,
      [req.user.id, date, total_cards, total_ltm_cards, cards_practiced_today, correct_first_try_today,
       core_practiced_today, core_correct_first_try_today, avg_ltm_score, avg_stm_score]
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
