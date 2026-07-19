# Plan: examens (exam-aware scheduling)

> **Status 2026-07-19: plan, nog niet geïmplementeerd.** Vervangt de oudere
> Feature-3-schets in PRO_FEATURES_PLAN.md waar ze verschillen (dit plan:
> hive-first snapshot-sync, hard-delete, groepsexamens; migratienummer is
> inmiddels 024, niet 023). De `readiness`-gedachte uit dat plan komt hier
> terug via `longest_in_streak_hours` (§5).

## Doel

Een **examen** is een benoemde deadline met een set decks eraan: naam,
examendatum, en de decks waarvan de vragen op het examen getoetst worden. Een
examen hoort bij een **user** (persoonlijk) óf bij een **groep** (zichtbaar
voor alle actieve leden). De client moet per kaart goedkoop kunnen bepalen:
*is dit een examenvraag, en zo ja wat is de eerstvolgende examendatum?* — want
daarop past de (client-side) scheduler het vervalalgoritme aan. Het geheel
moet **hive-first** zijn: examens staan lokaal in Hive en zijn offline
bruikbaar; de server is de sync-bron.

## Vastgelegde ontwerpkeuzes

1. **Scheduling blijft client-side.** De backend slaat alleen de examens op en
   synct ze; het vervalalgoritme (interval-cap richting examendatum) leeft in
   de Flutter-scheduler, net als de rest van de SRS (zie
   HOURLY_SRS_V3_PLAN.md). De backend hoeft `/review/*` dus **niet** aan te
   passen: `due_date` die de client upload is al exam-aware.
2. **"Is dit een examenvraag?" loopt via het deck.** Kaart → `deck_id` →
   staat dat deck in een examen met `exam_date` in de toekomst? De client
   bouwt uit de Hive-box één map `deck_id → eerstvolgende exam_date` (kaart in
   meerdere examens: vroegste toekomstige datum wint). Geen per-kaart
   koppeling nodig; dat houdt het model klein en de lookup O(1).
3. **`exam_date` is een `timestamptz`, mét tijdstip (besluit Niels
   2026-07-19).** Consistent met migratie 021 en de uur-granulariteit van SRS
   v3. Een examen mag een expliciete UTC-tijd krijgen; de UI stuurt een
   volledige ISO-8601-timestamp (datum-zonder-tijd mag de client zelf
   aanvullen), de backend valideert alleen geldig ISO.
4. **Sync als snapshot, niet als delta.** `/sync/changes` levert **altijd de
   volledige set** toegankelijke examens (laag-cardinaal: een handvol rijen
   per user, elk klein). De client vervangt zijn Hive-box integraal
   (set-replace). Dat lost in één klap op wat bij een delta lastig is:
   - verwijderde examens → geen tombstones/`deleted_at` nodig;
   - toegang verloren (groep verlaten / gekickt / groep opgeheven) → examen
     staat gewoon niet meer in de snapshot; geen `removed_exam_ids`-mechaniek
     zoals bij decks (dat daar nodig is omdat kaarten/progress te groot zijn
     voor snapshots);
   - idempotent, geen watermerk-subtiliteiten, `full_resync` gedraagt zich
     vanzelf goed.
   Examens worden dus **hard-deleted** (zoals contacts/group_decks), niet
   soft-deleted.
5. **Deck-koppelingen zitten embedded in het examen-object** (`deck_ids:
   [...]`), zowel in REST als in de sync-snapshot. Muteren gaat via
   set-replace op `PUT /exams/:id` (geen aparte link/unlink-endpoints); elke
   wijziging aan de koppelingen bumpt `exams.updated_at` (voor WS en
   stale-write).
6. **Groepsexamens: owner én actieve leden met `can_add_decks`** mogen ze
   maken/bewerken/verwijderen (besluit Niels 2026-07-19). Overige actieve
   leden zien ze read-only.
