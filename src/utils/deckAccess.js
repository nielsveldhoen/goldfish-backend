// Toegangslaag voor deck-sharing (SHARING_PLAN.md). Eén plek voor de
// SQL-fragmenten en de response-shaping, zodat alle routes uniform blijven.
//
// Model: één niet-gerevokete rij in deck_shares = leestoegang voor de
// recipient tot het deck (+ eigen progress erop). Schrijven aan deck/kaarten
// blijft owner-only — maar via canWriteDeckSql, zodat Release C
// (schrijfrechten voor groepsleden) alleen dát fragment hoeft te verruimen.

// Leestoegang tot deck `alias` voor user-parameter `userParam` (bijv. '$1').
// LET OP: userParam komt meermaals in het fragment terug; de aanroeper moet
// dezelfde parameter-index gebruiken.
export function canReadDeckSql(alias, userParam) {
  return `(${alias}.user_id = ${userParam} OR EXISTS (
    SELECT 1 FROM deck_shares _s
    WHERE _s.deck_id = ${alias}.id
      AND _s.recipient_id = ${userParam}
      AND _s.revoked_at IS NULL))`;
}

// Schrijftoegang: v1 = alleen de eigenaar. Release C verruimt dit fragment
// naar "owner óf actief groepslid met can_edit_decks".
export function canWriteDeckSql(alias, userParam) {
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
        AND _si.revoked_at IS NULL), false) END)`;
}

// Extra SELECT-kolommen voor deck-reads: role, owner_username, can_edit en de
// effectieve inactive. Vereist `JOIN users _ou ON _ou.id = <alias>.user_id`
// in de query (via ownerJoinSql hieronder).
export function deckShareColumnsSql(alias, userParam) {
  return `
    CASE WHEN ${alias}.user_id = ${userParam} THEN 'owner' ELSE 'recipient' END AS role,
    _ou.username AS owner_username,
    (${alias}.user_id = ${userParam}) AS can_edit,
    ${effectiveInactiveSql(alias, userParam)} AS effective_inactive`;
}

export function ownerJoinSql(alias) {
  return `JOIN users _ou ON _ou.id = ${alias}.user_id`;
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

  // Paren die géén actieve share meer hebben = toegang volledig kwijt.
  const removed = await client.query(
    `SELECT DISTINCT r.deck_id, r.recipient_id
     FROM unnest($1::uuid[], $2::uuid[]) AS r(deck_id, recipient_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM deck_shares s
       WHERE s.deck_id = r.deck_id
         AND s.recipient_id = r.recipient_id
         AND s.revoked_at IS NULL)`,
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
             AND s.revoked_at IS NULL)`,
      [removed.rows.map((r) => r.deck_id), removed.rows.map((r) => r.recipient_id)]
    );
  }

  return removed.rows;
}
