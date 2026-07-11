# Edit-rechten op gedeelde decks — plan (Release C, herzien)

Status: **gebouwd op 2026-07-11** (migratie 019, backend + tests +
frontend; lokale migratie gedraaid, remote deploy + `min_client_build`-
bump nog te doen). Vervangt de Release C-schets in SHARING_PLAN.md.
Bouwt voort op Release A+B (migraties 016–018, `routes/shares.js`,
`routes/groups.js`, `utils/deckAccess.js`).

## Requirements (Niels, 2026-07-11)

1. De owner moet per deck kunnen **zien met wie** (personen én groepen)
   het gedeeld is.
2. De owner kan die personen **edit-rechten** geven op het deck —
   **geen delete-rechten**.
3. Ook **groepsleden** kunnen edit-rechten krijgen op decks zelf.
4. **De owner van elk deck bepaalt** wie welke rechten op dát deck
   heeft — niet de groepsowner.
5. **Last-write-wins** op vragen en antwoorden is acceptabel.

Punt 4 is de afwijking van de oude Release C-schets: die legde het
recht als `group_members.can_edit_decks` bij de groep (één vlag voor
al iemands decks in die groep). Nu: **per deck, per persoon, beheerd
door de deck-owner**.

## Kernbeslissingen

1. **Het recht leeft op `deck_shares.can_edit`** (nieuwe kolom,
   default `false`). Eén rij = toegang; dezelfde rij draagt nu ook het
   schrijfrecht. Geen nieuwe tabel, geen fan-out, en het recht
   verdwijnt automatisch mee met een revoke/kick/unfollow — alle
   bestaande opruimpaden (`revokeShares`) blijven correct zonder
   wijziging.
2. **Effectief recht = `bool_or` over iemands actieve, geaccepteerde
   rijen** (contact-share + groepsshare kunnen naast elkaar bestaan,
   zelfde patroon als de effectieve `inactive`). De toggle-route zet
   het recht daarom altijd op ál iemands rijen tegelijk, zoals
   `PUT /decks/:id/share-state` dat voor `inactive` doet.
3. **Edit = volledig kaartbeheer, niets op deck-niveau** (besloten
   2026-07-11): een editor mag kaarten aanmaken, bewerken én
   verwijderen (vraag/antwoord). Owner-only blijven: het deck
   verwijderen én álle deck-velden (titel, omschrijving, tags,
   `is_public`, `inactive`, `core_only` — heel `PUT /decks/:id`),
   bulk-delete, delen/intrekken, groepscatalogus-beheer. N.B. een
   kaart-delete door een editor cascadeert zoals elke kaart-delete
   naar de progress van álle gebruikers op die kaart — geaccepteerd.
4. **LWW blijft het conflictmodel.** Het bestaande
   `client_updated_at` → `409 stale_write` + `current`-mechanisme (met
   rij-lock) werkt ongewijzigd voor meerdere schrijvers; de client
   lost een 409 al op door `current` over te nemen. Geen extra
   conflictmachinerie nodig.
5. **Groepsleden krijgen het recht per persoon**, op hun bestaande
   groepsshare-rij (die ontstaat wanneer een lid het catalogus-deck
   toevoegt). Wie het deck (nog) niet toevoegde heeft geen rij en kan
   dus ook geen recht krijgen — rechten gelden alleen voor wie het
   deck daadwerkelijk heeft. Een groeps-brede toggle kan later
   additief (Open keuzes).

Rollen op een deck worden daarmee: **owner** (alles) · **editor**
(lezen + eigen progress + volledig kaartbeheer) ·
**recipient** (lezen + eigen progress). `role` in het API-contract
blijft `owner|recipient`; `can_edit` onderscheidt editor van kale
recipient — precies waarvoor die vlag in Release A is klaargezet.

---

## Fase 1 — Migratie `019_deck_share_edit.sql`

Idempotent, als `postgres` draaien (memory `project_db_access.md`
eerst volledig lezen), registreren in `schema_migrations`:

```sql
ALTER TABLE deck_shares
  ADD COLUMN IF NOT EXISTS can_edit boolean NOT NULL DEFAULT false;
```

- Geen nieuwe index nodig: de schrijfcheck is een EXISTS op
  `(deck_id, recipient_id)` en `idx_deck_shares_deck` /
  `deck_shares_direct_uniq` dekken dat al.
- GRANT is tabel-breed al geregeld (migratie 016).
- Down-migratie: `ALTER TABLE deck_shares DROP COLUMN IF EXISTS can_edit`.
- `migrations/README.md` bijwerken.

## Fase 2 — Toegangslaag (`utils/deckAccess.js`)

