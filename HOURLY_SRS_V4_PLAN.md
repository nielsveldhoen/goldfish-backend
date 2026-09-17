# Plan: SRS v4 — 1–10-score, R1/R2-recovery en examenmodus

> **Status 2026-09-15: Fase 1 geïmplementeerd** (`RepetitionServiceV4` als
> part-bestand van v3, geregistreerd in main.dart; 37 unit-tests in
> `test/repetition_service_v4_test.dart` plus een fuzz-test met 200
> reeksen/4155 antwoorden in `test/repetition_service_v4_fuzz_test.dart`).
> **Fase 3 en 4 geïmplementeerd** (`ExamScheduling` in de frontend +
> `expireDecksForExam` in `exams.js`; 14 tests in
> `test/exam_scheduling_test.dart` en 10 in `backend/test/exam-expiry.test.js`).
> Van Fase 2 is alleen het noodzakelijke gedaan: de graad wordt nu ook na een
> eerdere fout vandaag gevraagd (anders logt een graadloos goed een C = score
> 3 = break). De 10-segmenten-taart staat nog open, net als het ophogen van
> `min_client_build`. **`kV4Epoch` is verwijderd (besluit Niels 2026-09-15)**:
> de v4-breakregel geldt voor het hele log, zie K7.
>
> Bouwt voort op HOURLY_SRS_V3_PLAN.md (uur-granulariteit) en EXAM_PLAN.md
> (examens). Het **logformaat blijft v3**: dezelfde tokens, dezelfde
> merge-regel, geen migratieketen-stap nodig. Wat verandert is de
> *interpretatie* van het log door de scheduler, de beoordelings-UI en één
> backend-ingreep bij het aanmaken van een examen.

## Doel

Twee problemen uit de praktijk:

1. Een 4 of 5 op de huidige moeilijkheidstaart ("goed, maar met veel moeite")
   telt nu gewoon als goed antwoord: de streak loopt door en het interval
   groeit. Je wilt dan juist een paar snelle herhalingen.
2. Examenvoorbereiding vraagt een ander regime dan vrije retentie: de
   kaarten moeten *vóór* de examendatum bewezen zitten, en daarna niet meer
   in de weg lopen.

## Vastgelegde besluiten (Niels, 2026-09-15)

0. **Elke sessie vraagt opnieuw om een moeilijkheidsscore** (besluit Niels
   2026-09-15). De oude regel keek naar de dag: een kaart die 's ochtends
   fout ging kreeg 's avonds in een nieuwe sessie geen taart meer. De skip is
   nu per sessie — binnen één sessie vraagt een herhaalde fout niet opnieuw,
   want het log houdt daar toch de graad van de eerste fout van de dag aan.
   Een goed antwoord vraagt altijd, ook na een fout: de score bepaalt of het
   een streak vasthoudt (1/2) of een break is (3+).
1. **Eén score 1–10 per antwoord**, in één stap. 1 = goed zonder moeite,
   10 = fout en geen idee. **1–5 telt als goed, 6–10 als fout** in de
   statistieken — dat is exact de huidige betekenis van `A–E` / `F–J`, dus
   de scoreformules (remote/stable/recent) en de dag-aggregatie veranderen
   niet. Mapping: 1→A, 2→B, 3→C, 4→D, 5→E, 6→F, 7→G, 8→H, 9→I, 10→J.
2. **Scheduling-streak = alleen scores 1 en 2.** Score ≥ 3 breekt de
   streak. Daarmee bestaan er twee streakbegrippen:
   - *statistische* streak (1–5 goed): ongewijzigd, voor de scores;
   - *scheduling*-streak (1–2): voor het interval, `longestInStreak` én de
     server-kolom `longest_in_streak_hours` (zie §Backend).
3. **Resets.** Score 3 → verval over 1–12 u (afhankelijk van de totale
   moeilijkheid, intrinsic inbegrepen). Score > 3 → verval over 1 u. Geldt in
   normale én in examenmodus.
4. **R1** na elke break: de gewone factorberekening (zoals N), tot de proven
   gap van de *huidige* streak ≥ 1 week (168 u). R1 is bewust trager dan de
   huidige v3-recovery. Startpunt is het reset-interval uit besluit 3.
5. **Na R1** hangt het af van de break-score:
   - break was **score 3** → direct één interval ter grootte van de proven
     gap van de *vorige* streak, daarna N;
   - break was **score > 3** → **R2**: factor 2–4,8 (afhankelijk van de
     totale moeilijkheid 1–10), **gecapt** op de proven gap van de vorige
     streak; exit zodra de huidige proven gap die waarde bereikt → N.
