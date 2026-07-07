import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { broadcast } from "../ws.js";
import { SYNC_RESYNC_HORIZON_DAYS, SYNC_WATERMARK_OVERLAP_SECONDS } from "../config/retention.js";
import { LIMITS, invalidString, invalidBoolean, invalidScore, invalidDate, firstError } from "../utils/validate.js";

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
             ucp.id AS progress_id, ucp.remote_score, ucp.stable_score, ucp.recent_score,
             ucp.due_date, ucp.repetitions, ucp.is_core, ucp.updated_at AS progress_updated_at
      FROM cards c
      JOIN user_card_progress ucp ON c.id = ucp.card_id
      JOIN decks d ON c.deck_id = d.id
      WHERE ucp.user_id = $1
        AND ucp.due_date <= CURRENT_DATE
        AND ucp.deleted_at IS NULL
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
         AND ucp.deleted_at IS NULL
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
              ucp.id AS progress_id, ucp.remote_score, ucp.stable_score, ucp.recent_score,
              ucp.due_date, ucp.repetitions, ucp.is_core, ucp.updated_at AS progress_updated_at
       FROM cards c
       JOIN decks d ON c.deck_id = d.id
       LEFT JOIN user_card_progress ucp
         ON c.id = ucp.card_id
         AND ucp.user_id = $1
         AND ucp.deleted_at IS NULL
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
// GET DECK SCORES (lichte score-index per kaart van één deck)
// ========================
router.get("/deck/:deck_id/scores", authMiddleware, async (req, res) => {
  const { deck_id } = req.params;

  if (!isUUID(deck_id)) {
    return res.status(404).json({ error: "Deck not found" });
  }

  try {
    const deckCheck = await pool.query(
      `SELECT user_id FROM decks WHERE id = $1 AND deleted_at IS NULL`,
      [deck_id]
    );

    if (deckCheck.rowCount === 0) {
      return res.status(404).json({ error: "Deck not found" });
    }

    if (deckCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const result = await pool.query(
      `SELECT
         c.id AS card_id,
         c.deck_id,
         COALESCE(ucp.is_core, false) AS is_core,
         (ucp.id IS NULL OR ucp.repetitions IS NULL OR ucp.repetitions = '') AS is_new,
         CASE WHEN ucp.id IS NULL OR ucp.repetitions IS NULL OR ucp.repetitions = ''
              THEN NULL ELSE ucp.remote_score END AS remote_score,
         CASE WHEN ucp.id IS NULL OR ucp.repetitions IS NULL OR ucp.repetitions = ''
              THEN NULL ELSE ucp.stable_score END AS stable_score,
         CASE WHEN ucp.id IS NULL OR ucp.repetitions IS NULL OR ucp.repetitions = ''
              THEN NULL ELSE ucp.recent_score END AS recent_score
       FROM cards c
       JOIN decks d ON c.deck_id = d.id
       LEFT JOIN user_card_progress ucp
         ON c.id = ucp.card_id
         AND ucp.user_id = $1
         AND ucp.deleted_at IS NULL
       WHERE c.deck_id = $2
         AND d.user_id = $1
         AND c.deleted_at IS NULL
         AND d.deleted_at IS NULL
       ORDER BY c.id ASC`,
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
  const { card_id, remote_score, stable_score, recent_score, due_date, repetitions, is_core, client_updated_at } = req.body;

  if (!card_id) {
    return res.status(400).json({ error: "Missing fields" });
  }

  if (!isUUID(card_id)) {
    return res.status(404).json({ error: "Card not found" });
  }

  const coreOnly = remote_score === undefined && stable_score === undefined && recent_score === undefined
    && !due_date && is_core !== undefined;

  if (!coreOnly && (remote_score === undefined || !due_date)) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Scores buiten smallint-range zouden anders als 22003 in Postgres
  // stranden (500); repetitions/datums idem met andere foutcodes.
  const invalid = firstError(
    invalidScore(remote_score, "remote_score"),
    invalidScore(stable_score, "stable_score"),
    invalidScore(recent_score, "recent_score"),
    invalidDate(due_date, "due_date"),
    invalidString(repetitions, "repetitions", LIMITS.REPETITIONS_MAX),
    invalidBoolean(is_core, "is_core"),
    invalidDate(client_updated_at, "client_updated_at"),
  );
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  // Hele flow in één transactie met een rij-lock op het voortgangsrecord:
  // zonder lock kunnen twee devices tussen de 409-check en de write
  // interleaven en elkaars voortgang alsnog stilzwijgend overschrijven.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ownerCheck = await client.query(
      `SELECT c.id FROM cards c
       JOIN decks d ON c.deck_id = d.id
       WHERE c.id = $1 AND d.user_id = $2
         AND c.deleted_at IS NULL AND d.deleted_at IS NULL`,
      [card_id, req.user.id]
    );

    if (ownerCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Not allowed" });
    }

    // Conflict check — lock het huidige voortgangsrecord voor beide modes.
    // Bestaat het record nog niet, dan valt er niets te locken en vangt de
    // unique constraint (ON CONFLICT) gelijktijdige inserts af.
    if (client_updated_at) {
      const existing = await client.query(
        `SELECT * FROM user_card_progress WHERE card_id = $1 AND user_id = $2
         FOR UPDATE`,
        [card_id, req.user.id]
      );
      if (existing.rowCount > 0 && existing.rows[0].updated_at > new Date(client_updated_at)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "stale_write", current: existing.rows[0] });
      }
    }

    let result;

    if (coreOnly) {
      result = await client.query(
        `UPDATE user_card_progress
         SET is_core = $1
         WHERE card_id = $2 AND user_id = $3 AND deleted_at IS NULL
         RETURNING *`,
        [is_core, card_id, req.user.id]
      );

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "No progress found for this card" });
      }
    } else {
      const coreParam = is_core !== undefined ? is_core : null;

      result = await client.query(
        `INSERT INTO user_card_progress
         (user_id, card_id, remote_score, stable_score, recent_score, due_date, repetitions, is_core)
         VALUES ($1, $2, $3, $4, COALESCE($5::smallint, 0), $6, $7, COALESCE($8::boolean, false))
         ON CONFLICT (user_id, card_id)
         DO UPDATE SET
           remote_score = EXCLUDED.remote_score,
           stable_score = EXCLUDED.stable_score,
           recent_score = COALESCE($5::smallint, user_card_progress.recent_score),
           due_date = EXCLUDED.due_date,
           repetitions = EXCLUDED.repetitions,
           is_core = COALESCE($8::boolean, user_card_progress.is_core),
           deleted_at = NULL
         RETURNING *`,
        [req.user.id, card_id, remote_score, stable_score ?? 0, recent_score ?? null, due_date, repetitions || "", coreParam]
      );
    }

    await client.query("COMMIT");

    if (coreOnly) {
      broadcast(req.user.id, "core_set", result.rows[0]);
    }

    res.json(result.rows[0]);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// RESET PROGRESS (soft-delete)
