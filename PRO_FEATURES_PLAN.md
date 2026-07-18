# Abonnementen & pro-features — plan

Status: het **abonnementen-fundament is gebouwd** (migratie 022,
`src/config/products.js`, `src/utils/entitlements.js`,
`src/middleware/entitlements.js`, `routes/subscriptions.js`,
`entitlements` in `GET /auth/me`, `test/subscriptions.test.js`). De drie
pro-features zelf zijn nog **niet** gebouwd; dit plan beschrijft hoe ze
er straks in schuiven zonder grote verbouwing.

## Samenvatting

Een account kan **meerdere abonnementen** tegelijk hebben — in eerste
instantie drie producten, uitbreidbaar naar meer zonder migratie. De
pro-features:

1. **Spraakherkenning in alle talen** (`speech_recognition`)
2. **AI-gestuurde antwoordcontrole** (`ai_answer_check`)
3. **Examens inplannen + examentraining** (`exam_planning`)

## Kernbeslissingen (fundament, gebouwd)

1. **Product ≠ feature.** Een abonnement koopt een `product_key`; wat
   dat ontgrendelt (de **entitlements**) staat alleen in
   `src/config/products.js`. Routes checken uitsluitend op entitlement
   via `requireEntitlement("...")`. Nieuw product of bundel ("pro_all")
   = één regel in de catalogus, nul route-wijzigingen, geen DDL.
2. **"Actief" is berekend, geen status-kolom.** `started_at <= nu` en
   (`expires_at` leeg of toekomst). `canceled_at` is informatief:
   opzeggen stopt verlenging, de betaalde periode loopt door
   (app-store-semantiek). Historie blijft staan als losse rijen.
3. **Geen schrijf-endpoint voor clients.** Rijen ontstaan server-side:
   nu handmatig (SQL), later via betaalprovider-webhooks.
   `source`/`external_ref` (+ unieke index) liggen daarvoor klaar.
   Webhooks komen te zijner tijd **buiten `/v2`** te hangen (providers
   sturen geen `X-Client-Build`) — zelfde uitzondering als de
   reset-/verificatie-browserflows in `app.js`.
4. **403 met `code: "entitlement_required"`** + de ontbrekende
   entitlement, zodat de client een gerichte upgrade-prompt kan tonen.
   Fail-closed bij DB-storing (zelfde afweging als de revocatie-check).
5. **Client leest de toestand op twee plekken:** `entitlements` zit in
   `GET /auth/me` (voor het snelle pad bij opstart) en volledig in
   `GET /subscriptions` (voor een abonnementen-scherm incl. historie).

## Feature 1 — Spraakherkenning (`speech_recognition`)

Server-side proxy naar een STT-provider (bijv. OpenAI Whisper API,
Deepgram of Google STT — allemaal multi-language; keuze bij bouw). De
API-sleutel blijft op de server; de app stuurt audio, krijgt tekst.

- **Route:** `POST /v2/speech/transcribe` in nieuw
  `routes/speech.js` — `authMiddleware` →
  `requireEntitlement(ENTITLEMENTS.SPEECH_RECOGNITION)` → eigen
  limiter → provider-call.
- **Body:** audio is groter dan de JSON-limiet van 1 MB. De route
  krijgt een **eigen body-parser** (`express.raw` met bijv. 10 MB, of
  multipart) — alleen op dit pad, de globale 1 MB-limiet blijft staan.
  Parameters (taalhint, kaart-id) in de query of multipart-velden.
- **Response:** `{ "text": "...", "language": "nl" }` — de
  scoring blijft client-side zoals bij getypte antwoorden.
- **Provider-abstractie:** `src/utils/speechProvider.js` met één
  functie `transcribe(buffer, { language })`; providerkeuze via env
  (`SPEECH_PROVIDER`, `SPEECH_API_KEY`). Wisselen van provider raakt
  dan alleen dat bestand.
- **Kostenbewaking:** zie "Gebruiksmeting" hieronder.

## Feature 2 — AI-antwoordcontrole (`ai_answer_check`)

LLM beoordeelt of een (vrij geformuleerd of getranscribeerd) antwoord
inhoudelijk klopt met de achterkant van de kaart.

- **Route:** `POST /v2/ai/check-answer` in nieuw `routes/ai.js` —
  zelfde sandwich: auth → `requireEntitlement(ENTITLEMENTS.AI_ANSWER_CHECK)`
  → eigen limiter.