6. **N-factor blijft** `2^(1 − difficulty)` met de bestaande blend
   (intrinsic/perceived, gewicht op `longestInStreak / 8760`).
7. **Modi worden niet opgeslagen** maar afgeleid uit het log (zie
   §Afleidbaarheid). Geen N/R1/R2/E-tokens.
8. **Examen aanmaken zet alle kaarten van de gekoppelde decks direct op
   verlopen**, lokaal in Hive én in de DB. **Spiegelbeeld (besluit Niels
   2026-09-15): een deck dat uit een examen gaat laat al zijn kaarten hun
   due-datum HERBEREKENEN** uit het repetitielog, want de staande due is
   onder het examenregime bepaald (H/2-cap, ready-beurt, bodem) en slaat
   daarbuiten nergens meer op. Dat kan alleen de client: de server
   interpreteert het log niet. Zie §Herberekenen.
9. **Examenmodus** (deck zit in een examen met `exam_date` in de toekomst):
   geen R1/R2; ready ⇔ proven gap > 2 × uren tot examen; ready-kaart wordt
   nog één keer gepland op `uren tot examen / 2`; **bodem** zodra proven gap
   > 4 × uren tot examen (dan gewone planning, die per constructie ná het
   examen valt).
10. **Geen voorrang** voor examenkaarten in `TrainingMode` (komt later als
    aparte examenTraining-variant).
11. **Perceived difficulty houdt het huidige venster** (laatste 5 goede
    dagen), geen 2-wekengemiddelde.

### Keuzes van Claude — graag bevestigen of omdraaien

Deze punten waren niet expliciet besloten; hieronder de default die het plan
hanteert, met de reden.

- **K1. Richting van de score-3-reset.** Makkelijke kaart → 12 u, moeilijke
  kaart → 1 u: `reset = round(12 − 11 · difficulty)`. Reden: bij een
  makkelijke kaart is een 3 een klein duwtje, bij een moeilijke kaart wil je
  hem snel terug.
- **K2. Geen factorvloer in R1 (besluit Niels 2026-09-15).** De aanname
  "bij score 1/2 ligt de factor altijd boven 1,5" klopt niet met de formule:
  bij een moeilijke kaart (intrinsic 1,0, basis 0 → gewicht 0,5) is
  `2^(1−0,5)` = 1,41, en perceived middelt nog oude 4/5-scores mee. Dat
  minimum is acceptabel: de week wordt dan in ~10 reps (vanaf 12 u) of ~15
  reps (vanaf 1 u) bereikt. R1 is daarmee **exact** de N-formule.
- **K3. R2-factor genormaliseerd op 2–4,8.** De notitie `6 − D/2,5` geeft
  5,6–2,0 voor D ∈ [1,10]. Het plan gebruikt de genoemde *range*:
  `factorR2 = 4,8 − (D − 1) · 2,8/9`, met `D = 1 + 9 · difficulty` (de
  bestaande blend op 1–10 geschaald). D=1 → 4,8, D=10 → 2,0.
- **K4. "Vorige streak" = de meest recente eerdere streak met proven gap ≥
  168 u.** Strikt "de streak direct vóór de break" faalt zodra je in R1 nog
  een keer breekt: de vorige streak is dan een R1-streakje van een paar uur,
  R2 capt daarop en de 30 dagen die daarvoor bewezen waren zijn onbereikbaar.
  Bestaat er geen eerdere streak ≥ 168 u, dan gaat R1 direct over in N.
- **K5. Cap in examenmodus voor niet-ready kaarten.** Zonder cap kan een
  niet-ready kaart over het examen heen springen (gap 72 u, examen over
  120 u: 72 × 2 = 144 u). Default: `interval = min(interval, H/2)` in
  examenmodus. Gevolg: de laatste dagen voor het examen kan een kaart
  H/2, H/4, H/8 … worden gevraagd tot hij ready is; met de bodem uit besluit
  9 stopt dat. Uren zijn heel, dus onder de 2 u wordt het 1 u — bij een
  examen dat over 3 u begint is dat gewenst gedrag.
