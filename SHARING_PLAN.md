# Deck-sharing & groepen — fullstack plan

Status: voorstel, nog niets gebouwd. Vervangt de eerdere versie van dit
plan; contacten (migratie 015, `routes/contacts.js`, Contacts-tab) zijn
inmiddels gebouwd en dit plan bouwt daarop voort.

## Samenvatting van het idee

Gebruikers kunnen decks **live** delen — geen kopieën, de ontvanger ziet
altijd de actuele versie van het deck van de eigenaar, read-only, met
volledig eigen voortgang/scores. Delen kan op drie manieren:

1. **Met een contact** — via de bestaande contactenlijst (alleen
   geaccepteerde contacten). Het deck verschijnt direct op het dashboard
   van de ontvanger.
2. **Met een groep** — nieuw. Een groep is een besloten club met een
   join-wachtwoord. Een deck delen met een groep zet het in de
   **groepscatalogus**; elk lid kiest zélf welke catalogus-decks het aan
   zijn dashboard toevoegt (opt-in, zoals "volgen" bij publieke decks).
3. **Publiek** — `is_public` maakt het deck vindbaar in een publieke
   bibliotheek; iedereen kan het "volgen".

**Groepen** in het kort:

- Iedereen kan groepen aanmaken; de maker is owner.
- Lid worden kan op twee manieren: (a) zelf joinen met de groepscode +
  het join-wachtwoord dat de owner uitdeelt, of (b) uitgenodigd worden
  door een lid — de uitgenodigde (moet een contact van de uitnodiger
  zijn) krijgt een aanvraag die hij accepteert of afwijst.
- De owner kan het join-wachtwoord wijzigen en leden eruit gooien (UI
  adviseert dan meteen het wachtwoord te wijzigen, anders joint het
  ex-lid gewoon opnieuw).
- In de groep zijn alleen **usernames** zichtbaar, nooit e-mailadressen.
- Per lid instelbare bevoegdheid: eigen decks aan de groep mogen
  toevoegen. Eigen toegevoegde decks mag je altijd weer weghalen; de
  owner mag elk deck uit de groep halen.
- Bewerken van andermans (groeps)decks blijft in deze versie **uit
  scope** — alles is read-only voor niet-eigenaren (zie Open keuzes).

**Frontend**: de Contacts-tab bestaat al (pending = "niet geverifieerd",
accepted = "geverifieerd"). Er komt een **Groups-tab** bij
(groepenlijst → ledenlijst → lid-detail; smal = overlays, breed = naast
elkaar). Op het dashboard krijgt de FAB-rij bij deck-selectie een
**deel-icoon**: een zoek-/sorteerbare lijst van contacten én groepen
(alleen voor eigen decks). Contact- en groependata leven in **Hive**
(lokale source of truth), bijgewerkt via WS-events — buiten de
deck/card-sync-delta om, zoals contacten nu al werken.

---

## Kernbeslissingen

1. **Live delen, geen kopieën.** Kopieën divergeren — een fix in een
   kaart moet dan overal apart. De ontvanger ziet hetzelfde deck en
   dezelfde kaarten als de eigenaar, read-only, via de bestaande
   sync/WS-mechaniek. Voortgang is al `(user_id, card_id)`-gekeyed in
   `user_card_progress`, dus scores/due-dates van ontvanger en eigenaar
   staan volledig los van elkaar. **Dit maakt live delen haalbaar zonder
   datamodel-verbouwing.**
2. **Eén toegangswaarheid: `deck_shares`.** Een rij = toegang, ongeacht
   de bron (contact-share, groepscatalogus, publiek volgen). Alle
   toegangschecks, sync- en WS-wijzigingen hoeven dus maar één tabel te
   kennen. Groepslidmaatschap geeft *zelf* géén deck-toegang — pas het
   "toevoegen" van een catalogus-deck maakt een share-rij aan. Daardoor
   blijft join/leave/kick goedkoop en is er geen fan-out bij delen met
   een grote groep.
