# Plan: uur-granulariteit SRS — repetitielog v2 → v3

Status: **LIVE per 2026-07-16.** Fase 1–4 uitgevoerd op branch `v3-hourly-srs`
(frontend + backend), migratie 021 op dev én productie gedraaid, backend +
webfrontend gedeployed (md5-geverifieerd). Pre-migratie-dumps staan op de
server (`/var/backups/goldfish/goldfish-pre-v3-*`) en op de laptop
(`~/goldfish-backups/`). Nog open: Android-app op het toestel updaten vóór
gebruik (oude client kan [3]-logs niet lezen) en de branch naar main mergen.

## Vastgelegde besluiten

1. **Eén logentry per uur** (niet meer per dag). Formaat:
   `YYYY*MM#DD&TT[entry]&TT[entry]…#DD&TT[entry]…`
   - `&` staat vóór **elke** uurentry (ondubbelzinnig parsen naast de overdue-cijfersuffix).
   - `TT` = uur 00–23.
2. **Tijdrepresentatie: log in UTC, dag-begrippen lokaal afgeleid bij het lezen.**
   Elke logentry is een UTC-instant (datum + uur). Alles wat "dag" is — de
   score-aggregatie, `hadWrongToday`, dagstatistieken — wordt bij het lezen afgeleid
   door elke entry per instant naar lokale tijd te converteren (`toLocal()`) en op
   lokale kalenderdag te groeperen. Binnen één vaste tijdzone is die groepering
   volledig stabiel (elke entry converteert met de offset die op dát moment gold,
   dus ook DST verschuift geschiedenis niet); alleen een echte tijdzone-verhuizing
   verschuift de groepering van historische entries rond middernacht — bewust
   geaccepteerd. Winst van UTC: uur-gaps zijn exacte verstreken tijd, zonder
   DST- of reis-ruis, en appends zijn van nature chronologisch.
   De `due_date` gaat als ISO-8601 UTC-timestamp naar de server (`NOW()`-vergelijking).
3. **Afronding antwoordmoment**: minuut 00–29 → uur naar beneden, 30–59 → naar boven (keuze Niels).
4. **Overdue in uren** i.p.v. dagen: `A336~` = correct, 336 uur (14 dagen) over tijd.
5. **Migratie v2→v3** (in de bestaande versioned migration chain, prefix `[3]`):
   - elk historisch dag-entry `DD[entry]` → `DD&00[entry]` = **00:00 UTC** (tekstueel
     blijft de datum gelijk). In NL (UTC+1/+2) leest dat terug als 01:00/02:00 lokaal
     op dezélfde kalenderdag, dus de historische daggroepering blijft in de praktijk
     ongewijzigd;
   - overdue-waarden ×24 (dagen → uren);
   - version stamp `[2]` → `[3]`.
6. **Scores blijven dag-gebaseerd op lokale kalenderdagen**: uurentries (UTC) worden
   bij het lezen per **lokale kalenderdag** geaggregeerd tot dag-entries met exact
   de huidige v2-semantiek; remote/stable/recent veranderen niet van betekenis.
   Ook de stats-geschiedenis blijft volledig ongewijzigd: `deck_stats`
   (user+deck+datum) en `user_daily_snapshot` (user+datum) houden hun DATE-kolommen
   met de **lokale dag** die de client al opstuurt (`/stats/update`, tellers
   optellen + avg-scores overschrijven per dagrij). De scores zelf blijven één
   snapshot per kaart in `user_card_progress`.
7. **Scheduler rekent in uren**, met alle huidige dag-hoeveelheden ×24 zodat het gedrag 1:1 behouden blijft. Sub-dag intervallen (bv. eerste interval < 24u) zijn latere tuning, geen onderdeel van dit plan.

## Waarom scores via dag-aggregatie

De hele v2-semantiek (grade = eerste antwoord van de dag, auto-F, wrongCount per dag,
`hadWrongToday`, streaks/gaps in dagen, scorevensters in dagen) is dag-gebaseerd.
Door de UTC-uurentries bij het **lezen** naar lokale tijd te converteren en per
lokale kalenderdag te aggregeren — door ze in volgorde door de bestaande
dag-state-machine te spelen — blijven alle scoreformules en tuning-knobs ongewijzigd
geldig, terwijl de scheduler op uurniveau (puur UTC, exacte verstreken tijd) gaps en
due dates berekent.

Aggregatieregels per lokale kalenderdag (replay van de bestaande transitions uit v2):
- dag-`wrongCount` = som van de uur-wrongCounts (cap 27);
- dag-grade = grade van de **eerste** entry van de dag; een fout ná een eerder goed
  antwoord die dag → auto-F (grade 0, correct=false), zoals nu;
- `correct` van de dag = alleen als er geen wrong-uurentries zijn;
- X-regels ongewijzigd (X+wrong→wrong, X+correct→X, …);
- dag-overdue = overdue (uren) van de eerste correcte entry, /24 afgerond, t.b.v. de
  "earned gap"-berekeningen in de dag-gebaseerde scores.

