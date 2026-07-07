import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { SYNC_WATERMARK_OVERLAP_SECONDS } from "../config/retention.js";
import { invalidCounterDelta, invalidTotal, invalidAvg, invalidDate, firstError } from "../utils/validate.js";

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Valideert de tellers/snapshotvelden van een delta- of snapshot-object.
// Tellers mogen niet negatief of absurd groot zijn: ze worden cumulatief
// opgeteld en een corrupte delta vervuilt de tellers permanent.
function invalidStatsFields(obj, counterKeys, totalKeys, avgKeys) {
  return firstError(
    ...counterKeys.map((k) => invalidCounterDelta(obj[k], k)),
    ...totalKeys.map((k) => invalidTotal(obj[k], k)),
    ...avgKeys.map((k) => invalidAvg(obj[k], k)),
  );
}


// ========================
// POST UPDATE STATS
// ========================
router.post("/update", authMiddleware, async (req, res) => {
  const { date, deck_id, deck_delta, daily_delta, daily_snapshot } = req.body;

  // daily_snapshot is optioneel (deprecatiepad): weggelaten = user_daily_snapshot
  // niet bijwerken. daily_delta voedt alleen die snapshot en is daarom eveneens
  // optioneel geworden. deck_delta blijft verplicht — dat is de primaire schrijfweg.
  if (!date || !deck_id || !deck_delta) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Malformed deck_id = onbekend deck (zelfde uitkomst als de ownercheck),
  // maar zonder 22P02 → 500.
  if (typeof deck_id !== "string" || !UUID_RE.test(deck_id)) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const invalidInput = firstError(
    invalidDate(date, "date", { required: true }),
    typeof deck_delta === "object" && !Array.isArray(deck_delta)
      ? invalidStatsFields(
          deck_delta,
          ["cards_practiced", "cards_correct_first_try", "core_cards_practiced", "core_correct_first_try"],
          ["total_cards", "total_core_cards"],
          ["avg_remote_score", "avg_stable_score", "avg_recent_score",
           "avg_core_remote_score", "avg_core_stable_score", "avg_core_recent_score"],
        )
      : "deck_delta must be an object",
    daily_delta === undefined || daily_delta === null
      ? null
      : typeof daily_delta === "object" && !Array.isArray(daily_delta)
        ? invalidStatsFields(
            daily_delta,
            ["cards_practiced_today", "correct_first_try_today", "core_practiced_today", "core_correct_first_try_today"],
            [], [],
          )
        : "daily_delta must be an object",
    daily_snapshot === undefined || daily_snapshot === null
      ? null
      : typeof daily_snapshot === "object" && !Array.isArray(daily_snapshot)
        ? invalidStatsFields(
            daily_snapshot,
            [],
            ["total_cards", "total_core_cards"],
            ["avg_remote_score", "avg_stable_score", "avg_recent_score",
             "avg_core_remote_score", "avg_core_stable_score", "avg_core_recent_score"],
          )
        : "daily_snapshot must be an object",
  );
  if (invalidInput) {
    return res.status(400).json({ error: invalidInput });
  }

  const {
    cards_practiced = 0,
    cards_correct_first_try = 0,
    core_cards_practiced = 0,
    core_correct_first_try = 0,
    // Absolute deckgroottes (overschrijven; weglaten = onveranderd, zoals de avg_*).
    total_cards: deck_total_cards = null,
    total_core_cards: deck_total_core_cards = null,
    avg_remote_score: deck_avg_remote = null,
    avg_stable_score: deck_avg_stable = null,
    avg_recent_score: deck_avg_recent = null,
    avg_core_remote_score: deck_avg_core_remote = null,
    avg_core_stable_score: deck_avg_core_stable = null,
    avg_core_recent_score: deck_avg_core_recent = null,
  } = deck_delta;

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
          total_cards, total_core_cards,
          avg_remote_score, avg_stable_score, avg_recent_score,
          avg_core_remote_score, avg_core_stable_score, avg_core_recent_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (user_id, deck_id, date) DO UPDATE SET
         cards_practiced          = deck_stats.cards_practiced          + EXCLUDED.cards_practiced,
         cards_correct_first_try  = deck_stats.cards_correct_first_try  + EXCLUDED.cards_correct_first_try,
         core_cards_practiced     = deck_stats.core_cards_practiced     + EXCLUDED.core_cards_practiced,
         core_correct_first_try   = deck_stats.core_correct_first_try   + EXCLUDED.core_correct_first_try,
         total_cards              = COALESCE(EXCLUDED.total_cards, deck_stats.total_cards),
         total_core_cards         = COALESCE(EXCLUDED.total_core_cards, deck_stats.total_core_cards),
         avg_remote_score         = EXCLUDED.avg_remote_score,
         avg_stable_score         = EXCLUDED.avg_stable_score,
         avg_recent_score         = COALESCE(EXCLUDED.avg_recent_score, deck_stats.avg_recent_score),
         avg_core_remote_score    = COALESCE(EXCLUDED.avg_core_remote_score, deck_stats.avg_core_remote_score),
         avg_core_stable_score    = COALESCE(EXCLUDED.avg_core_stable_score, deck_stats.avg_core_stable_score),
         avg_core_recent_score    = COALESCE(EXCLUDED.avg_core_recent_score, deck_stats.avg_core_recent_score),
         updated_at               = NOW()
       RETURNING *`,
      [req.user.id, deck_id, date, cards_practiced, cards_correct_first_try, core_cards_practiced, core_correct_first_try,
       deck_total_cards, deck_total_core_cards,
       deck_avg_remote, deck_avg_stable, deck_avg_recent,
       deck_avg_core_remote, deck_avg_core_stable, deck_avg_core_recent]
    );

    // daily_snapshot weggelaten → user_daily_snapshot niet bijwerken (deprecatiepad).
    let snapshot = null;
    if (daily_snapshot) {
      const {
        cards_practiced_today = 0,
        correct_first_try_today = 0,
        core_practiced_today = 0,
        core_correct_first_try_today = 0,
      } = daily_delta || {};

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
      snapshot = snapshotResult.rows[0];
    }

    res.json({
      deck_stats: deckStatsResult.rows[0],
      daily_snapshot: snapshot,
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
    // Watermerk éérst nemen (niet parallel aan de data-queries) en met een
    // overlap-venster terugzetten: een write die commit tussen het
    // data-snapshot en een later uitgelezen NOW() zou anders vóór het nieuwe
    // watermerk vallen maar niet in de response zitten — en wordt dan bij de
    // volgende delta permanent overgeslagen.
    const serverTimeResult = await pool.query(
      `SELECT NOW() - make_interval(secs => $1) AS now`,
      [SYNC_WATERMARK_OVERLAP_SECONDS]
    );

    const [deckStatsResult, snapshotsResult] = await Promise.all([
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
// GET DECK STATS (batch)
// ========================
// Alle deck_stats van de gebruiker in één request, gegroepeerd per deck —
// vervangt N losse GET /stats/deck/:deckId calls op het dashboard. Optioneel
// ?ids=<uuid,uuid,...> om te beperken tot specifieke decks; zonder ids alle
// levende (niet-verwijderde) decks. Elk gevraagd/levend deck krijgt een key,
// óók zonder stats-rijen (lege array) — zo kan de client "geen stats" van
// "niet gevraagd" onderscheiden.
router.get("/decks", authMiddleware, async (req, res) => {
  const { ids } = req.query;

  let deckIds = null;
  if (ids !== undefined && ids !== "") {
    deckIds = ids.split(",").map((s) => s.trim()).filter(Boolean);
    if (deckIds.length === 0 || !deckIds.every((id) => UUID_RE.test(id))) {
      return res.status(400).json({ error: "Invalid ids — expected comma-separated UUIDs" });
    }
  }

  try {
    const decksResult = await pool.query(
      `SELECT id FROM decks
       WHERE user_id = $1 AND deleted_at IS NULL
       ${deckIds ? "AND id = ANY($2::uuid[])" : ""}`,
      deckIds ? [req.user.id, deckIds] : [req.user.id]
    );

    const liveIds = decksResult.rows.map((r) => r.id);

    const byDeck = {};
    for (const id of liveIds) byDeck[id] = [];

    if (liveIds.length > 0) {
      const statsResult = await pool.query(
        `SELECT * FROM deck_stats
         WHERE user_id = $1 AND deck_id = ANY($2::uuid[])
         ORDER BY deck_id, date DESC`,
        [req.user.id, liveIds]
      );
      for (const row of statsResult.rows) byDeck[row.deck_id].push(row);
    }

    res.json(byDeck);
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

  // Malformed id = onbekend deck: zelfde lege lijst als een geldig-maar-
  // onbekend id, i.p.v. een 22P02 → 500.
  if (!UUID_RE.test(deckId)) {
    return res.json([]);
  }

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
