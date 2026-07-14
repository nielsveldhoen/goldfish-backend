# Account verwijderen — ontwerp en datamap

Hoort bij SECURITY_PLAN.md, stap 4.4. **Geïmplementeerd op 2026-07-12** (migratie 020,
`DELETE /v2/auth/me` + `POST /v2/auth/me/restore`, orphan-flow in deck-delete,
`purgeDeletedAccounts`-job, sweep in `purgeTombstones`). Dit document is het ontwerp
erachter; de API-details staan in BACKEND_API.md.

**Besluit (Niels, 2026-07-12):** gedeelde decks blijven bij account- óf deck-verwijdering
eigenaarloos voortbestaan zolang er daadwerkelijk subscribers zijn ("het deck leeft zolang
het gebruikt wordt", §3). Editors houden kaartbeheer, subscribers hun voortgang. Een
periodieke sweep ruimt eigenaarloze decks zonder subscribers op (§7).

Geschreven op basis van het echte schema in productie (FK-regels uitgelezen op 2026-07-12),
niet op basis van wat de migraties zouden moeten hebben gedaan.

---

## 1. Datamap — waar staan persoonsgegevens?

| Gegeven | Waar | Opmerking |
|---|---|---|
| E-mailadres | `users.email` | **De enige plek.** Nergens gedupliceerd. |
| Gebruikersnaam | `users.username` | Zichtbaar voor contacten, groepsleden en volgers van een publiek deck (`owner_username`). |
| Wachtwoord | `users.password_hash` | argon2. |
| Verificatie-/reset-tokens | `email_verification_tokens`, `password_reset_tokens` | Alleen SHA-256-hashes, met expiry; de purge-job ruimt verlopen exemplaren al op. |
| Sociale relaties | `contacts`, `deck_shares`, `group_members`, `group_decks` | Wie kent wie, wie deelt wat. |
| Inhoud | `decks`, `cards` | Kan alles bevatten wat de gebruiker intypt — behandel als persoonsgegeven. |
| Leergedrag | `user_card_progress`, `deck_stats`, `user_daily_snapshot` | Wanneer en hoe goed iemand leert. |
| IP-adressen | pm2/nginx-logs | Alleen in logs (security-events, access-log), niet in de database. Vallen onder logretentie, niet onder een account-delete. |

**E-mail lekt naar buiten via precies één route:** `GET /v2/contacts` geeft het adres van je
contacten terug (en van wie jou een verzoek stuurde). Groeps- en share-responses bevatten
bewust **nooit** een e-mailadres — alleen `user_id` + `username`. Dat onderscheid moet zo blijven.

## 2. Wat het schema vandaag doet bij `DELETE FROM users`

Uitgelezen uit de FK-regels in productie:

**CASCADE (verdwijnt vanzelf):** `contacts`, `decks` → `cards` → `user_card_progress`,
`deck_stats`, `user_daily_snapshot`, `group_members`, `groups` (waar je owner van bent),
`group_decks.added_by`, `email_verification_tokens`, `password_reset_tokens`.
`group_members.invited_by` wordt `SET NULL`.

**NO ACTION:** `deck_shares.owner_id` / `deck_shares.recipient_id` / `deck_shares.deck_id` /
`deck_shares.group_id` en `group_decks.deck_id` — een kale `DELETE FROM users` faalt met een
foreign-key-fout zodra de gebruiker ook maar één share-rij heeft.

Het ontwerp hieronder **benut** die NO ACTION-blokkade: de share-rijen zijn precies wat moet
overleven om subscribers hun toegang te laten houden. In plaats van ze op te ruimen zodat de
cascade kan lopen, halen we de decks (en groepen) juist úít de cascade door hun eigenaar op
`NULL` te zetten.

## 3. Het besluit: eigenaarloos voortbestaan zolang gebruikt

Bij verwijdering (account of deck) geldt per deck:

- **≥ 1 actieve, geaccepteerde share van een ander** (`revoked_at IS NULL AND accepted_at IS
  NOT NULL`) → het deck wordt **geörphand**: `user_id = NULL`, share-rijen blijven staan.
  Subscribers oefenen door met hun eigen voortgang; recipients met `can_edit` houden volledig
  kaartbeheer (dat recht zit op hún share-rij, `canEditDeckSql`, niet op de eigenaar).
- **Geen actieve subscribers** → het deck verdwijnt (tombstone, zie §5/§6).

Waarom dit past: de hele toegangslaag (`src/utils/deckAccess.js`) checkt overal
`d.user_id = $me OR EXISTS (actieve share-rij)`. Met `user_id = NULL` valt de eerste poot
stil en draagt de EXISTS-poot alles. `role` wordt automatisch `'recipient'` voor iedereen
(de `CASE WHEN d.user_id = $1` matcht `NULL` nooit) en owner-only routes (`isDeckOwnerSql`)
matchen niemand meer.

**Bewust aanvaard: bevroren beheer.** Zonder eigenaar kan niemand het deck hernoemen,
`is_public` togglen, shares beheren of nieuwe editors aanwijzen. Bestaande editors houden
kaartbeheer; het beheerniveau ligt permanent vast. Een "adoptie"-mechanisme kan later, is
geen onderdeel van dit ontwerp.

**Bewust gekozen: `is_public = false` bij het orphanen.** Een eigenaarloos deck is niet meer
publiek vindbaar en trekt geen nieuwe volgers; het sterft natuurlijk uit en de sweep ruimt
het op zodra de laatste volger vertrekt. (Alternatief — publiek laten staan onder
"verwijderde gebruiker" — houdt decks kunstmatig in leven en ondermijnt de sweep.)
Bestaande subscribers merken hier niets van: hun toegang loopt via de share-rij, niet via
`is_public`.

**AVG.** Dit is een variant van "anonimiseren", maar verdedigbaar: de `users`-rij verdwijnt
volledig (e-mail, username, hash, voortgang, contacten), alleen deck-inhoud blijft, alléén
zolang anderen die actief gebruiken, en de sweep ruimt de rest op. Kaarten kúnnen
persoonsgegevens van de auteur bevatten — daarom expliciet in de verwijderbevestiging en de
privacyverklaring: *"decks die anderen gebruiken blijven anoniem voor hen beschikbaar."*
Optionele uitbreiding: bij het wissen per gedeeld deck de keuze geven (achterlaten vs. toch
verwijderen); dan is het een geïnformeerde keuze per deck.

Voor **groepen** is overdracht niet nodig: de groep van een verwijderde eigenaar wordt
gewoon opgeheven (soft-delete + revoke, het bestaande `DELETE /groups/:id`-pad). Decks die
leden via die groep volgden verliezen daarmee hun share-rij — tenzij ze het deck óók direct
of via een andere groep hebben (het bestaande `revokeShares`-gedrag regelt dat al).

## 4. Schema- en querywijzigingen (migratie 020)

**Migratie `020_orphan_decks.sql`:**

1. `ALTER TABLE decks ALTER COLUMN user_id DROP NOT NULL;`
2. `ALTER TABLE deck_shares ALTER COLUMN owner_id DROP NOT NULL;`
3. `ALTER TABLE groups ALTER COLUMN owner_id DROP NOT NULL;` (FK-anker: gerevokete
   group-shares verwijzen naar `group_id`, dus de groepsrij moet tot de purge blijven bestaan
   zonder aan de users-cascade te hangen.)
4. `ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;` (bedenktijd, §6)

De FK's zelf blijven zoals ze zijn: een `NULL`-eigenaar wordt door geen enkele FK geraakt,
en voor niet-geörphande decks blijft de bestaande cascade gewoon werken.

**Queries — de eigenaar-join wordt optioneel.** Overal waar `owner_username` wordt gejoind
moet `JOIN users` een `LEFT JOIN` worden, anders verdwijnen geörphande decks stilletjes uit
íéders resultaten:

- `ownerJoinSql` in `src/utils/deckAccess.js` (dekt o.a. review.js);
- de inline join in `src/routes/sync.js` (deck-query van `/sync/changes`);
- `src/routes/decks.js` (PUT-response, regel ~156);
- de share-/groepslijsten in `src/routes/shares.js` en `src/routes/groups.js` die
  `u.username AS owner_username` joinen (grep op `owner_username` vóór implementatie).

`owner_username` wordt dan `NULL`; de frontend toont "verwijderde gebruiker".
Autorisatie hoeft nergens aangepast: owner-checks lopen al via de deck-rij
(zie de comment in shares.js bij de owner-check), en `s.owner_id` wordt nergens
als toegangsbron gebruikt.

`GET /decks/public` hoeft niet te wijzigen (orphans zijn `is_public = false`), maar een
defensieve `AND user_id IS NOT NULL` in het publieke filter mag.

## 5. Deck-verwijdering door een levende eigenaar (`DELETE /decks/:id`, bulk-delete)

Huidig gedrag: soft-delete + soft-delete van **ieders** progress — recipients zien het deck
meteen verdwijnen. Nieuw gedrag, per deck, in één transactie:

**Geen actieve geaccepteerde shares van anderen** → huidig gedrag ongewijzigd
(tombstone `deleted_at = NOW()`, progress-cascade, WS `deck_deleted`).

**Wel actieve subscribers** → orphanen in plaats van verwijderen:

1. `UPDATE decks SET user_id = NULL, is_public = false, updated_at = NOW() WHERE id = $1`
   — de `updated_at`-bump levert het deck (met `owner_username = NULL`) in ieders volgende
   sync-delta.
2. Pending uitnodigingen (`accepted_at IS NULL`) op het deck revoken — niemand kan ze nog
   intrekken en de uitnodiger bestaat straks niet meer.
3. `UPDATE deck_shares SET owner_id = NULL WHERE deck_id = $1` (alle rijen, ook gerevokete).
4. Eigen progress van de ex-eigenaar op het deck soft-deleten (zelfde cascade als nu, maar
   dan alléén voor `user_id = ex-eigenaar`).
5. **Synthetische tombstone voor de ex-eigenaar** — zijn (offline) apparaten hebben een
   removal-signaal nodig, maar er is geen `deleted_at` en hij heeft geen share-rij:
   `INSERT INTO deck_shares (deck_id, owner_id, recipient_id, kind, accepted_at, revoked_at)
   VALUES ($1, NULL, $ex_owner, 'invited', NOW(), NOW()) ON CONFLICT DO NOTHING`.
   Dit voedt de bestaande `removed_deck_ids`-query van `/sync/changes` (die eist alleen
   `revoked_at > since` zonder resterende actieve share). De `no_self`-CHECK
   (`owner_id <> recipient_id`) passeert omdat `owner_id` `NULL` is; de partiële unique
   index `(deck_id, recipient_id) WHERE group_id IS NULL` kan niet botsen omdat een eigenaar
   nooit een share-rij op zijn eigen deck had.
6. WS: `deck_removed` naar de apparaten van de ex-eigenaar. Subscribers krijgen **geen**
   removal — hooguit de deck-update uit stap 1 via de normale sync.

Response: `{ orphaned: true, subscribers: N }` zodat de app het verschil kan tonen.
Frontend: bevestigingsdialoog vóór verwijdering — *"N mensen gebruiken dit deck; het blijft
voor hen beschikbaar"* (aantal via de bestaande share-lijst van de eigenaar).

Bulk-delete maakt dezelfde splitsing per deck binnen de batch.

## 6. Account-verwijderflow

**Endpoint:** `DELETE /v2/auth/me`, met het **wachtwoord in de body** als herbevestiging
(zelfde argon2-verify als login — een gestolen JWT mag geen account kunnen wissen).

**Bedenktijd.** Niet meteen hard verwijderen: zet `users.deletion_requested_at` en trek alle
JWT's in (`tokens_valid_after = NOW()`, het bestaande mechanisme). De gebruiker is direct
overal uitgelogd; de purge-job wist het account definitief na `ACCOUNT_DELETION_GRACE_DAYS`
(default 14). **Herstel**: opnieuw inloggen blijft mogelijk (het wachtwoord is dan opnieuw
bewezen — een gestolen JWT kan hier niets); de login-response meldt `deletion_pending_until`
en `POST /v2/auth/me/restore` annuleert de aanvraag. Een bevestigingsmail bij de aanvraag
("je account wordt op … gewist — was jij dit niet? log in en annuleer") maakt het rond.
Zo is er geen aparte unauthenticated cancel-token-flow nodig.

**Hard delete (in de purge-job, in één transactie), in deze volgorde:**

1. **Splitsing decks:** decks mét actieve geaccepteerde share van een ander → orphan-set,
   de rest → tombstone-set.
2. **Orphan-set:** `user_id = NULL, is_public = false, updated_at = NOW()` + pending
   invites revoken (stappen 1–3 van §5; de eigen-progress- en synthetische-tombstone-stappen
   zijn hier overbodig: de cascade in stap 7 wist zijn progress en al zijn apparaten zijn
   al uitgelogd).
3. **Tombstone-set:** `user_id = NULL, is_public = false, deleted_at = NOW()`. Óók
   `user_id = NULL`: zo blijven deze decks buiten de users-cascade en blijven hun
   (gerevokete) share-rijen — het offline-removal-signaal voor ex-volgers — geldig tot de
   normale purge ze na de retentie opruimt. Pending invites revoken.
4. `UPDATE deck_shares SET owner_id = NULL WHERE owner_id = $me` (alle rijen op zijn decks).
5. `DELETE FROM deck_shares WHERE recipient_id = $me` — zijn eigen abonnementen. Hard
   delete is hier juist: de FK (NO ACTION) blokkeert anders stap 7, en zijn apparaten zijn
   uitgelogd dus er hoeft geen signaal meer geleverd te worden.
6. **Zijn groepen:** per groep het bestaande verwijderpad (soft-delete +
   `revokeShares({groupId})`, met de bijbehorende progress-cascade en
   `deck_removed`-signalen voor leden), daarna `owner_id = NULL` zodat de groepsrij als
   FK-anker blijft staan; de bestaande purge ruimt soft-deleted groepen zonder share-rijen
   al op.
7. `DELETE FROM users WHERE id = $me` — de cascade doet de rest: contacts, group_members,
   `user_card_progress`, `deck_stats`, `user_daily_snapshot`, tokens, en `group_decks`-rijen
   die hij toevoegde (`added_by` CASCADE — catalogusvermeldingen van hem in andermans
   groepen verdwijnen dus mee; verwijzen ze naar een geörphand deck, dan verliezen die
   groepsleden hun catalogus-ingang, maar bestaande group-shares blijven werken).
8. WS: `deck_removed` / `group_removed` naar iedereen die toegang verloor (uit de
   `revokeShares`-returns). Volgers van geörphande decks krijgen géén removal.

**Logs:** IP-adressen in de security- en access-logs blijven staan; die vallen onder
logretentie (nu: logrotate). Dat hoort in de privacyverklaring, niet in de verwijderflow.

## 7. Sweep van eigenaarloze decks zonder subscribers

Gevraagd: 1× per maand. Voorstel: als extra stap in de bestaande **dagelijkse**
`purgeTombstones`-run — zelfde effect (een orphan zonder volgers verdwijnt hoogstens een dag
later in plaats van tot een maand later), geen aparte timer, en de retentiegarantie blijft
op één plek:

```sql
UPDATE decks SET deleted_at = NOW()
WHERE user_id IS NULL AND deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM deck_shares s
                  WHERE s.deck_id = decks.id
                    AND s.revoked_at IS NULL
                    AND s.accepted_at IS NOT NULL);
```

De sweep **tombstonet** dus alleen; de bestaande purge-pipeline hard-delete't het deck
(incl. share- en catalogusrijen, cards via cascade) pas na `TOMBSTONE_RETENTION_DAYS`
(90 d). Zo blijven de gerevokete share-rijen van de laatste ontvolger lang genoeg staan als
`removed_deck_ids`-bron voor diens offline apparaten — dezelfde garantie als elke andere
tombstone. Geen race met vers geörphande decks: die hebben per definitie nog actieve
subscribers.

(Optioneel, pas als de tabel groot wordt: partiële index op
`decks (id) WHERE user_id IS NULL AND deleted_at IS NULL`.)

## 8. Implementatiestatus (2026-07-12)

Gedaan: migratie 020, LEFT JOINs (`ownerJoinSql`, sync, shares), `orphanDecks`-helper
(deckAccess.js), orphan-flow in `DELETE /decks/:id` + bulk-delete, sweep in
`purgeTombstones`, `purgeDeletedAccounts`-job (dagelijks vóór de tombstone-purge),
`DELETE /v2/auth/me` + `POST /v2/auth/me/restore` + `deletion_pending_until` in
login/`GET /me`, bevestigingsmail, security-events
(`account_deletion_requested/denied/cancelled`, `account_purged`), tests
(orphan-decks.test.js, account-deletion.test.js), BACKEND_API.md (beide exemplaren),
frontend-nullsafety voor `owner_username` (copyWith + sync-merge).

Nog open (frontend-UI):

1. Verwijderknop + wachtwoordbevestiging in de app; banner "je account wordt op … gewist"
   (login-response `deletion_pending_until`) met annuleerknop (`POST /auth/me/restore`).
2. Bevestigingsdialoog bij deck-verwijdering met subscribers ("N mensen gebruiken dit
   deck; het blijft voor hen beschikbaar") — de server geeft `orphaned`/`subscribers`
   pas in de response; het aantal vooraf kan uit `GET /shares/overview`.
3. Label "verwijderde gebruiker" bij `owner_username = null` (nu: generieke
   gedeeld-badge als fallback).
4. Privacyverklaring: zin over achterblijvende gedeelde decks en logretentie.

**Kroonjuweel-tests:**

- Na account-delete verwijst geen enkele rij nog naar het oude `user_id`; volgers van een
  geörphand deck houden deck, kaarten, `can_edit` en eigen progress; een editor kan nog
  kaarten schrijven.
- Na deck-orphaning levert `/sync/changes` op een oude `since` van de ex-eigenaar het deck
  in `removed_deck_ids`, en bij volgers juist het deck mét `owner_username = NULL` en
  zónder removal.
- De sweep tombstonet een orphan zonder actieve subscribers en laat een orphan mét
  subscribers staan; na de retentie is het deck met al zijn share-rijen echt weg.