3. **Delen met personen loopt via contacten, niet via e-mail.** De
   eerdere versie deelde op e-mailadres met anti-enumeratie-gedoe. Nu
   contacten bestaan is dat overbodig: je deelt met een geaccepteerd
   contact (`recipient_id` bekend, wederzijds bevestigd). Simpeler,
   privacyvriendelijker, en de deel-UI is gewoon je contactenlijst.
4. **Groepen zijn online-only Hive-data, net als contacten.** Geen
   soft-delete/watermerk in de sync-delta; de client leest
   `GET /v2/groups` en verwerkt WS-events. Alleen de *decks* die een lid
   toevoegt lopen via het normale share/sync-pad.

Rollen op een deck: **owner** (alles) vs **recipient** (lezen + eigen
progress + eigen archiefvlag; géén writes op deck of kaarten).

---

## Fase 1 — Backend: schema

Migraties 014 en 015 bestaan al (core_only, contacts) — sharing wordt
**016**, groepen **017**. Beide idempotent, als `postgres` draaien, met
`GRANT`-regels voor app-rol `goldfish` (zelfde les als migratie 015) en
registratie in `schema_migrations`.

### Migratie `016_deck_sharing.sql`

```sql
CREATE TABLE IF NOT EXISTS deck_shares (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id      UUID NOT NULL REFERENCES decks(id),
  owner_id     UUID NOT NULL REFERENCES users(id),
  recipient_id UUID NOT NULL REFERENCES users(id),
  -- 'invited'    = door eigenaar met een contact gedeeld
  -- 'subscribed' = zelf gevolgd (publiek deck)
  -- 'group'      = zelf toegevoegd uit een groepscatalogus (group_id gezet)
  kind         TEXT NOT NULL DEFAULT 'invited'
               CHECK (kind IN ('invited', 'subscribed', 'group')),
  group_id     UUID,            -- FK naar groups komt in migratie 017
  -- archiefvlag van de ONTVANGER (deck-kolom `inactive` blijft van de eigenaar)
  inactive     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ,
  CHECK ((kind = 'group') = (group_id IS NOT NULL))
);

-- Uniek per bron: één directe/publieke share per (deck, ontvanger) en
-- één groepsshare per (deck, ontvanger, groep). Zo kan hetzelfde deck
-- iemand via een contact-share ÉN via een groep bereiken zonder dat een
-- groeps-revoke de directe share sloopt.
CREATE UNIQUE INDEX IF NOT EXISTS deck_shares_direct_uniq
  ON deck_shares (deck_id, recipient_id) WHERE group_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS deck_shares_group_uniq
  ON deck_shares (deck_id, recipient_id, group_id) WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deck_shares_recipient
  ON deck_shares (recipient_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deck_shares_deck
  ON deck_shares (deck_id) WHERE revoked_at IS NULL;
-- Sync-watermarks (nieuwe shares én revokes moeten in de delta vallen):
CREATE INDEX IF NOT EXISTS idx_deck_shares_recipient_updated
  ON deck_shares (recipient_id, updated_at);
-- Publieke discovery:
CREATE INDEX IF NOT EXISTS idx_decks_public
  ON decks (created_at DESC) WHERE is_public = true AND deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON deck_shares TO goldfish;
```

`updated_at` bijhouden via de bestaande `set_updated_at()`-trigger-
functie (één `CREATE TRIGGER … BEFORE UPDATE ON deck_shares`).
Her-delen/her-toevoegen na revoke = upsert (`revoked_at = NULL`,
`updated_at = NOW()`).

### Migratie `017_groups.sql`

