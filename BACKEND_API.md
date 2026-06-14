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

## API-versionering

Alle endpoints zijn bereikbaar onder drie prefixen:

| Prefix | Veldnamen | Voor wie |
|---|---|---|
| *(geen)* — bijv. `/review/due` | oude namen (`ltm`/`stm`) | al uitgerolde appversies; identiek aan v1 |
| `/v1/...` | oude namen (`ltm`/`stm`) | expliciet v1 |
| `/v2/...` | nieuwe namen (`remote`/`stable`/`recent`) | nieuwe clients |

Beide versies werken op **dezelfde data**; de database houdt oude en nieuwe kolommen synchroon. Nieuwe clients gebruiken `/v2`.

**Veldnaam-mapping (v1 → v2):**

| v1 | v2 |
|---|---|
| `ltm_score` | `remote_score` |
| `stm_score` | `stable_score` |
| `ltm_cards_practiced` | `remote_cards_practiced` |
| `ltm_correct_first_try` | `remote_correct_first_try` |
| `avg_ltm_score` | `avg_remote_score` |
| `avg_stm_score` | `avg_stable_score` |
| `total_ltm_cards` | `total_remote_cards` |
| `total_ltm_count` | `total_remote_count` |
| — | `recent_score` *(nieuw, alleen v2)* |
| — | `avg_recent_score` *(nieuw, alleen v2)* |

**Alleen in v2 — `recent`:**
- `recent_score` (smallint, default 0) op het voortgangsobject. Optioneel bij `POST /v2/review/progress`; **weggelaten = waarde blijft onveranderd** (een v1-write reset `recent_score` dus ook niet).
- `avg_recent_score` (numeric, nullable) in `deck_delta`/`daily_snapshot` bij `POST /v2/stats/update` en in de stats-responses. Weggelaten = bestaande waarde blijft staan.
- v2-responses van `/review/due`, `/review/deck/:id`, `/review/progress`, `/sync/changes`, `/stats/*` en de summaries bevatten de recent-velden; v1-responses **niet**.

**Endpoint-alias:** `GET /review/ltm/summary` heet in v2 `GET /v2/review/remote/summary` (respons: `total_remote_count`, `due_count`, `avg_remote_score`, `avg_stable_score`, `avg_recent_score`). Het oude pad blijft onder alle prefixen werken.

**`GET /version`** (zonder auth) meldt de beschikbare versies en de ondergrens:
```json
{ "versions": ["v1", "v2"], "latest": "v2", "min": "v1" }
```

**Afsluiten van oude versies:** de server kan geconfigureerd worden met een minimumversie (`MIN_API_VERSION`). Calls naar een versie onder die grens — inclusief de ongeprefixte legacy-paden — krijgen dan op élk endpoint:

```json
HTTP 410 Gone
{ "error": "api_version_unsupported", "min_version": "v2" }
```

`GET /version` blijft altijd bereikbaar (en toont dan alleen nog de ondersteunde versies); clients horen bij het opstarten te checken of hun versie in `versions` staat en anders een update-melding te tonen.

**WebSocket:** de payloads van `/ws`-events (`progress_saved`, `core_set`, `progress_deleted`) bevatten **beide** naamsets (oud én nieuw, incl. `recent_score`). Clients moeten onbekende velden negeren en hun eigen naamset uitlezen.

> De rest van dit document beschrijft de endpoints met **v1-veldnamen**. Voor `/v2` geldt overal de bovenstaande naamtabel; verder zijn paden, statuscodes en semantiek identiek.

---

## Authenticatie (`/auth`)

### POST `/auth/register`
Registreer een nieuwe gebruiker. Na registratie wordt een verificatiemail gestuurd. De gebruiker kan pas inloggen nadat het e-mailadres is bevestigd.

**Rate limit:** 20 verzoeken per 15 minuten.

**Request body:**
```json
{
  "email": "user@example.com",
  "password": "geheimwachtwoord",   // minimaal 8 tekens
  "username": "niels"   // optioneel — wordt afgeleid van email als weggelaten
}
```

**Response `200`:**
```json
{
  "message": "Registration successful. Check your email to verify your account."
}
```

**Foutcodes:**
- `400` — ontbrekende velden, wachtwoord korter dan 8 tekens, of email/username bestaat al

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
- `401` — ongeldige inloggegevens
- `403` — e-mailadres nog niet geverifieerd

---