- **K6 → besluit Niels 2026-09-15: cheat-recovery vervalt.** Een X zet de
  vervaldatum op **1× de proven gap** en verder niets; de X is daarna een
  gewone break, dus het volgende antwoord loopt via R1/R2/N. "Proven gap" is
  de gap van de lopende streak tot en met het laatste échte antwoord — de
  tijd sinds dat antwoord telt niet mee (je hebt hem afgekeken, niet
  opgehaald), en het is nadrukkelijk niet de langste gap ooit: een kaart met
  een korte streak na een lapse krijgt die korte gap. Leeg log → 1 u. In
  examenmodus gecapt op H/2 (K5 gaat voor).
- **K7 → vervallen: géén epoch.** Het plan had een buildconstante `kV4Epoch`
  waarvóór historische C/D/E-entries (de oude default-graad) hun
  v3-betekenis zouden houden. Op 2026-09-15 doorgerekend over alle 536
  productie-logs: **de epoch veranderde geen enkele vervaldatum.** Reden: de
  langste gap in een streak is vrijwel altijd de laatste gap (intervallen
  groeien), dus een breekpunt dat naar achteren schuift neemt de maximumgap
  niet weg en `g` blijft gelijk; en `T` (een eerdere streak ≥ 1 week) komt in
  deze logs bijna niet voor. Niels besloot daarop de epoch te schrappen: de
  v4-breakregel geldt voor het hele log, en er is geen constante meer die op
  elk apparaat gelijk moet staan. Wat v3→v4 wél verandert (174 van de 536
  kaarten, waarvan 149 resets op een laatste score ≥ 3) komt uit de nieuwe
  scorebetekenis zelf en is precies de bedoeling.
- **K8. Verlopen-zetten bij examen: server doet het voor alle betrokkenen.**
  Zie §Backend. Alternatief is N losse `save_progress`-writes per device.

---

## Formules

Alle grootheden in **hele UTC-uren**, zoals v3. `g` = proven gap van de
huidige scheduling-streak (`longestInStreak`, running max, met het bestaande
12 u overdue-krediet: `earned = raw − max(0, overdue − 12)`). `difficulty` ∈
[0,1] is de bestaande blend. `base = 2^(1 − difficulty)` ∈ [1,2].

| situatie | interval (u) |
|---|---|
| score ≥ 4 | **1** |
| score 3 | `round(12 − 11 · difficulty)` ∈ [1,12] (K1) |
| score 1/2, geen break in log (N) | `max(1, round(g · base))` |
| score 1/2, break aanwezig, g < 168 (R1) | `max(1, round(g · base))` (K2: geen vloer) |
| score 1/2, g ≥ 168, break=3, T bekend, g < T | **T** (sprong) |
| score 1/2, g ≥ 168, break>3, T bekend, g < T (R2) | `min(T, round(g · factorR2))` (K3) |
| score 1/2, g ≥ T of T onbekend (N) | `max(1, round(g · base))` |
| cheat (X) | `max(1, proven gap van de lopende streak)` (K6) |

`T` = proven gap van de vorige streak (K4). Merk op dat R1 en N dezelfde
formule delen; het onderscheid zit uitsluitend in wat er *na* 168 u gebeurt.

### Examenmodus

`H` = hele uren van het (afgeronde) antwoordmoment tot `exam_date`, met de
bestaande map `deck_id → eerstvolgende toekomstige exam_date`. Alleen actief
als H > 0.

| conditie | interval (u) |
|---|---|
| score ≥ 3 | reset als hierboven (1 u resp. 1–12 u) |
| g > 4H (bodem) | gewone N-formule, geen cap — valt ná het examen |
| 2H < g ≤ 4H (ready) | `max(1, round(H / 2))` |
| g ≤ 2H (niet ready) | `max(1, min(round(H/2), round(g · base)))` (K5), nooit R1/R2 |

*Waarom de bodem terminerend is:* bij het ready-antwoord op tijdstip met
H₁ geldt g > 2H₁. De volgende beurt valt op H₂ = H₁/2; g is niet gekrompen
(running max), dus g > 2H₁ = 4H₂ → bodem. Precies één extra beurt.

*Readiness buiten het antwoordmoment* (voor UI/badges): dezelfde vergelijking
met H gemeten vanaf `lastReviewed` in plaats van nu, zoals in de notitie.

---

## Afleidbaarheid van de modi (besluit 7, gecheckt)

De scheduler heeft per antwoord nodig: (a) is er een break, (b) g, (c) de
score van de laatste break, (d) T. Alle vier volgen deterministisch uit de
uur-entries, die op elk device na merge identiek zijn:

- **break-entry** ⇔ `!correct` (F–J), `cheated` (X), of `correct && grade ≥ 2`
  (C/D/E). Dit is de enige nieuwe
  predicaat; v3's `_runStart` zoekt nu alleen `!correct`.