De splitsing die Release A voorbereidde wordt nu echt gemaakt —
"schrijven" valt uiteen in twee niveaus:

- **Nieuw `canEditDeckSql(alias, userParam)`** — owner óf actieve,
  geaccepteerde share-rij met `can_edit`:

  ```sql
  (d.user_id = $me OR EXISTS (
     SELECT 1 FROM deck_shares _s
     WHERE _s.deck_id = d.id AND _s.recipient_id = $me
       AND _s.revoked_at IS NULL AND _s.accepted_at IS NOT NULL
       AND _s.can_edit))
  ```

- **`canWriteDeckSql` hernoemen naar `isDeckOwnerSql`** (zelfde
  fragment, `d.user_id = $me`) zodat elke callsite expliciet zegt wat
  hij bedoelt. Indeling van de bestaande callsites:

  | Callsite | Wordt |
  |---|---|
  | `cards.js` POST /cards, bulk-create, PUT /cards/:id (beide queries) | `canEditDeckSql` |
  | `cards.js` DELETE /cards/:id, bulk-delete | `canEditDeckSql` |
  | `decks.js` PUT /decks/:id | `isDeckOwnerSql` (ongewijzigd gedrag) |
  | `decks.js` DELETE /decks/:id, bulk-delete | `isDeckOwnerSql` |
  | `shares.js` POST share, DELETE share | `isDeckOwnerSql` |
  | `groups.js` catalogus-checks | `isDeckOwnerSql` |

- **`can_edit` in deck-responses wordt overal het echte recht** i.p.v.
  hardcoded `d.user_id = $me`: `deckShareColumnsSql` in
  `deckAccess.js` en de losse kolommen in `sync.js` (~r64) en
  `review.js` (~r427). In de sync-query kan het goedkoop via de
  bestaande LATERAL: `bool_or(s.can_edit)` naast `bool_and(s.inactive)`.
  De `shape`-helper in `decks.js` PUT (~r171) mag `role:'owner'/
  can_edit:true` blíjven hardcoden — dat pad is en blijft owner-only.

## Fase 3 — Routes

Alles 🔒 auth + UUID-checks zoals de bestaande share-routes.

### Nieuw: `GET /shares/overview` — met wie deel ik wat

Owner-perspectief, alles in één response zodat de client er zowel een
totaaloverzicht als een per-deck "Gedeeld met"-paneel mee kan vullen
(online-only, zoals contacts/groups; usernames, nooit e-mail):

```json
[{
  "deck_id": "…", "deck_title": "…", "is_public": true,
  "people": [
    { "user_id": "…", "username": "…", "kind": "invited",
      "pending": false, "can_edit": true,
      "via_groups": ["Groepsnaam"] }
  ],
  "groups": [
    { "group_id": "…", "name": "…",
      "members_with_deck": 3, "member_count": 7 }
  ],
  "follower_count": 12
}]
```