7. **Verlopen examens blijven bestaan** tot de gebruiker ze verwijdert. De
   client negeert examens met `exam_date` in het verleden voor de scheduling
   (de kaarten vallen terug op het normale verval), maar kan ze in de UI nog
   tonen ("afgelopen"). Optionele purge-job is latere zorg.
8. **Pro-gating (besluit Niels 2026-07-19).** Twee entitlements, gecheckt via
   het bestaande `requireEntitlement` (products.js-filosofie: routes checken
   entitlements, nooit product-keys):
   - `EXAM_PLANNING` (bestaat al): alle **schrijf**-routes op `/exams`
     (persoonlijk én groep);
   - nieuw `GROUP_MANAGEMENT`: wijzigingen aan een groep of groepscatalogus
     (zie §4).
   **Lezen blijft overal gratis**: `GET /exams`, de sync-snapshot en de
   WS-events zijn niet gegate — een gratis groepslid moet groepsexamens
   kunnen zien en ermee trainen (de scheduler draait lokaal), en joinen
   blijft voor iedereen open. Alleen het *aanbrengen van wijzigingen* is pro.
   **Productmapping (besluit Niels 2026-07-19)**: drie tiers —
   **`pro`** (ontgrendelt `EXAM_PLANNING` + `GROUP_MANAGEMENT`, en later álle
   extra features zonder externe API-kosten), daarboven t.z.t. **`pro_plus`**
   en **`pro_max`** voor de features mét API-kosten (spraakherkenning,
   AI-check; dagcaps zie PRO_FEATURES_PLAN.md). Hogere tiers omvatten de
   lagere (superset van entitlements). De product-keys zijn definitief; de
   getóónde namen ("Pro+"/"Pro Max", of later bv. dier-namen) zijn puur
   frontend en kunnen los wijzigen. De losse voorbeeldproducten
   `pro_speech`/`pro_ai_check`/`pro_exams` in products.js worden vervangen
   door deze tier-opzet; `entitlementsFor` negeert onbekende keys, dus
   bestaande handmatige subscription-rijen breken niet (wel even her-mappen
   naar `pro`).
9. **`longest_in_streak_hours` in `user_card_progress` (besluit Niels
   2026-07-19).** De client uploadt voortaan per kaart de langste verdiende
   gap (in uren) binnen de huidige ononderbroken goed-streak — het
   `longestInStreak` dat de v3-scheduler toch al berekent
   (HOURLY_SRS_V3_PLAN.md, besluit 9). Dit is de meest waardevolle indicator
   of kennis er op de examendatum nog in zit: dekt de bewezen retentie de
   resterende tijd tot het examen? We slaan hem op voor **alle** kaarten,
   niet alleen huidige examenvragen — examenlidmaatschap wisselt over de
   tijd (deck komt later in een examen), de waarde is goedkoop en de client
   berekent hem toch al per antwoord. De kolom voedt straks de
   "op schema"-berekening (readiness) en maakt later groepsbrede aggregatie
   mogelijk zonder repetitielog-parsing op de server.
10. **Geen grandfathering (besluit Niels 2026-07-19).** Bestaande groepen en
    examens blijven gewoon bestaan en bruikbaar als pro ontbreekt of
    verloopt; alleen *wijzigen* vereist pro. Dat is precies wat de
    schrijf-gating al doet — er komt geen uitzonderingsregeling.

---

## Backend

### 1. Migratie `024_exams.sql` (+ `_down`)