```sql
CREATE TABLE IF NOT EXISTS groups (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT,
  -- korte, unieke, deelbare code (identificatie); wachtwoord is het geheim
  join_code          TEXT NOT NULL UNIQUE,       -- bv. 8 tekens A-Z2-9
  join_password_hash TEXT NOT NULL,              -- argon2, zoals users.password
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'member')),
  -- uitnodiging (via contact) begint als 'invited'; join met code+pw = direct 'active'
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('invited', 'active')),
  -- bevoegdheid: eigen decks aan de groepscatalogus toevoegen
  can_add_decks BOOLEAN NOT NULL DEFAULT true,
  invited_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id);

-- De catalogus: welke decks zijn met de groep gedeeld.
CREATE TABLE IF NOT EXISTS group_decks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  deck_id    UUID NOT NULL REFERENCES decks(id),
  added_by   UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, deck_id)
);
CREATE INDEX IF NOT EXISTS group_decks_deck_idx ON group_decks (deck_id);

ALTER TABLE deck_shares
  ADD CONSTRAINT deck_shares_group_fk
  FOREIGN KEY (group_id) REFERENCES groups(id);   -- idempotent verpakken

GRANT SELECT, INSERT, UPDATE, DELETE ON groups, group_members, group_decks TO goldfish;
```

Hard-delete-semantiek (zoals contacten): leden, invites en catalogus-
rijen worden hard verwijderd; alleen `deck_shares` kent `revoked_at`
omdat de sync-delta dat nodig heeft. `groups`/`group_members` krijgen de
`set_updated_at()`-trigger voor nette `updated_at`.

## Fase 2 — Backend: toegangslaag

### Toegangshelper (`utils/deckAccess.js`)

Eén herbruikbaar SQL-fragment + JS-helper, zodat de ~20 querywijzigingen
uniform zijn:

```sql
-- leestoegang:
(d.user_id = $me OR EXISTS (
   SELECT 1 FROM deck_shares s
   WHERE s.deck_id = d.id AND s.recipient_id = $me AND s.revoked_at IS NULL))
```

- **Read-paden** krijgen deze check: `GET /decks`, `GET /decks/:id`,
  `GET /cards` (deck-join), `GET /cards/:id`, alle `/review/*`-reads,
  `POST /stats/update` (deck-check), `/stats/decks`, `/sync/changes`.
- **Eigen-progress-paden** (recipient mag dit op een gedeeld deck) — let
  op: deze hebben nú een owner-guard die met **403** afwijst, niet 404,
  en moeten expliciet verruimd worden naar de toegangshelper:
  - `POST /review/progress` — de `ownerCheck` (`d.user_id = $2`,
    review.js ~r283) verruimen naar "toegang tot het deck". De
    progress-write zelf is al `user_id`-gescoped.
  - `DELETE /review/progress/:card_id` (reset) — de
    `user_id !== req.user.id`-check (review.js ~r381) idem verruimen.
- **Write-paden blijven owner-only**, maar de owner-check gaat door een
  `canWrite`-fragment in dezelfde helper (betekent in v1 gewoon
  `d.user_id = $me`, zelfde 404-gedrag). Zo hoeft Release C
  (schrijfrechten voor groepsleden) alleen dat ene fragment te
  verruimen, niet ~10 losse queries: `PUT/DELETE /decks/:id`,
  `bulk-delete`, `POST/PUT/DELETE /cards`, `cards/bulk*`.
- Deck-reads krijgen extra velden: `role: "owner" | "recipient"`,
  `owner_username` én `can_edit` (boolean; in v1 altijd `role ==
  "owner"`). De client stuurt zijn UI en write-guards op **`can_edit`**,
  niet op `role` — `role`/`owner_username` zijn puur weergave. Daardoor
  kan Release C bewerkrechten aanzetten zonder dat A-era clients het
  verkeerd interpreteren.
- Voor recipients wordt `inactive` in deck-responses vervangen door de
  waarde van hún share-rij (`COALESCE` over de join). Heeft iemand
  meerdere share-rijen op één deck (contact + groep), pak dan
  `bool_and`/de directe rij — kleinigheid, wel vastleggen in de query.

## Fase 3 — Backend: share-routes (`routes/shares.js`)

Alles 🔒 auth, UUID-checks zoals `contacts.js`, rate limits op de
duurdere endpoints (`express-rate-limit` is er al).