### GET `/auth/verify-email`
Bevestig het e-mailadres via de token uit de verificatiemail. Token is 24 uur geldig en single-use: na een geslaagde verificatie is hij verbruikt en geeft dezelfde link `400`.

**Query params:**
- `token` — de verificatietoken uit de mail

**Response `200`:**
```json
{
  "message": "Email verified successfully"
}
```

**Foutcodes:**
- `400` — token ontbreekt, ongeldig of verlopen

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
    "tags": ["frans", "vocabulaire"],
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-02T00:00:00.000Z",
    "deleted_at": null
  }
]
```

---

### GET `/decks/:id`
Eén deck ophalen. Soft-deleted decks geven een 404.

**Response `200`:** zie hierboven (enkel object)
**Foutcodes:**
- `404` — deck niet gevonden (of niet van deze gebruiker)

---

### POST `/decks`
Nieuw deck aanmaken.

**Request body:**
```json
{
  "title": "Frans vocabulaire",       // verplicht
  "description": "Basiswoorden",      // optioneel
  "is_public": false,                 // optioneel, standaard false
  "tags": ["frans", "school"]         // optioneel, standaard []
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
  "tags": ["frans", "school"],
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z",
  "deleted_at": null
}
```

**Foutcodes:**
- `400` — titel ontbreekt

---

### PUT `/decks/:id`
Deck bijwerken. Alleen meegestuurde velden worden bijgewerkt — niet-meegestuurde velden blijven ongewijzigd.

**Request body** (alle velden optioneel):
```json
{
  "title": "Nieuwe titel",
  "description": "Nieuwe omschrijving",
  "is_public": true,
  "tags": ["nieuw", "tag"],
  "client_updated_at": "2024-01-01T00:00:00.000Z"   // optioneel — ISO timestamp van de lokaal bekende versie
}
```

Als `client_updated_at` meegestuurd wordt en de server heeft een nieuwere versie, wordt `409` teruggegeven.

**Response `200`:** bijgewerkt deck-object

**Foutcodes:**
- `404` — deck niet gevonden
- `409` — conflict: de server heeft een nieuwere versie
  ```json
  { "error": "stale_write", "current": { /* huidig deck-object */ } }
  ```

---

### DELETE `/decks/:id`
Soft-delete: zet `deleted_at` op de huidige tijd. Het deck verschijnt niet meer in normale GET-responses, maar wel in `/sync/changes`.

**Response `200`:**
```json
{ "message": "Deck deleted" }
```

**Foutcodes:**
- `404` — deck niet gevonden

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
- `404` — kaart niet gevonden

---

### POST `/cards`
Nieuwe kaart aanmaken.

**Request body:**
```json
{
  "deck_id": "uuid",            // verplicht
  "question": "Wat is appel?",  // verplicht
  "answer": "pomme"             // verplicht
}
```

**Response `201`:** kaart-object

**Foutcodes:**
- `400` — ontbrekende velden
- `403` — deck is niet van deze gebruiker

---

### POST `/cards/bulk`
Meerdere kaarten tegelijk aanmaken in één deck. Alle kaarten worden in een transactie ingevoegd — als één mislukt worden geen kaarten aangemaakt.

**Request body:**
```json
{
  "deck_id": "uuid",
  "cards": [
    { "question": "Wat is appel?", "answer": "pomme" },
    { "question": "Wat is peer?",  "answer": "poire"  }
  ]
}
```

**Response `201`:** array van aangemaakte kaart-objecten

**Foutcodes:**
- `400` — ontbrekende velden of lege cards-array
- `403` — deck is niet van deze gebruiker

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

Als `client_updated_at` meegestuurd wordt en de server heeft een nieuwere versie, wordt `409` teruggegeven.

**Response `200`:** bijgewerkt kaart-object

**Foutcodes:**
- `404` — kaart niet gevonden
- `409` — conflict: de server heeft een nieuwere versie
  ```json
  { "error": "stale_write", "current": { /* huidig kaart-object */ } }
  ```

---

### DELETE `/cards/:id`
Soft-delete: zet `deleted_at` op de huidige tijd. De kaart verschijnt niet meer in normale GET-responses, maar wel in `/sync/changes`.

**Response `200`:**
```json
{ "message": "Card deleted" }
```

**Foutcodes:**
- `404` — kaart niet gevonden

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
    "ltm_score": 2,
    "stm_score": 3,
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
    "ltm_score": 2,                  // null als nog nooit geoefend
    "stm_score": 3,                  // null als nog nooit geoefend
    "due_date": "...",               // null als nog nooit geoefend
    "repetitions": "...",          // null als nog nooit geoefend
    "is_core": false,           // null als nog nooit geoefend
    "progress_updated_at": "..."     // null als nog nooit geoefend
  }
]
```

