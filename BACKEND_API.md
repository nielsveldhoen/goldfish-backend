# Goldfish Backend API

## Overzicht

- **Base URL:** productie `https://<domein>` (TLS via reverse proxy), lokaal `http://localhost:3000`
- **Formaat:** JSON (altijd `Content-Type: application/json` meesturen bij POST/PUT). Request-body's groter dan 1 MB worden geweigerd.
- **Authenticatie:** JWT Bearer token — stuur bij beveiligde endpoints (🔒):
  ```
  Authorization: Bearer <token>
  ```
- **Token geldigheid:** 7 dagen
- **401-semantiek:** een ontbrekend, ongeldig of verlopen token geeft op élk beveiligd endpoint altijd exact `401`. `403` betekent: geldig token, maar de resource is van een andere gebruiker (of: e-mail nog niet geverifieerd bij login).

---

## Veldnamen

De backend kent één naamset:

- **`remote_*`** — de long-term score (voorheen `ltm_score`): `remote_score`, `avg_remote_score`.
- **`stable_*`** — de short-term score (voorheen `stm_score`): `stable_score`, `avg_stable_score`.
- **`recent_*`** — recente score: `recent_score` (smallint, default 0), `avg_recent_score` (numeric, nullable).
- **`core_*`** — het kaarttype "core" (`is_core`) en de daarvan afgeleide tellingen + gemiddelden: `core_cards_practiced`, `core_correct_first_try`, `total_core_cards`, `total_core_count`, `core_practiced_today`, `core_correct_first_try_today`, en de gemiddelde scores over alléén core-kaarten: `avg_core_remote_score`, `avg_core_stable_score`, `avg_core_recent_score` (numeric, nullable).

> `ltm` was vroeger twee dingen tegelijk — een **score** én een **kaarttype**. De score heet nu `remote`, het type `core`.

**`recent` is optioneel bij writes:**
- `recent_score` bij `POST /review/progress`: **weggelaten = waarde blijft onveranderd**.
- `avg_recent_score` en `avg_core_remote_score`/`avg_core_stable_score`/`avg_core_recent_score` in `deck_delta`/`daily_snapshot` bij `POST /stats/update`: weggelaten = bestaande waarde blijft staan. (`avg_remote_score`/`avg_stable_score` overschrijven daarentegen altijd, ook met `null`.)
- `total_cards`/`total_core_cards` in `deck_delta` bij `POST /stats/update`: absolute deckgroottes die de bestaande waarde overschrijven; weggelaten = onveranderd. Bestaande rijen zijn `null` (geen backfill). Oudere clients sturen ze niet mee.

**Paden:** alle endpoints zitten onder het prefix `/v2` (bijv. `/v2/review/due`). De paden in dit document staan voor de leesbaarheid zonder dat prefix; zet er in de praktijk `/v2` voor. Ongeprefixte paden bestaan niet meer.

**WebSocket:** de payloads van `/ws`-events (`core_set`, `progress_deleted`) bevatten voortgangsobjecten met de veldnamen hierboven. Payloads zijn altijd een **array** van objecten, ook bij één item (zie het WebSocket-hoofdstuk).

---

## Minimale clientversie

De server bewaakt een minimaal vereist **Flutter buildNumber** (het getal na de `+` in `version: x.y.z+build`). Dit minimum staat in de database (`app_config.min_client_build`) en wordt door de beheerder met SQL bijgesteld.

**De client moet bij élk verzoek zijn buildNumber meesturen in de header:**
```
X-Client-Build: 42
```

- Is de meegestuurde build **lager** dan het minimum (of ontbreekt de header — telt als `0`), dan weigert de server het verzoek met **`426 Upgrade Required`**:
  ```json
  { "error": "client_version_unsupported", "min_client_build": 42 }
  ```
- Bij minimum `0` (de standaard) wordt niets geblokkeerd.

**`GET /version`** (zonder auth, nooit geblokkeerd) meldt het actuele minimum, zodat de client bij het opstarten kan checken of hij nog mag draaien en anders een update-melding toont:
```json
{ "versions": ["v2"], "latest": "v2", "min": "v2", "min_client_build": 42 }
```

> De client hoort bij opstart `GET /version` te raadplegen en bij `eigen buildNumber < min_client_build` niet verder te draaien. De `426` op de API-calls is het vangnet voor clients die dat niet doen.

---

## Authenticatie (`/auth`)

### POST `/auth/register`
Registreer een nieuwe gebruiker. Na registratie wordt een verificatiemail gestuurd. De gebruiker kan pas inloggen nadat het e-mailadres is bevestigd.

**Rate limit:** 20 verzoeken per 15 minuten.

**Request body:**
```json
{
  "email": "user@example.com",      // max 254 tekens
  "password": "geheimwachtwoord",   // 8–128 tekens
  "username": "niels"   // optioneel (max 64 tekens) — wordt afgeleid van email als weggelaten
}
```

**Response `200`:**
```json
{
  "message": "Registration successful. Check your email to verify your account.",
  "email_sent": true
}
```

> Registratie is atomair: user en verificatietoken worden in één transactie aangemaakt. Faalt daarna alleen het versturen van de verificatiemail, dan is het account tóch aangemaakt en antwoordt de server `200` met `"email_sent": false` (en een afwijkende `message`). De gebruiker kan dan via `POST /auth/resend-verification` een nieuwe mail aanvragen.

> **Anti-enumeration:** bestaat het e-mailadres al, dan is de response *identiek* aan een geslaagde registratie (`200`) — er wordt dan geen account aangemaakt maar een "je hebt al een account"-mail gestuurd die naar de wachtwoord-reset wijst. De client kan een bestaand adres dus niet aan de response aflezen; dat is bewust.

**Foutcodes:**
- `400` — ontbrekende velden, wachtwoord korter dan 8 of langer dan 128 tekens, e-mail/username boven de maximale lengte, of username al bezet (`"Username already taken"`, alleen wanneer het e-mailadres nog vrij is)

---

### POST `/auth/login`
Login met email of username.

**Rate limit:** 20 verzoeken per 15 minuten.

**Request body:**
```json
{
  "email": "user@example.com",   // gebruik email of identifier, niet beide
  "password": "geheimwachtwoord"
}
```
> Je kunt ook `"identifier"` sturen in plaats van `"email"`. De waarde kan een e-mailadres of username zijn.