- **`POST /decks/:id/share`** — body `{ recipient_id }`. Owner-only.
  Guard: recipient moet een **geaccepteerd contact** zijn (één EXISTS op
  `contacts … status='accepted'`), anders 403 `not_a_contact`. Upsert op
  de directe rij (`kind='invited'`, `revoked_at=NULL`). WS
  `share_received` naar de ontvanger. Bulk vanuit de FAB-flow = de
  client roept dit per deck × doel aan (aantallen zijn klein; geen apart
  bulk-endpoint nodig).
- **`DELETE /decks/:id/share/:recipient_id`** — owner trekt de directe
  share in (`revoked_at = NOW()`), + soft-delete van de progress-rijen
  van díe recipient op dit deck **mits** er geen andere actieve
  share-rij (groep) meer is. WS `deck_removed` naar de recipient.
- **`GET /shares/sent`** — owner: per deck de recipients (username, geen
  e-mail) om te kunnen intrekken.
- **`GET /decks/public`** — discovery, gepagineerd:
  `?search=&limit=&offset=` → `[{ id, title, description, tags,
  card_count, owner_username, created_at }]`. **Routevolgorde:** vóór
  `GET /decks/:id` registreren.
- **`POST /decks/:id/follow`** / **`DELETE /decks/:id/follow`** —
  publiek deck volgen/ontvolgen (`kind='subscribed'`). Follow alleen als
  `is_public` en niet soft-deleted → anders 404. Unfollow geldt ook voor
  'invited': een ontvanger mag altijd zelf afhaken. Zelfde
  progress-cascade als revoke (alleen als het de láátste actieve share
  op het deck was).
- **`PUT /decks/:id/share-state`** — recipient zet zijn eigen
  `inactive`-vlag (het enige dat een recipient "schrijft").
- **Eigenaar zet `is_public` uit**: bestaand `PUT /decks/:id`; bestaande
  volgers houden toegang (default, zie Open keuzes).

## Fase 4 — Backend: groepen-routes (`routes/groups.js`)

Patroon van `contacts.js` volgen (transacties, perspectief-objecten,
WS-broadcasts naar alle betrokkenen). E-mailadressen komen **nooit** in
group-responses — alleen `user_id` + `username`.

### Groepsbeheer

- **`POST /groups`** — body `{ name, password }`. Genereert unieke
  `join_code` (8 tekens uit A-Z/2-9, retry bij botsing), hasht het
  wachtwoord met argon2 (zelfde util-pad als auth). Maker krijgt
  member-rij `role='owner'`. Response bevat `join_code` (het wachtwoord
  uiteraard nooit).
- **`GET /groups`** — al mijn groepen (owner + lid + openstaande
  invites), inclusief ledenlijst (`user_id, username, role, status,
  can_add_decks`) en catalogus-samenvatting. Eén endpoint dat de hele
  Hive-box kan vullen, zoals `GET /contacts`.
- **`PUT /groups/:id`** — owner: `name`/`description`.
- **`PUT /groups/:id/password`** — owner: nieuw join-wachtwoord
  (argon2). Response bevat desgewenst een verse `join_code` als we die
  ook laten rouleren (zie Open keuzes).
- **`DELETE /groups/:id`** — owner. Revoket alle `deck_shares` met dit
  `group_id` (+ progress-cascade waar het de laatste share was), hard-
  delete van de groep (cascade ruimt members/catalogus op). WS
  `group_deleted` naar alle leden.

### Lidmaatschap

- **`POST /groups/join`** — body `{ code, password }`. Zwaar
  rate-limiten (zoals login) + argon2-verify; bij succes member-rij
  `status='active'`. 404 bij onbekende code én bij fout wachtwoord
  (geen onderscheid lekken). WS `group_member_joined` naar de leden,
  `group_joined` (volledige groep) naar de joiner zelf.
- **`POST /groups/:id/invites`** — body `{ user_id }`. Uitnodiger moet
  actief lid zijn én het doelwit moet een geaccepteerd contact van hem
  zijn. Maakt member-rij `status='invited'`, WS `group_invite_received`
  naar het doelwit.