- **huidige streak** = entries ná de laatste break; de break zelf **ankert**
  de eerste gap (zoals `wrongIdx` nu), dus de wachttijd na een reset telt
  mee. g = `max(_longestHourGapOver(streak), _longestGapSince(break))` —
  dezelfde helpers als nu, met het nieuwe break-predicaat in `_runStart` en in
  `_currentCorrectStreak` (dag-aggregaat: dag telt als streakdag als de dag
  begon met A/B).
- **break-score** = grade van die break-entry: C → "score 3"-pad, anders
  "> 3"-pad. Een wrong-after-correct op dezelfde dag schrijft nu al een
  automatische F in het uur-entry, dus ook dat pad is zichtbaar.
- **T** = loop terug over eerdere streaks (gescheiden door break-entries);
  neem de eerste met proven gap ≥ 168 u (K4). Een X sluit een streak net als
  een wrong (v3-semantiek van `_longestGapEverHours`).
- **Examenmodus** komt uit de exams-box, niet uit het log.

Wat *niet* afleidbaar is en ook niet nodig: "hoe vaak ben ik al in R2
geweest". Er is geen stapteller. Conclusie: opslaan is overbodig, de
merge-regel blijft de bestaande `mergeImpl` (slechtste wint per uur).

Eén randgeval: score 3 gevolgd door score 3 op de volgende beurt. De tweede
3 is opnieuw een break → nieuwe reset 1–12 u, R1 begint opnieuw. Dat is
conform "indien je weer score 3 geeft begin je opnieuw".

---

## Migratie

Geen. Het logformaat is v3 en er is geen epoch (zie K7). Oude builds die na
de uitrol nog C-als-default schrijven zijn wel een reden om `min_client_build`
op te hogen — niet omdat de lezing verschilt, maar omdat die default-C's
onder v4 échte score-3-breaks zijn en de gebruiker ze dan niet bewust koos.

## Fase 1 — Frontend: `RepetitionServiceV3` → scheduler v4

Gebouwd als `RepetitionServiceV4 extends RepetitionServiceV3` in
`repetition_service_v4.dart`, een `part of` v3 zodat de private helpers en
typedefs (`_Entry`, `_DayEntry`) gedeeld blijven zonder ze open te zetten.
V3 blijft intact en apart testbaar; v4 overschrijft alleen
`computeDueDateImpl` en `longestInStreakHoursImpl`. Onderdelen:

1. `_isBreak(_Entry e)` met de epoch-regel; gebruiken in `_runStart`,
   `_currentCorrectStreak` (via het dag-aggregaat: dag-`correct` voor de
   *scheduler* wordt "eerste antwoord was A/B"; voor de *scores* blijft het
   "eerste antwoord was A–E" — twee velden op `_DayEntry`, bv. `correct` en
   `inStreak`), `_longestGapEverHours` en `longestInStreakHoursImpl`.
2. `_previousStreakGap(hours)` → T (K4).
3. `computeDueDateImpl` herschrijven naar de tabel hierboven. De
   v3-recovery (`inRecovery`, bonus `2 − intrinsic`, cap `longestEver`) en de
   lapse-branch ("basis × 1") vervallen; de cheat-branch blijft. Nieuwe
   signatuur: `isCorrect` + `difficulty` blijven, maar de scheduler leest
   de *score* (`grade` 0–4 + correct/wrong) — geen aparte parameter nodig.
4. Examenmodus: `computeDueDateImpl` krijgt `DateTime? examDate` (null =
   geen examen). De aanroep in `review_controller._finalise` slaat de map
   `deck_id → exam_date` op uit `ExamLocal.fetchAll()` bij sessiestart.
5. Debug-info (`setDebugScheduleInfo`) meldt de modus: `N`, `R1`, `sprong`,
   `R2`, `exam:ready`, `exam:hard`, `exam:bodem`, met g, T, H en factor.
6. Tuning-constanten bovenaan bij de andere knobs: `_kR1ThresholdHours =
   168`, `_kR2FactorMax = 4.8`, `_kR2FactorMin =
   2.0`, `_kReset3MaxHours = 12`, `_kExamReadyFactor = 2`,
   `_kExamDoneFactor = 4`.