**Response `200`:**
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "niels"
  },
  "token": "eyJ..."
}
```

**Foutcodes:**
- `400` — ontbrekende velden
- `401` — ongeldige inloggegevens (ook bij een identifier of wachtwoord ver boven de maximale lengte — zulke input kan nooit geldig zijn en wordt geweigerd zonder hash-verificatie)
- `403` — e-mailadres nog niet geverifieerd

---

### GET `/auth/verify-email` (zónder `/v2`-prefix)
Browser-flow voor de verificatielink uit de mail — de client hoeft hier niets mee. `GET ?token=...` bevestigt het e-mailadres (`email_verified = true`) en toont een HTML-bevestigingspagina; bij een ontbrekend, ongeldig of verlopen token een HTML-foutpagina met status `400`. Deze route staat **buiten** het `/v2`-prefix en buiten de client-versiegate, omdat een browser geen `X-Client-Build` meestuurt.

Token is 24 uur geldig en single-use: na een geslaagde verificatie (of één klik) is hij verbruikt en toont dezelfde link de foutpagina.

**Query params:**
- `token` — de verificatietoken uit de mail

---

### POST `/auth/resend-verification`
Stuur een nieuwe verificatiemail. Geeft altijd dezelfde response terug, ook als het e-mailadres niet bestaat (voorkomt user enumeration).

**Rate limit:** 20 verzoeken per 15 minuten.

**Request body:**
```json
{
  "email": "user@example.com"
}
```

**Response `200`:**
```json
{
  "message": "If your email exists and is unverified, a new verification email has been sent."
}
```

**Foutcodes:**
- `400` — ontbrekend e-mailadres

---

### POST `/auth/forgot-password`
Vraag een wachtwoord-reset-link aan. Geeft altijd dezelfde response terug, ook als het e-mailadres niet bestaat (voorkomt user enumeration). Bestaat het adres wél, dan wordt er een mail gestuurd met een link die **1 uur** geldig en single-use is; een nieuwe aanvraag vervangt de vorige link. De reset zelf verloopt via de browser (zie hieronder), niet via de app.

**Rate limit:** 20 verzoeken per 15 minuten.

**Request body:**
```json
{
  "email": "user@example.com"
}
```

**Response `200`:**
```json
{
  "message": "If your email exists, a password reset email has been sent."
}
```

**Foutcodes:**
- `400` — ontbrekend e-mailadres

---

### GET / POST `/auth/reset-password` (zónder `/v2`-prefix)
Browser-flow voor de reset-link uit de mail — de client hoeft hier niets mee, maar voor de volledigheid: `GET ?token=...` toont een HTML-formulier; de `POST` (formulier of JSON `{ "token", "password" }`) voert de reset uit. Deze routes staan **buiten** het `/v2`-prefix en buiten de client-versiegate, omdat een browser geen `X-Client-Build` meestuurt.

Een geslaagde reset:
- zet het nieuwe wachtwoord (8–128 tekens),
- zet `email_verified = true` (de reset bewijst bezit van de mailbox),
- **trekt alle bestaande JWT's van de gebruiker in** — elk apparaat krijgt op zijn eerstvolgende call een `401` en moet opnieuw inloggen.

---

### POST `/auth/logout-all` 🔒
Trekt **alle** JWT's van de ingelogde gebruiker per direct in (ook het token waarmee deze call gedaan is). Elk apparaat — inclusief dit — krijgt daarna `401` op API-calls en `4001` bij een nieuwe WS-handshake, en moet opnieuw inloggen. Gebruik dit bij een kwijtgeraakt/gestolen apparaat.

**Response `200`:**
```json
{
  "message": "All sessions revoked"
}
```

> **Revocatie-mechanisme:** de server bewaart per gebruiker een watermerk (`tokens_valid_after`). Tokens die vóór dat moment zijn uitgegeven worden geweigerd door alle 🔒-endpoints en door de WS-handshake. Een gewone logout in de app blijft client-side (token weggooien); `logout-all` en de wachtwoord-reset zetten het watermerk.

---

### GET `/auth/me` 🔒
Haal het profiel op van de ingelogde gebruiker.

**Response `200`:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "username": "niels"
}
```

---

## Decks (`/decks`) 🔒

Alle deck-endpoints vereisen authenticatie. Gebruikers zien en beheren alleen hun eigen decks.

### GET `/decks`
Alle decks van de ingelogde gebruiker, gesorteerd op aanmaakdatum (nieuwste eerst). Soft-deleted decks worden niet teruggegeven.

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "user_id": "uuid",
    "title": "Frans vocabulaire",
    "description": "Basiswoorden Frans",
    "is_public": false,
    "inactive": false,
    "core_only": false,
    "tags": ["frans", "vocabulaire"],
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-02T00:00:00.000Z",
    "deleted_at": null
  }
]
```

> **`inactive`** (boolean, standaard `false`): een deck dat is "gearchiveerd". De client verbergt inactieve decks en sluit hun kaarten uit van de due/new-weergave. Sinds juli 2026 tellen **óók de core-kaarten** van een inactief deck **niet** meer mee: `/review/core`, `/review/core/summary` en `/review/core/scores` sluiten kaarten uit decks met `inactive = true` uit — analoog aan hoe kaarten in een soft-deleted deck al uit de core-stats vallen.
>
> **`core_only`** (boolean, standaard `false`): de toestand "alleen kernkaarten". Puur een client-side vlag: de client laat dan alleen de core-kaarten (`is_core = true`) van dit deck meetellen en negeert de rest. `core_only` heeft **geen** effect op de core-endpoints of op welke server-aggregatie dan ook — het wordt alleen opgeslagen, geretourneerd en gesynct (spiegelt `inactive` daarin volledig). Deze toestand neemt de rol over van het oude `inactive`-gedrag (waar core-kaarten van een inactief deck bleven meetellen).

---

### GET `/decks/:id`
Eén deck ophalen. Soft-deleted decks geven een 404.

**Response `200`:** zie hierboven (enkel object)
**Foutcodes:**
- `404` — deck niet gevonden (of niet van deze gebruiker, of malformed id)

---

### POST `/decks`
Nieuw deck aanmaken.

**Request body:**
```json
{
  "title": "Frans vocabulaire",       // verplicht, max 200 tekens
  "description": "Basiswoorden",      // optioneel, max 2000 tekens
  "is_public": false,                 // optioneel, standaard false
  "inactive": false,                  // optioneel, standaard false
  "core_only": false,                 // optioneel, standaard false
  "tags": ["frans", "school"]         // optioneel, standaard [] — max 50 tags van elk max 100 tekens
}
```

**Response `201`:**
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "title": "Frans vocabulaire",
  "description": "Basiswoorden",
  "is_public": false,
  "inactive": false,
  "core_only": false,
  "tags": ["frans", "school"],
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z",
  "deleted_at": null
}
```

**Foutcodes:**
- `400` — titel ontbreekt, veld boven de maximale lengte, of veld van het verkeerde type (tags geen string-array, is_public/inactive/core_only geen boolean)

---

### PUT `/decks/:id`
Deck bijwerken. Alleen meegestuurde velden worden bijgewerkt — niet-meegestuurde velden blijven ongewijzigd.

**Request body** (alle velden optioneel):
```json
{
  "title": "Nieuwe titel",
  "description": "Nieuwe omschrijving",
  "is_public": true,
  "inactive": true,
  "core_only": false,
  "tags": ["nieuw", "tag"],
  "client_updated_at": "2024-01-01T00:00:00.000Z"   // optioneel — ISO timestamp van de lokaal bekende versie
}
```

`inactive` en `core_only` (beide boolean) worden — net als `title`/`tags` — alleen bijgewerkt als ze zijn meegestuurd; ontbreken ze, dan blijft de huidige waarde staan. De `409`-`current` bevat het volledige deck-object, inclusief `inactive` en `core_only`.

Als `client_updated_at` meegestuurd wordt en de server heeft een nieuwere versie, wordt `409` teruggegeven. De conflict-check en de update zijn atomair (rij-lock in één transactie): twee apparaten die tegelijk schrijven kunnen elkaars write niet meer stilzwijgend overschrijven.

**Response `200`:** bijgewerkt deck-object

**Foutcodes:**
- `400` — veld boven de maximale lengte of van het verkeerde type (zelfde limieten als `POST /decks`)
- `404` — deck niet gevonden (ook bij een malformed id)
- `409` — conflict: de server heeft een nieuwere versie
  ```json
  { "error": "stale_write", "current": { /* huidig deck-object */ } }
  ```

---

### DELETE `/decks/:id`
Soft-delete: zet `deleted_at` op de huidige tijd. Het deck verschijnt niet meer in normale GET-responses, maar wel in `/sync/changes`.

**Cascade:** de voortgangsrecords van alle kaarten in dit deck worden mee-gesoftdelete (`deleted_at` gezet). Ze verschijnen daarmee in `/sync/changes` met `deleted_at != null` — behandel ze als "verwijder het lokale voortgangsrecord" (zoals bij een progress-reset). Hierdoor tellen kaarten in een verwijderd deck ook niet meer mee in de core-stats (`/review/core/summary`).

**Response `200`:**
```json
{ "message": "Deck deleted" }
```

**Foutcodes:**
- `404` — deck niet gevonden

---

### POST `/decks/bulk-delete`
Meerdere decks tegelijk soft-deleten (max **100** ids per request), in één transactie. Per deck exact dezelfde semantiek als `DELETE /decks/:id`, inclusief de cascade: de voortgangsrecords van alle kaarten in elk verwijderd deck worden mee-gesoftdelete, zodat ze via `/sync/changes` en de core-stats correct verdwijnen.

**Idempotent en tolerant:** ids die niet bestaan, al soft-deleted zijn of van een andere gebruiker zijn worden **stilzwijgend genegeerd** (zelfde stijl als het `ids`-filter van `GET /stats/decks`). Er komt géén `404` voor individuele ids — bij een `200` mag de client de hele batch als geslaagd behandelen. Een tweede call met dezelfde ids geeft gewoon `200` met `"deleted": 0`.