## Fase 1 — Frontend: `RepetitionServiceV3` (grootste stuk)

Bestanden: `lib/services/repetition_service_base.dart`, nieuw
`lib/services/repetition_service_v3.dart`, registratie in `main.dart`.

1. **Base-klasse** (`repetition_service_base.dart`):
   - `LogEntry.date` krijgt uurprecisie als **UTC-instant**; documentatie bijwerken.
   - Helpers `hoursBetween`/`addHours`: rechttoe-rechtaan UTC-rekenkunde — exacte
     verstreken uren, geen DST-correcties meer nodig (het bestaande
     `daysBetween`-DST-kunstje vervalt voor de uur-paden).
   - `effectiveDay`-clamp (reizen/DST) is met UTC grotendeels overbodig: UTC loopt
     nooit terug bij reizen of DST. Er blijft een kleine clamp (`effectiveHour`)
     nodig voor afronden-naar-boven (entry tot 30 min in de toekomst) en echte
     klokafwijkingen — het volgende antwoord mag nooit vóór de laatste entry landen.
   - `hadWrongToday`/`hasAnswerToday`: "vandaag" = de huidige **lokale kalenderdag**,
     vergeleken met de naar lokaal geconverteerde dag-aggregaten (gedrag binnen één
     tijdzone identiek aan v2).
2. **V3-service** (`repetition_service_v3.dart`, gebaseerd op v2):
   - `migrations = [_v0ToV1, _v1ToV2, _v2ToV3]` → `currentVersion = 3`.
   - `_parseAll`/`_buildLog` voor het `&TT`-formaat; round-trip-assert behouden.
   - `appendImpl`: state machine per **uur**-entry (zelfde transitions als nu, maar
     binnen het uur i.p.v. binnen de dag). Afronding: zie besluit 3.
   - Dag-aggregatiefunctie (zie boven) als bron voor alle score-functies;
     `_resolveEntries` (X-recovery) draait op dag-aggregaten, zodat `_recoverySteps`
     dezelfde uitkomsten houdt.
   - `computeDueDateImpl` in uren:
     - wrong F/G → +24u; wrong H/I/J → +0u (nu due);
     - het eerste góede antwoord van de dag krijgt altijd ≥ 24u verlooptijd
       (besluit Niels 2026-07-16, bewuste afwijking van v2: een herstel na een
       fout vandaag wordt nooit dezelfde dag opnieuw gedrilld;
       `hadWrongThisSession` heeft in v3 geen effect meer);
     - één interval-formule voor elk goed antwoord (besluit Niels 2026-07-16,
       geen aparte ladder-branch): interval = langste verdiende gap tussen de
       antwoorden (uurentries) in de huidige streak × de vermenigvuldigings-
       factor (1–3) uit de logs, afgerond op hele uren, min 1u. Sub-dag- en
       meerdaagse gaps liggen op dezelfde schaal, dus drillen klimt naadloos
       1-2-4-8-16-32u-… (bij factor 2) door de daggrens heen. Een herhaal-
       goed gebruikt de formule zónder de 24u-vloer; doordat de basis een
       lopend maximum is kan een herbeurt het interval nooit verkorten
       ("alleen verlengen" zit in de formule zelf). Herhaal-goeds worden als
       eigen uurentry gelogd; de dag-aggregatie leest de eerste beurt van de
       dag, dus de scores veranderen niet mee;
     - streak-gaps en `longestEver` in uren, `earned = raw − overdueUren`;
     - `historicalMastery` = longestEverUren/8760; `streakDays/365` → uren/8760;
     - retention-jump en cheat-recovery: zelfde formules, ×24;
     - interval afronden op hele uren, minimum 24u (huidig gedrag behouden);
     - debug-info in uren rapporteren.
   - `mergeImpl`: sleutel wordt het (UTC-dag, uur)-paar zoals opgeslagen i.p.v. dag;
     zelfde conflictregel. Tijdzone-onafhankelijk en dus deterministisch op elk device.
   - `buildAction`: overdue-parameter heet voortaan uren.
3. **`processAnswer`** (base): `overdueDays` → `overdueHours` =
   `hoursBetween(cardDueDate, now).clamp(0, …)`; alleen bij correct, zoals nu.
4. **Registratie**: `main.dart` zet `RepetitionServiceBase.instance = RepetitionServiceV3.instance`.
5. **Tests**: nieuwe `test/repetition_service_v3_test.dart`:
   - formaat-round-trips, append-transitions per uur, dag-aggregatie
     (incl. auto-F over uren heen), merge per uur;
   - migratietests `[2]`→`[3]` (entry → `&00`, overdue ×24, scores vóór/na migratie
     gelijk voor dag-gebaseerde logs);
   - schedulertests: uitkomsten = v2-uitkomsten ×24 uur voor bestaande scenario's.
   - `repetition_service_v2_test.dart` blijft bestaan (migratiepad moet blijven werken).