Unit tests (bestaande testmap voor v3 uitbreiden):
- ladder na score 4: 1 → × base … tot ≥ 168 u → R2 tot T → N;
- ladder na score 3: reset 1–12 u afhankelijk van difficulty → R1 → sprong T;
- dubbele break in R1: T blijft de oude lange streak (K4);
- T onbekend (nieuwe kaart met één break): R1 → N zonder sprong;
- epoch: log met C vóór de epoch breekt niet, C erna wel;
- examen: niet-ready cap H/2; ready → H/2; bodem → gewone formule na
  examen; H ≤ 0 → normale modus;
- merge: twee devices, verschillende scores in hetzelfde uur → slechtste
  wint, afgeleide modus identiek;
- scores (remote/stable/recent) op een vaste log zijn bit-voor-bit gelijk
  aan vóór de wijziging (regressietest: de dag-aggregatie voor scores
  mag niet veranderen).

## Fase 2 — Frontend: beoordelings-UI

1. `difficulty_panel.dart`: tien segmenten, labels 1–10, kleurverloop
   `difficultyEasy → difficultyHard` voor 1–5 en `gradeAlmost →
   gradeBlackout` voor 6–10 (de twee bestaande verlopen achter elkaar).
   Default-selectie 2.
2. `review_controller`: `judgeAnswer(bool)` en de tweetrapsflow
   (`awaitingJudgement` → `awaitingDifficulty`) worden één stap:
   `pickScore(int 1–10)` → `correct = score ≤ 5`, `difficulty = (score−1) % 5`
   → bestaande `buildAction`/`appendImpl`. De taart wordt **altijd** getoond,
   ook bij een herhaald antwoord op dezelfde dag; de dag-regels in
   `appendImpl` (automatische F, count-verhoging, slechtste-per-uur) blijven
   bepalen wat er in het log komt. `hadWrongToday`/`hasAnswerToday` in de
   controller vervallen daarmee.
3. `review_screen.dart`: de goed/fout-knoppen (`onJudge`) en de
   auto-judge-doorvoer (`pendingJudgement`) verwijderen; sessie-telling
   `_sessionWrong` op `score ≥ 6`.
4. `session_summary_panel.dart` toont de score-verdeling (1–10) in plaats
   van goed/fout + graad.
5. Kaartdetail/debug-bubbel: modus tonen uit de debug-info.

## Herberekenen bij het verlaten van een examen

`RepetitionServiceBase.recomputeDueDate(log, cardId, {examDate})` speelt de
LAATSTE log-entry opnieuw af alsof hij nú gegeven wordt — eigen uur, eigen
graad, eigen overdue — tegen het log dat eraan voorafging. Zonder `examDate`
levert dat exact de due-datum die het antwoord zonder examen had gekregen.
Alleen v4 implementeert het (v1–v3 geven null); het log wordt niet gewijzigd.

Het is een pure functie van het log, dus deterministisch over devices: twee
clients die na dezelfde sync herberekenen komen op dezelfde waarde uit en de
tweede schrijft niets (`ExamScheduling` slaat een kaart over als de
herberekende due gelijk is aan de staande). Dat maakt de hele reconciliatie
idempotent en voorkomt 409-stormen bij multi-device.

## Fase 3 — Frontend: examen verlopen-zetten (lokaal)

Bij `ExamLocal.save` van een nieuw examen, of bij een `PUT` die decks
toevoegt, én bij een sync-snapshot die een nieuw/uitgebreid examen brengt
met `exam_date` in de toekomst: voor elke kaart in de betrokken decks
`dueDate = now` via `CardLocal.saveCard` (bumpt revision en deck-tallies).
Geen queue-write per kaart: de server doet de DB-kant (Fase 4), en de
sync-delta die daaruit volgt overschrijft lokaal dezelfde waarde. Kaarten
zonder voortgang zijn al "nieuw" en hoeven niets.

## Fase 4 — Backend

1. **`exams.js`**: na een geslaagde `POST /exams` en na een `PUT /exams/:id`
   die decks toevoegt, en alleen als `exam_date > now()`:
   ```sql
   UPDATE user_card_progress ucp
      SET due_date = now(), updated_at = now()
     FROM cards c
    WHERE ucp.card_id = c.id
      AND c.deck_id = ANY($1)           -- de (nieuw) gekoppelde decks
      AND c.deleted_at IS NULL
      AND ucp.deleted_at IS NULL
      AND ucp.user_id = ANY($2)         -- owner, of alle actieve groepsleden
      AND (ucp.due_date IS NULL OR ucp.due_date > now());
   ```
   In dezelfde transactie als de exam-write. `updated_at = now()` zorgt dat
   `/sync/changes` de rijen aan elk device levert; een device met een
   openstaande `save_progress` op zo'n kaart krijgt een 409 en merget zoals
   nu. WS-event `progress_changed` (of het bestaande equivalent) per
   betrokken user broadcasten zodat open apps meteen bijwerken.