**Request body:**
```json
{
  "deck_ids": ["uuid", "uuid"]
}
```

**Response `200`:**
```json
{
  "deleted": 2,
  "ids": ["uuid", "uuid"]
}
```
`ids` bevat de ids die daadwerkelijk verwijderd zijn (genegeerde ids ontbreken).

**Realtime:** er wordt **één** `deck_deleted`-event gebroadcast met als payload een array van `{ "id": "uuid", "deleted_at": "…" }`-objecten voor alle daadwerkelijk verwijderde decks. Genegeerde ids zitten niet in de array; wordt er niets verwijderd, dan komt er geen event.

**Foutcodes:**
- `400` — `deck_ids` ontbreekt, is leeg, of bevat meer dan 100 ids

---

## Kaarten (`/cards`) 🔒

Alle card-endpoints vereisen authenticatie. Toegang is beperkt tot kaarten in decks van de ingelogde gebruiker.

### GET `/cards`
Alle kaarten van de gebruiker. Optioneel filteren op deck. Soft-deleted kaarten en kaarten in soft-deleted decks worden niet teruggegeven.

**Query params:**
- `deck_id` (optioneel) — filter op een specifiek deck

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "deck_id": "uuid",
    "question": "Wat is 'appel' in het Frans?",
    "answer": "pomme",
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-02T00:00:00.000Z",
    "deleted_at": null
  }
]
```

---

### GET `/cards/:id`
Één kaart ophalen.

**Response `200`:** zie hierboven (enkel object)
**Foutcodes:**
- `404` — kaart niet gevonden (of malformed id)

---

### POST `/cards`
Nieuwe kaart aanmaken.

**Request body:**
```json
{
  "deck_id": "uuid",            // verplicht
  "question": "Wat is appel?",  // verplicht, max 10000 tekens
  "answer": "pomme",            // verplicht, max 10000 tekens
  "created_at": "2026-01-15T09:30:00.000Z"  // optioneel — ISO timestamp, voor offline aangemaakte kaarten
}
```

> **`created_at`** (optioneel): de aanmaaktijd volgens de client, bedoeld voor kaarten die offline zijn aangemaakt en later gesynct worden. Ontbreekt het veld of is de waarde geen geldige timestamp, dan gebruikt de server de DB-klok.

**Response `201`:** kaart-object

**Foutcodes:**
- `400` — ontbrekende velden of vraag/antwoord boven de maximale lengte
- `403` — deck is niet van deze gebruiker (ook bij een malformed deck_id)

---

### POST `/cards/bulk`
Meerdere kaarten tegelijk aanmaken in één deck (max **500** per request). Alle kaarten worden in een transactie ingevoegd — als één mislukt worden geen kaarten aangemaakt.

**Request body:**
```json
{
  "deck_id": "uuid",
  "cards": [
    { "question": "Wat is appel?", "answer": "pomme" },
    { "question": "Wat is peer?",  "answer": "poire", "created_at": "2026-01-15T09:30:00.000Z" }
  ]
}
```

Per kaart is `created_at` optioneel, met exact dezelfde semantiek als bij `POST /cards`: geldige ISO-timestamp → overgenomen, ontbrekend of ongeldig → DB-klok.

**Response `201`:** array van aangemaakte kaart-objecten.

> **Volgorde-garantie (hard contract):** de response-array heeft altijd exact dezelfde volgorde als de `cards`-array in de request. De client mag dus op index zijn lokale temp-ids aan de server-ids koppelen.

**Foutcodes:**
- `400` — ontbrekende velden, lege cards-array, meer dan 500 kaarten, of een vraag/antwoord boven de maximale lengte (max 10000 tekens; de hele batch wordt dan geweigerd)
- `403` — deck is niet van deze gebruiker (ook bij een malformed deck_id)

---

### PUT `/cards/:id`
Kaart bijwerken. Alleen meegestuurde velden worden bijgewerkt.

**Request body** (alle velden optioneel):
```json
{
  "question": "Nieuwe vraag",
  "answer": "Nieuw antwoord",
  "client_updated_at": "2024-01-01T00:00:00.000Z"   // optioneel — ISO timestamp van de lokaal bekende versie
}
```

Als `client_updated_at` meegestuurd wordt en de server heeft een nieuwere versie, wordt `409` teruggegeven. De conflict-check en de update zijn atomair (rij-lock in één transactie): twee apparaten die tegelijk schrijven kunnen elkaars write niet meer stilzwijgend overschrijven.

**Response `200`:** bijgewerkt kaart-object

**Foutcodes:**
- `400` — vraag/antwoord boven de maximale lengte (max 10000 tekens)
- `404` — kaart niet gevonden (ook bij een malformed id)
- `409` — conflict: de server heeft een nieuwere versie
  ```json
  { "error": "stale_write", "current": { /* huidig kaart-object */ } }
  ```

---

### DELETE `/cards/:id`
Soft-delete: zet `deleted_at` op de huidige tijd. De kaart verschijnt niet meer in normale GET-responses, maar wel in `/sync/changes`.

**Cascade:** het voortgangsrecord van deze kaart wordt mee-gesoftdelete (`deleted_at` gezet). Het verschijnt daarmee in `/sync/changes` met `deleted_at != null` — behandel het als "verwijder het lokale voortgangsrecord" (zoals bij een progress-reset). Hierdoor telt een verwijderde kaart ook niet meer mee in de core-stats (`/review/core/summary`).

**Response `200`:**
```json
{ "message": "Card deleted" }
```

**Foutcodes:**
- `404` — kaart niet gevonden

---

### POST `/cards/bulk-delete`
Meerdere kaarten tegelijk soft-deleten (max **500** ids per request), in één transactie. Per kaart exact dezelfde semantiek als `DELETE /cards/:id`, inclusief de cascade: het voortgangsrecord van elke verwijderde kaart wordt mee-gesoftdelete, zodat het via `/sync/changes` en de core-stats correct verdwijnt.

**Idempotent en tolerant:** ids die niet bestaan, al soft-deleted zijn of van een andere gebruiker zijn worden **stilzwijgend genegeerd** (zelfde stijl als het `ids`-filter van `GET /stats/decks`). Er komt géén `404` voor individuele ids — bij een `200` mag de client de hele batch als geslaagd behandelen. Een tweede call met dezelfde ids geeft gewoon `200` met `"deleted": 0`.

**Request body:**
```json
{
  "card_ids": ["uuid", "uuid", "uuid"]
}
```

**Response `200`:**
```json
{
  "deleted": 3,
  "ids": ["uuid", "uuid", "uuid"]
}
```
`ids` bevat de ids die daadwerkelijk verwijderd zijn (genegeerde ids ontbreken).

**Realtime:** er wordt **één** `card_deleted`-event gebroadcast met als payload een array van `{ "id": "uuid", "deck_id": "uuid", "deleted_at": "…" }`-objecten voor alle daadwerkelijk verwijderde kaarten. Genegeerde ids zitten niet in de array; wordt er niets verwijderd, dan komt er geen event.

**Foutcodes:**
- `400` — `card_ids` ontbreekt, is leeg, of bevat meer dan 500 ids

---

## Review / Spaced Repetition (`/review`) 🔒

De frontend berekent zelf de SRS-logica (score, volgende due_date) en stuurt het resultaat op naar de backend. De backend slaat de voortgang op en beantwoordt vragen over welke kaarten wanneer herhaald moeten worden.

---

### GET `/review/due`
Kaarten die nu herhaald moeten worden (`due_date <= nu`), gesorteerd op oudste due_date. Max 50 per keer.

**Query params:**
- `deck_id` (optioneel) — filter op een specifiek deck
- `core=true` (optioneel) — alleen core-kaarten

**Response `200`:** array van kaarten inclusief voortgangsdata
```json
[
  {
    "id": "uuid",                    // kaart-id
    "deck_id": "uuid",
    "question": "...",
    "answer": "...",
    "created_at": "...",
    "updated_at": "...",
    "progress_id": "uuid",           // id van het voortgangsrecord
    "remote_score": 2,
    "stable_score": 3,
    "recent_score": 1,               // null als nog geen voortgang
    "due_date": "2024-01-01",
    "repetitions": "...",
    "is_core": true,
    "progress_updated_at": "..."
  }
]
```

---

### GET `/review/new`
Kaarten in een deck die nog nooit zijn beantwoord (geen record of lege `repetitions`). Max 50.

**Query params:**
- `deck_id` (verplicht)

**Response `200`:** array van kaart-objecten (zonder voortgangsdata)

**Foutcodes:**
- `400` — `deck_id` ontbreekt

---

### GET `/review/deck/:deck_id`
Alle kaarten in een deck, inclusief voortgangsdata. Kaarten zonder voortgang hebben `null` voor voortgangsvelden.

**Response `200`:**
```json
[
  {
    "id": "uuid",                    // kaart-id
    "deck_id": "uuid",
    "question": "...",
    "answer": "...",
    "created_at": "...",
    "updated_at": "...",
    "progress_id": "uuid",           // null als nog nooit geoefend
    "remote_score": 2,                  // null als nog nooit geoefend
    "stable_score": 3,                  // null als nog nooit geoefend
    "recent_score": 1,                  // null als nog nooit geoefend
    "due_date": "...",               // null als nog nooit geoefend
    "repetitions": "...",          // null als nog nooit geoefend
    "is_core": false,           // null als nog nooit geoefend
    "progress_updated_at": "..."     // null als nog nooit geoefend
  }
]
```

---

### GET `/review/deck/:deck_id/scores` 🔒
Lichte score-index van alle kaarten in één deck — alleen de scores en types per kaart, zonder kaart-tekst. Bedoeld om deck-gemiddelden exact te berekenen zonder de volledige kaartdata te laden. Read-only, niet gepagineerd, gesorteerd op `card_id`.

Bevat ook nog-nieuwe kaarten (`is_new = true`); voor die kaarten zijn de scores `null`.

**Response `200`:** array van score-objecten — één per kaart
```json
[
  {
    "card_id": "uuid",
    "deck_id": "uuid",
    "is_core": true,        // type-aanduiding (false als nog geen voortgangsrecord)
    "is_new": false,        // true = geen actief voortgangsrecord OF lege repetitions
    "remote_score": 2,      // null wanneer is_new = true
    "stable_score": 3,      // null wanneer is_new = true
    "recent_score": 1       // null wanneer is_new = true
  }
]
```

**Foutcodes:**
- `403` — het deck is niet van deze gebruiker
- `404` — het deck bestaat niet (of is verwijderd)

---

### GET `/review/progress/:card_id` 🔒
Eén kaart inclusief voortgangsdata, in exact dezelfde rijvorm als een element van GET `/review/deck/:deck_id` (dezelfde `FlashCard.fromJson`). Bedoeld voor de save_progress-merge in de client: die heeft vóór het uploaden van een review-antwoord alleen het server-log (`repetitions`) van déze kaart nodig, niet het complete deck.

**Response `200`:** één object (geen array) met dezelfde velden als `/review/deck/:deck_id`; voortgangsvelden zijn `null` als de kaart nog nooit geoefend is (of de voortgang gereset is).

**Foutcodes:**
- `403` — de kaart is niet van deze gebruiker
- `404` — de kaart bestaat niet (of is verwijderd, of het id is geen geldig uuid)

---

### POST `/review/progress`
Sla de voortgang op na het beantwoorden van een kaart. Ondersteunt twee modi:

**Modus 1 — volledige upsert** (na het beantwoorden van een kaart):
```json
{
  "card_id": "uuid",                        // verplicht
  "remote_score": 2,                        // verplicht — long-term (remote) score
  "stable_score": 3,                        // optioneel, standaard 0 — short-term (stable) score
  "recent_score": 1,                        // optioneel — weggelaten = bestaande waarde blijft staan
  "due_date": "2024-02-01",                 // verplicht — YYYY-MM-DD
  "repetitions": "...",                     // optioneel, standaard "" — intern formaat (max 2000 tekens), backend slaat op en geeft terug zonder te interpreteren
  "is_core": true,                          // optioneel — als weggelaten blijft de bestaande waarde behouden (eerste keer: false)
  "client_updated_at": "2024-01-01T00:00:00.000Z"  // optioneel — echo van de server-versie waarop deze write gebaseerd is (zie conflictcheck)
}
```
Werkt als upsert. `is_core` wordt alleen overschreven als het expliciet meegestuurd wordt. Modus 1 broadcast **geen** WebSocket-event; andere apparaten halen de wijziging op via `/sync/changes`.

**Modus 2 — alleen `is_core` aanpassen:**
```json
{
  "card_id": "uuid",                        // verplicht
  "is_core": true,                          // verplicht
  "client_updated_at": "2024-01-01T00:00:00.000Z"  // optioneel
}
```
Werkt als update — past alleen `is_core` aan op een bestaand voortgangsrecord. Alle andere velden blijven ongewijzigd.

Als `client_updated_at` meegestuurd wordt en de server heeft een nieuwere versie, wordt `409` teruggegeven. De conflict-check en de write zijn atomair (rij-lock in één transactie): twee apparaten die tegelijk schrijven kunnen elkaars voortgang niet meer stilzwijgend overschrijven.

Stuur als `client_updated_at` de **server-versie** waarop de write gebaseerd is: de `progress_updated_at` uit GET `/review/progress/:card_id` (of `updated_at` uit een eerdere POST-response) — géén device-kloktijd. De check is daarmee een zuivere compare-and-swap (servertijd vs. servertijd, klokverschillen irrelevant): rij ongewijzigd → geaccepteerd; tussentijds door een ander device beschreven → `409` met `current`, waarna de client server- en lokale log merge't. Alleen weglaten bij een eerste write (nog geen voortgangsrecord om te bewaken). Het reviewmoment zelf hoeft niet apart meegestuurd te worden: dat zit op dagniveau in de `repetitions`-log.

**Response `200`:** voortgangsobject
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "card_id": "uuid",
  "remote_score": 2,
  "stable_score": 3,
  "due_date": "2024-02-01",
  "repetitions": "...",
  "is_core": true,
  "updated_at": "2024-02-01T00:00:00.000Z",
  "deleted_at": null
}
```

