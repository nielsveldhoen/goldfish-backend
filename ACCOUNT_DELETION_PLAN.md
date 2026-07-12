# Account verwijderen — ontwerp en datamap

Hoort bij SECURITY_PLAN.md, stap 4.4. **Dit is een ontwerp, nog geen implementatie.**
Er zitten productbeslissingen in (wat gebeurt er met decks die anderen gebruiken?) die
Niels moet maken voordat er code komt.

Geschreven op basis van het echte schema in productie (FK-regels uitgelezen op 2026-07-12),
niet op basis van wat de migraties zouden moeten hebben gedaan.

---

## 1. Datamap — waar staan persoonsgegevens?

| Gegeven | Waar | Opmerking |
|---|---|---|
| E-mailadres | `users.email` | **De enige plek.** Nergens gedupliceerd. |
| Gebruikersnaam | `users.username` | Zichtbaar voor contacten, groepsleden en volgers van een publiek deck (`owner_username`). |
| Wachtwoord | `users.password_hash` | argon2. |
| Verificatie-/reset-tokens | `email_verification_tokens`, `password_reset_tokens` | Alleen SHA-256-hashes, met expiry; de purge-job ruimt verlopen exemplaren al op. |
| Sociale relaties | `contacts`, `deck_shares`, `group_members`, `group_decks` | Wie kent wie, wie deelt wat. |
| Inhoud | `decks`, `cards` | Kan alles bevatten wat de gebruiker intypt — behandel als persoonsgegeven. |
| Leergedrag | `user_card_progress`, `deck_stats`, `user_daily_snapshot` | Wanneer en hoe goed iemand leert. |
| IP-adressen | pm2/nginx-logs | Alleen in logs (security-events, access-log), niet in de database. Vallen onder logretentie, niet onder een account-delete. |

**E-mail lekt naar buiten via precies één route:** `GET /v2/contacts` geeft het adres van je
contacten terug (en van wie jou een verzoek stuurde). Groeps- en share-responses bevatten
bewust **nooit** een e-mailadres — alleen `user_id` + `username`. Dat onderscheid moet zo blijven.

## 2. Wat het schema vandaag doet bij `DELETE FROM users`

Uitgelezen uit de FK-regels in productie:

**CASCADE (verdwijnt vanzelf):** `contacts`, `decks` → `cards` → `user_card_progress`,
`deck_stats`, `user_daily_snapshot`, `group_members`, `groups` (waar je owner van bent),
`group_decks.added_by`, `email_verification_tokens`, `password_reset_tokens`.
`group_members.invited_by` wordt `SET NULL`.

**NO ACTION — hier klapt het:**

- `deck_shares.owner_id` / `deck_shares.recipient_id` → **een kale `DELETE FROM users` faalt
  met een foreign-key-fout** zodra de gebruiker ook maar één share-rij heeft (nu 7 actieve in
  productie). `deck_shares` moet dus expliciet vóóraf worden opgeruimd.
- `deck_shares.deck_id` en `group_decks.deck_id` → hetzelfde probleem één laag dieper: de
  cascade wil je decks verwijderen, maar die zijn nog aan share- en catalogusrijen geketend.
- `deck_shares.group_id` → idem voor de groepen waarvan je owner bent.

Met andere woorden: **de delete-volgorde is niet optioneel.** Eerst `deck_shares` en
`group_decks`, dan pas de rest.

## 3. De echte productvraag: wat gebeurt er met gedeelde decks?

Dit is geen technische keuze maar een belofte aan gebruikers. Als de eigenaar zijn account
wist, cascadeert vandaag `decks` → `cards` → **ook de `user_card_progress` van iedereen die
dat deck volgde of gedeeld kreeg**. Iemand die maanden op jouw deck heeft geleerd, ziet het
zonder waarschuwing verdwijnen — inclusief zijn eigen leerhistorie.

Drie opties:

- **A. Alles weg (huidige cascade).** Eerlijkst richting de vertrekker: zijn inhoud is echt
  weg. Hardst richting de rest. Verdedigbaar: het deck wás van hem.
