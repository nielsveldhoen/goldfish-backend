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

> **Wachtwoord-blocklist:** naast de lengte-eis (8–128) wordt het wachtwoord getoetst aan een lijst van veelgelekte wachtwoorden (`password123`, `welkom123`, `qwerty123`, …; case-insensitief). Staat het erop → `400` `{ "error": "This password is too common. Choose a less predictable password." }`. Er zijn **geen** complexity-regels (hoofdletters/cijfers/tekens). Dezelfde toets geldt bij de wachtwoord-reset.

**Foutcodes:**
- `400` — ontbrekende velden, wachtwoord korter dan 8 of langer dan 128 tekens, wachtwoord op de blocklist, e-mail/username boven de maximale lengte, of username al bezet (`"Username already taken"`, alleen wanneer het e-mailadres nog vrij is)

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
  "token": "eyJ...",
  "deletion_pending_until": "2026-07-26T00:00:00.000Z"   // alleen bij een openstaande verwijderaanvraag
}
```

> **`deletion_pending_until`** (alleen aanwezig bij een openstaande account-verwijdering, zie `DELETE /auth/me`): inloggen blijft tijdens de bedenktijd mogelijk. De client hoort dan een banner te tonen ("je account wordt op … gewist") met een knop naar `POST /auth/me/restore`.

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
- zet het nieuwe wachtwoord (8–128 tekens, en niet op de wachtwoord-blocklist — zie `POST /auth/register`),
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
  "username": "niels",
  "deletion_pending_until": "2026-07-26T00:00:00.000Z"   // alleen bij een openstaande verwijderaanvraag
}
```

---

### DELETE `/auth/me` 🔒
Vraag verwijdering van het eigen account aan (ACCOUNT_DELETION_PLAN.md). Het **wachtwoord moet mee in de body** als herbevestiging — een gestolen JWT kan hiermee dus geen account wissen.

Een geslaagde aanvraag:
- zet de bedenktijd-klok: het account wordt **definitief gewist na 14 dagen** (`ACCOUNT_DELETION_GRACE_DAYS`),
- **trekt alle JWT's in** (zelfde watermerk als `logout-all`) — elk apparaat is per direct uitgelogd,
- stuurt een bevestigingsmail met de wisdatum en de herstel-instructie.

Tijdens de bedenktijd kan de eigenaar gewoon opnieuw inloggen (de login-response bevat dan `deletion_pending_until`) en de aanvraag annuleren via `POST /auth/me/restore`. Nogmaals aanvragen reset de klok.

**Wat er bij de definitieve wis gebeurt:** alle persoonsgegevens (e-mail, username, wachtwoord, voortgang, contacten, groepslidmaatschappen) verdwijnen. Decks **zonder** actieve volgers verdwijnen mee. Decks **mét** actieve volgers blijven **eigenaarloos** bestaan: volgers houden het deck, hun voortgang en een eventueel edit-recht; `owner_username` wordt `null` en het deck is niet langer publiek vindbaar. Groepen van de gebruiker worden opgeheven (leden krijgen `group_removed`/`deck_removed`).

**Rate limit:** 20 verzoeken per 15 minuten.

**Request body:**
```json
{ "password": "geheimwachtwoord" }
```

**Response `200`:**
```json
{
  "message": "Account deletion scheduled",
  "deletion_pending_until": "2026-07-26T00:00:00.000Z"
}
```

**Foutcodes:**
- `400` — wachtwoord ontbreekt
- `401` — wachtwoord onjuist (of token al ongeldig)

---

### POST `/auth/me/restore` 🔒
Annuleer een openstaande verwijderaanvraag. Vereist een geldige login van ná de aanvraag (de aanvraag zelf trok alle tokens in, dus wie hier komt heeft het wachtwoord opnieuw bewezen).

**Response `200`:**
```json
{ "message": "Account deletion cancelled" }
```

**Foutcodes:**
- `409` — `no_pending_deletion`: er staat geen verwijderaanvraag open

---

## Decks (`/decks`) 🔒