**Foutcodes:**
- `400` — ontbrekende of ongeldige velden: scores moeten integers binnen de smallint-range zijn, `due_date`/`client_updated_at` geldige datums, `repetitions` max 2000 tekens, `is_core` een boolean
- `403` — kaart is niet van deze gebruiker
- `404` — kaart niet gevonden (malformed card_id), of (modus 2) nog geen voortgangsrecord voor deze kaart
- `409` — conflict: de server heeft een nieuwere versie
  ```json
  { "error": "stale_write", "current": { /* huidig voortgangsobject */ } }
  ```

---

### DELETE `/review/progress/:card_id` 🔒
Reset de voortgang van één kaart voor de ingelogde gebruiker (soft-delete van het voortgangsrecord). De kaart zelf blijft bestaan en telt daarna weer als "nieuw".

Idempotent: ook als er geen (actief) voortgangsrecord was, is de response `200`.

**Response `200`:**
```json
{ "message": "Progress reset" }
```

**Foutcodes:**
- `403` — kaart is niet van deze gebruiker
- `404` — kaart bestaat niet

**Sync naar andere apparaten:** het voortgangsrecord krijgt `deleted_at` gezet en verschijnt daarmee in `/sync/changes`. Clients moeten een progress-record met `deleted_at != null` behandelen als "verwijder het lokale voortgangsrecord van deze kaart". **Let op:** de overige velden van zo'n record (`remote_score`, `due_date`, `repetitions`, …) bevatten nog de oude waarden van vóór de reset — die dus niet toepassen. Daarnaast wordt realtime het WebSocket-event `progress_deleted` gebroadcast.

Een nieuwe review van dezelfde kaart (POST `/review/progress`) maakt het record weer actief (`deleted_at` wordt `null`); de server behoudt daarbij de bestaande `is_core`-waarde van het record, tenzij `is_core` expliciet wordt meegestuurd.

---

### GET `/review/core/summary`
Overzicht van alle core-kaarten (`is_core = true`) van de gebruiker (over alle decks). Kaarten uit **inactieve** decks (`inactive = true`) en uit soft-deleted decks tellen **niet** mee. `core_only` speelt hier geen rol.