## Fase 2 — Frontend: due date-doorvoer

- `lib/repositories/review_repository.dart`: `_dateString(dueDate)` →
  `dueDate.toUtc().toIso8601String()` (volledige timestamp).
- `lib/data/remote/progress_remote.dart:52` (404-fallback voor core-set): idem.
- `lib/models/flash_card.dart:65`: `due_date` parsen met `_parseTimestamp`
  (bestaat al) i.p.v. `_parseDate` (die knipt op 10 tekens → lokale middernacht).
- Controleren maar waarschijnlijk al goed (vergelijken instants, geen dagen):
  `card_repository.dart`, `card_provider.dart`, `deck_counts_local.dart`
  (`refreshDueIfLoaded` herberekent al tijd-gebaseerd — werkt per uur vanzelf),
  `flush_handler._replayDueDate` (krijgt uurprecisie via `entries.last.date`),
  `server_reconciler.dart`, Hive-adapters (DateTime bewaart tijd al).
- UI-check: plekken die een due date als datum tonen (deck-editor/card_item) —
  weergave mag datum blijven, maar niet terug-truncaten bij opslaan.

## Fase 3 — Backend

- **Migratie `021_due_date_timestamptz.sql`** (+ `_down.sql`), idempotent,
  registreren in `schema_migrations`:
  `ALTER TABLE user_card_progress ALTER COLUMN due_date TYPE timestamptz USING due_date;`
  Bestaande DATE-waarden worden 00:00 UTC — consistent met de `&00`-logmigratie.
  Client-side is dat 1–2 uur later dan de lokale middernacht waarop zo'n kaart
  voorheen due werd; eenmalig en verwaarloosbaar, geen correctie nodig.
- **Queries** `due_date <= CURRENT_DATE` → `due_date <= NOW()`:
  `src/routes/review.js` (regels ~30, ~430, ~445, ~498) en `src/routes/sync.js` (~85).
- **`src/utils/validate.js`**: `LIMITS.REPETITIONS_MAX` 2000 → **4000**
  (v3 is ~50% groter: `&TT` per entry + overdue ×24 + extra uurentries bij drills).
  `invalidDate` accepteert ISO-timestamps al — geen wijziging.
- **BACKEND_API.md bijwerken in backend én frontend-kopie** (vaste werkwijze):
  due_date is voortaan een ISO-8601 UTC-timestamp op hele uren; repetitions-limiet 4000;
  voorbeelden aanpassen.

## Fase 4 — Uitrol (strikte volgorde)

1. Lokaal: migratie 021 op de dev-DB (sudo-wachtwoord aan Niels vragen), backend-tests,
   `flutter analyze` + `flutter test`.
2. **Backend eerst deployen** (incl. migratie): timestamptz accepteert de oude
   `YYYY-MM-DD`-writes van nog-niet-geüpdatete clients (→ 00:00 UTC). Andersom niet:
   een ISO-timestamp in een DATE-kolom wordt stil getrunceerd.
3. Daarna frontend: web-build direct mee-deployen en **alle devices updaten**.
   ⚠️ Oude app-versies kunnen `[3]`-logs niet lezen (de v2-parser struikelt over `&`
   en leest uren als dagen) — niet mixen; dit is een harde cut-over per account.
4. Deploy volgens de vaste werkwijze (memory `goldfish-remote-deploy` volledig lezen).

## Bekende gedragsverschuivingen (geaccepteerd)

- Daggrenzen, same-day-regels en dagstatistieken blijven **lokale kalenderdagen**;
  binnen één vaste tijdzone is het gedrag identiek aan v2 (ook door DST heen, want
  elke entry converteert met de offset die op dát moment gold).
- Alleen een echte **tijdzone-verhuizing** hergroepeert historische entries die
  dicht bij middernacht vielen: die kunnen dan in een aangrenzende lokale dag
  vallen, waardoor scores bij de eerstvolgende herberekening licht verschuiven.
  Bewust geaccepteerd ("geschiedenis wordt niet herschreven — de UTC-instants
  blijven exact; alleen de dag-bril verschuift mee met waar je bent").
- Uur-gaps en overdue zijn exacte verstreken tijd (UTC): géén DST- of reis-ruis
  meer, en geen dubbel 02:00-uur bij DST-terugval — een verbetering t.o.v. de
  dag-ruis die v2 accepteerde.
- De `due_date` op de server is een UTC-instant: na een tijdzone-verhuizing valt een
  kaart op het juiste *verstreken-tijd*-moment due, wat op de nieuwe locatie een
  ander klokuur is dan waarop hij gepland leek. Dat is correct gedrag, geen bug.

## Buiten scope (later tunen)

- Sub-dag intervallen in de scheduler (eerste interval < 24u, uur-gebaseerde groei).
- Compactie van het `&TT`-formaat voor lange-gap-entries (grammatica laat
  TT-loze entries toe, maar we schrijven ze niet meer).