Alle deck-endpoints vereisen authenticatie. Gebruikers zien hun **eigen decks én de decks die met hen gedeeld zijn** (zie [Delen](#delen--publieke-bibliotheek-🔒)). Schrijven (deck/kaarten bewerken of verwijderen) kan alleen de eigenaar.

### GET `/decks`
Alle decks waar de ingelogde gebruiker toegang toe heeft (eigen + gedeeld), gesorteerd op aanmaakdatum (nieuwste eerst). Soft-deleted decks worden niet teruggegeven.

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
    "deleted_at": null,
    "role": "owner",              // "owner" | "recipient" — puur weergave
    "owner_username": "niels",    // username van de eigenaar
    "can_edit": true              // stuurt ALLE bewerk-guards in de client
  }
]
```

> **`role` / `owner_username` / `can_edit`** (sinds de sharing-release; `can_edit` écht sinds de edit-rechten-release/migratie 019): `can_edit` is de capability-vlag waar de client zijn **kaart**-bewerk-UI en write-queue-guards op stuurt. Voor de eigenaar altijd `true`; voor een recipient `true` zodra de eigenaar hem edit-recht gaf (`PUT /decks/:id/permissions/:user_id`) — dat betekent **volledig kaartbeheer** (kaarten aanmaken/bewerken/verwijderen), maar **géén** deck-writes: `PUT/DELETE /decks/:id` blijven owner-only. Eigenaarschap-beslissingen (deck verwijderen vs. van dashboard halen, archiefvlag via deck-PUT vs. share-state, delen, catalogus) moet de client dus op `role` keyen, **niet** op `can_edit`. `owner_username` is weergave (badge "gedeeld door X").
>
> **Eigenaarloze decks** (sinds de account-deletion-release/migratie 020): verwijdert een eigenaar zijn deck of account terwijl anderen het actief volgen, dan blijft het deck bestaan **zonder eigenaar** — `user_id` en `owner_username` zijn dan `null`, iedereen heeft `role: "recipient"`, en bestaande `can_edit`-rechten blijven werken. Toon in dat geval "verwijderde gebruiker" als eigenaar. Niemand kan zo'n deck nog hernoemen, delen of publiek maken; een dagelijkse sweep ruimt het op zodra de laatste volger afhaakt.
>
> **`inactive` voor recipients:** bij een gedeeld deck bevat `inactive` de archiefvlag van de **ontvanger zelf** (gezet via `PUT /decks/:id/share-state`), niet die van de eigenaar — archiveren van een gedeeld deck raakt de eigenaar dus niet, en andersom.

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

**`is_public` is onomkeerbaar** (owner-only, zoals alle deck-metadata): een deck publiek maken kan (`is_public: true`, idempotent), maar een publiek deck terug privé zetten wordt geweigerd met `400` `is_public_irreversible`. Een publiek deck uit de bibliotheek halen kan alleen door het deck te verwijderen.

Als `client_updated_at` meegestuurd wordt en de server heeft een nieuwere versie, wordt `409` teruggegeven. De conflict-check en de update zijn atomair (rij-lock in één transactie): twee apparaten die tegelijk schrijven kunnen elkaars write niet meer stilzwijgend overschrijven.

**Response `200`:** bijgewerkt deck-object

**Foutcodes:**
- `400` — veld boven de maximale lengte of van het verkeerde type (zelfde limieten als `POST /decks`), of `{ "error": "is_public_irreversible" }` bij `is_public: false` op een publiek deck
- `404` — deck niet gevonden (ook bij een malformed id)
- `409` — conflict: de server heeft een nieuwere versie
  ```json
  { "error": "stale_write", "current": { /* huidig deck-object */ } }
  ```

---

### DELETE `/decks/:id`
Het gedrag hangt af van of het deck **actieve volgers** heeft (geaccepteerde, niet-ingetrokken shares — pending uitnodigingen tellen niet):

**Zonder volgers — soft-delete:** zet `deleted_at` op de huidige tijd. Het deck verschijnt niet meer in normale GET-responses, maar wel in `/sync/changes`.

**Cascade:** de voortgangsrecords van alle kaarten in dit deck worden mee-gesoftdelete (`deleted_at` gezet). Ze verschijnen daarmee in `/sync/changes` met `deleted_at != null` — behandel ze als "verwijder het lokale voortgangsrecord" (zoals bij een progress-reset). Hierdoor tellen kaarten in een verwijderd deck ook niet meer mee in de core-stats (`/review/core/summary`).

**Mét volgers — orphan:** het deck wordt **niet** verwijderd maar eigenaarloos gemaakt (`user_id`/`owner_username` → `null`, `is_public` → `false`). Volgers en editors houden alles; alleen de eigen voortgang van de ex-eigenaar wordt gesoftdelete. Voor de ex-eigenaar verdwijnt het deck: zijn devices krijgen een `deck_removed`-event en zijn (offline) apparaten zien het deck in `removed_deck_ids` van `/sync/changes`. De client hoort vóór deze call te waarschuwen ("N mensen gebruiken dit deck; het blijft voor hen beschikbaar").

**Response `200`:**
```json
{ "message": "Deck deleted", "orphaned": false, "subscribers": 0 }
```
of
```json
{ "message": "Deck released", "orphaned": true, "subscribers": 3 }
```

**Foutcodes:**
- `404` — deck niet gevonden

---

### POST `/decks/bulk-delete`
Meerdere decks tegelijk verwijderen (max **100** ids per request), in één transactie. Per deck exact dezelfde semantiek als `DELETE /decks/:id`, inclusief de orphan-splitsing (decks met actieve volgers worden eigenaarloos i.p.v. verwijderd) en de cascade: de voortgangsrecords van alle kaarten in elk verwijderd deck worden mee-gesoftdelete, zodat ze via `/sync/changes` en de core-stats correct verdwijnen.

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
  "ids": ["uuid", "uuid"],
  "orphaned_ids": ["uuid"]
}
```
`ids` bevat de ids die daadwerkelijk verwerkt zijn (genegeerde ids ontbreken); `orphaned_ids` is de deelverzameling die eigenaarloos werd i.p.v. verwijderd. Voor de aanroeper is het effect gelijk: al deze decks zijn van zíjn dashboard verdwenen.