- **Body:** `{ "card_id": "uuid", "given_answer": "..." }`. De server
  haalt zelf voor/achterkant op (met de bestaande
  `canReadDeckSql`-toegangscheck uit `utils/deckAccess.js`) — de client
  kan dan niet een andere "verwachte tekst" meesturen dan wat op de
  kaart staat.
- **Response:** `{ "verdict": "correct" | "partial" | "incorrect",
  "explanation": "..." }`. De client vertaalt het verdict naar de
  bestaande score-invoer; het SRS-model verandert niet.
- **Provider-abstractie:** `src/utils/aiProvider.js`
  (`AI_PROVIDER`/`AI_API_KEY` in env), prompt op één plek. Let op:
  kaartinhoud is gebruikersdata — in de prompt behandelen als data,
  nooit als instructies.

## Feature 3 — Examenplanning (`exam_planning`)

Puur CRUD + bestaande data, geen externe provider. Een **examen** heeft
een datum en een set decks ("vragenlijsten"); de app toont of je op
schema ligt en biedt examentraining.

- **Datamodel (migratie 023):**
  - `exams`: `id`, `user_id`, `title`, `exam_date timestamptz`,
    `created_at/updated_at/deleted_at` — zelfde soft-delete +
    `set_updated_at`-patroon als `decks`.
  - `exam_decks`: `exam_id`, `deck_id`, `added_at` (uniek paar). Alleen
    decks waar de user leestoegang toe heeft (`canReadDeckSql` bij
    toevoegen); een revoke laat de koppeling staan maar het deck telt
    niet meer mee (zelfde joins als elders).
- **Routes:** `routes/exams.js`, alles achter
  `requireEntitlement(ENTITLEMENTS.EXAM_PLANNING)`:
  `GET/POST /exams`, `PUT/DELETE /exams/:id`,
  `POST/DELETE /exams/:id/decks(/:deck_id)`,
  `GET /exams/:id/readiness`.
- **"Op schema"-berekening:** server-side uit bestaande tabellen, geen
  nieuwe voortgangsdata: per gekoppeld deck de core-tellingen en
  scores uit `cards`/`user_card_progress` (zelfde subqueries als
  `/sync/changes`) afgezet tegen de resterende tijd tot `exam_date`.
  Startpunt simpel: % kaarten "op niveau" + verwachte haalbaarheid;
  verfijnen kan zonder API-wijziging.
- **Examentraining** = bestaande review-flow op de kaarten van de
  gekoppelde decks; hooguit een `GET /review/exam/:exam_id`-variant
  die de bestaande due/new-queries hergebruikt met een
  `deck_id IN (…exam_decks…)`-filter.
- **Sync/offline:** eerste versie **online-only** (zoals contacten):
  lijst via REST + WS-events (`exam_updated`). Doordat `exams` wél
  `updated_at`/`deleted_at` draagt, kan het later alsnog als extra
  array in `/sync/changes` schuiven zonder schemawijziging.

## Gebruiksmeting (nodig voor 1 en 2)

Externe STT/LLM-calls kosten per stuk geld; een rate-limiter per
15 minuten (in-memory, reset bij restart) is geen kostenplafond.
Daarom bij de eerste externe-provider-feature een tabelletje
`feature_usage` (migratie t.z.t.): `user_id`, `feature`, `day`,
`count` — `INSERT ... ON CONFLICT ... count = count + 1` vóór de
provider-call, en een dagcap per entitlement in
`src/config/products.js` (bijv. `pro_speech: { entitlements: [...],
daily_caps: { speech_recognition: 300 } }`). Overschrijding → `429`
met een eigen `code`, zodat de client "daglimiet bereikt" kan tonen
i.p.v. een generieke fout.

## Volgorde van bouwen

1. ✅ Fundament (migratie 022 + entitlement-laag) — gebouwd, migratie
   nog draaien (lokaal + remote, zie migrations/README.md).
2. Examenplanning (geen externe afhankelijkheden, direct waarde).
3. AI-antwoordcontrole (providerkeuze + `feature_usage`).
4. Spraakherkenning (zelfde patroon als 3, plus audio-upload-pad).

Frontend kan per feature onafhankelijk volgen: de poort is overal
hetzelfde 403-contract (`entitlement_required`).