- **`POST /groups/:id/invites/accept`** / **`DELETE
  /groups/:id/invites`** — de uitgenodigde accepteert (→ `active`, WS
  `group_member_joined`) of wijst af (hard delete, WS naar uitnodiger).
- **`DELETE /groups/:id/members/:user_id`** — owner kickt een lid, of
  een lid verlaat zelf de groep (`:user_id` = ikzelf). Gevolgen: (a)
  member-rij weg, (b) zijn `deck_shares kind='group'` op deze groep
  gerevoket + progress-cascade, (c) catalogus-rijen die híj toevoegde
  blijven staan? Nee — **zijn toegevoegde decks gaan mee de groep uit**
  (het zijn zijn decks; de shares van andere leden daarop worden ook
  gerevoket). WS `group_member_left` + `deck_removed` waar relevant.
  Response/UI bij kick herinnert de owner aan wachtwoord wijzigen.
- **`PUT /groups/:id/members/:user_id`** — owner zet bevoegdheden
  (`can_add_decks`). WS `group_member_updated`.

### Catalogus

- **`POST /groups/:id/decks`** — body `{ deck_id }`. Vereist: actief
  lid, `can_add_decks`, én eigenaar van het deck. Rij in `group_decks`,
  WS `group_deck_added` naar alle leden (met `title`, `card_count`,
  `added_by_username`).
- **`DELETE /groups/:id/decks/:deck_id`** — toegestaan voor de
  toevoeger (eigen deck terugtrekken) en de group-owner. Revoket alle
  `deck_shares` van groepsleden op dit deck (`group_id`-match) +
  progress-cascade. WS `group_deck_removed`.
- **`GET /groups/:id/decks`** — catalogus voor de ledenlijst-UI:
  `[{ deck_id, title, description, card_count, added_by_username,
  added_at, already_added }]` (`already_added` = heb ík al een actieve
  share-rij).
- **`POST /groups/:id/decks/:deck_id/add`** — lid voegt een
  catalogus-deck aan zijn dashboard toe: upsert share-rij
  (`kind='group'`, `group_id`, recipient = ikzelf). Deck verschijnt
  daarna via de normale sync. Weghalen = bestaand
  `DELETE /decks/:id/follow`-pad (werkt op elke eigen share-rij).

### WS-helper

Naast `broadcast(userId, …)` komen er twee fan-outs in `ws.js`:

- `broadcastDeck(deckId, event, payload)` — owner + actieve recipients
  (één indexed query op `deck_shares`). Voor `card_created/updated/
  deleted`, `deck_updated`, `deck_deleted`.
- `broadcastGroup(groupId, event, payload)` — alle actieve leden (één
  query op `group_members`). Voor alle `group_*`-events hierboven.

`deck_created` en progress-/stats-events blijven per-user.

## Fase 5 — Backend: sync-delta (het echte werk)

### `/sync/changes`

1. **Decks-query**: naast eigen decks ook decks met een actieve
   share-rij (`JOIN deck_shares`), inclusief soft-deleted bron-decks
   (tombstone moet bij de recipient aankomen). De per-deck
   core-subqueries werken al op `ucp.user_id = $me` en blijven kloppen.
2. **Nieuw-gedeeld venster**: een vandaag gedeeld deck heeft een oude
   `updated_at` en valt buiten `updated_at > since`. Daarom: is
   `share.updated_at > since` (nieuwe share óf re-share), stuur dan het
   deck **en al zijn kaarten** integraal mee. (Dubbel geleverde rijen
   zijn onschadelijk; client-upsert is idempotent.)
3. **Toegang verloren**: revoke/ontvolgen/kick laat geen tombstone
   achter — het deck bestaat nog. Response krijgt
   `removed_deck_ids: [...]` uit `deck_shares WHERE recipient_id = $me
   AND revoked_at > $since` (alleen ids waarvoor géén andere actieve
   share meer bestaat). Client ruimt deck + kaarten + progress op. Bij
   `full_resync` gratis: de client herbouwt toch alles.

Cards-query: van "decks die ik bezit" naar "decks waar ik toegang toe
heb" (toegangshelper). Groepsdata zelf zit **niet** in de delta
(online-only, zie kernbeslissing 4).