```sql
CREATE TABLE IF NOT EXISTS exams (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid        REFERENCES users(id) ON DELETE CASCADE,
  group_id   uuid        REFERENCES groups(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  exam_date  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- persoonlijk (owner, geen groep) óf groepsexamen (groep; owner = maker,
  -- mag NULL worden bij account-verwijdering, orphan-patroon migratie 020)
  CONSTRAINT exams_scope CHECK (group_id IS NOT NULL OR owner_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS exams_owner_idx ON exams (owner_id);
CREATE INDEX IF NOT EXISTS exams_group_idx ON exams (group_id);

CREATE TABLE IF NOT EXISTS exam_decks (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id    uuid        NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  -- CASCADE: de tombstone-purge (purgeTombstones.js) hard-delete't oude
  -- decks; een RESTRICT-FK zou die job breken.
  deck_id    uuid        NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, deck_id)
);

CREATE INDEX IF NOT EXISTS exam_decks_deck_idx ON exam_decks (deck_id);

DROP TRIGGER IF EXISTS exams_updated_at ON exams;
CREATE TRIGGER exams_updated_at
  BEFORE UPDATE ON exams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON exams, exam_decks TO goldfish;

-- Readiness-indicator (ontwerpkeuze 9): langste verdiende gap (uren) in de
-- huidige goed-streak, aangeleverd door de client. NULL = nog nooit
-- aangeleverd (oude client of kaart nog nooit beantwoord).
ALTER TABLE user_card_progress
  ADD COLUMN IF NOT EXISTS longest_in_streak_hours integer;
```

Down: beide tabellen én de kolom droppen. Idempotent zoals altijd; uitvoeren volgens de
werkwijze in memory (`sudo -u postgres psql`, tabellen owned by postgres).
Rij toevoegen aan `migrations/README.md`.

Bij `group_id`: `ON DELETE CASCADE` is een vangnet — groepen worden
soft-deleted, maar de accountpurge kan via orphan-opruiming ooit hard
verwijderen. **Let op:** een soft-deleted groep (`groups.deleted_at`) moet de
examens wél verbergen; dat filtert de toegangsquery (zie §3), de rijen
blijven staan tot de groep echt weg is.

### 2. Toegangsregel (één SQL-bouwsteen)

"Voor mij toegankelijke examens" — hergebruiken in GET, PUT-check en sync:

```sql
e.owner_id = $me AND e.group_id IS NULL          -- persoonlijk
OR e.group_id IN (
     SELECT gm.group_id FROM group_members gm
     JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
     WHERE gm.user_id = $me AND gm.status = 'active')
```

Schrijfrechten: persoonlijk → `owner_id = $me`; groepsexamen → actieve
membership met `role = 'owner'` **of** `can_add_decks = true`. Helper in
`src/utils/` (naast `deckAccess.js`) of bovenin de router. Daarbovenop geldt
op route-niveau `requireEntitlement(EXAM_PLANNING)` (ontwerpkeuze 8): eerst
entitlement (403), dan pas de rechtencheck (404).

### 3. Nieuwe router `src/routes/exams.js` (mounten in `app.js` onder `/exams` 🔒)

Het examen-object (overal dezelfde vorm, ook in sync en WS):

```json
{
  "id": "…", "name": "Anatomie deeltoets 2", "exam_date": "2026-09-14T07:00:00Z",
  "owner_id": "…", "group_id": null,
  "deck_ids": ["…", "…"],
  "created_at": "…", "updated_at": "…"
}
```

`deck_ids` komt uit een `LEFT JOIN LATERAL` / `array_agg` op `exam_decks`,
**gefilterd op decks die de lezer mag zien** (owner of actieve share,
`deleted_at IS NULL`) zodat een lid nooit deck-ids lekt die het zelf niet
heeft — voor groepsexamens is dat in de praktijk de hele set, want de
catalogusregel (zie POST) garandeert groepstoegang.

- **`GET /exams`** — alle toegankelijke examens (toegangsregel §2), gesorteerd
  op `exam_date ASC`. **Geen entitlement** (lezen is gratis, ontwerpkeuze 8).