- **B. Anonimiseren i.p.v. verwijderen.** `users`-rij leeghalen (e-mail/username/hash naar
  `NULL` of een placeholder, `deleted_at` zetten), decks laten staan onder een "verwijderde
  gebruiker". Volgers houden hun deck en hun voortgang. Maar: dit is **geen echte
  verwijdering** — de inhoud die iemand schreef blijft online. Onder de AVG mag dat alleen als
  het deck redelijkerwijs geen persoonsgegevens meer bevat, en dat kun je niet garanderen
  (kaarten kunnen van alles bevatten).
- **C. Splitsen.** Bij het wissen krijgt de gebruiker de keuze: *"3 mensen gebruiken jouw deck
  'Spaans'. Overdragen aan een van hen, of verwijderen?"* Overgedragen decks krijgen een nieuwe
  `user_id`; de rest wordt hard verwijderd.

**Advies: A als basis, C als uitbreiding wanneer het pijn doet.** A is nu al het gedrag van het
schema, is uitlegbaar ("je decks gaan met je mee") en is AVG-schoon. C is netter maar vraagt UI,
een overdrachts-endpoint en randgevallen (wat als niemand het wil overnemen?). B zou ik niet
doen: het klinkt vriendelijk maar levert een halve verwijdering op, en dat is precies wat je
bij een verwijderverzoek niet wilt beloven.

Voor **groepen** speelt hetzelfde: `groups.owner_id` cascadeert, dus de groep verdwijnt met zijn
eigenaar. Bij een groep met leden is overdracht (aan het oudste actieve lid) waarschijnlijk het
minst vervelend — maar dat is dezelfde afweging als hierboven en kan in dezelfde slag.

## 4. Voorgestelde flow

**Endpoint:** `DELETE /v2/auth/me`, met het **wachtwoord in de body** als herbevestiging
(zelfde argon2-verify als login — een gestolen JWT mag geen account kunnen wissen).

**Bedenktijd.** Niet meteen hard verwijderen: zet `users.deletion_requested_at` en trek alle
JWT's in (`tokens_valid_after = NOW()`, het bestaande mechanisme). De gebruiker is dan direct
overal uitgelogd, kan niet meer inloggen, en de purge-job wist het account definitief na
bijv. 14 dagen. Dat vangt spijt en gehackte accounts op. Een mail bij de aanvraag
("je account wordt over 14 dagen gewist — was jij dit niet? klik hier") maakt het rond.

**Hard delete (in de purge-job, in één transactie), in deze volgorde:**

1. `deck_shares` waar de user owner óf recipient is — **eerst**, anders faalt de rest (NO ACTION).
2. `group_decks` van zijn decks en van zijn groepen.
3. `deck_shares` die nog naar zijn groepen of decks wijzen.
4. `DELETE FROM users` — de cascade doet de rest (decks, cards, progress, stats, contacts,
   groepen, tokens).
5. WS `deck_removed` / `group_removed` naar iedereen die toegang verliest, zodat hun client
   niet met wees-decks blijft zitten.

**Tombstones:** andere apparaten van de gebruiker zijn al uitgelogd, dus die hebben geen
sync-delta meer nodig. Voor *andere* gebruikers is het `deck_removed`-event de enige signalering
— die moet er dus echt zijn, anders houden zij een deck in hun Hive-box dat niet meer bestaat.

**Logs:** IP-adressen in de security- en access-logs blijven staan; die vallen onder logretentie
(nu: logrotate). Dat hoort in de privacyverklaring te staan, niet in de verwijderflow.

## 5. Wat er nog moet gebeuren vóór implementatie

1. **Beslissing Niels:** optie A, B of C uit §3 (en hetzelfde voor groepen).
2. Migratie: `users.deletion_requested_at` toevoegen.
3. Endpoint + purge-stap + WS-events + tests (kroonjuweel-test: ná verwijdering bestaat er
   nergens meer een rij met dit `user_id`, en houden andere gebruikers geen wees-decks over).
4. Frontend: knop, wachtwoordbevestiging, en de "je hebt nog 14 dagen"-melding bij inloggen.
