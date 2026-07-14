// Toegangslaag voor deck-sharing (SHARING_PLAN.md + EDIT_RIGHTS_PLAN.md).
// Eén plek voor de SQL-fragmenten en de response-shaping, zodat alle routes
// uniform blijven.
//
// Model: één niet-gerevokete, geaccepteerde rij in deck_shares = leestoegang
// voor de recipient tot het deck (+ eigen progress erop). accepted_at IS NULL
// = uitnodiging in afwachting (alleen kind='invited'): nog géén toegang, de
// ontvanger accepteert of wijst af. Draagt zo'n rij can_edit, dan heeft de
// recipient bovendien volledig kaartbeheer (canEditDeckSql). Deck-writes,
// delen en catalogusbeheer blijven owner-only (isDeckOwnerSql).

// Leestoegang tot deck `alias` voor user-parameter `userParam` (bijv. '$1').
// LET OP: userParam komt meermaals in het fragment terug; de aanroeper moet
// dezelfde parameter-index gebruiken.
export function canReadDeckSql(alias, userParam) {
  return `(${alias}.user_id = ${userParam} OR EXISTS (
    SELECT 1 FROM deck_shares _s
    WHERE _s.deck_id = ${alias}.id
      AND _s.recipient_id = ${userParam}
      AND _s.revoked_at IS NULL
      AND _s.accepted_at IS NOT NULL))`;
}

// Kaartbeheer (create/update/delete van kaarten): de eigenaar óf een
// recipient met een actieve, geaccepteerde share-rij met can_edit. Het recht
// zit op de rij en sterft dus automatisch mee met een revoke/kick/unfollow.
export function canEditDeckSql(alias, userParam) {
  return `(${alias}.user_id = ${userParam} OR EXISTS (
    SELECT 1 FROM deck_shares _s
    WHERE _s.deck_id = ${alias}.id
      AND _s.recipient_id = ${userParam}
      AND _s.revoked_at IS NULL
      AND _s.accepted_at IS NOT NULL
      AND _s.can_edit))`;
}

// Owner-only: deck-writes (PUT/DELETE /decks, bulk-delete), share-beheer en
// groepscatalogus. Bewust een apart fragment naast canEditDeckSql, zodat elke
// callsite expliciet zegt welk niveau hij bedoelt.
export function isDeckOwnerSql(alias, userParam) {
  return `${alias}.user_id = ${userParam}`;
}

// Effectieve archiefvlag: de eigenaar houdt de deck-kolom, een recipient
// krijgt de vlag van zíjn share-rij(en). bool_and over meerdere bronnen
// (contact-share + groep): pas "gearchiveerd" als alle rijen het zijn —
// PUT /decks/:id/share-state zet ze altijd allemaal tegelijk.
export function effectiveInactiveSql(alias, userParam) {
  return `(CASE WHEN ${alias}.user_id = ${userParam} THEN ${alias}.inactive
    ELSE COALESCE((SELECT bool_and(_si.inactive) FROM deck_shares _si
      WHERE _si.deck_id = ${alias}.id
        AND _si.recipient_id = ${userParam}
        AND _si.revoked_at IS NULL
        AND _si.accepted_at IS NOT NULL), false) END)`;
}

// Extra SELECT-kolommen voor deck-reads: role, owner_username, can_edit en de
// effectieve inactive. can_edit is het échte recht (owner of share-rij met
// can_edit), niet langer een owner-synoniem. Vereist de owner-join (via
// ownerJoinSql hieronder). Bij een eigenaarloos deck (user_id NULL,
// ACCOUNT_DELETION_PLAN.md) is owner_username NULL en role 'recipient'.
export function deckShareColumnsSql(alias, userParam) {
  return `
    CASE WHEN ${alias}.user_id = ${userParam} THEN 'owner' ELSE 'recipient' END AS role,
    _ou.username AS owner_username,
    ${canEditDeckSql(alias, userParam)} AS can_edit,
    ${effectiveInactiveSql(alias, userParam)} AS effective_inactive`;
}