2. **`review.js`**: geen wijziging. `longest_in_streak_hours` krijgt stil de
   scheduling-streak-betekenis; de waarde heelt zichzelf bij het eerstvolgende
   antwoord per kaart. Documenteren in BACKEND_API.md bij het veld.
3. **`app_config.min_client_build`** ophogen naar de v4-build (zie
   §Migratie).
4. Tests: `exams.test.js` uitbreiden met de expiry (persoonlijk, groep,
   verleden examendatum → niets, PUT met alleen verwijderde decks → niets).

## Fase 5 — Uitrol (strikte volgorde)

1. Frontend bouwen
   met dat build-nummer.
2. Backend deployen (deploy.sh); `min_client_build` nog **niet** ophogen.
3. Frontend deployen (web + stores). Zodra de stores live zijn:
   `min_client_build` ophogen. Tussen 2 en 3 schrijven oude builds nog C's
   ná de epoch — die worden als score-3-breaks gelezen. Houd dat venster kort
   of zet de epoch op het moment van stap 3.
4. Handmatige testlijst hieronder afwerken op minstens twee devices.

## Handmatige testlijst (multi-device waar het ertoe doet)

- Nieuwe kaart, score 1 → due +1 u; score 1 na 1 u → +2 u (factor 2 bij
  difficulty 0); ladder klopt met de debug-bubbel.
- Volwassen kaart (gap ≥ 7 d), score 4 → due +1 u, R1-ladder met de
  N-factor, bij ≥ 168 u R2 met cap op de oude gap, daarna N.
- Zelfde kaart, score 3 → due 1–12 u afhankelijk van moeilijkheid; na R1 de
  sprong naar de oude gap in één keer.
- Score 3 gevolgd door score 3 → opnieuw reset, geen sprong.
- Oude kaart met historische C's (vóór epoch): eerste v4-antwoord met score
  1 → **geen** terugval naar R1; gap blijft de oude.
- Device A antwoordt score 2, device B (offline) score 7 in hetzelfde uur;
  B synct → 409 → merge → beide devices tonen dezelfde due-date en modus.
- Examen aanmaken op deck X (persoonlijk): alle kaarten van X direct due op
  dit device; tweede device na sync ook; kaart in deck Y ongewijzigd.
- Groepsexamen: ook bij een ander groepslid worden de kaarten due.
- Examen met datum in het verleden aanmaken: niets verloopt.
- Kaart in examenmodus: score 5 → +1 u, geen R2 daarna (hard regime);
  niet-ready kaart komt niet over het examen heen (cap H/2); ready-kaart
  precies één keer op H/2; daarna gewone planning na het examen.
- Examen verwijderen of laten verlopen: kaart valt terug op normale modus
  bij het volgende antwoord; de resets in het log blijven staan
  (geaccepteerd).
- Taart: 10 segmenten, default 2, kleuren per helft; sessiesamenvatting
  toont de verdeling; foutlimiet in de sessie telt vanaf score 6.
- Statistieken (remote/stable/recent, deck-gemiddelden, dagsnapshot) zijn
  vóór en ná de update identiek voor een kaart die nog niet beantwoord is.

## Bekende gedragsverschuivingen (geaccepteerd)

- Score 4/5 ("goed maar zwaar") kost nu de streak: sneller herhalen, maar de
  statistiek blijft "goed". Dat is precies probleem 1.
- Een wrong zet de kaart niet meer op *nu* maar op +1 u. In-sessie herhaling
  loopt via `TrainingMode` en blijft werken; de "due"-badge in de decklijst
  tikt een uur later.
- Examenkaarten laten een spoor van resets na dat de intrinsieke moeilijkheid
  niet raakt (die kijkt alleen vóór het eerste goed) maar perceived tijdelijk
  omlaag drukt.
- De v3-recovery (×2–4, cap `longestEver`) verdwijnt; recovery is nu R1/R2
  en per definitie trager tot 168 u.

## Buiten scope

- Voorrang voor examenkaarten en een examenTraining-modus (besluit 10).
- Readiness-percentage per examen in de UI (kan later uit
  `longest_in_streak_hours` + `exam_date`, ook groepsbreed).
- Een echte v3→v4-logmigratie die de epoch-tak overbodig maakt.