- `people` = gededupliceerd per persoon over al zijn actieve rijen
  (direct + groep), met effectief `can_edit` (`bool_or`) en de
  bron(nen). Volgers (`kind='subscribed'`) tellen alleen mee in
  `follower_count` (Open keuzes #3).
- `groups` komt uit `group_decks` van mijn decks; `members_with_deck`
  = aantal actieve share-rijen met dat `group_id`.
- Implementatie: 2–3 queries (shares+users, group_decks+groups,
  follower-count), groeperen in JS — zelfde stijl als `GET /groups`.
- `GET /shares/sent` blijft bestaan (client gebruikt het al); response
  krijgt er alleen het veld `can_edit` bij.

### Nieuw: `PUT /decks/:id/permissions/:user_id` — recht togglen

Body `{ can_edit: boolean }`. Owner-only (`isDeckOwnerSql`, anders
404).

```sql
UPDATE deck_shares
SET can_edit = $1, updated_at = NOW()
WHERE deck_id = $2 AND recipient_id = $3
  AND revoked_at IS NULL AND kind <> 'subscribed'
RETURNING …
```

- Alle niet-gerevokete rijen tegelijk (direct + groep), zodat het
  effectieve `bool_or` eenduidig blijft. Pending rijen tellen mee: het
  recht gaat dan in bij acceptatie (Open keuzes #4).
- 0 rijen → 404 `share_not_found`.
- De `updated_at`-bump laat het deck in het share-venster van
  `/sync/changes` vallen → de recipient krijgt het deck met de nieuwe
  `can_edit` vanzelf in de eerstvolgende delta. **Geen
  sync-formaatwijziging nodig.**
- WS: nieuw event **`deck_access_changed`** `[{ deck_id, can_edit }]`
  naar de recipient (al zijn devices) voor directe UI-update, plus
  `shares_updated`-hint naar de owner zelf (andere devices verversen
  het overview).

### Aanpassingen aan bestaande routes

- **`PUT /decks/:id`** — **ongewijzigd** (owner-only): alle
  deck-metadata blijft bij de eigenaar.
- **`POST /cards`, bulk-create, `PUT /cards/:id`, `DELETE /cards/:id`,
  bulk-delete** — alleen de guard verruimen naar `canEditDeckSql`;
  LWW/409-pad, de progress-cascade bij delete en de
  `broadcastDeck`-events blijven exact gelijk. Editor-writes en
  -deletes bereiken owner en mede-recipients dus al live.
- **`POST /decks/:id/share`** (upsert) en **`POST /decks/:id/follow`**
  (upsert): bij her-delen/her-volgen ná een revoke `can_edit`
  expliciet op `false` resetten (zelfde CASE-patroon als
  `accepted_at`); bij dubbel delen op een actieve rij blijft het recht
  staan (Open keuzes #5).
- `revokeShares` en alle groeps-/kick-/verlaat-paden: **geen
  wijziging** — recht zit op de rij en gaat mee dood.

## Fase 4 — Frontend (Flutter, `/mnt/c/programming/goldfish/goldfish_v1`)

### 4a. Ontvlechting `canEdit` vs eigenaarschap — **kritiek, eerst doen**

De client gebruikt `canEdit` nu op meerdere plekken als proxy voor
"eigen deck". Zodra de server `can_edit=true` naar een recipient
stuurt, kiezen die paden het verkeerde gedrag:

- `deck_repository.deleteDeck` (~r74): `!canEdit` → unfollow. Een
  editor-recipient zou bij "verwijderen" een echte `delete_deck`
  enqueuen (server 404't, maar lokaal is het deck weg tot resync).
- `deck_repository.updateDeck` (~r112): `!canEdit` → archiefvlag via
  share-state. Een editor-recipient zou zijn archiefvlag via
  `PUT /decks/:id` sturen en zo **de vlag van de owner** raken (server
  weigert dit met de nieuwe 403, maar de flush blijft dan hangen).
- `deck_provider` WS-handler `deck_updated` (~r326): clobber-guard
  voor `inactive` keyt op `!canEdit`.
- `dashboard_screen` (~r600): deel-FAB "allOwn" keyt op `canEdit`.
- `group_detail_panel` (~r105): "eigen deck aan catalogus toevoegen"
  keyt op `canEdit`.
- `deck_card` (~r94): gedeeld-badge keyt op `!canEdit`.

**Fix:** `role` toevoegen aan `models/deck.dart` (server stuurt het al
in élke deck-response en in de sync-delta; Hive-veld met default
afgeleid uit `canEdit` voor bestaande rijen, `deck.g.dart`
regenereren, `isOwner`-getter). Alle zes bovenstaande plekken sturen
voortaan op `isOwner`; **alleen de kaart-guards** (deck-editor,
`card_repository`, write-queue voor card-create/-update/-delete)
blijven op `canEdit`. Deck-metadata-bewerking en deck-delete keyen op
`isOwner`.

### 4b. "Gedeeld met"-paneel (owner)

- Ingang: deck-instellingen (`deck_settings_dialog`) en/of het
  deel-sheet — knop "Gedeeld met…" op eigen decks.
- Data: `GET /shares/overview` (nieuw
  `repositories/share_repository`-call; online-only, niet in Hive of
  in een simpele memory-cache zoals het overview kort leeft).
- UI per deck: sectie **Personen** (username, pending-badge,
  bron-chip "via groep X", **edit-switch** → `PUT
  /decks/:id/permissions/:user_id`, intrek-knop → bestaand
  `DELETE /decks/:id/share/:recipient_id`), sectie **Groepen** (naam,
  "3 van 7 leden hebben dit deck"; beheer loopt via de Groups-tab),
  regel **Volgers** (alleen aantal).
- Eventueel later: totaaloverzicht "Alles wat ik deel" als apart
  scherm — zelfde endpoint, buiten scope voor nu.

### 4c. Editor-ervaring (recipient met `can_edit`)

- Werkt grotendeels vanzelf zodra `canEdit=true` binnenkomt: editor
  opent, kaarten toevoegen/bewerken/verwijderen enqueuet gewoon
  (guards keyen al op `canEdit`), 409-afhandeling bestaat.
- WS-handler voor `deck_access_changed` in
  `realtime_sync_service.dart`: `canEdit` in de Hive-deck bijwerken +
  snackbar ("Je kunt 'X' nu bewerken" / "Bewerken van 'X' is
  uitgezet").
- `flush_handler`/`write_queue_service`: 403/404 op een card-write
  van een niet-meer-editor (recht offline ingetrokken) → stil laten
  vallen + deck-resync triggeren, niet eindeloos retryen.
  (Controleren wat het huidige 404-gedrag met queue-items doet; zo
  nodig hier verbreden.)
- `deck_settings_dialog`: voor een editor-recipient identiek aan een
  kale recipient — eigen archiefvlag (share-state) + "Verwijderen van
  dashboard" (unfollow); deck-metadata is en blijft owner-only.

### 4d. Compatibiliteit

**`min_client_build`-bump is verplicht** bij deze release: oude
clients gebruiken `canEdit` als eigenaarschap-proxy (zie 4a) en gaan
bij `can_edit=true` verkeerde writes enqueuen. Server-side kan er
niets destructiefs gebeuren (alle owner-only guards zitten in SQL),
maar de UX breekt. Volgorde: backend deployen (rechten staan overal
nog `false`), client releasen, bump zetten — pas daarna is togglen
zichtbaar veilig voor iedereen.

## Fase 5 — Tests (`test/`)

- **Permissions-route**: owner-only (recipient/derde → 404); toggle
  zet álle rijen (direct + groep) tegelijk; pending rij krijgbaar;
  `subscribed`-only → 404; 0 rijen → 404.
- **Schrijfrechten**: editor kan card create/update/delete (incl.
  bulk-create) en de delete cascadeert naar ieders progress; editor
  krijgt 404 op PUT /decks, deck-delete, bulk-delete en share-beheer;
  kale recipient blijft overal read-only (regressie); pending share
  met `can_edit=true` geeft nog géén schrijfrecht.
- **Levenscyclus**: revoke van de laatste rij → recht weg; her-delen
  na revoke → `can_edit` gereset naar false; direct-rij gerevoket
  terwijl groepsrij `can_edit=true` heeft → recht blijft (bool_or);
  kick uit groep → recht weg.
- **LWW/409**: twee editors, oudere `client_updated_at` → 409 met
  correcte `current`-shape (echte `role`/`can_edit` van de schrijver).
- **Sync**: toggle → deck in de delta met nieuwe `can_edit`.
- **WS**: editor-edit (`card_updated`) bereikt owner én andere
  recipient; `deck_access_changed` bereikt de recipient.
- **Overview**: personen gededupliceerd met effectief recht +
  bronnen; groepen met tellingen; volgers alleen als aantal; geen
  e-mailadressen in de response.

## Fase 6 — Documentatie & deploy

1. `BACKEND_API.md` in **beide** repo's (vaste regel): migratie 019,
   `GET /shares/overview`, `PUT /decks/:id/permissions/:user_id`,
   `can_edit`-semantiek (nu écht recht i.p.v. owner-synoniem: volledig
   kaartbeheer, geen deck-writes), WS-event `deck_access_changed`,
   `can_edit` in `/shares/sent`.
2. Lokaal: migratie via `sudo -u postgres psql` (memory
   `project_db_access.md` eerst volledig lezen), volledige testsuite.
3. Remote: **eerst memory `project_remote_deploy.md` volledig
   lezen**; migratie, deploy, pm2-restart.
4. Client-release + `min_client_build`-bump (zie 4d).

## Besloten (2026-07-11)

- **Kaart-deletes voor editors: ja** — edit-recht = volledig
  kaartbeheer (create/update/delete). Alleen het déck verwijderen
  blijft owner-only.
- **Deck-metadata (titel/omschrijving/tags e.d.): alleen de eigenaar**
  — `PUT /decks/:id` blijft volledig owner-only.

## Open keuzes (default staat erbij)

1. **Edit-recht voor publieke volgers** (`kind='subscribed'`):
   default **nee** — vreemden krijgen geen schrijfrecht; edit alleen
   via contact-share of groep.
2. **Recht instelbaar op een pending uitnodiging**: default **ja**
   (gaat in zodra de ontvanger accepteert); schrijven kan pas na
   acceptatie hoe dan ook niet.
3. **`can_edit` bij her-delen na revoke**: default **reset naar
   false** (intrekken = vertrouwen intrekken); bij dubbel delen op een
   actieve rij blijft het recht staan.
4. **Groeps-brede toggle** ("iedereen in groep G mag dit deck
   bewerken", kolom op `group_decks`, OR'en in `canEditDeckSql`):
   default **niet nu** — per persoon dekt de vraag en blijft expliciet
   ("de owner bepaalt wie"); groepsbreed kan later volledig additief.
