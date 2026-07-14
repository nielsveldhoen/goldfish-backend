import { pool } from "../db.js";
import { ACCOUNT_DELETION_GRACE_DAYS } from "../config/retention.js";
import { orphanDecks, revokeShares } from "../utils/deckAccess.js";
import { broadcast } from "../ws.js";
import { securityEvent } from "../utils/securityLog.js";

// Definitieve account-wis (ACCOUNT_DELETION_PLAN.md §6): accounts waarvan de
// verwijderaanvraag (users.deletion_requested_at) langer dan de bedenktijd
// geleden is. Eén transactie per account, in de volgorde die de
// NO ACTION-FK's van deck_shares afdwingen:
//
//   1. decks splitsen: mét actieve geaccepteerde subscribers → orphan
//      (user_id NULL, deck blijft leven voor de subscribers), zonder →
//      tombstone (deleted_at) MÉT user_id NULL, zodat het deck en zijn
//      (gerevokete) share-rijen — het offline-removal-signaal van ex-volgers —
//      buiten de users-cascade blijven tot de tombstone-purge ze opruimt.
//   2. alle share-rijen op zijn decks: owner_id NULL (gebeurt in orphanDecks
//      voor de orphans; hier nog voor de tombstones).
//   3. zijn eigen abonnementen hard weg (FK recipient_id blokkeert anders de
//      DELETE; zijn apparaten zijn al uitgelogd, dus geen signaal nodig).
//   4. zijn groepen: zelfde pad als DELETE /groups/:id (revoke + soft-delete)
//      plus owner_id NULL als FK-anker; de bestaande purge ruimt soft-deleted
//      groepen zonder share-rijen al op.
//   5. DELETE FROM users — de cascade doet de rest (contacts, progress,
//      stats, snapshots, memberships, tokens, group_decks.added_by).
//
// Geen synthetische owner-tombstones (withOwnerTombstone=false): alle
// apparaten van de gebruiker zijn sinds de aanvraag uitgelogd.
export async function purgeDeletedAccounts(graceDays = ACCOUNT_DELETION_GRACE_DAYS) {
  const due = await pool.query(
    `SELECT id FROM users
     WHERE deletion_requested_at IS NOT NULL
       AND deletion_requested_at < now() - ($1 || ' days')::interval`,
    [String(graceDays)]
  );

  let purged = 0;
  for (const { id: userId } of due.rows) {
    // Per account een eigen transactie: één kapot account mag de rest niet
    // tegenhouden.
    const client = await pool.connect();
    const notifications = [];
    try {
      await client.query("BEGIN");

      const decks = await client.query(
        `SELECT id, EXISTS (
           SELECT 1 FROM deck_shares s
           WHERE s.deck_id = decks.id
             AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL
         ) AS has_subscribers
         FROM decks WHERE user_id = $1
         FOR UPDATE OF decks`,
        [userId]
      );
      const orphanIds = decks.rows.filter((d) => d.has_subscribers).map((d) => d.id);
      const tombstoneIds = decks.rows.filter((d) => !d.has_subscribers).map((d) => d.id);

      await orphanDecks(client, orphanIds, userId, { withOwnerTombstone: false });

      if (tombstoneIds.length > 0) {
        await client.query(
          `UPDATE decks
           SET user_id = NULL, is_public = false,
               deleted_at = COALESCE(deleted_at, NOW())
           WHERE id = ANY($1::uuid[])`,
          [tombstoneIds]
        );
        // Pending invites revoken en de eigenaar-verwijzing weghalen — zelfde
        // opruiming als orphanDecks, maar dan voor de tombstone-set.
        await client.query(
          `UPDATE deck_shares SET revoked_at = NOW(), updated_at = NOW()
           WHERE deck_id = ANY($1::uuid[])
             AND revoked_at IS NULL AND accepted_at IS NULL`,
          [tombstoneIds]
        );
        await client.query(
          `UPDATE deck_shares SET owner_id = NULL
           WHERE deck_id = ANY($1::uuid[]) AND owner_id = $2`,
          [tombstoneIds, userId]
        );
      }

      await client.query(
        `DELETE FROM deck_shares WHERE recipient_id = $1`,
        [userId]
      );

      const groups = await client.query(
        `SELECT id FROM groups WHERE owner_id = $1 FOR UPDATE`,
        [userId]
      );
      for (const { id: groupId } of groups.rows) {
        const members = await client.query(
          `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2`,
          [groupId, userId]
        );
        const removed = await revokeShares(client, { groupId });

        await client.query(`DELETE FROM group_decks WHERE group_id = $1`, [groupId]);
        await client.query(`DELETE FROM group_members WHERE group_id = $1`, [groupId]);
        await client.query(
          `UPDATE groups
           SET owner_id = NULL, deleted_at = COALESCE(deleted_at, NOW())
           WHERE id = $1`,
          [groupId]
        );

        for (const { user_id } of members.rows) {
          notifications.push(["group_removed", user_id, [{ id: groupId }]]);
        }
        for (const { deck_id, recipient_id } of removed) {
          notifications.push(["deck_removed", recipient_id, [{ id: deck_id }]]);
        }
      }

      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

      await client.query("COMMIT");
      purged++;

      // WS pas ná de commit — en nooit naar de gewiste gebruiker zelf.
      for (const [type, recipient, payload] of notifications) {
        broadcast(recipient, type, payload);
      }
      securityEvent("account_purged", { user_id: userId });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[purgeDeletedAccounts] failed for user ${userId}, rolled back:`, err);
    } finally {
      client.release();
    }
  }

  if (due.rowCount > 0) {
    console.log(`[purgeDeletedAccounts] purged ${purged}/${due.rowCount} accounts (grace ${graceDays}d)`);
  }
  return { due: due.rowCount, purged };
}
