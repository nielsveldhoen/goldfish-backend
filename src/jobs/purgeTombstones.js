import { pool } from "../db.js";
import { TOMBSTONE_RETENTION_DAYS } from "../config/retention.js";

// Hard-delete soft-deletes (tombstones) die ouder zijn dan de retentie. Houdt
// de garantie-grens schoon op precies `now() - retentionDays`: jongere
// tombstones blijven staan zodat /sync/changes ze nog aan clients kan leveren.
//
// Idempotent en veilig om DAGELIJKS te draaien — kleine batches, stabiele
// horizon, minder bloat dan een grote run per retentieperiode. Eén transactie;
// volgorde child → parent (progress, cards, dan decks) zodat FK's niet breken.
//
// `retentionDays` is overschrijfbaar (tests); default uit config/env.
export async function purgeTombstones(retentionDays = TOMBSTONE_RETENTION_DAYS) {
  const days = String(retentionDays);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const progress = await client.query(
      `DELETE FROM user_card_progress
       WHERE deleted_at IS NOT NULL
         AND deleted_at < now() - ($1 || ' days')::interval`,
      [days]
    );
    const cards = await client.query(
      `DELETE FROM cards
       WHERE deleted_at IS NOT NULL
         AND deleted_at < now() - ($1 || ' days')::interval`,
      [days]
    );
    // Share- en catalogusrijen die naar te purgen decks verwijzen eerst weg
    // (FK's zonder cascade). Daarnaast: gerevokete shares ouder dan de
    // retentie zijn als removed_deck_ids-bron uitgewerkt (de resync-horizon
    // is korter) en mogen dus ook weg.
    const shares = await client.query(
      `DELETE FROM deck_shares
       WHERE deck_id IN (SELECT id FROM decks
                         WHERE deleted_at IS NOT NULL
                           AND deleted_at < now() - ($1 || ' days')::interval)
          OR (revoked_at IS NOT NULL
              AND revoked_at < now() - ($1 || ' days')::interval)`,
      [days]
    );
    await client.query(
      `DELETE FROM group_decks
       WHERE deck_id IN (SELECT id FROM decks
                         WHERE deleted_at IS NOT NULL
                           AND deleted_at < now() - ($1 || ' days')::interval)`,
      [days]
    );
    const decks = await client.query(
      `DELETE FROM decks
       WHERE deleted_at IS NOT NULL
         AND deleted_at < now() - ($1 || ' days')::interval`,
      [days]
    );
    // Soft-deleted groepen waarvan geen share-rij meer bestaat mogen hard weg.
    const groups = await client.query(
      `DELETE FROM groups g
       WHERE g.deleted_at IS NOT NULL
         AND g.deleted_at < now() - ($1 || ' days')::interval
         AND NOT EXISTS (SELECT 1 FROM deck_shares s WHERE s.group_id = g.id)`,
      [days]
    );

    // Geen tombstones, maar dezelfde dagelijkse hygiëne: verlopen
    // verificatie- en wachtwoord-reset-tokens zijn onbruikbaar (de routes
    // checken expires_at) en hoeven dus niet te blijven staan.
    const authTokens = await client.query(
      `WITH v AS (
         DELETE FROM email_verification_tokens WHERE expires_at < now() RETURNING 1
       ), p AS (
         DELETE FROM password_reset_tokens WHERE expires_at < now() RETURNING 1
       )
       SELECT (SELECT COUNT(*) FROM v) + (SELECT COUNT(*) FROM p) AS count`
    );

    await client.query("COMMIT");

    const expiredAuthTokens = Number(authTokens.rows[0].count);
    console.log(
      `[purgeTombstones] purged progress=${progress.rowCount}, ` +
        `cards=${cards.rowCount}, decks=${decks.rowCount}, ` +
        `shares=${shares.rowCount}, groups=${groups.rowCount}, ` +
        `expired auth tokens=${expiredAuthTokens} (retention ${days}d)`
    );

    return {
      progress: progress.rowCount,
      cards: cards.rowCount,
      decks: decks.rowCount,
      shares: shares.rowCount,
      groups: groups.rowCount,
      expiredAuthTokens,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[purgeTombstones] failed, rolled back:", err);
    throw err;
  } finally {
    client.release();
  }
}