**Realtime:** er wordt **één** `deck_deleted`-event gebroadcast met als payload een array van `{ "id": "uuid", "deleted_at": "…" }`-objecten voor alle daadwerkelijk soft-deleted decks, plus **één** `deck_removed`-event (payload `{ "id": "uuid" }`-objecten) voor de geörphande decks. Genegeerde ids zitten niet in de arrays; wordt er niets verwijderd, dan komt er geen event.

**Foutcodes:**
- `400` — `deck_ids` ontbreekt, is leeg, of bevat meer dan 100 ids

---

## Kaarten (`/cards`) 🔒

Alle card-endpoints vereisen authenticatie. Lezen kan in elk deck waar de gebruiker toegang toe heeft (eigen + gedeeld). **Schrijven** (aanmaken, bewerken, verwijderen, bulk) kan in eigen decks én in gedeelde decks waar de eigenaar de gebruiker **edit-recht** gaf (`can_edit`, zie `PUT /decks/:id/permissions/:user_id`); zonder dat recht geven card-writes `403`/`404` zoals voorheen.

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
- `403` — geen schrijfrecht op dit deck: geen eigenaar en geen `can_edit` (ook bij een malformed deck_id)

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
- `403` — geen schrijfrecht op dit deck: geen eigenaar en geen `can_edit` (ook bij een malformed deck_id)

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

**Idempotent en tolerant:** ids die niet bestaan, al soft-deleted zijn of in een deck zitten waar de gebruiker geen schrijfrecht op heeft worden **stilzwijgend genegeerd** (zelfde stijl als het `ids`-filter van `GET /stats/decks`). Er komt géén `404` voor individuele ids — bij een `200` mag de client de hele batch als geslaagd behandelen. Een tweede call met dezelfde ids geeft gewoon `200` met `"deleted": 0`.

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

Sinds SRS v3 is `due_date` een **volledige ISO-8601 UTC-timestamp op een heel uur** (kolomtype `timestamptz`, migratie 021); kaarten verlopen daardoor per uur i.p.v. per dag. De vergelijking is overal `due_date <= NOW()`. Een kale `YYYY-MM-DD` van een oudere client blijft geaccepteerd en wordt gelezen als 00:00 UTC.

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
    "due_date": "2024-01-01T14:00:00.000Z",
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
  "due_date": "2024-02-01T14:00:00.000Z",   // verplicht — ISO-8601 UTC-timestamp op een heel uur (kale YYYY-MM-DD van oudere clients → 00:00 UTC)
  "repetitions": "...",                     // optioneel, standaard "" — intern formaat (max 4000 tekens), backend slaat op en geeft terug zonder te interpreteren
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
  "due_date": "2024-02-01T14:00:00.000Z",
  "repetitions": "...",
  "is_core": true,
  "updated_at": "2024-02-01T00:00:00.000Z",
  "deleted_at": null
}
```

**Foutcodes:**
- `400` — ontbrekende of ongeldige velden: scores moeten integers binnen de smallint-range zijn, `due_date`/`client_updated_at` geldige datums/timestamps, `repetitions` max 4000 tekens, `is_core` een boolean
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
      "due_date": "2024-01-01T14:00:00.000Z",
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
    "core_due_count": "1",     // core-kaarten met due_date <= nu (al beoordeeld)
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
Geeft alle decks, kaarten en voortgangsrecords terug die gewijzigd zijn na `since`. Inclusief soft-deleted items (zodat de client lokaal kan verwijderen). Omvat naast eigen decks ook **met mij gedeelde decks** (zie [Delen](#delen--publieke-bibliotheek-🔒)); progress blijft strikt van de ingelogde gebruiker.

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
      "role": "owner",           // "owner" | "recipient"
      "owner_username": "niels",
      "can_edit": true,          // stuurt alle bewerk-guards in de client
      "core_total_count": "3",   // totaal aantal core-kaarten in het deck (is_core = true)
      "core_due_count": "1",     // core-kaarten met due_date <= nu
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
  ],
  "removed_deck_ids": ["uuid"]
}
```