// LEFT JOIN: een geörphand deck (user_id NULL) moet in élke lijst blijven
// verschijnen — een INNER JOIN zou het stilletjes uit ieders resultaten laten
// vallen.
export function ownerJoinSql(alias) {
  return `LEFT JOIN users _ou ON _ou.id = ${alias}.user_id`;
}

// Zet een deck-rij met de extra kolommen om naar de response-vorm: inactive
// vervangen door de effectieve vlag, hulpkolom eruit. can_edit stuurt in de
// client álle bewerk-guards (role is puur weergave).
export function shapeDeckRow(row) {
  const { effective_inactive, ...deck } = row;
  return { ...deck, inactive: effective_inactive };
}

// Revoket share-rijen en soft-delete't de progress van de getroffen
// recipients op de betrokken decks — maar alléén waar geen andere actieve
// share (of eigendom) de toegang nog draagt. Gebruikt door: share intrekken,
// ontvolgen, deck uit groepscatalogus, lid verlaat/kick, groep verwijderen.
//
// `where`: { deckId?, deckIds?, recipientId?, groupId?, directOnly? }.
// Draait binnen de transactie van de aanroeper (client verplicht).
// Retourneert de (deck_id, recipient_id)-paren die hun LAATSTE toegang
// verloren — daar hoort een WS deck_removed bij.
export async function revokeShares(client, { deckId, deckIds, recipientId, groupId, directOnly } = {}) {
  const conds = ["revoked_at IS NULL"];
  const params = [];

  if (deckId) {
    params.push(deckId);
    conds.push(`deck_id = $${params.length}`);
  }
  if (deckIds) {
    if (deckIds.length === 0) return [];
    params.push(deckIds);
    conds.push(`deck_id = ANY($${params.length}::uuid[])`);
  }
  if (recipientId) {
    params.push(recipientId);
    conds.push(`recipient_id = $${params.length}`);
  }
  if (groupId) {
    params.push(groupId);
    conds.push(`group_id = $${params.length}`);
  }
  if (directOnly) {
    conds.push(`group_id IS NULL`);
  }

  // Minstens één echte selector verplicht — anders zou dit alles revoken.
  if (params.length === 0) {
    throw new Error("revokeShares: at least one selector is required");
  }

  const revoked = await client.query(
    `UPDATE deck_shares
     SET revoked_at = NOW(), updated_at = NOW()
     WHERE ${conds.join(" AND ")}
     RETURNING deck_id, recipient_id`,
    params
  );

  if (revoked.rowCount === 0) return [];

  const deckIdsArr = revoked.rows.map((r) => r.deck_id);
  const recipientIdsArr = revoked.rows.map((r) => r.recipient_id);

  // Paren die géén actieve share meer hebben = toegang volledig kwijt. Een
  // resterende pending uitnodiging telt niet als toegang en mag het
  // deck_removed-signaal dus niet onderdrukken.
  const removed = await client.query(
    `SELECT DISTINCT r.deck_id, r.recipient_id
     FROM unnest($1::uuid[], $2::uuid[]) AS r(deck_id, recipient_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM deck_shares s
       WHERE s.deck_id = r.deck_id
         AND s.recipient_id = r.recipient_id
         AND s.revoked_at IS NULL
         AND s.accepted_at IS NOT NULL)`,
    [deckIdsArr, recipientIdsArr]
  );

  if (removed.rowCount > 0) {
    // Progress-cascade: zelfde redenering als DELETE /decks/:id — geen
    // wees-core-stats achterlaten bij wie de toegang verloor.
    await client.query(
      `UPDATE user_card_progress p SET deleted_at = NOW()
       FROM (SELECT DISTINCT deck_id, recipient_id
             FROM unnest($1::uuid[], $2::uuid[]) AS t(deck_id, recipient_id)) r
       JOIN cards c ON c.deck_id = r.deck_id
       WHERE p.card_id = c.id
         AND p.user_id = r.recipient_id
         AND p.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM deck_shares s
           WHERE s.deck_id = r.deck_id
             AND s.recipient_id = r.recipient_id
             AND s.revoked_at IS NULL
             AND s.accepted_at IS NOT NULL)`,
      [removed.rows.map((r) => r.deck_id), removed.rows.map((r) => r.recipient_id)]
    );
  }

  return removed.rows;
}

