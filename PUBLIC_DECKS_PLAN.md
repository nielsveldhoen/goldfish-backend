# Publieke decks — afronding + bibliotheek als tab

Status: **gebouwd** (2026-07-11), nog niet gedeployed. Bouwt voort op
SHARING_PLAN.md (Release A) en EDIT_RIGHTS_PLAN.md (migratie 019) — het
publieke fundament bestond al grotendeels; dit plan maakte het af.

## Requirements

1. Een deck kan **alleen door de eigenaar** publiek gemaakt worden, en
   dat is **onomkeerbaar**: eenmaal publiek blijft publiek. Vóór het
   zetten krijgt de eigenaar daarom een expliciete dubbele check
   (bevestigingsdialoog die de onomkeerbaarheid benoemt).
2. Een publiek deck is voor volgers read-only; **bewerken kan alleen door
   mensen die expliciet edit-toegang van de eigenaar kregen** (de
   bestaande `can_edit`-mechaniek).
3. De publieke bibliotheek wordt een **tab** in de bottom-nav, in plaats
   van het huidige icoon in de dashboard-appbar.

## Huidige stand (wat er al ligt)

**Backend — vrijwel compleet, geen migratie nodig:**

- `decks.is_public` bestaat, met partial index `idx_decks_public`
  (migratie 016).
- `GET /decks/public` — zoeken (ILIKE op titel + tags, escaped),
  paginatie, rate limit, eigen decks uitgesloten (`shares.js`).
- `POST /decks/:id/follow` / `DELETE /decks/:id/follow` — volgen als
  `kind='subscribed'` (direct `accepted_at`, geen invite-stap);
  her-volgen reset `can_edit`.
- **Requirement 1 is al afgedwongen**: `PUT /decks/:id` gebruikt
  `isDeckOwnerSql` — een editor-recipient (can_edit) kan géén
  deck-metadata schrijven, dus ook `is_public` niet (404).
- **Requirement 2 is al afgedwongen**: kaart-writes lopen via
  `canEditDeckSql`; `PUT /decks/:id/permissions/:user_id` sluit
  `kind='subscribed'` expliciet uit — een anonieme volger kan nooit
  edit-recht krijgen. Edit-toegang op een publiek deck loopt dus via een
  **directe contact-share** (of groep) met de switch in het "Gedeeld
  met"-paneel — dat ís de "expliciete toegang van de eigenaar".
- `GET /shares/overview` levert per deck al `is_public` +
  `follower_count`.

**Frontend — half af:**

- `PublicLibraryScreen` bestaat (zoeken, infinite scroll, volgen) op
  route `/library`, geopend via een `Icons.public`-icoon in de
  dashboard-appbar (`dashboard_screen.dart` ~r484).
- `shared_with_sheet.dart` (owner-only) toont volgers-aantal en heeft
  de edit-switches per persoon.

**Wat ontbreekt (de eigenlijke klus):**

1. Er is **geen UI om een deck publiek te maken**: het `Deck`-model kent
   geen `isPublic` (server stuurt `is_public` wel mee via `d.*`, client
   negeert het), `DeckRepository.updateDeck` kan het veld niet zetten,
   en nergens staat een toggle.
2. De bibliotheek zit achter een appbar-icoon i.p.v. een tab.
3. De eigenaar ziet nergens wélke van zijn decks publiek zijn (badge).

---

## Fase 1 — Frontend: deck publiek maken (owner-only)

### Model & data

- `models/deck.dart`: veld `isPublic` (`@HiveField(8, defaultValue:
  false)`), in `fromJson` (`json['is_public'] == true`), `copyWith`,
  constructor; `deck.g.dart` regenereren (build_runner). Alleen
  betekenisvol voor eigen decks — voor recipient-decks is het weergave.
- `DeckRepository.updateDeck`: parameter `bool? isPublic` — in de
  praktijk alleen ooit `true` (onomkeerbaar; de UI biedt geen
  uit-knop). Gaat door het bestaande pad: `DeckLocal.updateDeck` +
  `update_deck`-payload krijgt `is_public` (incl.
  `client_updated_at`-stale-guard). De bestaande niet-owner-guard in
  `updateDeck` dekt requirement 1 client-side al af; server blijft de
  waarheid (404).
- `deck_updated`-merge (WS) en sync: client behoudt eigen
  role/can_edit/inactive maar neemt `is_public` wél uit de payload over.