Tombstone-purge (`purgeTombstones.js`): purge-horizon ≥ resync-horizon
blijft gelden; share-rijen worden niet gepurged (klein, laten staan).

### Ongemoeid

- `DELETE /decks/:id`-cascade soft-delete't `user_card_progress` al
  zonder user-filter — dekt recipients ✓.
- Reviewlogica, scores, due-dates: per-user progress, geen wijziging.
- Contacts-routes: ongewijzigd; alleen de share-guard leest de tabel.

### Tests (`test/`)

- Toegang: recipient kan deck/cards/review lezen, progress schrijven én
  resetten; recipient krijgt 404 op deck/card-writes; niet-gedeelde
  user 403/404 overal, óók op `/review/progress`.
- Shares: happy paths; delen met niet-contact → 403; upsert na revoke;
  follow op niet-publiek deck 404; dubbele bron (contact + groep) →
  revoke van één bron behoudt toegang en progress.
- Groepen: join met goede/foute code/pw (+ rate limit); invite vereist
  contact-relatie; kick revoket shares en progress; leden-privacy (geen
  e-mail in enige group-response); `can_add_decks`-guard; deck van
  vertrekkend lid verdwijnt uit catalogus én bij alle leden;
  group-delete ruimt alles op.
- Sync: nieuw-gedeeld oud deck komt integraal mee; revoke →
  `removed_deck_ids`; owner-delete → tombstone bij recipient.
- WS: `card_updated` bereikt recipient; `group_deck_added` bereikt alle
  leden; `deck_removed` bij kick.
- Routevolgorde `/decks/public` vs `/decks/:id`.

### Documentatie

- `BACKEND_API.md` in **beide** repo's bijwerken (vaste regel): alle
  nieuwe routes, `role`/`owner_username`, `removed_deck_ids`, alle
  nieuwe WS-eventtypen.
- `migrations/README.md`: regels voor 016 en 017.

---

## Fase 6 — Frontend (Flutter, `/mnt/c/programming/goldfish/goldfish_v1`)

### Model & data (Hive is lokale source of truth)

- `models/deck.dart`: velden `role` (owner/recipient), `ownerUsername`,
  `isPublic` én `canEdit` (+ Hive-velden met defaults, `deck.g.dart`
  regenereren). **Alle** bewerk-guards (editor, FAB-acties, write-queue)
  sturen op `canEdit`, nooit op `role` — zie fase 2.
- Nieuw `models/group.dart` (+ `group.g.dart`): `id, name, description,
  joinCode, myRole, myCanAddDecks, members[] (userId, username, role,
  status, canAddDecks), decks[] (catalogus-items incl. alreadyAdded)`.
  Eigen Hive-box `groups` in `hive_service.dart` (registreren in
  `hive_registrar.g.dart`, clearen bij logout zoals `contacts`).
- Vulstrategie zoals contacten: bij connect/refresh `GET /v2/groups` →
  box vervangen; daarna muteren WS-events de box. Hive is wat de UI
  leest; de backend is alleen de bron van wijzigingen.
- `realtime_sync_service.dart`: handlers voor `share_received`
  (snackbar "X deelde een deck met je" + refresh), `deck_removed`
  (lokaal deck+cards+progress opruimen) en alle `group_*`-events
  (box-mutaties + evt. snackbar bij invite).
- `sync_service.dart`: `removed_deck_ids` afhandelen (zelfde pad als
  deck-tombstone).
- Nieuw `repositories/share_repository.dart`: `shareDeck(deckId,
  recipientId)`, `revokeShare`, `fetchSentShares`, `fetchPublicDecks`,
  `follow/unfollow`, `setSharedInactive`.
- Nieuw `repositories/group_repository.dart`: alle group-endpoints.
- Nieuw `providers/group_provider.dart` naar het model van
  `contact_provider.dart`.

### Read-only afdwingen (recipient-decks)

- `deck_editor_screen.dart` + `card_input_panel.dart`: niet openen /
  read-only weergave voor `canEdit == false`.