---

### POST `/review/progress`
Sla de voortgang op na het beantwoorden van een kaart. Ondersteunt twee modi:

**Modus 1 — volledige upsert** (na het beantwoorden van een kaart):
```json
{
  "card_id": "uuid",                        // verplicht
  "ltm_score": 2,                           // verplicht — long term memory score
  "stm_score": 3,                           // optioneel, standaard 0 — short term memory score
  "due_date": "2024-02-01",                 // verplicht — YYYY-MM-DD
  "repetitions": "...",                     // optioneel, standaard "" — intern formaat, backend slaat op en geeft terug zonder te interpreteren
  "is_core": true,                          // optioneel — als weggelaten blijft de bestaande waarde behouden (eerste keer: false)
  "client_updated_at": "2024-01-01T00:00:00.000Z"  // optioneel — ISO timestamp van de lokaal bekende versie
}
```
Werkt als upsert. `is_core` wordt alleen overschreven als het expliciet meegestuurd wordt.

**Modus 2 — alleen `is_core` aanpassen:**
```json
{
  "card_id": "uuid",                        // verplicht
  "is_core": true,                          // verplicht
  "client_updated_at": "2024-01-01T00:00:00.000Z"  // optioneel
}
```
Werkt als update — past alleen `is_core` aan op een bestaand voortgangsrecord. Alle andere velden blijven ongewijzigd.

Als `client_updated_at` meegestuurd wordt en de server heeft een nieuwere versie, wordt `409` teruggegeven.

**Response `200`:** voortgangsobject
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "card_id": "uuid",
  "ltm_score": 2,
  "stm_score": 3,
  "due_date": "2024-02-01",
  "repetitions": "...",
  "is_core": true,
  "updated_at": "2024-02-01T00:00:00.000Z",
  "deleted_at": null
}
```

**Foutcodes:**
- `400` — ontbrekende velden
- `403` — kaart is niet van deze gebruiker
- `404` — (modus 2) nog geen voortgangsrecord voor deze kaart
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

**Sync naar andere apparaten:** het voortgangsrecord krijgt `deleted_at` gezet en verschijnt daarmee in `/sync/changes`. Clients moeten een progress-record met `deleted_at != null` behandelen als "verwijder het lokale voortgangsrecord van deze kaart". **Let op:** de overige velden van zo'n record (`ltm_score`, `due_date`, `repetitions`, …) bevatten nog de oude waarden van vóór de reset — die dus niet toepassen. Daarnaast wordt realtime het WebSocket-event `progress_deleted` gebroadcast.

Een nieuwe review van dezelfde kaart (POST `/review/progress`) maakt het record weer actief (`deleted_at` wordt `null`); de server behoudt daarbij de bestaande `is_core`-waarde van het record, tenzij `is_core` expliciet wordt meegestuurd.

---

### GET `/review/ltm/summary`
Overzicht van alle LTM-kaarten van de gebruiker (over alle decks).

**Response `200`:**
```json
{
  "total_ltm_count": "14",   // totaal aantal LTM-kaarten
  "due_count": "3",          // LTM-kaarten met due_date <= nu
  "avg_ltm_score": "2.71",   // gemiddelde ltm_score (null als geen LTM-kaarten)
  "avg_stm_score": "1.50"    // gemiddelde stm_score (null als geen LTM-kaarten)
}
```

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
    "due_count": "5",          // kaarten met due_date <= nu
    "new_count": "12",         // kaarten die nog nooit zijn beantwoord (repetitions leeg of geen record)
    "total_count": "20",       // totaal aantal kaarten in het deck
    "avg_ltm_score": "2.71",   // gemiddelde ltm_score van geoefende kaarten (null als geen)
    "avg_stm_score": "1.50",   // gemiddelde stm_score van geoefende kaarten (null als geen)
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
- `since` (verplicht) — ISO 8601 timestamp, bijv. `2026-05-01T00:00:00.000Z`

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
      "tags": ["frans"],
      "created_at": "...",
      "updated_at": "...",
      "deleted_at": null
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
      "ltm_score": 2,
      "stm_score": 3,
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

**Foutcodes:**
- `400` — `since` ontbreekt of ongeldig formaat

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
    "ltm_cards_practiced": 0,
    "ltm_correct_first_try": 0,
    "avg_ltm_score": 3.40,    // actuele gemiddelde ltm_score van dit deck (overschrijft)
    "avg_stm_score": 1.80     // actuele gemiddelde stm_score van dit deck (overschrijft)
  },

  "daily_delta": {            // verplicht — delta voor de dagelijkse user-totalen (0 of 1 per veld)
    "cards_practiced_today": 1,
    "correct_first_try_today": 1,
    "core_practiced_today": 0,
    "core_correct_first_try_today": 0
  },

  "daily_snapshot": {         // verplicht — absolute waarden (overschrijven bestaande waarden)
    "total_cards": 42,        // optioneel — weglaten als onveranderd (bijv. bij reviews)
    "total_ltm_cards": 18,    // optioneel — weglaten als onveranderd
    "avg_ltm_score": 3.40,
    "avg_stm_score": 1.80
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
    "ltm_cards_practiced": 2,
    "ltm_correct_first_try": 1,
    "avg_ltm_score": "3.40",
    "avg_stm_score": "1.80",
    "updated_at": "2026-05-14T14:32:00.000Z"
  },
  "daily_snapshot": {
    "id": "uuid",
    "user_id": "uuid",
    "date": "2026-05-14",
    "total_cards": 42,
    "total_ltm_cards": 18,
    "cards_practiced_today": 5,
    "correct_first_try_today": 3,
    "core_practiced_today": 2,
    "core_correct_first_try_today": 1,
    "avg_ltm_score": "3.40",
    "avg_stm_score": "1.80",
    "updated_at": "2026-05-14T14:32:00.000Z"
  }
}
```