### UI

- **Eenrichtings-actie in `shared_with_sheet.dart`** ("Gedeeld met" —
  al owner-only): bovenaan een tile "Publiek maken in de bibliotheek"
  (icoon `Icons.public`). Tik → **bevestigingsdialoog** die expliciet
  zegt dat dit *niet ongedaan te maken* is (iedereen kan het deck dan
  voor altijd vinden en volgen), met "Annuleren" als default-knop en
  "Publiek maken" als bevestiging. Pas na bevestigen →
  `DeckRepository.updateDeck(isPublic: true)`.
- Is het deck al publiek, dan toont dezelfde plek een **statische
  status** "Publiek" (geen switch, niets te togglen meer); de
  volgers-tile eronder blijft.
- **Badge op de deck-kaart** (`deck_card.dart`): klein
  `Icons.public`-icoon voor eigen publieke decks, naast de bestaande
  "gedeeld door X"-badge-plek.
- Strings in `strings_en.dart` + `strings_fr.dart`.

## Fase 2 — Frontend: bibliotheek als tab

- `app_shell.dart`: vierde destination in de `NavigationBar` én de
  `IndexedStack`. Volgorde: **Decks · Bibliotheek · Groepen ·
  Contacts** (bibliotheek naast Decks; zie Open keuzes). Icoon
  `Icons.public`/`Icons.public` outlined-variant bestaat niet apart —
  `Icons.language` of gewoon `Icons.public` voor beide states.
- `PublicLibraryScreen` ombouwen van pushed screen naar tab-body:
  - `onBack` + back-arrow weg; `GoldfishAppBar` met `onLogout`, zoals
    `GroupsScreen`/`ContactsScreen`.
  - **Zoek-gestuurd, geen standaardlijst** (besluit Niels): de tab
    opent leeg met alleen het zoekveld en een uitleg-placeholder
    ("Zoek op titel of tag"). Er wordt pas gefetcht zodra er een
    zoekterm van ≥ 2 tekens staat (met de bestaande 400ms-debounce);
    zoekveld leegmaken → lijst weg, géén nieuwe fetch. Daarmee vervalt
    ook het lazy-load-probleem van de IndexedStack: er is bij het
    opstarten sowieso niets te laden.
  - Paginering/infinite scroll blijft, maar dan binnen de zoekresultaten.
  - **Zoekgedrag blijft substring-match**: `ILIKE '%term%'` op titel én
    tags werkt al, ook op het midden van een woord ("ans" vindt
    "Frans"). Geen wijziging nodig; alleen de placeholder-tekst mag dit
    uitleggen.
- Dashboard-appbar: het `Icons.public`-icoon verwijderen
  (`dashboard_screen.dart`).
- `app_router.dart`: de `/library`-child-route verwijderen (de tab is
  geen adresseerbare route; zelfde model als Groepen/Contacts).
- De follow-flow zelf blijft ongewijzigd (follow → `SyncService.sync()`
  → deck op het dashboard).

## Fase 3 — Backend: onomkeerbaarheid afdwingen + tests

Twee routewijzigingen (geen migratie):

1. **`PUT /decks/:id` weigert `is_public: false` op een deck dat al
   publiek is** — 400 `is_public_irreversible`. De check zit in de
   bestaande check-then-write-transactie (de rij is daar al gelockt en
   gelezen). Server-side afdwingen is nodig: de UI verbergt de
   uit-knop, maar een oude client of een handmatige API-call mag de
   regel niet omzeilen. `is_public: true` op een al publiek deck blijft
   gewoon idempotent oké.
2. **`GET /decks/public` vereist een zoekterm** (≥ 2 tekens) — zonder
   (of te korte) `search` → 400 `search_required`. Het "geen
   standaardlijst"-besluit is een load-overweging; die hoort dan ook
   server-side, anders dumpt een oude client of scraper alsnog de hele
   catalogus per 50. Bijvangst: de duurste variant van deze query
   (ongefilterd alles pagineren) verdwijnt. `ILIKE '%term%'` kan de
   partial index niet gebruiken (seq scan over publieke decks) — prima
   op de huidige schaal; `pg_trgm` staat als latere optie in
   SCALING-hoek, niet nu.

Tests (voor zover ze nog niet bestaan in `test/`):

- Alleen de owner kan `is_public` zetten: `PUT /decks/:id` met
  `is_public` door een editor-recipient → 404.