- `deck_settings_dialog.dart`: recipients zien alleen eigen archiefvlag
  (`PUT /decks/:id/share-state`) en "Verwijderen van dashboard"
  (unfollow).
- Dashboard (`deck_card.dart`, `selection_model.dart`, bulk-acties):
  "Verwijderen" wordt "Verwijderen van dashboard" voor recipient-decks;
  badge/avatar met `ownerUsername` op de deck-kaart.
- `write_queue_service.dart` / `flush_handler.dart`: guard — geen
  deck/card-mutaties enqueuen voor recipient-decks (offline
  randgevallen). Progress-writes wél toestaan.

### Deel-flow vanaf het dashboard (FAB-rij)

- Bij deck-selectie verschijnt een **deel-icoon** in de FAB-rij, alleen
  actief als álle geselecteerde decks eigen decks zijn (anders disabled
  met tooltip).
- Tik → bottom sheet / dialoog met twee secties, **zoekbaar en
  sorteerbaar** (naam / recent): geaccepteerde **contacten** en mijn
  **groepen** (alleen groepen waar ik decks aan mag toevoegen). Multi-
  select doelwitten → "Delen" doet per deck × doel de betreffende call
  (`POST /decks/:id/share` of `POST /groups/:id/decks`), met nette
  per-item foutafhandeling (bv. deck zat al in de groep → overslaan).

### Contacts-tab (bestaat al — kleine aanscherping)

- Secties "In afwachting" (pending_incoming bovenaan met
  accepteer/weiger-knoppen, pending_outgoing met annuleren) en
  "Contacten" (accepted). De incoming-aanvraag ís het "bericht of ze
  jou als contact willen accepteren" — al gedekt door WS
  `contact_invited` + de tab; eventueel alleen een badge op het
  tab-icoon toevoegen bij openstaande aanvragen.

### Groups-tab (nieuw, `lib/screens/groups/`)

- Vervangt de `PlaceholderTab` in `app_shell.dart` (IndexedStack).
- **Groepenlijst** (`groups_screen.dart`): secties "Mijn groepen"
  (owner) en "Lidmaatschappen"; openstaande group-invites bovenaan met
  accepteer/weiger. Acties: groep aanmaken (naam + wachtwoord; toont
  daarna de join-code om te delen), joinen (code + wachtwoord).
- **Ledenlijst/groepsdetail** (`group_detail_panel.dart`): leden
  (username, rol, status) + de deck-catalogus met per deck een
  "Toevoegen"-knop (of "Toegevoegd ✓"). Owner-acties: wachtwoord
  wijzigen, contact uitnodigen (picker uit geaccepteerde contacten),
  groep verwijderen. Lid-acties: eigen deck toevoegen (indien
  bevoegd), groep verlaten.
- **Lid-detail** (`member_detail_panel.dart`): username, rol,
  bevoegdheden-switches (alleen owner kan schakelen), "Verwijderen uit
  groep" (owner; toont hint "wijzig ook het wachtwoord").
- **Responsief**: smal = lijst met overlays (ledenlijst als overlay op
  de groepenlijst, lid-detail als overlay daarop); breed = drie panelen
  naast elkaar (lijst | detail | lid). Zelfde breakpoint-aanpak als de
  bestaande dashboard/review-layouts.

### Publieke bibliotheek

- Nieuw scherm (route in `app_router.dart`): zoekveld + gepagineerde
  lijst uit `GET /decks/public`, per deck "Volgen". Gevolgde/gedeelde/
  toegevoegde decks verschijnen daarna vanzelf op het dashboard via de
  normale sync — geen aparte "gedeeld met mij"-lijst nodig, hooguit een
  filter/badge.

---

## Fase 7 — Deploy

1. Lokaal: migraties 016 + 017 via `sudo -u postgres psql` (memory
   `project_db_access.md` eerst volledig lezen), volledige testsuite.
2. Remote: **eerst memory `project_remote_deploy.md` volledig lezen**;
   migraties draaien, code deployen, pm2 `goldfish-backend` herstarten.