- **`POST /exams`** 💰`EXAM_PLANNING` — body
  `{ name, exam_date, group_id?, deck_ids? }`. Validatie:
  - `name` via `invalidString` (`LIMITS.TITLE_MAX`), verplicht;
  - `exam_date` verplicht, geldige ISO-timestamp (UTC-tijdstip toegestaan,
    zelfde check-stijl als `since` in sync.js); verleden toestaan (bewust:
    importeren/na-registratie);
  - `group_id` (optioneel): user moet owner of `can_add_decks`-lid met
    `status = 'active'` van die groep zijn, groep niet soft-deleted;
  - `deck_ids` (optioneel, default `[]`, max **50**, geldige UUID's):
    persoonlijk examen → elk deck leesbaar voor de user (`canReadDeckSql`);
    groepsexamen → elk deck in de **groepscatalogus** (`group_decks`), zodat
    elk lid de decks ook echt kan hebben.
  In één transactie: examen inserten + `exam_decks`-rijen. 201 met het
  volledige object; WS-event (zie §5).
- **`PUT /exams/:id`** 💰`EXAM_PLANNING` — body `{ name?, exam_date?, deck_ids?,
  client_updated_at? }`. Zelfde patroon als `PUT /decks/:id`: transactie,
  `SELECT … FOR UPDATE`, 404 bij geen schrijfrecht, **409 `stale_write` met
  `current`** als `client_updated_at` ouder is dan `updated_at`. `deck_ids`
  is set-replace (delete + insert binnen de transactie); ook als alléén
  `deck_ids` wijzigt een dummy-`UPDATE exams` doen zodat de trigger
  `updated_at` bumpt. Scope (`group_id`) is **immutabel** na aanmaak.
- **`DELETE /exams/:id`** — hard delete (CASCADE ruimt `exam_decks` op), 200
  `{ success: true }`; WS-event. **Bewust géén entitlement** (wel de gewone
  schrijfrechten-check): een examen beïnvloedt de scheduling agressief, dus
  wie zijn pro laat verlopen moet een oud examen altijd nog kunnen opruimen —
  zelfde "opruimen is vrij"-principe als in §4.

### 4. Pro-gating in `groups.js` (entitlement `GROUP_MANAGEMENT`)

Nieuw entitlement in `src/config/products.js`:

```js
GROUP_MANAGEMENT: "group_management", // groepen aanmaken/beheren + catalogus
```

Leidend principe: **aanmaken/wijzigen is pro; joinen, opruimen en modereren
blijven vrij.** Zo sluit een verlopen abonnement nooit iemand op: leden kunnen
blijven joinen en vertrekken, en een owner zonder pro kan zijn groep blijven
modereren (bad actors kicken, aanvragen afhandelen) en opheffen — hij kan er
alleen niets nieuws meer in bouwen.

💰 `requireEntitlement(GROUP_MANAGEMENT)` op:

| Route | Wat |
|---|---|
| `POST /groups` | groep aanmaken |
| `PUT /groups/:id` | naam/omschrijving/`require_approval` wijzigen |
| `PUT /groups/:id/password` | join-wachtwoord wisselen |
| `POST /groups/:id/invites` | uitnodiging versturen |
| `PUT /groups/:id/members/:user_id` | `can_add_decks`-rechten toggelen |
| `POST /groups/:id/decks` | deck aan de catalogus toevoegen |
| `DELETE /groups/:id/decks/:deck_id` | deck uit de catalogus halen — **behalve** je eigen deck terugtrekken (added_by = ik of deck-owner = ik): dat is privacy/opruimen en blijft vrij |

Vrij blijft (naast alle GET's): `POST /groups/join`,
`POST /groups/:id/invites/accept`, `DELETE /groups/:id/invites`
(intrekken/weigeren), `POST /groups/:id/members/:user_id/approve`,
`DELETE /groups/:id/members/:user_id` (kick én zelf vertrekken),
`DELETE /groups/:id` (groep opheffen), en
`POST /groups/:id/decks/:deck_id/add` (catalogus-deck aan je eigen dashboard
toevoegen — dat is de groep *gebruiken*, niet beheren).

### 5. `review.js`: veld `longest_in_streak_hours`

`POST /review/progress` accepteert een nieuw optioneel veld
`longest_in_streak_hours` (integer ≥ 0, cap bv. 200000 — nieuwe
`invalidInt`-helper in `utils/validate.js`), opgeslagen in zowel het
insert- als het update-pad van de volledige progress-write; het
core-only-pad (alleen `is_core` toggelen) raakt het veld niet aan. Oude
clients sturen het veld niet → kolom blijft NULL, niets breekt.

Teruglezen: `/sync/changes` gebruikt `SELECT *` op `user_card_progress`, dus
het veld loopt daar automatisch mee (hive-first: de client kan zijn lokale
waarde herstellen na herinstallatie). In `review.js` de expliciete
kolomlijsten (`ucp.remote_score, … ucp.repetitions, …`) uitbreiden met
`ucp.longest_in_streak_hours` waar progress-objecten teruggaan
(`/review/due`, `/review/deck/:id`, `/review/progress/:card_id`, `/review/core`).

Semantiek is en blijft client-owned (de v3-scheduler berekent hem al, zie
ontwerpkeuze 9); de server valideert alleen het type en slaat op. Toekomstig
gebruik: `GET /exams/:id/readiness` — per gekoppeld deck het aandeel kaarten
waarvan `longest_in_streak_hours` ≥ de resterende uren tot `exam_date`
(uit PRO_FEATURES_PLAN.md; geen onderdeel van deze eerste iteratie).

### 6. `/sync/changes`: snapshot-key `exams`

In `src/routes/sync.js` één query toevoegen aan de `Promise.all` (toegangsregel
§2 + `array_agg` van deck_ids, **zonder** `updated_at > since`-filter) en in de
response opnemen:

```json
{ "server_time": "…", "decks": […], "cards": […], "progress": […],
  "removed_deck_ids": […], "exams": [ …volledige set… ] }
```

Client-contract: **Hive-box `exams` integraal vervangen** door deze array,
elke sync. Bij `full_resync: true` verandert er niets bijzonders: de
resync-flow eindigt toch in een verse `/sync/changes` + `GET`-calls.
Oude clients negeren de extra key — geen bump van `min_client_build` nodig.

### 7. WebSocket

Live updates op andere devices / bij groepsgenoten, patroon uit `groups.js`:

- persoonlijk examen: `broadcast(ownerId, "exam_updated", [examObject])`
  resp. `"exam_removed", [{ id }]`;
- groepsexamen: `broadcastGroup(groupId, …)` naar alle actieve leden.

Client-afhandeling: upsert/verwijder in de Hive-box; wie het event mist,
wordt bij de volgende sync-snapshot toch consistent.

### 8. Randgevallen

- **Deck verwijderd (soft-delete)**: `exam_decks`-rij blijft staan tot de
  purge hem cascade't; de leesquery filtert tombstones er al uit, dus het
  examen toont vanzelf minder decks. Geen extra werk.
- **Deck uit groepscatalogus gehaald / share gerevoked**: idem — de
  `deck_ids`-filtering op leesbaarheid verbergt het deck per lezer. De
  `exam_decks`-rij laten staan is bewust: komt het deck terug in de
  catalogus, dan telt het weer mee. (Wel: de eerstvolgende snapshot na zo'n
  wijziging levert het gekrompen examen; er is géén `updated_at`-bump op het
  examen nodig dankzij snapshot-sync.)
- **Groep verlaten/gekickt/opgeheven**: examen valt uit de snapshot →
  client ruimt lokaal op. Kick stuurt al `group_removed` via WS; de client
  kan daarop meteen ook de examens van die groep droppen.
- **Meerdere examens over hetzelfde deck**: toegestaan (UNIQUE is per
  examen); de client neemt de vroegste toekomstige datum.
- **Account-verwijdering**: persoonlijke examens cascaden weg met de user;
  bij groepsexamens wordt `owner_id` NULL (orphan-patroon) — géén aanpassing
  in `purgeDeletedAccounts.js` nodig behalve controleren dat de volgorde
  (user hard-delete) niet op een RESTRICT-FK stuit; met bovenstaande FK's
  zit dat goed.

### 9. Tests (`test/exams.test.js` + uitbreiding `groups.test.js`)

- CRUD happy path (persoonlijk + groep), object-vorm met `deck_ids`;
- validatie: naamlengte, ongeldige `exam_date` (mét en zonder tijdstip),
  >50 decks, vreemde UUID's;
- rechten: niet-lid ziet groepsexamen niet; actief lid zónder
  `can_add_decks` ziet read-only (PUT → 404); owner én `can_add_decks`-lid
  mogen schrijven; deck buiten catalogus → 400; persoonlijk examen met
  andermans deck → 400;
- entitlements: `POST/PUT /exams` zonder `EXAM_PLANNING` → 403;
  `DELETE /exams/:id` werkt zónder entitlement; `GET /exams` en de
  sync-snapshot werken zonder entitlement;
- `groups.test.js`: elke 💰-route uit §4 zonder `GROUP_MANAGEMENT` → 403;
  join/accept/leave/kick/approve/opheffen én eigen-deck-terugtrekken werken
  zonder entitlement;
- `PUT` stale-write → 409 met `current`;
- sync: snapshot bevat eigen + groepsexamens; na kick/verlaten verdwijnt het
  groepsexamen uit de snapshot; na `DELETE` idem;
- `deck_ids`-filtering: soft-deleted deck verschijnt niet in het object;
- `longest_in_streak_hours`: upload via `POST /review/progress`, terug in
  `/sync/changes` en `/review/*`; negatief/niet-integer → 400; core-only
  write laat de waarde staan; oude client (veld weg) laat de waarde staan.

### 10. Documentatie

- `BACKEND_API.md`: sectie **"Examens (`/exams`) 🔒"**, de `exams`-key onder
  `GET /sync/changes`, `longest_in_streak_hours` bij `POST /review/progress`
  en de nieuwe 💰-markeringen op de groups-routes — **in beide kopieën**
  (backend én frontend, zie memory-regel);
- `src/config/products.js`: `GROUP_MANAGEMENT` toevoegen en de
  voorbeeldproducten vervangen door de tier-opzet uit ontwerpkeuze 8
  (`pro: { entitlements: [EXAM_PLANNING, GROUP_MANAGEMENT] }`; hogere tiers
  volgen bij de API-features);
- `PRO_FEATURES_PLAN.md`: bij Feature 3 een verwijzing naar dit plan zetten;
- `migrations/README.md`: rij voor 024.

---

## Frontend (contract, ter referentie — niet dit plan)

1. Hive-box `exams`; set-replace bij elke sync-snapshot, upsert/delete bij WS.
2. Afgeleide map `deck_id → eerstvolgende toekomstige exam_date` (herbouwen
   bij box-wijziging en bij dag-overgang).
3. Scheduler-hook: is de kaart een examenvraag, cap dan het interval zodat de
   kaart vóór (en rond) de examendatum rijp terugkomt; na de examendatum
   normaal verval. De precieze capping-formule is een eigen frontend-besluit
   (analoog aan de keuzes in HOURLY_SRS_V3_PLAN.md).
4. Offline aangemaakte examens: lokaal in Hive + outbox naar `POST /exams`
   zodra online, zoals de bestaande hive-first flows.
5. Bij elke progress-upload `longest_in_streak_hours` meesturen (de
   scheduler berekent hem al); UI kan er lokaal direct een
   examen-readiness-indicator op bouwen (dekt de bewezen gap de tijd tot
   het examen?).
6. Pro-status: 403 met entitlement-fout van de 💰-routes netjes afvangen →
   upsell-scherm; `GET /auth/me`/subscriptions-endpoint vertelt de client
   welke entitlements actief zijn.

## Open vragen voor Niels

Geen — alle open vragen zijn 2026-07-19 beantwoord en verwerkt in
ontwerpkeuzes 8 en 10 (carve-out §4 akkoord; tiers `pro`/`pro_plus`/`pro_max`,
displaynamen zijn frontend-zaak). Voor deze feature hoeft alleen `pro` echt
in products.js te bestaan; de hogere tiers volgen bij de API-features.