- `is_public: false` op een publiek deck → 400
  `is_public_irreversible`; `is_public: true` idempotent; een PUT
  zónder `is_public`-veld op een publiek deck blijft gewoon werken
  (het veld valt terug op de huidige waarde).
- Volger (subscribed) kan geen kaarten schrijven; owner kan een
  subscribed-rij geen `can_edit` geven (404 op permissions).
- Volgen van een niet-publiek / soft-deleted / eigen deck → 404;
  her-volgen na unfollow reset `can_edit`.
- `GET /decks/public` zonder of met te korte (< 2 tekens) `search` →
  400 `search_required`; substring-match op midden van titelwoord én op
  tags levert het deck op.
- Routevolgorde `/decks/public` vóór `/decks/:id` (bestaat vermoedelijk
  al als test — checken).

## Fase 4 — Docs, verificatie & deploy

- `BACKEND_API.md` in **beide** repo's checken/bijwerken: `is_public`
  op deck-responses en in `PUT /decks/:id` (owner-only, **onomkeerbaar**
  — nieuwe 400 `is_public_irreversible`) expliciet documenteren, plus
  de nieuwe `search`-eis op `GET /decks/public` (400 `search_required`,
  min. 2 tekens).
- Flutter: `dart run build_runner build` (deck.g.dart), `flutter
  analyze`, bestaande tests.
- Backend lokaal: testsuite; er is geen migratie, dus deploy = code
  only. Bij deploy eerst memory `project_remote_deploy.md` volledig
  lezen (vaste regel).
- Oude clients: `is_public` in responses negeren ze al; de nieuwe
  toggle is additief → geen `min_client_build`-bump nodig.

## Volgorde van bouwen

1. Fase 3 eerst (kleine backend-guard + tests): de onomkeerbaarheid
   moet server-side staan vóór de app een publiek-knop krijgt.
2. Fase 1 (model + publiek-maken-flow + badge) — daarmee is het
   feature-verhaal compleet: publiek maken kan eindelijk vanuit de app.
3. Fase 2 (tab) — puur UI-verhuizing, los te releasen.
4. Fase 4 (docs, verificatie, deploy) sluit af.

## Buiten scope / later

- Eigen publieke decks tonen in de bibliotheek (nu uitgesloten door
  `d.user_id <> $1`) — evt. later met "eigen deck"-label.
- Populariteit/sortering (volgers-aantal, ratings), categorieën,
  publieke profielen.
- Edit-rechten voor anonieme volgers — bewust niet: edit loopt via
  contact-share/groep (requirement 2).
- Deep link naar een publiek deck (`/library/:deckId`).

## Besloten

- **`is_public` is onomkeerbaar** (besluit Niels, 2026-07-11): er komt
  géén uit-knop, server weigert `is_public: false` op een publiek deck
  (400 `is_public_irreversible`), en de UI doet een expliciete dubbele
  check vóór het aanzetten. De eerdere open keuze "volgers behouden
  toegang bij uitzetten" vervalt daarmee.
- **Bibliotheek is zoek-gestuurd, geen standaardlijst** (besluit Niels,
  2026-07-11): geen fetch zonder zoekterm — onnodige serverload. Client
  fetcht pas vanaf 2 tekens; server vereist `search` (400
  `search_required`). Substring-zoeken (ook midden in een woord, op
  titel én tags) bestond al en blijft.

## Open keuzes (default staat erbij)

1. **Plaats van de publiek-maken-actie**: "Gedeeld met"-sheet (default
   — daar leven alle deel-instellingen en het volgers-aantal) of de
   deck-status-dialoog.
2. **Tabvolgorde**: Decks · Bibliotheek · Groepen · Contacts (default)
   of de bibliotheek achteraan.
3. **Herselectie-refresh**: nu de tab leeg opent is er weinig te
   verversen; default = staande zoekresultaten blijven staan bij
   tab-wissel (IndexedStack) en alleen een nieuwe zoekactie of
   pull-to-refresh haalt verse data — let op de rate limit van
   120/15min.
4. **Wissen als nooduitgang**: een publiek deck verwijderen kan de
   eigenaar uiteraard nog wel (soft-delete → tombstone bij alle
   volgers). Vermelden we dit in de bevestigingsdialoog als de enige
   "uitweg"? Default: ja, één zin.