3. Client-release. Nieuwe endpoints zijn additief; oude clients negeren
   `removed_deck_ids` en de nieuwe WS-events stilzwijgend — maar een
   oude client die een recipient-deck lokaal "bewerkt" krijgt 404's uit
   de queue. Default: `min_client_build`-bump bij release van de
   share-UI.

## Volgorde van bouwen

Sharing en groepen zijn gescheiden te bouwen en releasen:

1. **Release A — delen met contacten + publiek** (migratie 016, fases
   2/3/5, frontend zonder Groups-tab). Volledig bruikbaar zonder
   groepen.
2. **Release B — groepen** (migratie 017, fase 4, Groups-tab +
   groepssectie in de deel-flow). Bouwt alleen op de al bestaande
   `deck_shares`-mechaniek; sync/WS-fundament is er dan al.
3. **Release C — schrijfrechten voor groepsleden** (later, optioneel).
   Volledig additief op A/B dankzij twee voorbereidingen die al in A
   zitten (`can_edit`-vlag in het API-contract, `canWrite`-fragment in
   de toegangshelper). Schets:
   - Migratie: `ALTER TABLE group_members ADD COLUMN can_edit_decks
     BOOLEAN NOT NULL DEFAULT false` (additief).
   - `canWrite`-fragment verruimen: owner ÓF actief groepslid met
     `can_edit_decks` op een deck dat in díe groepscatalogus zit.
   - **Stale-write-guard i.p.v. conflictmodel**: `PUT /cards/:id`
     accepteert optioneel `expected_updated_at`; is de serverrij
     nieuwer → 409, client toont "kaart is intussen gewijzigd door X".
     Binnen één account blijft LWW gelden (geen `expected_updated_at`
     meesturen = oud gedrag).
   - **Deletes blijven bij de deck-eigenaar** — een edit-lid mag
     kaarten/decks niet verwijderen (deletes cascaden naar ieders
     progress; te destructief voor gedeeld beheer).
   - Frontend: 403/409-afhandeling in `flush_handler.dart` (rechten
     kunnen wijzigen terwijl je offline was), bevoegdheden-switch in
     het lid-detailpaneel.

## Buiten scope / later

- **Schrijfrechten voor leden op groepsdecks**: zie Release C hierboven
  — bewust niet in A/B, maar het contract (`can_edit`) en de helper
  liggen er klaar voor. v1 is read-only voor iedereen behalve de
  deck-eigenaar.
- "Dupliceren om te bewerken": expliciete kopieer-actie voor een
  recipient die een deck wíl aanpassen. Optioneel, na de basis.
- E-mailnotificatie bij share/invite, populariteit/ratings op publieke
  decks, publieke profielen, groepschat.

## Open keuzes (default staat erbij)

1. **Join-identificatie**: default = join-code (deelbaar, niet geheim)
   + wachtwoord (geheim). Alternatief: alleen een wachtwoord — dan moet
   dat globaal uniek en raadbaar-veilig zijn; afgeraden.
2. **Join-code rouleren bij wachtwoord-wijziging**: default = nee (code
   is identificatie, geen geheim); wachtwoord wijzigen volstaat na een
   kick.
3. **`is_public` uitzetten**: bestaande volgers houden toegang
   (default) of verliezen die meteen.
4. **Progress bij revoke/ontvolgen/kick**: soft-deleten (default,
   consistent met de delete-cascade) of bewaren voor als de share
   terugkomt. N.B. bij meerdere bronnen (contact + groep) wordt pas
   gecascaded als de láátste actieve share verdwijnt.
5. **Decks van een vertrekkend/gekickt lid**: gaan mee de groep uit
   (default — het zijn zijn decks) of blijven in de catalogus tot de
   owner ze verwijdert.
6. **Direct gedeelde decks (contact-share)**: verschijnen automatisch
   op het dashboard van de ontvanger (default) of vragen eerst om
   acceptatie zoals group-invites. Groepscatalogus is sowieso opt-in.