**Response `200`:**
```json
{
  "total_core_count": "14",     // totaal aantal core-kaarten
  "due_count": "3",             // core-kaarten met due_date <= nu
  "avg_remote_score": "2.71",   // gemiddelde remote_score (null als geen core-kaarten)
  "avg_stable_score": "1.50",   // gemiddelde stable_score (null als geen core-kaarten)
  "avg_recent_score": "1.20"    // gemiddelde recent_score (null als geen core-kaarten)
}
```

---

### GET `/review/core/scores` 🔒
Lichte score-index van alle core-kaarten (`is_core = true`) van de gebruiker, over alle decks. Zelfde vorm als `/review/deck/:deck_id/scores`. Bedoeld om het core-gemiddelde exact te berekenen zonder de volledige kaartdata te laden. Read-only, niet gepagineerd, gesorteerd op `card_id`. Kaarten uit **inactieve** decks (`inactive = true`) en uit soft-deleted decks worden **niet** teruggegeven; `core_only` heeft geen effect.

Bevat ook core-kaarten die nog nieuw zijn (`is_new = true`); voor die kaarten zijn de scores `null`.

**Response `200`:** array van score-objecten — één per core-kaart
```json
[
  {
    "card_id": "uuid",
    "deck_id": "uuid",
    "is_core": true,        // altijd true in deze response
    "is_new": false,        // true = lege repetitions (nog nooit beantwoord)
    "remote_score": 2,      // null wanneer is_new = true
    "stable_score": 3,      // null wanneer is_new = true
    "recent_score": 1       // null wanneer is_new = true
  }
]
```

---

### GET `/review/core` 🔒
Incrementele core-delta: de core-kaarten van de gebruiker (over alle decks) waarvan de voortgang is **gewijzigd sinds `since`**. Zelfde stijl als `/sync/changes` — niet de volledige lijst, alleen het verschil — en bedoeld om de core-set in de client incrementeel bij te werken. Read-only, niet gepagineerd.

**Query params:**
- `since` (optioneel) — ISO 8601 timestamp. Alleen records met `progress.updated_at > since` worden teruggegeven. Leeg of weggelaten = epoch, dus de eerste sync geeft alle huidige core-kaarten terug.

Er wordt **niet hard op `is_core` gefilterd**: per kaart komt de actuele `is_core` mee. `is_core = true` → kaart toevoegen aan / bijwerken in de core-set; `is_core = false` → kaart is geen core meer en mag uit de core-set verwijderd worden.

Kaarten uit **inactieve** decks (`inactive = true`) en uit soft-deleted decks worden **niet** teruggegeven (consistent met `/review/core/summary` en `/review/core/scores`). Let op: het inactief maken van een deck bumpt alleen `decks.updated_at`, niet `progress.updated_at`, dus zo'n deck verdwijnt niet via déze delta uit de core-set — de client leert de inactief-status via `/sync/changes` en filtert de core-set daar lokaal op. `core_only` heeft geen effect op dit endpoint.

De kaart-objecten hebben exact dezelfde veldnamen als `/review/due` en `/review/deck/:deck_id` (dezelfde `FlashCard.fromJson`).

**Response `200`:** object met `cards` (delta) + `server_time` (volgend watermerk)
```json
{
  "cards": [
    {
      "id": "uuid",
      "deck_id": "uuid",
      "question": "...",
      "answer": "...",
      "created_at": "...",
      "updated_at": "...",
      "progress_id": "uuid",
      "remote_score": 2,
      "stable_score": 3,
      "recent_score": 1,
      "due_date": "2024-01-01",
      "repetitions": "...",
      "is_core": true,                  // true = in core-set, false = uit core-set
      "progress_updated_at": "..."
    }
  ],
  "server_time": "2026-05-09T12:00:00.000Z"
}
```
Geen wijzigingen sinds `since` → `"cards": []` met status `200`, plus de actuele `server_time`. De client stuurt `server_time` mee als `since` bij de volgende call. Filter en `server_time` gebruiken dezelfde tijdsbron (DB-klok), zodat er geen wijzigingen tussen twee calls in wegvallen.

> **Overlap-venster:** `server_time` wordt vóór de data-query genomen en staat bewust enkele seconden (default 5, `SYNC_WATERMARK_OVERLAP_SECONDS`) in het verleden. Writes die rond het query-moment committen vallen daardoor gegarandeerd binnen het volgende delta-venster — maar rijen uit die laatste seconden kunnen dus **dubbel** geleverd worden. De client moet deltas idempotent verwerken (upsert op id); dat deed hij al.

**Full-resync-signaal:** net als `/sync/changes` heeft dit endpoint een resync-horizon (`SYNC_RESYNC_HORIZON_DAYS`, default 75 d). `/review/core` signaleert core-verwijderingen via `is_core = false`-flips; is `since` ouder dan de horizon — of ontbreekt/leeg (epoch, dus eerste sync) — dan kan zo'n flip al gepurged zijn. De server geeft dan **geen delta** maar:

```json
{ "full_resync": true, "server_time": "2026-05-09T12:00:00.000Z" }
```

De client moet dan zijn lokale core-set wegdoen en die volledig opnieuw opbouwen (bijv. via `/review/core/scores`), en `server_time` als nieuwe `since` bewaren. Een normale delta-response bevat het veld `full_resync` **niet**.

**Foutcodes:**
- `400` — `since` meegegeven maar geen geldige ISO 8601

---