**Foutcodes:**
- `400` — ontbrekende velden
- `403` — deck is niet van deze gebruiker

---

### GET `/stats/deck/:deckId`
Alle dagelijkse statistieken voor één deck, gesorteerd van nieuw naar oud.

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
    "ltm_cards_practiced": 2,
    "ltm_correct_first_try": 1,
    "avg_ltm_score": "3.40",
    "avg_stm_score": "1.80",
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
    "total_ltm_cards": 18,
    "cards_practiced_today": 5,
    "correct_first_try_today": 3,
    "core_practiced_today": 2,
    "core_correct_first_try_today": 1,
    "avg_ltm_score": "3.40",
    "avg_stm_score": "1.80",
    "updated_at": "2026-05-14T14:32:00.000Z"
  }
]
```

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

Alle berichten zijn JSON:
```json
{
  "type": "event_type",
  "payload": { /* object */ },
  "server_time": "2024-01-01T00:00:00.000Z"
}
```

### Eventtypen

| `type`            | Trigger                              | `payload`                        |
|-------------------|--------------------------------------|----------------------------------|
| `deck_created`    | POST `/decks`                        | volledig deck-object             |
| `deck_updated`    | PUT `/decks/:id`                     | bijgewerkt deck-object           |
| `deck_deleted`    | DELETE `/decks/:id`                  | `{ "id": "uuid" }`              |
| `card_created`    | POST `/cards` of POST `/cards/bulk`  | volledig kaart-object            |
| `card_updated`    | PUT `/cards/:id`                     | bijgewerkt kaart-object          |
| `card_deleted`    | DELETE `/cards/:id`                  | `{ "id": "uuid", "deck_id": "uuid" }` |
| `progress_saved`  | POST `/review/progress` (modus 1)    | voortgangsobject                 |
| `core_set`        | POST `/review/progress` (modus 2)    | voortgangsobject                 |
| `progress_deleted`| DELETE `/review/progress/:card_id`   | voortgangsobject (met `deleted_at` gezet) |

> **Let op:** de payload van `progress_saved`, `core_set` en `progress_deleted` is het voortgangsobject en bevat dus **geen** `deck_id` — wel `card_id`. Clients die het bijbehorende deck nodig hebben, moeten dat lokaal opzoeken via de kaart. Bij `progress_deleted` bevatten de overige velden nog de oude waarden van vóór de reset; alleen de verwijdering toepassen.

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
| `429` | Te veel verzoeken (rate limit) |
| `500` | Serverfout |

Alle fouten hebben het formaat:
```json
{ "error": "Omschrijving van het probleem" }
```