// Orphant decks (ACCOUNT_DELETION_PLAN.md §5): de eigenaar verdwijnt maar het
// deck blijft bestaan voor zijn actieve subscribers. Aanroeper bepaalt WELKE
// decks (alleen decks met ≥1 actieve geaccepteerde share horen hier); draait
// binnen de transactie van de aanroeper.
//
// `ownerId` is de vertrekkende eigenaar. `withOwnerTombstone` (deck-delete
// door een levende eigenaar): zet een synthetische, direct-gerevokete
// share-rij voor de ex-eigenaar neer zodat /sync/changes zijn (offline)
// apparaten het deck via removed_deck_ids laat opruimen — er is immers geen
// deleted_at en hij heeft zelf geen share-rij. Bij een account-purge is dat
// overbodig (alle apparaten zijn al uitgelogd) en wist de users-cascade zijn
// progress, dus dan withOwnerTombstone = false.
export async function orphanDecks(client, deckIds, ownerId, { withOwnerTombstone } = {}) {
  if (deckIds.length === 0) return;

  await client.query(
    `UPDATE decks
     SET user_id = NULL, is_public = false, updated_at = NOW()
     WHERE id = ANY($1::uuid[])`,
    [deckIds]
  );

  // Pending uitnodigingen revoken: niemand kan ze nog intrekken en de
  // uitnodiger bestaat straks niet meer. (Pending = nog geen toegang, dus
  // geen progress-cascade nodig zoals in revokeShares.)
  await client.query(
    `UPDATE deck_shares
     SET revoked_at = NOW(), updated_at = NOW()
     WHERE deck_id = ANY($1::uuid[])
       AND revoked_at IS NULL AND accepted_at IS NULL`,
    [deckIds]
  );

  // De share-rijen overleven de eigenaar; owner_id wordt nergens als
  // toegangsbron gebruikt (owner-checks lopen via de deck-rij).
  await client.query(
    `UPDATE deck_shares SET owner_id = NULL
     WHERE deck_id = ANY($1::uuid[]) AND owner_id = $2`,
    [deckIds, ownerId]
  );

  if (withOwnerTombstone) {
    // Eigen progress van de ex-eigenaar mee-softdeleten (zelfde redenering
    // als DELETE /decks/:id: geen wees-core-stats achterlaten).
    await client.query(
      `UPDATE user_card_progress SET deleted_at = NOW()
       WHERE user_id = $2 AND deleted_at IS NULL
         AND card_id IN (SELECT id FROM cards WHERE deck_id = ANY($1::uuid[]))`,
      [deckIds, ownerId]
    );

    // De no_self-CHECK (owner_id <> recipient_id) passeert met owner_id NULL;
    // de directe unique index kan niet botsen omdat een eigenaar nooit een
    // share-rij op zijn eigen deck had. ON CONFLICT toch, voor idempotentie.
    await client.query(
      `INSERT INTO deck_shares (deck_id, owner_id, recipient_id, kind, accepted_at, revoked_at)
       SELECT d, NULL, $2, 'invited', NOW(), NOW() FROM unnest($1::uuid[]) AS d
       ON CONFLICT (deck_id, recipient_id) WHERE group_id IS NULL
       DO UPDATE SET revoked_at = NOW(), updated_at = NOW()`,
      [deckIds, ownerId]
    );
  }
}