### GET `/review/decks/summary`
Overzicht van alle decks met het aantal due kaarten en nieuwe kaarten. Handig voor het dashboard.

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "title": "Frans vocabulaire",
    "tags": ["Frans", "vocabulaire"],
    "inactive": false,         // gearchiveerd? client verbergt dan het deck; sinds juli 2026 tellen ook de core-kaarten niet meer mee in /review/core*
    "due_count": "5",          // kaarten met due_date <= nu
    "new_count": "12",         // kaarten die nog nooit zijn beantwoord (repetitions leeg of geen record)
    "total_count": "20",       // totaal aantal kaarten in het deck
    "core_total_count": "3",   // totaal aantal core-kaarten in het deck (is_core = true, incl. nieuwe)
    "core_due_count": "1",     // core-kaarten met due_date <= vandaag (al beoordeeld)
    "core_new_count": "1",     // core-kaarten die nog nieuw zijn (nooit beantwoord)
    "avg_remote_score": "2.71",   // gemiddelde remote_score van geoefende kaarten (null als geen)
    "avg_stable_score": "1.50",   // gemiddelde stable_score van geoefende kaarten (null als geen)
    "created_at": "2024-01-01T00:00:00.000Z", // aanmaakdatum van het deck
    "last_reviewed_at": "2026-05-20"          // datum van de meest recente review-sessie (null als nooit)
  }
]
```

---

## Sync (`/sync`) 🔒

### GET `/sync/changes`
Geeft alle decks, kaarten en voortgangsrecords terug die gewijzigd zijn na `since`. Inclusief soft-deleted items (zodat de client lokaal kan verwijderen). Gefilterd op de ingelogde gebruiker.

**Query params:**
- `since` (optioneel) — ISO 8601 timestamp, bijv. `2026-05-01T00:00:00.000Z`

**Full-resync-signaal:** soft-deleted rijen (tombstones) worden server-side maar een beperkte tijd bewaard (`TOMBSTONE_RETENTION_DAYS`, default 90 d) en daarna hard verwijderd. Is `since` ouder dan de resync-horizon (`SYNC_RESYNC_HORIZON_DAYS`, default 75 d) — of ontbreekt/leeg, zoals bij een nieuwe installatie — dan kunnen er in dat venster al deletes gepurged zijn die de client nooit gezien heeft. De server geeft dan **geen delta** maar:

```json
{ "full_resync": true, "server_time": "2026-05-09T12:00:00.000Z" }
```

De client moet in dat geval zijn lokale state wegdoen en een **volledige** load doen (alle decks/kaarten/voortgang opnieuw ophalen), en `server_time` als nieuwe `since`-cursor bewaren. `server_time` komt uit de DB-klok, gelijk aan de normale response. Een delta-response (zie hieronder) bevat het veld `full_resync` **niet**.

**Response `200`:**
```json
{
  "server_time": "2026-05-09T12:00:00.000Z",
  "decks": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "title": "Frans vocabulaire",
      "description": "...",
      "is_public": false,
      "inactive": false,
      "core_only": false,
      "tags": ["frans"],
      "created_at": "...",
      "updated_at": "...",
      "deleted_at": null,
      "core_total_count": "3",   // totaal aantal core-kaarten in het deck (is_core = true)
      "core_due_count": "1",     // core-kaarten met due_date <= vandaag
      "core_new_count": "1"      // core-kaarten die nog nooit beoordeeld zijn
    }
  ],
  "cards": [
    {
      "id": "uuid",
      "deck_id": "uuid",
      "question": "...",
      "answer": "...",
      "created_at": "...",
      "updated_at": "...",
      "deleted_at": null
    }
  ],
  "progress": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "card_id": "uuid",
      "remote_score": 2,
      "stable_score": 3,
      "due_date": "...",
      "repetitions": "...",
      "is_core": true,
      "updated_at": "...",
      "deleted_at": null
    }
  ]
}
```

> **Progress-resets:** een progress-record met `deleted_at != null` betekent dat de voortgang van die kaart gereset is (via DELETE `/review/progress/:card_id`, mogelijk op een ander apparaat). Verwijder dan het lokale voortgangsrecord; de kaart telt weer als nieuw.

> **Overlap-venster:** `server_time` wordt vóór de data-queries genomen en staat bewust enkele seconden (default 5, `SYNC_WATERMARK_OVERLAP_SECONDS`) in het verleden. Writes die rond het query-moment committen vallen daardoor gegarandeerd binnen het volgende delta-venster — maar rijen uit die laatste seconden kunnen dus **dubbel** geleverd worden. De client moet deltas idempotent verwerken (upsert op id); dat deed hij al.

**Foutcodes:**
- `400` — `since` meegegeven maar geen geldig ISO 8601-formaat

---

## Statistieken (`/stats`) 🔒

Alle stats-endpoints vereisen authenticatie. Data is altijd gefilterd op de ingelogde gebruiker.

---

### POST `/stats/update`
Verwerk één beantwoorde kaart: tel delta's op in `deck_stats` en `user_daily_snapshot`. Wordt per kaart aangeroepen direct na het beantwoorden.

**Request body:**
```json
{
  "date": "2026-05-14",       // verplicht — lokale datum van de gebruiker (YYYY-MM-DD)
  "deck_id": "uuid",          // verplicht

  "deck_delta": {             // verplicht — counters (0 of 1) + huidige gemiddelde scores van dit deck
    "cards_practiced": 1,
    "cards_correct_first_try": 1,
    "core_cards_practiced": 0,
    "core_correct_first_try": 0,
    "total_cards": 42,               // optioneel — absoluut aantal kaarten in dit deck (overschrijft; weglaten = onveranderd)
    "total_core_cards": 18,          // optioneel — absoluut aantal core-kaarten in dit deck (overschrijft; weglaten = onveranderd)
    "avg_remote_score": 3.40,        // actuele gemiddelde remote_score over alle kaarten (overschrijft)
    "avg_stable_score": 1.80,        // actuele gemiddelde stable_score over alle kaarten (overschrijft)
    "avg_recent_score": 2.10,        // optioneel — gemiddelde recent_score over alle kaarten (weglaten = onveranderd)
    "avg_core_remote_score": 3.80,   // optioneel — gemiddelde remote_score over alleen core-kaarten
    "avg_core_stable_score": 2.40,   // optioneel — gemiddelde stable_score over alleen core-kaarten
    "avg_core_recent_score": 2.90    // optioneel — gemiddelde recent_score over alleen core-kaarten
  },

  "daily_delta": {            // optioneel — delta voor de dagelijkse user-totalen (0 of 1 per veld); alleen gebruikt als daily_snapshot meekomt
    "cards_practiced_today": 1,
    "correct_first_try_today": 1,
    "core_practiced_today": 0,
    "core_correct_first_try_today": 0
  },

  "daily_snapshot": {         // optioneel (deprecatiepad) — weggelaten = user_daily_snapshot niet bijwerken; nieuwe clients sturen dit niet meer
    "total_cards": 42,        // optioneel — weglaten als onveranderd (bijv. bij reviews)
    "total_core_cards": 18,    // optioneel — weglaten als onveranderd
    "avg_remote_score": 3.40,        // gemiddelde remote_score over alle kaarten (overschrijft)
    "avg_stable_score": 1.80,        // gemiddelde stable_score over alle kaarten (overschrijft)
    "avg_recent_score": 2.10,        // optioneel — gemiddelde recent_score over alle kaarten (weglaten = onveranderd)
    "avg_core_remote_score": 3.80,   // optioneel — gemiddelde remote_score over alleen core-kaarten
    "avg_core_stable_score": 2.40,   // optioneel — gemiddelde stable_score over alleen core-kaarten
    "avg_core_recent_score": 2.90    // optioneel — gemiddelde recent_score over alleen core-kaarten
  }
}
```

**Response `200`:**
```json
{
  "deck_stats": {
    "id": "uuid",
    "user_id": "uuid",
    "deck_id": "uuid",
    "date": "2026-05-14",
    "cards_practiced": 5,
    "cards_correct_first_try": 3,
    "core_cards_practiced": 2,
    "core_correct_first_try": 1,
    "total_cards": 42,
    "total_core_cards": 18,
    "avg_remote_score": "3.40",
    "avg_stable_score": "1.80",
    "avg_recent_score": "2.10",
    "avg_core_remote_score": "3.80",
    "avg_core_stable_score": "2.40",
    "avg_core_recent_score": "2.90",
    "updated_at": "2026-05-14T14:32:00.000Z"
  },
  "daily_snapshot": {
    "id": "uuid",
    "user_id": "uuid",
    "date": "2026-05-14",
    "total_cards": 42,
    "total_core_cards": 18,
    "cards_practiced_today": 5,
    "correct_first_try_today": 3,
    "core_practiced_today": 2,
    "core_correct_first_try_today": 1,
    "avg_remote_score": "3.40",
    "avg_stable_score": "1.80",
    "avg_recent_score": "2.10",
    "avg_core_remote_score": "3.80",
    "avg_core_stable_score": "2.40",
    "avg_core_recent_score": "2.90",
    "updated_at": "2026-05-14T14:32:00.000Z"
  }
}
```

`total_cards`/`total_core_cards` op `deck_stats` zijn de per-deck deckgroottes op die datum; ze zijn `null` zolang ze nog nooit gezet zijn (geen backfill). Wordt `daily_snapshot` weggelaten, dan blijft `user_daily_snapshot` ongemoeid en is `daily_snapshot` in de response `null`.

**Validatie:** de tellervelden (`cards_practiced`, `cards_correct_first_try`, `core_*`, `*_today`) moeten niet-negatieve integers zijn (max 10000 per request) — negatieve of absurde deltas zouden de cumulatieve tellers permanent corrumperen. `total_cards`/`total_core_cards` zijn niet-negatieve integers; de `avg_*`-velden eindige getallen; `date` een geldige datum.

**Foutcodes:**
- `400` — ontbrekende velden (`date`, `deck_id` of `deck_delta`) of een veld dat de validatie hierboven niet haalt
- `403` — deck is niet van deze gebruiker (ook bij een malformed deck_id)

---

### GET `/stats/changes` 🔒
Incrementele stats-delta: alle `deck_stats`- en `user_daily_snapshot`-rijen van de gebruiker die **gewijzigd zijn sinds `since`**. Zelfde stijl als `/review/core` en `/sync/changes` — niet de volledige lijst, alleen het verschil — bedoeld om de stats op andere apparaten incrementeel bij te werken. **Aparte cursor**, los van `/sync/changes`. Read-only, niet gepagineerd.

Alleen levende rijen worden teruggegeven; er is **geen soft-delete**. Een `deck_stats`-rij verdwijnt alleen als het deck verdwijnt, en deck-deletes lopen al via `/sync/changes` — de client ruimt de bijbehorende lokale stats-orphans zelf op.

**Query params:**
- `since` (optioneel) — ISO 8601 timestamp. Alleen rijen met `updated_at > since` (strikt `>`) worden teruggegeven. Leeg of weggelaten = epoch, dus de eerste sync geeft de volledige historie terug.

De rij-objecten hebben exact dezelfde veldnamen als `/stats/deck/:deckId` (`deck_stats`) en `/stats/daily` (`daily_snapshots`). De `avg_core_*`-velden zijn `null` als er geen core-kaarten geoefend zijn (niet `0`). `deck_stats.total_cards`/`total_core_cards` zijn `null` voor rijen waar ze nog nooit gezet zijn. `date` is `YYYY-MM-DD`.

> **Deprecatie:** `daily_snapshots` blijft voorlopig in de response staan, maar nieuwe clients berekenen de "all decks"-statistieken door `deck_stats` te aggregeren (gewogen op `total_cards` per datum) en lezen `user_daily_snapshot` niet meer. Zodra oude clients uitgefaseerd zijn vervalt `daily_snapshots` hier en wordt de tabel gedropt.

**Response `200`:** object met `deck_stats` + `daily_snapshots` (delta) + `server_time` (volgend watermerk)
```json
{
  "deck_stats": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "deck_id": "uuid",
      "date": "2026-06-25",
      "cards_practiced": 5,
      "cards_correct_first_try": 3,
      "core_cards_practiced": 2,
      "core_correct_first_try": 1,
      "total_cards": 42,
      "total_core_cards": 18,
      "avg_remote_score": "3.40",
      "avg_stable_score": "1.80",
      "avg_recent_score": "2.10",
      "avg_core_remote_score": null,
      "avg_core_stable_score": null,
      "avg_core_recent_score": null,
      "updated_at": "2026-06-25T10:00:00.000Z"
    }
  ],
  "daily_snapshots": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "date": "2026-06-25",
      "total_cards": 42,
      "total_core_cards": 18,
      "cards_practiced_today": 5,
      "correct_first_try_today": 3,
      "core_practiced_today": 2,
      "core_correct_first_try_today": 1,
      "avg_remote_score": "3.40",
      "avg_stable_score": "1.80",
      "avg_recent_score": "2.10",
      "avg_core_remote_score": null,
      "avg_core_stable_score": null,
      "avg_core_recent_score": null,
      "updated_at": "2026-06-25T10:00:00.000Z"
    }
  ],
  "server_time": "2026-06-25T10:00:01.000Z"
}
```
Geen wijzigingen sinds `since` → `"deck_stats": []` en `"daily_snapshots": []` met status `200`, plus de actuele `server_time`. De client stuurt `server_time` mee als `since` bij de volgende call. Filter en `server_time` gebruiken dezelfde tijdsbron (DB-klok); `updated_at` wordt server-side bij elke wijziging bijgewerkt, dus de client-klok is nooit de bron van het watermerk.

> **Overlap-venster:** `server_time` wordt vóór de data-queries genomen en staat bewust enkele seconden (default 5, `SYNC_WATERMARK_OVERLAP_SECONDS`) in het verleden. Writes die rond het query-moment committen vallen daardoor gegarandeerd binnen het volgende delta-venster — maar rijen uit die laatste seconden kunnen dus **dubbel** geleverd worden. De client moet deltas idempotent verwerken (upsert op id); dat deed hij al.

**Foutcodes:**
- `400` — `since` meegegeven maar geen geldige ISO 8601

---

### GET `/stats/decks`
Alle dagelijkse deck-statistieken van de gebruiker **in één request**, gegroepeerd per deck — de batch-variant van `GET /stats/deck/:deckId`. Bedoeld voor het dashboard: één call in plaats van één per deck.

**Query-parameters:**

| Parameter | Type | Verplicht | Beschrijving |
|-----------|------|-----------|--------------|
| `ids` | string | nee | Komma-gescheiden deck-UUID's. Weggelaten of leeg → alle levende decks van de gebruiker. |

Alleen **levende** (niet-verwijderde) decks van de ingelogde gebruiker tellen mee; verwijderde of andermans deck-id's in `ids` worden stilzwijgend genegeerd. Elk levend (gevraagd) deck krijgt een key in de response, ook als er nog geen stats-rijen zijn (lege array) — zo is "deck zonder stats" te onderscheiden van "deck niet teruggekregen".

**Response `200`:** object met per deck-id een array rij-objecten, per deck gesorteerd van nieuw naar oud. De rij-objecten zijn identiek aan die van `GET /stats/deck/:deckId`.
```json
{
  "3f2a...uuid": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "deck_id": "3f2a...uuid",
      "date": "2026-05-14",
      "cards_practiced": 5,
      "cards_correct_first_try": 3,
      "core_cards_practiced": 2,
      "core_correct_first_try": 1,
      "avg_remote_score": "3.40",
      "avg_stable_score": "1.80",
      "avg_recent_score": "2.10",
      "avg_core_remote_score": "3.80",
      "avg_core_stable_score": "2.40",
      "avg_core_recent_score": "2.90",
      "updated_at": "2026-05-14T14:32:00.000Z"
    }
  ],
  "9b1c...uuid": []
}
```

**Foutcodes:**
- `400` — `ids` meegegeven maar geen geldige komma-gescheiden UUID's

---

### GET `/stats/deck/:deckId`
Alle dagelijkse statistieken voor één deck, gesorteerd van nieuw naar oud. Meerdere decks nodig (bijv. dashboard)? Gebruik `GET /stats/decks` — één request voor alles. Een malformed of onbekend deck-id geeft een lege array.

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "user_id": "uuid",
    "deck_id": "uuid",
    "date": "2026-05-14",
    "cards_practiced": 5,
    "cards_correct_first_try": 3,
    "core_cards_practiced": 2,
    "core_correct_first_try": 1,
    "total_cards": 42,
    "total_core_cards": 18,
    "avg_remote_score": "3.40",
    "avg_stable_score": "1.80",
    "avg_recent_score": "2.10",
    "avg_core_remote_score": "3.80",
    "avg_core_stable_score": "2.40",
    "avg_core_recent_score": "2.90",
    "updated_at": "2026-05-14T14:32:00.000Z"
  }
]
```

