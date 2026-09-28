# Plan: R1 met g=0 na een score-2-antwoord

Status: UITGEVOERD (2026-09-18). Zie 'Uitvoering' onderaan voor wat er
anders is gelopen dan hier gepland.

## Aanleiding

Een kaart werd met score 2 beantwoord en kreeg: `R1, score=2, g=0h,
overdueHours=4, interval=1h`. Volgens Niels was het vorige antwoord de avond
ervoor, dus g had ruwweg 8–16 u moeten zijn.

## Wat de code nu doet

`RepetitionServiceV4.computeDueDateImpl` (frontend/lib/services/repetition_service_v4.dart):

- `breakIdx` = laatste entry in het log die fout, X of goed met score ≥ 3 is.
- `g = _longestGapSince(rawHours, breakIdx, nowHour, overdue)`: de langste
  verdiende gap tussen opeenvolgende entries vanaf de break, plus de gap van
  de laatste entry naar `nowHour`. Die laatste gap telt alleen als
  `nowHour.isAfter(laatste entry)`.
- R1: `interval = max(1, round(g × base))`.

Met `overdue=4` is de verdiende gap gelijk aan de ruwe gap (overdue-krediet
is 12 u). Dus **g=0 kan in R1 alleen ontstaan als de laatste entry in het log
een break is die op hetzelfde afgeronde uur als het antwoord ligt, of later**.
Er is geen andere route: elke echte gap van ≥ 1 u sinds de break levert g ≥ 1.

Twee bekende manieren waarop zo'n entry in het log komt:

1. **Herhaling binnen het uur.** TrainingMode en UntilAllCorrectMode vragen
   kaarten opnieuw: na een fout (reinsert), én als "geleende" kaart om een gap
   te vullen (`_borrowCandidate` in training_mode.dart; geleende kaarten zijn
   kaarten die eerder goed waren, óók met score 3). Een score-3-antwoord om
   05:39 gevolgd door score 2 om 05:44 (beide uur 04:00 UTC) geeft precies
   het gemelde beeld. Ook een herstart van de app tussen twee antwoorden
   (backend.log van vanochtend: POST progress 03:39:07 en 03:39:25 UTC,
   herstart 03:40:33, POST progress 03:44:34) telt hier als "andere sessie".
2. **Klokverschil tussen devices.** Een entry die > 1 u in de toekomst ligt
   sorteert als laatste (`_normalize`) en de gap naar nu valt stil weg.
   `_effectiveNowInstant` klemt alleen tot 1 u. In de DB-kopie van 2026-09-15
   zijn géén toekomstige entries gevonden, dus dit is onwaarschijnlijk maar
   niet uitgesloten.

Onderbouwing uit de DB-kopie (530 kaarten van Niels, stand 2026-09-15):

| patroon | aantal |
|---|---|
| zelfde kaart in twee opeenvolgende uren, overdue van het tweede antwoord = eerste + 1 (verouderde due) | 48 |
| gelogde overdue groter dan de gap sinds de vorige entry + 12 u (idem, verouderde due) | 16 |
| entry in de toekomst t.o.v. `updated_at` | 0 |
| entries niet chronologisch | 0 |

De `overdue=4` in de melding is dus vrijwel zeker de **verouderde due-datum
van het FlashCard-object in de sessie** (zie fout 1 hieronder), niet een
echte wachttijd.

## Fouten

### Fout 1 — verouderde due-datum in de reviewsessie (echte bug)

`ReviewController._finalise` geeft `cardDueDate: card.dueDate` mee. Dat
object komt uit `_cards` en wordt na een antwoord nooit ververst
(`_cardOverrides` wordt alleen bij een kaartbewerking gevuld). Bij elke
herhaling in dezelfde sessie is de overdue dus die van het eerste antwoord
plus de verstreken tijd. Gevolgen:

- het overdue-token in het log is fout (64 gevallen in de kopie);
- bij overdue > 12 u trekt `_earnedGap` ten onrechte uren van de gap af;
- de debuginformatie is misleidend ("overdue=4" terwijl de kaart net was
  beantwoord).

### Fout 2 — R1 behandelt een same-hour-break als nieuwe break (ontwerpkeuze, maar ongelukkig)

Het log houdt per uur het slechtste antwoord (`appendImpl`: "hour keeps its
worst"). Een score 2 na een score 3 in hetzelfde uur verandert het log dus
niet, maar de scheduler berekent er wél een nieuwe due uit: R1 met g=0 →
1 u. Terwijl de score-3-reset zelf 1–12 u had gegeven. Twee antwoorden die
in het log identiek zijn, horen dezelfde due te geven — anders geven twee
devices na dezelfde sync een andere uitkomst (recompute geeft de reset,
het live antwoord geeft 1 u).

Na een fóut in hetzelfde uur is 1 u wél het ontwerp (v4-plan: "een wrong zet
de kaart op +1 u; in-sessie herhaling loopt via TrainingMode").

### Fout 3 — stille verwerking van onmogelijke invoer

- Een laatste entry ná `nowHour` (klokfout) laat de gap naar nu stil
  wegvallen.
- Een overdue groter dan de tijd sinds de laatste entry is per constructie
  onmogelijk (due ≥ laatste antwoord), maar wordt niet afgevangen.

### Fout 4 — 409-nabehandeling kiest de vroegste due bij een nieuwer log

`FlushHandler._applyServerProgress` (flush_handler.dart, gebruikt na een
tweede 409 op rij en na een `set_core`-409) voegt de logs samen (unie, het
uur houdt het slechtste antwoord) maar neemt voor de due
`min(localDue, serverDue)`. Heeft de server een nieuwer antwoord (break op
uur H met due H+1…12) en lokaal staat nog de oude due van gisteravond, dan
houdt de kaart: log eindigend op de break van uur H, due van gisteravond.
De kaart is dan direct weer "due" met een overdue die niets met het log te
maken heeft, en een antwoord in uur H geeft R1 met g=0.

De gewone flushroute (`mergeDueDate`: server nieuwst → replay over het
samengevoegde log) en de catch-up-sync (`ServerReconciler.applyProgress`:
serverrij in zijn geheel) houden log en due wél consistent. Alleen deze
zijroute niet.

## Multi-device: wat de twee getallen samen bewijzen

`overdue=4` betekent dat het device de due van het avondantwoord kende (due
≈ 00:00 UTC, antwoord ≈ 04:00 UTC). `g=0` betekent dat het log op datzelfde
device eindigde op een break op of na 04:00 UTC. Een consistente rij (log
en due uit hetzelfde antwoord) kan die combinatie niet opleveren. De routes
die log en due uit elkaar laten lopen:

1. Fout 1: kaartobject in de sessie houdt de oude due, terwijl `_repetitions`
   in de sessie wél het antwoord van eerder dit uur bevat (zelfde device,
   herhaling of herlaad binnen het uur).
2. Fout 4: 409-nabehandeling met vroegste due (ander device schreef de break
   van uur H, dit device had nog de due van gisteravond).
3. Klok: het device dat de laatste entry schreef liep > 1 u voor.

Beslissend is de productierij van de kaart (Niels kan die zelf opvragen; de
sessie mag dat niet):

```
ssh -i ~/.ssh/fedora-hetzner root@178.104.88.142 "sudo -u postgres psql -d goldfish -tAF'|' -c \
  \"SELECT p.card_id, p.due_date, p.updated_at, p.repetitions FROM user_card_progress p \
    JOIN users u ON u.id=p.user_id WHERE u.email='nielsveldhoen1@gmail.com' \
    AND p.updated_at >= '2026-09-18' ORDER BY p.updated_at DESC LIMIT 40\""
```

De rij van de kaart eindigt dan op `18&04<letter>…`. Is die letter C–J en
komt er vóór dat uur alleen gisteravond, dan is route 1 of 2 bevestigd
(twee antwoorden in uur 04:00 UTC, het slechtste staat in het log).

## Wijzigingen

### A. Diagnose vastleggen vóór de fix

1. In `dbg(...)` van v4 de volgende regel toevoegen:
   `laatste=<datum uur token>  break=<idx/datum/token>  gap→nu=<h>`.
   Daarmee is uit één debugbubbel af te lezen welk van de twee routes
   hierboven speelde.
2. Niels leest de bestaande debugbubbel van het gemelde antwoord terug
   ("log voor: …"). Eindigt die op een entry van 04:00 UTC vandaag met
   token C–J, dan is route 1 bevestigd. Eindigt hij op de avond ervoor, dan
   is het een klok- of sync-probleem en moet route 2 verder worden
   uitgezocht vóór stap C.

### B. Verouderde due in de sessie (fout 1)

1. `ReviewController`: een `Map<String, DateTime> _dueOverrides` bijhouden;
   in `_finalise` na `processAnswer` `_dueOverrides[card.id] =
   result.dueDate` zetten en `cardDueDate: _dueOverrides[card.id] ??
   card.dueDate` meegeven.
2. Vangnet in `RepetitionServiceBase.processAnswer` (of in v4):
   `overdue = min(overdue, hoursBetween(laatste entry, nowHour))`. Een due
   vóór het laatste antwoord bestaat niet, dus dit is altijd veilig en houdt
   ook andere aanroepers (exam-recompute, flush-replay) schoon.
3. Geen datareparatie van bestaande logs: de foute tokens zitten op gaps
   van 1 u en beïnvloeden g niet (verdiende gap is daar toch 0).

### B2. 409-nabehandeling (fout 4)

`_applyServerProgress` laat de due bepalen door `mergeDueDate(...)` met het
samengevoegde log, precies zoals de gewone flushroute, in plaats van
`min(localDue, serverDue)`. Server nieuwst → replay over het samengevoegde
log; gelijk-recent → vroegste due. Test: lokaal log t/m gisteravond met
due 00:00, server log met break om 04:00 en due 05:00 → na 409-merge due
05:00 (niet 00:00).

### C. Same-hour-regel in v4 (fout 2)

Uitgangspunt (Niels, 2026-09-18): **een nieuw antwoord in hetzelfde uur kan
het log en de planning nooit verbeteren.** Dat de sessie opnieuw om een
score vraagt is puur voor de lopende reviewsessie; de planning is al
gedaan door het eerste antwoord van dat uur.

Regel, in `computeDueDateImpl` vóór de modusbepaling, als het uur al een
entry heeft (`rawHours.isNotEmpty && !nowHour.isAfter(rawHours.last.date)`):

1. `dueOud` = due die het log vóór dit antwoord al bepaalde
   (`recomputeDueDateImpl(existingLog)`: laatste entry afgespeeld op zijn
   eigen uur, met zijn eigen overdue).
2. Verslechtert dit antwoord het log niet (`appendImpl` levert hetzelfde
   log), dan is de due `dueOud`. Klaar; geen R1, geen g, niets.
3. Verslechtert het log wél (fout na goed, hogere graad), dan
   `dueNieuw = recomputeDueDateImpl(merged)` en de due wordt
   `min(dueOud, dueNieuw)`. Een reset van score 3 (tot 12 u) mag dus nooit
   later uitkomen dan wat het eerdere antwoord al had gezet.

Invariant, ook als test vast te leggen: **binnen één uur is de due na het
tweede antwoord nooit later dan na het eerste.**

Uitkomsten:

| eerder dit uur | nu | huidige code | wordt |
|---|---|---|---|
| fout (F–J) | score 1/2 | 1 u | due van de fout (1 u), ongewijzigd |
| score 3 (C) | score 1/2 | 1 u (R1, g=0) | due die de C al had gezet (1–12 u); niet beter dan de C, wel de fout in R1 weg |
| score 4/5 (D/E) | score 1/2 | 1 u | due van de D/E (1 u), ongewijzigd |
| score 1/2 | score 1/2 | g × base opnieuw | due van het eerste antwoord |
| score 1/2 | score 3+ | reset | min(due eerste antwoord, reset) |
| goed | fout | 1 u | 1 u |

De huidige code doet het omgekeerde van de invariant in het C→B-geval: het
tweede antwoord maakt de due *korter* (1 u) dan het eerste antwoord had
gezet, terwijl het log niet verandert. Dat is de gemelde fout.

Gevolg voor de merge in `flush_handler.mergeDueDate`: twee devices met
hetzelfde log geven dezelfde due (recompute is deterministisch), dus de
"earliest due wins"-clausule voor gelijk-recente logs blijft kloppen en
wordt niet meer getriggerd door een same-hour-herhaling.

Cheat (X) in hetzelfde uur: `appendImpl` maakt X een no-op op een dag met
een echt antwoord; de bestaande cheat-tak blijft vóór deze regel staan.

### D. Onmogelijke invoer zichtbaar maken (fout 3)

1. `_longestGapSince`: als de laatste entry méér dan 1 u na `nowHour` ligt,
   `debugPrint` met kaart-id en beide tijdstippen, en in de debuginfo de
   regel `KLOK: laatste entry ligt <n>h in de toekomst`. Gedrag verder
   ongewijzigd (gap naar nu telt niet; dat is correct: hij is niet gewacht).
2. Overdue-vangnet uit B.2 eveneens in de debuginfo tonen als het ingreep:
   `overdue geklemd 4 → 0 (due lag vóór laatste antwoord)`.

### E. Tests (frontend/test/repetition_service_v4_test.dart)

1. Score 3 om 12:10, score 2 om 12:25 (zelfde uur), verouderde due 4 u
   terug: due exact gelijk aan die van het score-3-antwoord; debuginfo
   bevat 'zelfde uur'; log ongewijzigd.
1b. Score 2 om 12:10 (g=2 u → due 12:00+4), score 3 om 12:25: log wordt C,
   due = min(eerste due, reset) = eerste due. Invariant: due nooit later
   dan na het eerste antwoord van het uur.
2. Fout om 12:10, score 2 om 12:25: due 13:00 (ongewijzigd gedrag).
3. Score 2 om 12:10, score 2 om 12:25 met verouderde due: overdue in het
   tweede antwoord geklemd op 0; log ongewijzigd.
4. Score 2 om 12:10, score 2 om 13:10 met verouderde due (overdue zou 5
   zijn): geklemd op 1; token `1~`.
5. Laatste entry 3 u in de toekomst: g negeert de gap naar nu, debuginfo
   bevat 'KLOK'.
6. `recomputeDueDate(log)` == live due voor elk van de bovenstaande logs
   (determinisme over devices).
7. ReviewController-test (of TrainingMode-scenario): kaart geleend en
   opnieuw gevraagd → tweede `processAnswer` krijgt de due van het eerste
   antwoord mee.

### F. Handmatige testlijst (multi-device)

1. Telefoon: trainingssessie, kaart score 3, later in dezelfde sessie
   geleend en score 2 → debugbubbel toont 'zelfde uur', due onveranderd
   t.o.v. het score-3-antwoord, overdue 0.
2. Telefoon: kaart fout, daarna score 2 in dezelfde sessie → due +1 u.
3. Laptop en telefoon: zelfde kaart binnen één uur op beide devices
   beantwoord (score 3 en score 2) → na sync op beide dezelfde due.
4. App herstarten tussen twee antwoorden op dezelfde kaart binnen één uur →
   tweede antwoord toont 'zelfde uur', geen overdue.
5. Kaart die écht de avond ervoor is beantwoord en nu score 2 krijgt → R1
   met g ≈ uren sinds gisteravond, interval g × base. Als hier tóch g=0
   verschijnt, geeft de nieuwe debugregel `laatste=…` aan welke entry de
   boosdoener is.

## Volgorde

A.1 en D (debug) eerst, dan B en B2, dan C met tests E, dan de testlijst F op de
tailnet-testrun. Geen logformaat- of serverwijziging nodig.

## Uitvoering (2026-09-18)

Alle onderdelen A t/m F zijn gebouwd. Twee dingen liepen anders dan gepland.

### Afwijking 1 — de scheduler kent nu het huidige due-moment

De invariant uit C ("binnen één uur nooit later dan na het eerste antwoord")
bleek niet haalbaar met alleen het log. `recomputeDueDateImpl` is namelijk
geen exacte reproductie van de live berekening: de moeilijkheidsblend
verschuift met elk antwoord van die dag, dus het log teruglezen kan een
LATERE due opleveren dan het eerste antwoord van het uur zette. De fuzztest
vond dat binnen enkele seconden (seed 183): antwoord 2 zette 16:00, antwoord
3 in hetzelfde uur las 00:00 terug uit het log.

Daarom heeft `computeDueDate(Impl)` er een optionele parameter bij:
`currentDue`, de due-datum die de kaart nu draagt. `processAnswer` geeft
`cardDueDate` door. In de zelfde-uur-tak wordt de uitkomst daarop geklemd,
met het volgende hele uur als ondergrens (een deck waarvan het examen
verlopen is, zet alle kaarten op nu; zonder die bodem bleef zo'n kaart in de
wachtrij staan). De andere aanroepers (exam-recompute, flush-replay) geven
`currentDue` niet mee en blijven puur op het log werken, zoals voorheen.
v1/v2/v3 accepteren de parameter en negeren hem.

### Afwijking 2 — fuzz-invariant 8 aangescherpt in plaats van gebroken

De fuzztest eiste dat score ≥ 4 (en score 3) altijd binnen 1 u (resp. 12 u)
plant. Dat geldt niet meer voor een antwoord in een uur dat al een entry
heeft: die plant helemaal niet zelf. De invariant is gesplitst: buiten de
zelfde-uur-tak ongewijzigd, binnen die tak de nieuwe eis dat de due nooit
later wordt dan wat er stond (invariant 8b).

### Wat waar staat

| onderdeel | plaats |
|---|---|
| A. debugregel `laatste=…  gap→nu=…  break=…` | `repetition_service_v4.dart`, `dbg()` |
| B. verse due in de sessie | `review_controller.dart`, `_dueOverrides` |
| B. vangnet overdue | `repetition_service_base.dart` `clampOverdueUnits`, override in v3 |
| B2. 409-nabehandeling via `mergeDueDate` | `flush_handler.dart`, `_applyServerProgress` |
| C. zelfde-uur-regel | `repetition_service_v4.dart`, vóór de modusbepaling |
| D. klok- en klemsignalen | `repetition_service_v4.dart` (`notices`), `repetition_service_base.dart` |
| E. tests | `repetition_service_v4_test.dart` (3 nieuwe groepen), `repetition_service_v4_fuzz_test.dart` (8b), `review_same_session_due_test.dart`, `flush_stale_write_due_test.dart` |

Testresultaat: 562 tests groen. De twee rode tests
(`exam_calendar_layout_test`, `deck_editor_smoke_test`) zijn layoutfouten
die losstaan van dit werk — ze raken de scheduler, de sessie en de flush
niet.

### Niet gedaan

De wiring van `_applyServerProgress` zelf is niet in een test gevangen: die
route vraagt een HTTP-antwoord en Hive. De beslissing die hij nu deelt met de
gewone flushroute (`mergeDueDate`) is wél getest, de wiring staat op de
handmatige lijst (F3).
