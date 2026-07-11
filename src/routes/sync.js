import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { SYNC_RESYNC_HORIZON_DAYS, SYNC_WATERMARK_OVERLAP_SECONDS } from "../config/retention.js";

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
    // Watermerk éérst nemen (niet parallel aan de data-queries) en met een
    // overlap-venster terugzetten: een write die commit tussen het
    // data-snapshot en een later uitgelezen NOW() zou anders vóór het nieuwe
    // watermerk vallen maar niet in de response zitten — en wordt dan bij de
    // volgende delta permanent overgeslagen. Dubbel geleverde rijen door de
    // overlap zijn onschadelijk: de client upsert idempotent.
    const serverTimeResult = await pool.query(
      `SELECT NOW() - make_interval(secs => $1) AS now`,
      [SYNC_WATERMARK_OVERLAP_SECONDS]
    );

    const [decksResult, cardsResult, progressResult, removedResult] = await Promise.all([
      // Eigen decks + decks met een actieve share-rij. Voor gedeelde decks
      // geldt een extra venster: is de shárerij nieuw/gewijzigd sinds `since`
      // (nieuw gedeeld, her-gedeeld, archiefvlag), dan komt het deck mee ook
      // al is d.updated_at oud. Tombstones (deleted_at gezet) lopen voor
      // beide rollen via d.updated_at, dat de soft-delete-UPDATE bijwerkt.
      pool.query(
        `SELECT d.*,
           CASE WHEN d.user_id = $1 THEN 'owner' ELSE 'recipient' END AS role,
           _ou.username AS owner_username,
           CASE WHEN d.user_id = $1 THEN true
                ELSE COALESCE(sh.can_edit, false) END AS can_edit,
           CASE WHEN d.user_id = $1 THEN d.inactive
                ELSE COALESCE(sh.inactive, false) END AS effective_inactive,
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
         JOIN users _ou ON _ou.id = d.user_id
         LEFT JOIN LATERAL (
           SELECT bool_and(s.inactive) AS inactive, bool_or(s.can_edit) AS can_edit,
                  MAX(s.updated_at) AS last_update
           FROM deck_shares s
           WHERE s.deck_id = d.id AND s.recipient_id = $1
             AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL
         ) sh ON true
         WHERE (d.user_id = $1 AND d.updated_at > $2)
            OR (sh.inactive IS NOT NULL AND (d.updated_at > $2 OR sh.last_update > $2))
         ORDER BY d.updated_at ASC`,
        [req.user.id, sinceDate]
      ),
      // Kaarten van decks waar ik toegang toe heb. Tweede tak: een share die
      // ná `since` (opnieuw) actief werd levert ál zijn kaarten integraal —
      // een vandaag gedeeld deck heeft kaarten met een oude updated_at die
      // anders buiten de delta vallen. Dubbel geleverde rijen zijn
      // onschadelijk: de client upsert idempotent.
      pool.query(
        `SELECT c.* FROM cards c
         WHERE (c.updated_at > $2 AND c.deck_id IN (
                 SELECT id FROM decks WHERE user_id = $1
                 UNION
                 SELECT deck_id FROM deck_shares
                 WHERE recipient_id = $1 AND revoked_at IS NULL
                   AND accepted_at IS NOT NULL))
            OR c.deck_id IN (
                 SELECT deck_id FROM deck_shares
                 WHERE recipient_id = $1 AND revoked_at IS NULL
                   AND accepted_at IS NOT NULL AND updated_at > $2)
         ORDER BY c.updated_at ASC`,
        [req.user.id, sinceDate]
      ),
      pool.query(
        `SELECT * FROM user_card_progress
         WHERE user_id = $1 AND updated_at > $2
         ORDER BY updated_at ASC`,
        [req.user.id, sinceDate]
      ),
      // Toegang verloren (revoke/ontvolgen/kick): geen tombstone — het deck
      // bestaat nog. Alleen decks zonder énige resterende actieve share (een
      // pending uitnodiging telt niet: tot accept hoort het deck lokaal weg);
      // de client ruimt deck + kaarten + eigen progress lokaal op.
      pool.query(
        `SELECT DISTINCT s.deck_id FROM deck_shares s
         WHERE s.recipient_id = $1 AND s.revoked_at > $2
           AND NOT EXISTS (
             SELECT 1 FROM deck_shares s2
             WHERE s2.deck_id = s.deck_id
               AND s2.recipient_id = $1
               AND s2.revoked_at IS NULL
               AND s2.accepted_at IS NOT NULL)`,
        [req.user.id, sinceDate]
      ),
    ]);

    res.json({
      server_time: serverTimeResult.rows[0].now,
      decks: decksResult.rows.map(({ effective_inactive, ...deck }) => ({
        ...deck,
        inactive: effective_inactive,
      })),
      cards: cardsResult.rows,
      progress: progressResult.rows,
      removed_deck_ids: removedResult.rows.map((r) => r.deck_id),
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