---

### GET `/stats/daily`
Alle dagelijkse snapshots van de gebruiker, gesorteerd van nieuw naar oud. Gebruik `updated_at` om te bepalen of de lokale cache verouderd is.

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "user_id": "uuid",
    "date": "2026-05-14",
    "total_cards": 42,
    "total_core_cards": 18,
    "cards_practiced_today": 5,
    "correct_first_try_today": 3,
    "core_practiced_today": 2,
    "core_correct_first_try_today": 1,
    "avg_remote_score": "3.40",
    "avg_stable_score": "1.80",
    "avg_recent_score": "2.10",
    "avg_core_remote_score": "3.80",
    "avg_core_stable_score": "2.40",
    "avg_core_recent_score": "2.90",
    "updated_at": "2026-05-14T14:32:00.000Z"
  }
]
```

---

## Contacten (`/contacts`) 🔒

Vrienden op e-mailadres: je stuurt een uitnodiging, de ander accepteert of wijst af. Zolang niet geaccepteerd staat de relatie "in behandeling"; bij afwijzen verdwijnt hij aan beide kanten; bij accepteren zijn beide personen elkaars contact.

**Online-only — staat LOS van de sync-delta.** Contacten zitten **niet** in `GET /sync/changes`, kennen **geen** `deleted_at`/soft-delete en **geen** sync-watermerk. Een verwijderde relatie wordt **hard verwijderd**. De client leest de lijst via `GET /contacts` (bij opstart/hervatten) en verwerkt tussentijdse mutaties via de WebSocket-events `contact_invited` / `contact_accepted` / `contact_rejected`. Voor `contact_`-events schuift de client zijn sync-cursor bewust **niet** door.

### Het contact-object

Overal waar een contact wordt teruggegeven of ge-pusht, is dit het object, **berekend t.o.v. de gebruiker die het ontvangt**:

```json
{
  "id": "uuid",                 // relatie-id — hiermee doet de client accept/delete
  "user_id": "uuid",            // de ANDERE gebruiker (t.o.v. de ontvanger)
  "username": "niels",          // van die andere gebruiker
  "email": "niels@example.com", // van die andere gebruiker
  "status": "pending_outgoing", // zie afleiding
  "created_at": "2026-07-09T12:00:00.000Z"
}
```

**Afleiding van `status`** voor gebruiker U die het object ontvangt:
- relatie `accepted` → `"accepted"`
- relatie `pending` en U heeft uitgenodigd → `"pending_outgoing"`
- relatie `pending` en U moet nog reageren → `"pending_incoming"`

`user_id`/`username`/`email` zijn altijd die van de **andere** persoon dan U. Het relatie-`id` is voor beide gebruikers hetzelfde.

### GET `/contacts`
Alle relaties waarin de ingelogde gebruiker betrokken is (als uitnodiger óf uitgenodigde). Elk item als het contact-object hierboven, berekend t.o.v. de ingelogde gebruiker.

**Response `200`:** array van contact-objecten (leeg → `[]`).

### POST `/contacts`
Nodig iemand uit op e-mailadres.

**Request body:** `{ "email": "iemand@example.com" }`

Verwerking:
1. Zoek een gebruiker met dit e-mailadres (**case-insensitief**). Niet gevonden → `404` `{ "error": "user_not_found" }`.
2. Is dat de ingelogde gebruiker zelf → `400` `{ "error": "cannot_invite_self" }`. Ontbrekend/ongeldig e-mailformaat → `400` `{ "error": "invalid_email" }`.
3. Bestaat er al een relatie tussen dit paar (welke richting/status dan ook) → `409` `{ "error": "already_exists" }`.
4. Anders: maak de relatie aan (`pending`).

> **Let op — e-mail enumeration:** `404 user_not_found` onthult of een adres een account is. Dit wijkt bewust af van het anti-enumeration-gedrag bij `/auth/register` en `/auth/forgot-password`, omdat de contacten-UX ("geen gebruiker met dit adres") het nodig heeft. Bewust geaccepteerd.

**Response `201`:** het contact-object t.o.v. de **afzender** (`status: "pending_outgoing"`, `user_id` = de uitgenodigde).

**Realtime:** `contact_invited` naar **de uitgenodigde** (`pending_incoming`) én naar **de afzender zelf** (eigen andere devices, `pending_outgoing`) — elk in diens eigen perspectief.

### POST `/contacts/:id/accept`
Accepteer een openstaand **inkomend** verzoek. `:id` = relatie-id.

- Alleen toegestaan als de ingelogde gebruiker de uitgenodigde is van een `pending`-relatie. Onbekend / niet van jou (of jij bent de uitnodiger) → `404`. Relatie niet meer `pending` → `409` `{ "error": "not_pending" }`.
- Zet de relatie op `accepted`.

**Response `200`:** contact-object t.o.v. de accepteerder (`status: "accepted"`).

**Realtime:** `contact_accepted` naar **beide** gebruikers, elk met het object t.o.v. die gebruiker (beide `accepted`).

### DELETE `/contacts/:id`
Één call voor **afwijzen** (inkomend), **annuleren** (uitgaand) én **verwijderen** (bestaand contact). `:id` = relatie-id.

- Toegestaan als de ingelogde gebruiker bij de relatie betrokken is (elke status). Anders `404`.
- **Hard delete** van de relatie.

**Response `204`** (geen body).

**Realtime:** `contact_rejected` naar **de andere** gebruiker (én eigen andere devices) met payload `[ { "id": "<relatie-id>" } ]` — alleen het id volstaat; de client verwijdert de lokale rij daarmee.

---

## WebSocket (`/ws`)

Realtime push-notificaties voor alle schrijfoperaties. De server broadcast naar alle open verbindingen van dezelfde gebruiker.

### Verbinding maken

```
wss://<domein>/ws?token=<jwt>        (productie)
ws://localhost:3000/ws?token=<jwt>   (lokaal)
```

Het JWT-token wordt als query-parameter meegestuurd. Bij een ongeldig of ontbrekend token sluit de server de verbinding met sluitcode `4001`. Verloopt het token terwijl de verbinding openstaat, dan sluit de server de verbinding eveneens met `4001`. Bij `4001` moet de client **niet** automatisch reconnecten, maar opnieuw inloggen.

### Berichtformaat

Alle berichten zijn JSON. `payload` is **altijd een array van objecten**, ook als het event maar één item betreft:
```json
{
  "type": "event_type",
  "payload": [ /* array van objecten, ook bij één item */ ],
  "server_time": "2024-01-01T00:00:00.000Z"
}
```

Bulk-endpoints sturen dus **één** event met alle items in de array (geen event per item). Een lege array wordt nooit verstuurd: als een bulk-delete niets verwijdert, komt er geen event.

> **`server_time`** komt uit dezelfde klokbron als de REST-sync (de Postgres-`updated_at`/`deleted_at` van de payload-rijen, jongste van de batch, minus 1 ms), zodat de client hem veilig naar dezelfde `lastSync`-cursor kan schrijven als de `server_time` van `/sync/changes`. De 1 ms-marge zorgt dat rijen die in dezelfde DB-transactie zijn mee-gewijzigd (bijv. cascade-gesoftdeletete voortgang bij een deck-delete, exact dezelfde timestamp) bij de volgende delta-sync nog binnen het `> since`-venster vallen.

### Eventtypen

| `type`            | Trigger                              | `payload` (array van …)          |
|-------------------|--------------------------------------|----------------------------------|
| `deck_created`    | POST `/decks`                        | volledige deck-objecten (incl. `inactive` en `core_only`) |
| `deck_updated`    | PUT `/decks/:id`                     | bijgewerkte deck-objecten (incl. `inactive` en `core_only`) |
| `deck_deleted`    | DELETE `/decks/:id` of POST `/decks/bulk-delete` (één event voor de hele batch) | `{ "id": "uuid", "deleted_at": "…" }` |
| `card_created`    | POST `/cards` of POST `/cards/bulk` (één event voor de hele batch) | volledige kaart-objecten |
| `card_updated`    | PUT `/cards/:id`                     | bijgewerkte kaart-objecten       |
| `card_deleted`    | DELETE `/cards/:id` of POST `/cards/bulk-delete` (één event voor de hele batch) | `{ "id": "uuid", "deck_id": "uuid", "deleted_at": "…" }` |
| `core_set`        | POST `/review/progress` (modus 2)    | voortgangsobjecten               |
| `progress_deleted`| DELETE `/review/progress/:card_id`   | voortgangsobjecten (met `deleted_at` gezet) |
| `contact_invited` | POST `/contacts`                     | contact-object (perspectief per ontvangende gebruiker) |
| `contact_accepted`| POST `/contacts/:id/accept`          | contact-object (`accepted`, perspectief per ontvanger) |
| `contact_rejected`| DELETE `/contacts/:id`               | `{ "id": "<relatie-id>" }`       |

> **Let op:** de payload-items van `core_set` en `progress_deleted` zijn voortgangsobjecten en bevatten dus **geen** `deck_id` — wel `card_id`. Clients die het bijbehorende deck nodig hebben, moeten dat lokaal opzoeken via de kaart. Bij `progress_deleted` bevatten de overige velden nog de oude waarden van vóór de reset; alleen de verwijdering toepassen.

### Ping/pong en berichten van de client

- De server beantwoordt WebSocket `ping`-frames altijd met een `pong`-frame. Gebruik dit om de verbinding levend te houden.
- De server stuurt zelf periodiek (elke ~30 s) een `ping`-frame en sluit verbindingen die niet binnen ~60 s ponggen. Native WebSocket-implementaties beantwoorden pings automatisch; daar hoeft de client niets voor te doen.
- Tekstberichten van de client maken geen deel uit van het protocol en worden genegeerd (ook onparseerbare, zoals de losse string `"ping"` van oudere clients); ze veroorzaken nooit een disconnect.

---

## Algemene foutresponses

| Status | Betekenis |
|--------|-----------|
| `400` | Ontbrekende of ongeldige velden |
| `401` | Niet ingelogd of token verlopen |
| `403` | Geen toegang (resource van andere gebruiker) |
| `404` | Resource niet gevonden |
| `409` | Conflict — server heeft een nieuwere versie (`stale_write`) |
| `426` | Clientversie te oud (`client_version_unsupported`) — update vereist |
| `429` | Te veel verzoeken (rate limit) |
| `500` | Serverfout |

Alle fouten hebben het formaat:
```json
{ "error": "Omschrijving van het probleem" }
```