> **Gedeelde decks in de delta:** accepteer je een deck-uitnodiging, volg je een publiek deck of voeg je een groepsdeck toe, dan komt het deck **én al zijn kaarten integraal** mee in de eerstvolgende delta — ook al zijn hun `updated_at`'s ouder dan `since` (het nieuw-gedeeld-venster kijkt naar de share-rij). Een nog niet geaccepteerde uitnodiging reist **niet** mee. Voor recipients bevat `inactive` de eigen archiefvlag (share-state), niet die van de eigenaar, en `can_edit` het effectieve edit-recht — een toggle door de eigenaar (`PUT /decks/:id/permissions/:user_id`) bumpt de share-rij en brengt het deck dus vanzelf met de nieuwe `can_edit` in de delta.
>
> **`removed_deck_ids`:** decks waarvoor de toegang sinds `since` is **ingetrokken** (revoke door de eigenaar, zelf ontvolgd, kick uit een groep, groep opgeheven). Er is dan geen tombstone — het deck bestaat nog bij de eigenaar. De client verwijdert deck + kaarten + eigen progress lokaal. Alleen decks zonder énige resterende toegangsbron staan erin. Bij `full_resync` is dit veld irrelevant (de client herbouwt toch alles). Oudere clients mogen het veld negeren.

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

> **Let op — e-mail enumeration:** `404 user_not_found` onthult of een adres een account is. Dit wijkt bewust af van het anti-enumeration-gedrag bij `/auth/register` en `/auth/forgot-password`, omdat de contacten-UX ("geen gebruiker met dit adres") het nodig heeft. Bewust geaccepteerd, maar **wel afgeremd**: zie de rate limit hieronder.

**Rate limit:** 30 verzoeken per 15 minuten, geteld **per gebruiker** (niet per IP). Overschrijding → `429` `{ "error": "Too many invitations, try again later" }`. Dezelfde limiter geldt voor `POST /decks/:id/share` en `POST /groups/:id/invites`.

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

## Delen & publieke bibliotheek 🔒

Decks worden **live** gedeeld — geen kopieën. Een recipient ziet hetzelfde deck en dezelfde kaarten als de eigenaar (read-only), met volledig eigen voortgang/scores (`user_card_progress` is per user). Eén toegangsmodel: een actieve, **geaccepteerde** rij in `deck_shares` = leestoegang, ongeacht de bron:

- **`invited`** — door de eigenaar met een **geaccepteerd contact** gedeeld. Begint als **uitnodiging** (`accepted_at = null`): de ontvanger accepteert of wijst af; tot die tijd géén toegang en reist het deck niet mee in de sync;
- **`subscribed`** — zelf gevolgd (publiek deck; eigen actie → direct geaccepteerd);
- **`group`** — zelf toegevoegd uit een groepscatalogus (eigen actie → direct geaccepteerd; zie [Groepen](#groepen-groups-🔒)).

Een recipient mag: alles lezen, eigen progress schrijven/resetten, eigen stats loggen, zijn eigen archiefvlag zetten en zelf afhaken. Writes op deck/kaarten geven `404` (zelfde als "bestaat niet") — **tenzij** de eigenaar hem **edit-recht** gaf (`can_edit`, per persoon per deck via `PUT /decks/:id/permissions/:user_id`): dan heeft hij volledig **kaartbeheer** (kaarten aanmaken/bewerken/verwijderen, incl. bulk; last-write-wins/`409 stale_write` zoals tussen eigen devices). Deck-writes (`PUT/DELETE /decks/:id`, bulk-delete, delen, catalogus) blijven altijd owner-only. Het recht zit op de share-rij en vervalt dus automatisch mee bij intrekken/afhaken/kick; bij her-delen/her-volgen/her-toevoegen ná een revoke begint de rij weer op `can_edit: false`.

### POST `/decks/:id/share`
Deel een eigen deck met een geaccepteerd contact. Maakt een **uitnodiging** aan (`accepted_at = null`): het deck verschijnt bij de ontvanger in de accepteer/afwijs-lijst (`GET /shares/received`), niet meteen op het dashboard.

**Request body:** `{ "recipient_id": "uuid" }` (het `user_id` uit het contact-object)

- Alleen de eigenaar; onbekend/andermans deck → `404`.
- `recipient_id` geen wederzijds geaccepteerd contact → `403` `{ "error": "not_a_contact" }`.
- Jezelf → `400` `{ "error": "cannot_share_with_self" }`.
- Her-delen na intrekken/afwijzen = upsert → nieuwe uitnodiging, met **gereset edit-recht** (`can_edit: false`). Her-delen van een nog openstaande of al geaccepteerde share verandert de status én het edit-recht niet (dubbel delen degradeert niets).

**Rate limit:** 30 verzoeken per 15 minuten **per gebruiker** (gedeeld met `POST /contacts` en `POST /groups/:id/invites`) → `429`.

**Response `201`:** de share-rij. **Realtime:** `share_received` naar de ontvanger — alleen zolang het een openstaande uitnodiging is.

### POST `/decks/:id/share/accept`
Ontvanger accepteert een openstaande uitnodiging. Deck + kaarten komen daarna integraal mee in de eerstvolgende sync-delta (nieuw-gedeeld-venster). Geen openstaande uitnodiging → `404`.

**Response `200`:** de share-rij. **Realtime:** `share_resolved` (`[ { "deck_id" } ]`) naar eigen andere devices. **Afwijzen** = `DELETE /decks/:id/follow` (zie hieronder).

### GET `/shares/received`
Mijn openstaande deck-uitnodigingen (de accepteer/afwijs-lijst): `[ { deck_id, deck_title, description, owner_username, created_at, card_count } ]`.

### DELETE `/decks/:id/share/:recipient_id`
Eigenaar trekt een directe share (invited/subscribed) of openstaande uitnodiging in. Idempotent → `204`. De progress van de recipient op dit deck wordt soft-deleted (tenzij een groepsshare de toegang nog draagt). **Realtime:** `deck_removed` naar de recipient.

### GET `/shares/sent`
Actieve directe shares op mijn decks (om in te trekken): `[ { deck_id, deck_title, recipient_id, recipient_username, kind, created_at, pending, can_edit } ]` — `pending: true` zolang de ontvanger de uitnodiging nog niet accepteerde. Geen e-mailadressen. Groepsshares lopen via de groep (zie `GET /shares/overview` voor het volledige beeld).

### GET `/shares/overview`
Met wie (personen én groepen) deel ik welke decks — het "Gedeeld met"-overzicht voor de eigenaar. Online-only (geen sync/Hive), usernames, nooit e-mailadressen.

**Response `200`:**
```json
[
  {
    "deck_id": "uuid",
    "deck_title": "Frans",
    "is_public": true,
    "people": [
      { "user_id": "uuid", "username": "anna",
        "direct": true,               // heeft een directe (contact)share
        "via_groups": ["Studieclub"], // groepsshares waarlangs ze het deck heeft
        "pending": false,             // true = nog géén enkele rij geaccepteerd
        "can_edit": true }            // effectief edit-recht (OR over de rijen)
    ],
    "groups": [
      { "group_id": "uuid", "name": "Studieclub",
        "members_with_deck": 3,       // leden die het catalogus-deck toevoegden
        "member_count": 7 }           // actieve leden totaal
    ],
    "follower_count": 12              // publieke volgers (alleen een aantal)
  }
]
```

- `people` is gededupliceerd per persoon over al zijn actieve rijen (direct + groepen); publieke volgers staan er **niet** in (alleen in `follower_count`).
- Decks zonder enige share/catalogus-vermelding/volger ontbreken.

### PUT `/decks/:id/permissions/:user_id`
Eigenaar geeft een persoon **edit-recht** op dit deck of trekt het in. Edit-recht = volledig **kaartbeheer** (kaarten aanmaken/bewerken/verwijderen, incl. bulk); deck-writes blijven owner-only.

**Request body:** `{ "can_edit": true }`

- Zet `can_edit` op **ál** iemands niet-gerevokete rijen op dit deck tegelijk (direct + groep), zodat het effectieve recht eenduidig is.
- Werkt ook op een nog openstaande uitnodiging (response: `"pending": true`) — het recht gaat dan in zodra de ontvanger accepteert.
- Publieke volgers (`kind: "subscribed"`) zijn uitgesloten → `404` (edit-recht loopt via een contact-share of groep).
- Alleen de eigenaar; onbekend/andermans deck of geen share-rij → `404`; `can_edit` geen boolean → `400`.

**Response `200`:** `{ "deck_id", "user_id", "can_edit", "pending" }`

**Realtime:** `deck_access_changed` (`[ { "deck_id", "can_edit" } ]`) naar de recipient (alleen als die het deck al heeft, dus minstens één geaccepteerde rij) en `shares_updated` (`[ { "deck_id" } ]`) naar de eigen andere devices. De recipient krijgt het deck bovendien met de bijgewerkte `can_edit` in zijn eerstvolgende sync-delta (de share-`updated_at` is gebumpt).

### GET `/decks/public`
Publieke bibliotheek (discovery), gepagineerd. Eigen decks worden uitgesloten.

**Query params:** `search` (**verplicht**, minimaal 2 tekens na trimmen; ILIKE-substring op titel + tags, dus ook het midden van een woord matcht), `limit` (default 20, max 50), `offset`.

**Response `200`:** `[ { id, title, description, tags, created_at, owner_username, card_count } ]`

**Foutcodes:** `400` `{ "error": "search_required" }` — geen of te korte zoekterm (er is bewust geen ongefilterde catalogus-listing); `400` `Invalid search` — zoekterm boven de maximale titellengte.

### POST `/decks/:id/follow` / DELETE `/decks/:id/follow`
Publiek deck volgen (`201`, share `kind: "subscribed"`, direct geaccepteerd) of een gedeeld deck van je dashboard halen (`204`). Follow op een niet-publiek/onbekend/eigen deck → `404`. **Unfollow geldt voor élke bron** (invited, subscribed én group) — een ontvanger mag altijd zelf afhaken — en is ook het **afwijzen van een openstaande uitnodiging**. Eigen progress op het deck wordt bij unfollow soft-deleted.

### PUT `/decks/:id/share-state`
Archiefvlag van de **ontvanger** op een gedeeld deck (het enige dat een recipient "schrijft").

**Request body:** `{ "inactive": true }` → **Response `200`:** `{ "deck_id": "…", "inactive": true }`. Geen actieve **geaccepteerde** share → `404`. **Realtime:** `shared_deck_state` naar eigen andere devices.

> `is_public` uitzetten bestaat niet meer: publiek maken is onomkeerbaar (`PUT /decks/:id` → `400` `is_public_irreversible`). Een individuele volger intrekken kan via `DELETE /decks/:id/share/:recipient_id`; het deck volledig terugtrekken kan alleen door het te verwijderen.

---

## Groepen (`/groups`) 🔒

Besloten clubs met een deelbare **join-code** (identificatie, niet geheim) en een **join-wachtwoord** (geheim, argon2-gehasht). Elke groep heeft een **deck-catalogus**: leden met `can_add_decks` zetten er eigen decks in, en elk lid kiest zélf welke catalogus-decks hij aan zijn dashboard toevoegt (opt-in) — pas dát geeft toegang (share `kind: "group"`).

**Online-only, zoals contacten:** groepen zitten **niet** in de sync-delta. De client leest `GET /groups` en verwerkt mutaties via de WS-events `group_updated` / `group_invite_received` / `group_removed`. In group-responses staan **nooit e-mailadressen** — alleen `user_id` + `username`.

### Het group-object

Eén canonieke vorm voor alle kijkers; de client leidt zijn eigen rol/rechten af uit `members[]` (hij kent zijn eigen `user_id`):

```json
{
  "id": "uuid",
  "name": "Studieclub",
  "description": null,
  "join_code": "K7NPQ2WX",
  "owner_id": "uuid",
  "created_at": "…",
  "updated_at": "…",
  "members": [
    { "user_id": "uuid", "username": "niels", "role": "owner",
      "status": "active", "can_add_decks": true, "created_at": "…" }
  ],
  "decks": [
    { "deck_id": "uuid", "title": "Frans", "description": null,
      "added_by": "uuid", "added_by_username": "anna",
      "added_at": "…", "card_count": "42" }
  ]
}
```

`status`: `"active"` of `"invited"` (aanvraag wacht op acceptatie). Het join-wachtwoord(-hash) komt nooit in een response.

### GET `/groups`
Alle groepen waar ik lid van ben, inclusief openstaande invites (mijn member-rij heeft dan `status: "invited"`).

### POST `/groups`
`{ "name": "…", "password": "…", "description?": "…" }` → `201` group-object. Wachtwoord min. 8 tekens. De maker wordt owner; de response bevat de gegenereerde `join_code`.

### POST `/groups/join`
`{ "code": "K7NPQ2WX", "password": "…" }` → `201` group-object. Onbekende code **én** fout wachtwoord geven allebei `404` `{ "error": "group_not_found" }` (geen onderscheid). Al lid → `409` `{ "error": "already_member" }`. Een openstaande invite wordt door een geslaagde join geactiveerd. **Zwaar rate-limited** (zelfde profiel als `/auth`). **Realtime:** `group_updated` naar alle leden.

### PUT `/groups/:id`
Owner: `{ "name?", "description?" }` → `200` group-object. **Realtime:** `group_updated`.

### PUT `/groups/:id/password`
Owner: `{ "password": "…" }` → `200`. Wissel het wachtwoord na een kick — anders joint het ex-lid gewoon opnieuw (de join-code blijft gelijk).

### DELETE `/groups/:id`
Owner heft de groep op → `204`. Alle groepsshares worden gerevoket (+ progress-cascade waar het de laatste toegangsbron was). **Realtime:** `group_removed` naar alle leden, `deck_removed` naar getroffen recipients.

### POST `/groups/:id/invites`
Actief lid nodigt een **eigen geaccepteerd contact** uit: `{ "user_id": "uuid" }` → `201`. Geen contact → `403` `{ "error": "not_a_contact" }`; al lid/uitgenodigd → `409`. **Rate limit:** 30 per 15 minuten **per gebruiker** (gedeeld met `POST /contacts` en `POST /decks/:id/share`) → `429`. **Realtime:** `group_invite_received` naar het doelwit, `group_updated` naar de leden.

### POST `/groups/:id/invites/accept` / DELETE `/groups/:id/invites`
De uitgenodigde accepteert (→ `200` group-object, lid wordt `active`) of wijst af (→ `204`, member-rij hard verwijderd). **Realtime:** `group_updated` resp. `group_removed` (eigen devices) + `group_updated` (leden).

### PUT `/groups/:id/members/:user_id`
Owner zet bevoegdheden: `{ "can_add_decks": false }` → `200` group-object. Niet op de owner zelf (→ `404`).

### DELETE `/groups/:id/members/:user_id`
Owner kickt een lid, óf een lid verlaat zelf (`:user_id` = eigen id) → `204`. De owner zelf → `400` `{ "error": "owner_cannot_leave" }` (die heft de groep op). Gevolgen: de groepsshares van het lid worden gerevoket **en zijn eigen toegevoegde decks gaan mee de groep uit** (incl. revoke bij alle leden). **Realtime:** `group_removed` naar het lid, `group_updated` naar de rest, `deck_removed` waar toegang verviel. De UI hoort de owner na een kick aan het wachtwoord-wisselen te herinneren.

### POST `/groups/:id/decks`
Actief lid met `can_add_decks` zet een **eigen** deck in de catalogus: `{ "deck_id": "uuid" }` → `201` group-object. Geen bevoegdheid → `403`; andermans/onbekend deck → `404`; al in de catalogus → `409`. **Realtime:** `group_updated`.

### DELETE `/groups/:id/decks/:deck_id`
De toevoeger (eigen deck terugtrekken) of de group-owner haalt een deck uit de catalogus → `204`. Revoket de groepsshares van alle leden op dit deck. **Realtime:** `group_updated` + `deck_removed`.

### POST `/groups/:id/decks/:deck_id/add`
Actief lid voegt een catalogus-deck aan zijn **eigen dashboard** toe → `201` share-rij (`kind: "group"`). Eigen deck → `400` `{ "error": "own_deck" }`. Het deck komt daarna binnen via de normale sync; weghalen = `DELETE /decks/:id/follow`.

---

## WebSocket (`/ws`)

Realtime push-notificaties voor alle schrijfoperaties. De server broadcast naar alle open verbindingen van dezelfde gebruiker. **Deck- en kaart-events fannen sinds de sharing-release ook uit naar alle actieve recipients** van het betreffende deck (`deck_updated`, `deck_deleted`, `card_created/updated/deleted`); `deck_created` en alle progress-/stats-events blijven per-user.

### Verbinding maken

Er zijn twee manieren om te authenticeren. **Voorkeur: het auth-bericht** — een query string belandt in de access-logs van de reverse proxy, een WebSocket-bericht niet.

**(a) Token als eerste bericht (aanbevolen):**
```
wss://<domein>/ws        (productie)
ws://localhost:3000/ws   (lokaal)
```
Stuur direct na `open` als eerste bericht:
```json
{ "type": "auth", "token": "<jwt>" }
```
De server heeft **5 seconden** om het auth-bericht te ontvangen; blijft het uit, dan sluit hij met `4001`. Vóór authenticatie worden andere berichten genegeerd (de timeout loopt door). Bij succes volgt geen bevestiging — de verbinding blijft simpelweg open en events beginnen te stromen.

**(b) Token in de query string (verouderd, blijft voorlopig werken):**
```
wss://<domein>/ws?token=<jwt>
```
Dit pad blijft ondersteund zolang er clients zijn die het gebruiken, maar verdwijnt zodra `min_client_build` de oude clients uitsluit. Nieuwe clients gebruiken (a).

**Sluitcodes:**

| Code | Betekenis | Reconnecten? |
|------|-----------|--------------|
| `4001` | Ongeldig, ontbrekend of verlopen token (ook: auth-timeout). Verloopt het token terwijl de verbinding openstaat, dan sluit de server eveneens met `4001`. | **Nee** — opnieuw inloggen |
| `4002` | Te veel gelijktijdige verbindingen voor deze gebruiker (max. 10); de **oudste** socket wordt gesloten om plaats te maken | Ja (met backoff) |
| `1009` | Bericht groter dan 64 KiB (`maxPayload`) | Ja |

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
| `share_received`  | POST `/decks/:id/share` (naar de ontvanger) | `{ "deck_id", "title", "owner_username" }` — **uitnodiging**: hoort in de accepteer/afwijs-lijst; het deck zelf komt pas na accepteren via de sync |
| `share_resolved`  | POST `/decks/:id/share/accept` (eigen andere devices) | `{ "deck_id" }` — uitnodiging is geaccepteerd: uit de pending-lijst halen en bijsyncen |
| `deck_removed`    | toegang verloren: share/uitnodiging ingetrokken, afgewezen, ontvolgd, kick, deck uit catalogus, groep opgeheven | `{ "id": "<deck-id>" }` — client verwijdert deck + kaarten + eigen progress lokaal (en haalt een eventuele uitnodiging uit de pending-lijst) |
| `shared_deck_state` | PUT `/decks/:id/share-state` (eigen andere devices) | `{ "id": "<deck-id>", "inactive": bool }` |
| `deck_access_changed` | PUT `/decks/:id/permissions/:user_id` (naar de recipient, alle devices) | `{ "deck_id", "can_edit": bool }` — client werkt de `can_edit` van het lokale deck bij |
| `shares_updated`  | PUT `/decks/:id/permissions/:user_id` (eigen andere devices van de owner) | `{ "deck_id" }` — hint om een open "Gedeeld met"-overzicht te verversen |
| `group_updated`   | elke groepsmutatie (join, invite, leden, bevoegdheden, catalogus, naam) — naar alle leden | volledig group-object (client upsert zijn Hive-box) |
| `group_invite_received` | POST `/groups/:id/invites` (naar het doelwit) | volledig group-object (eigen member-rij heeft `status: "invited"`) |
| `group_removed`   | je bent geen lid meer (kick, zelf verlaten, invite afgewezen, groep opgeheven) | `{ "id": "<group-id>" }` |

> **Let op — gedeelde decks:** de payload van `deck_updated`/`card_*` is de kale DB-rij (eigenaar-perspectief) en bevat **geen** `role`/`can_edit`/recipient-`inactive`. Een recipient-client moet die velden bij de merge uit zijn lokale deck behouden (de sync levert ze wél volledig geshaped).
>
> **Let op:** de payload-items van `core_set` en `progress_deleted` zijn voortgangsobjecten en bevatten dus **geen** `deck_id` — wel `card_id`. Clients die het bijbehorende deck nodig hebben, moeten dat lokaal opzoeken via de kaart. Bij `progress_deleted` bevatten de overige velden nog de oude waarden van vóór de reset; alleen de verwijdering toepassen.

### Ping/pong en berichten van de client

- De server beantwoordt WebSocket `ping`-frames altijd met een `pong`-frame. Gebruik dit om de verbinding levend te houden.
- De server stuurt zelf periodiek (elke ~30 s) een `ping`-frame en sluit verbindingen die niet binnen ~60 s ponggen. Native WebSocket-implementaties beantwoorden pings automatisch; daar hoeft de client niets voor te doen.
- Behalve het auth-bericht (zie "Verbinding maken") maken tekstberichten van de client geen deel uit van het protocol: ze worden genegeerd (ook onparseerbare, zoals de losse string `"ping"` van oudere clients) en veroorzaken nooit een disconnect.
- **Limieten:** berichten mogen maximaal **64 KiB** zijn (groter → close `1009`) en een gebruiker mag maximaal **10** gelijktijdige verbindingen open hebben (bij een 11e sluit de server de oudste met `4002`).

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

### Rate limits (overzicht)

Alle vensters zijn 15 minuten; overschrijding geeft `429`.

| Bereik | Limiet | Geteld per |
|--------|--------|------------|
| Hele `/v2`-API (vangnet) | 600 verzoeken | IP |
| `/auth/*` (register, login, resend, forgot) | 20 | IP |
| `/auth/reset-password`, `/auth/verify-email` (browser-flows) | 20 | IP |
| `POST /groups/join` | 20 | IP |
| `GET /decks/public` | 120 | IP |
| `POST /contacts`, `POST /decks/:id/share`, `POST /groups/:id/invites` | 30 | **gebruiker** |

De globale limiet van 600/15 min ligt ruim boven normaal client-gedrag (een actieve sessie doet er tientallen); een client die hem raakt, doet iets ongebruikelijks. De per-gebruiker-limiet op de uitnodigingsroutes remt zowel spam als het e-mail-orakel van `POST /contacts` af.