// ========================
router.delete("/progress/:card_id", authMiddleware, async (req, res) => {
  const { card_id } = req.params;

  if (!isUUID(card_id)) {
    return res.status(404).json({ error: "Card not found" });
  }

  try {
    const cardCheck = await pool.query(
      `SELECT d.user_id FROM cards c
       JOIN decks d ON c.deck_id = d.id
       WHERE c.id = $1 AND c.deleted_at IS NULL AND d.deleted_at IS NULL`,
      [card_id]
    );

    if (cardCheck.rowCount === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    if (cardCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const result = await pool.query(
      `UPDATE user_card_progress
       SET deleted_at = NOW()
       WHERE card_id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [card_id, req.user.id]
    );

    // Idempotent: ook 200 als er geen (actief) voortgangsrecord was.
    if (result.rowCount > 0) {
      broadcast(req.user.id, "progress_deleted", result.rows[0]);
    }

    res.json({ message: "Progress reset" });

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
        d.inactive,
        d.created_at,

        COUNT(ucp.card_id) FILTER (
          WHERE ucp.due_date <= CURRENT_DATE
        ) AS due_count,

        COUNT(c.id) FILTER (
          WHERE ucp.repetitions IS NULL OR ucp.repetitions = ''
        ) AS new_count,

        COUNT(c.id) AS total_count,

        COUNT(c.id) FILTER (
          WHERE ucp.is_core = true
        ) AS core_total_count,

        COUNT(ucp.card_id) FILTER (
          WHERE ucp.is_core = true
            AND ucp.due_date <= CURRENT_DATE
        ) AS core_due_count,

        COUNT(c.id) FILTER (
          WHERE ucp.is_core = true
            AND (ucp.repetitions IS NULL OR ucp.repetitions = '')
        ) AS core_new_count,

        ROUND(AVG(ucp.remote_score)::numeric, 2) AS avg_remote_score,
        ROUND(AVG(ucp.stable_score)::numeric, 2) AS avg_stable_score,
        ROUND(AVG(ucp.recent_score)::numeric, 2) AS avg_recent_score,

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
        AND ucp.deleted_at IS NULL

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
// GET CORE SUMMARY
// ========================
// Overzicht van de core-kaarten (is_core = true) — gaat over het kaarttype,
// niet over de remote-score.
router.get("/core/summary", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        COUNT(*) AS total_core_count,
        COUNT(*) FILTER (WHERE ucp.due_date <= CURRENT_DATE) AS due_count,
        ROUND(AVG(ucp.remote_score)::numeric, 2) AS avg_remote_score,
        ROUND(AVG(ucp.stable_score)::numeric, 2) AS avg_stable_score,
        ROUND(AVG(ucp.recent_score)::numeric, 2) AS avg_recent_score
       FROM user_card_progress ucp
       WHERE ucp.user_id = $1
         AND ucp.is_core = true
         AND ucp.deleted_at IS NULL`,
      [req.user.id]
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// GET CORE CHANGES (incrementele core-delta sinds `since`)
// ========================
// Geeft de core-kaarten terug waarvan de voortgang is gewijzigd sinds `since`.
// Stijl van /sync/changes: alleen de delta + server_time als volgend watermerk.
// We filteren op ucp.updated_at > since (niet hard op is_core) en geven de
// actuele is_core per kaart mee: true = toevoegen/bijwerken in core-set,
// false = uit core-set verwijderen. `since` leeg/weg → epoch (eerste sync).
router.get("/core", authMiddleware, async (req, res) => {
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

  // Full-resync-guard (defensief, zelfde reden als /sync/changes): /review/core
  // signaleert core-verwijderingen via is_core=false-flips. Is `since` ouder dan
  // de horizon — of leeg/epoch (nieuwe installatie) — dan kan zo'n flip al
  // gepurged zijn en mist de client hem. Geef dan een full-resync-signaal i.p.v.
  // een delta. server_time uit dezelfde DB-klokbron.
  const horizon = new Date(Date.now() - SYNC_RESYNC_HORIZON_DAYS * 864e5);
  if (sinceDate < horizon) {
    try {
      const { rows } = await pool.query(
        `SELECT NOW() - make_interval(secs => $1) AS now`,
        [SYNC_WATERMARK_OVERLAP_SECONDS]
      );
      return res.status(200).json({ full_resync: true, server_time: rows[0].now });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Server error" });
    }
  }

  try {
    // Watermerk éérst nemen (niet parallel aan de data-query) en met een
    // overlap-venster terugzetten: een write die commit tussen het
    // data-snapshot en een later uitgelezen NOW() zou anders vóór het nieuwe
    // watermerk vallen maar niet in de response zitten — en wordt dan bij de
    // volgende delta permanent overgeslagen.
    const serverTimeResult = await pool.query(
      `SELECT NOW() - make_interval(secs => $1) AS now`,
      [SYNC_WATERMARK_OVERLAP_SECONDS]
    );

    const cardsResult = await pool.query(
      `SELECT c.id, c.deck_id, c.question, c.answer, c.created_at, c.updated_at,
              ucp.id AS progress_id, ucp.remote_score, ucp.stable_score, ucp.recent_score,
              ucp.due_date, ucp.repetitions, ucp.is_core, ucp.updated_at AS progress_updated_at
       FROM cards c
       JOIN user_card_progress ucp ON c.id = ucp.card_id
       JOIN decks d ON c.deck_id = d.id
       WHERE ucp.user_id = $1
         AND ucp.updated_at > $2
         AND ucp.deleted_at IS NULL
         AND c.deleted_at IS NULL
         AND d.deleted_at IS NULL
       ORDER BY ucp.updated_at ASC`,
      [req.user.id, sinceDate]
    );

    res.json({
      cards: cardsResult.rows,
      server_time: serverTimeResult.rows[0].now,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// GET CORE SCORES (lichte score-index van alle core-kaarten)
// ========================
// Alle core-kaarten (is_core = true) van de gebruiker, over alle decks.
router.get("/core/scores", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         c.id AS card_id,
         c.deck_id,
         ucp.is_core AS is_core,
         (ucp.repetitions IS NULL OR ucp.repetitions = '') AS is_new,
         CASE WHEN ucp.repetitions IS NULL OR ucp.repetitions = ''
              THEN NULL ELSE ucp.remote_score END AS remote_score,
         CASE WHEN ucp.repetitions IS NULL OR ucp.repetitions = ''
              THEN NULL ELSE ucp.stable_score END AS stable_score,
         CASE WHEN ucp.repetitions IS NULL OR ucp.repetitions = ''
              THEN NULL ELSE ucp.recent_score END AS recent_score
       FROM user_card_progress ucp
       JOIN cards c ON c.id = ucp.card_id
       JOIN decks d ON c.deck_id = d.id
       WHERE ucp.user_id = $1
         AND ucp.is_core = true
         AND ucp.deleted_at IS NULL
         AND c.deleted_at IS NULL
         AND d.deleted_at IS NULL
       ORDER BY c.id ASC`,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
