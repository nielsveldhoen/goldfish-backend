# Security-stappenplan Goldfish backend

Doel: de veiligheid van gebruikers(data) garanderen en de app beschermen tegen aanvallen.
Herzien op 2026-07-12, na de sharing-releases (contacten, deck-shares, groepen,
edit-rechten, publieke bibliotheek — migraties 015 t/m 019). Die features hebben
het aanvalsoppervlak wezenlijk veranderd; de oude versie van dit plan ging nog uit
van "alle data is strikt van één user".

Regels voor de uitvoerder:

- **Lees eerst de memory-bestanden** `project_db_access.md` en `project_remote_deploy.md` volledig voordat je iets aan DB of server doet.
- Na elke backend-wijziging: **beide** `BACKEND_API.md`-bestanden bijwerken (backend + frontend) als de API-contracten veranderen.
- Elke stap: kleine commit, tests draaien (`npm test`), niets deployen zonder expliciete toestemming van Niels.

---

## Het autorisatiemodel (lees dit vóór je iets aan autorisatie raakt)

De oude vuistregel "elke query moet op `user_id = req.user.id` filteren" **geldt niet meer**
voor decks en cards. Sinds deck-sharing zijn er drie niveaus, en elke callsite moet
expliciet zeggen welk niveau hij bedoelt. De SQL-fragmenten staan op één plek:
`src/utils/deckAccess.js`.

| Niveau | Fragment | Wie | Waarvoor |
|---|---|---|---|
| Lezen | `canReadDeckSql` | owner + recipient met actieve, geaccepteerde share | deck/kaarten lezen, review, deck-stats |
| Kaartbeheer | `canEditDeckSql` | owner + recipient met `can_edit` op zijn share-rij | kaarten maken/wijzigen/verwijderen |
| Eigenaar | `isDeckOwnerSql` | alleen `decks.user_id` | deck-writes, delen, rechten uitdelen, groepscatalogus |

De invariant is dus niet meer "eigen rijen", maar:

1. De handelende identiteit komt **altijd** uit het JWT (`req.user.id`) — nooit uit body/params.
2. Elke deck- of card-query loopt via één van bovenstaande fragmenten; geen enkele route
   bouwt zijn eigen ad-hoc toegangs-SQL.
3. Per-user rijen (`user_card_progress`, `user_stats`, `deck_stats`) blijven wél strikt
   op `user_id = req.user.id` — ook op een gedeeld deck houdt iedereen zijn eigen voortgang.
4. Toegang zit uitsluitend in `deck_shares` (`revoked_at IS NULL AND accepted_at IS NOT NULL`).
   Lidmaatschap van een groep geeft op zichzelf géén toegang; pas het toevoegen van een
   catalogus-deck maakt een share-rij. Daardoor sterft toegang automatisch mee met
   revoke/kick/unfollow.

Elke nieuwe route die decks of kaarten raakt moet aan 1–4 voldoen.

## Al aanwezig — niet opnieuw bouwen

- `helmet()`, CORS-allowlist (localhost + `CORS_ORIGINS`), body-limits (1mb JSON / 10kb urlencoded) — `src/app.js`
- argon2-wachtwoordhashes, wachtwoordlengte-limieten, anti-enumeration op register/resend/forgot
- Verificatie- en reset-tokens: 32 bytes random, alleen als SHA-256-hash in de DB, single-use, met expiry
- JWT (7d) + revocatie-watermerk (`tokens_valid_after`, fail-closed) — `src/middleware/auth.js`
- Input-validatielaag op alle write-routes — `src/utils/validate.js`
- Request-log zonder query strings (tokens lekken niet in eigen logs)
- Geparametriseerde queries (pg met placeholders) — overal
- Groepen: join-wachtwoord argon2-gehasht, join-code niet geheim maar zonder wachtwoord onbruikbaar,
  404 bij zowel onbekende code als fout wachtwoord
- Uitnodigen (deck-share én groep) kan alleen naar een **wederzijds geaccepteerd contact** —
  dat is de belangrijkste rem op spam en op ongevraagde toegang
- Rate limiters (per IP, 15min-venster): `/auth/*` 20, password-reset 20, `/auth/verify-email` 20,
  `/groups/join` 20, `GET /decks/public` 120

---

## Fase 1 — Audit (uitgevoerd 2026-07-12, bevindingen hieronder)

**1.1 — IDOR/autorisatie-audit.** Alle routes in `src/routes/*.js` nagelopen tegen het model
hierboven. **Uitkomst: geen IDOR gevonden.** Decks/cards/review/stats gebruiken consequent
`canReadDeckSql`/`canEditDeckSql`/`isDeckOwnerSql`; progress- en stats-writes zijn op
`req.user.id` gekeyd; geen enkele route haalt een user-id uit de body of params om er
autorisatie op te baseren. `revokeShares()` weigert te draaien zonder selector.

**1.2 — Secrets-audit.** `.env` staat in `.gitignore` en komt niet voor in de git-historie
(`git log --all --full-history -- '*.env'` is leeg). Geen hardcoded secrets in `src/`.
*Open:* sterkte van `JWT_SECRET` op de server is nog niet geverifieerd (zie 3.6).

**1.3 — Dependency-audit.** `npm audit`: 5 bevindingen (1 high, 4 moderate), **allemaal
transitief** en geen van alle exploiteerbaar via dit aanvalsoppervlak (`form-data` CRLF —
wij sturen geen user-gestuurde multipart-veldnamen; `ip-address` XSS — wij emitten geen
HTML uit die lib; `qs.stringify` DoS — wij parsen alleen). Alle vijf oplosbaar met
patch-bumps. → afgehandeld in stap 2.0.

**1.4 — Error-lekken.** Geen enkele route stuurt `err.message`, stack traces of
DB-foutdetails naar de client; alles is `{ error: "Server error" }` met `console.error`
ernaast. Geen bevinding.

**1.5 — NIEUW: e-mail-enumeratie via contacten.** `POST /v2/contacts` neemt een e-mailadres
en antwoordt `404 user_not_found` als er geen account is. Dat is een orakel: elke
ingelogde gebruiker kan ongelimiteerd toetsen wélke e-mailadressen een Goldfish-account
hebben. De route had geen rate limiter. Het orakel is inherent aan "uitnodigen op
e-mailadres" (de UX moet kunnen zeggen "die persoon zit er nog niet op"), dus de
mitigatie is throttlen, niet verbergen. → stap 2.6.

## Fase 2 — Code-hardening (uitgevoerd 2026-07-12)

**✅ Stap 2.0 — Dependency-patches.** `npm audit fix` gedraaid (alleen patch-bumps).
`npm audit` meldt 0 vulnerabilities.

**✅ Stap 2.1 — WS-payload-limiet.** `maxPayload: 64 KiB` in `src/ws.js`; een groter
bericht sluit de socket met `1009`. De ws-default was 100 MiB (gratis geheugen-DoS).

**✅ Stap 2.2 — WS-verbindingslimiet per user.** Max 10 gelijktijdige sockets per userId;
bij een 11e gaat de **oudste** dicht met close-code `4002` (nieuwe weigeren zou iemand met
tien dode sockets buitensluiten).

**✅ Stap 2.3 — Globale rate limiter op `/v2`.** 600 req/15min per IP (`src/middleware/limiters.js`),
ruim boven normaal sync-gedrag. De strengere route-limiters staan er los naast.

**✅ Stap 2.4 — Timing-gelijke login.** Het onbekende-user-pad verifieert nu tegen een
vaste dummy-hash, zodat beide paden precies één `argon2.verify` doen. Een corrupt/legacy
hash telt als ongeldig (401) in plaats van 500.

**✅ Stap 2.5 — Wachtwoord-blocklist.** `src/utils/commonPasswords.js`, toegepast bij
register én reset, case-insensitief. Bevat alleen entries van ≥8 tekens (korter wordt al
door de minimumlengte geweigerd). Geen complexity-regels, geen externe API.

**✅ Stap 2.6 — Limiter op de uitnodigingsroutes (bevinding 1.5).** 30/15min, gesleuteld op
**user-id** (niet IP — de aanvaller is per definitie ingelogd, en een IP-sleutel gooit
gebruikers achter dezelfde NAT op één hoop). Geldt voor `POST /v2/contacts` (het
e-mail-orakel), `POST /v2/decks/:id/share` en `POST /v2/groups/:id/invites`.

**◐ Stap 2.7 — Token uit de WS-URL halen. Backend klaar, frontend open.**
Het JWT in de query string (`/ws?token=...`) belandt in de Caddy-accesslogs. De server
accepteert het token nu óók als eerste bericht (`{"type":"auth","token":"..."}`) met een
auth-timeout van 5s; het query-token blijft werken zolang oude clients bestaan.
**Nog te doen:** `lib/services/realtime_sync_service.dart` laten overschakelen op het
auth-bericht, en pas daarná (zodra `min_client_build` de oude clients uitsluit) het
query-token uit `src/ws.js` verwijderen. Beide `BACKEND_API.md`'s beschrijven het overgangspad.

## Fase 3 — Infra-hardening (uitgevoerd 2026-07-12)

> **Correctie t.o.v. de oude versie van dit plan:** de reverse proxy is **nginx** (1.18,
> Ubuntu), niet Caddy. De `Caddyfile` in de repo is dood gewicht van vóór de
> domein/TLS-migratie. Configs staan in `/etc/nginx/sites-enabled/{goldfish,api-goldfishstudy}`.

**✅ Stap 3.1 — Netwerk-oppervlak.** Externe portscan: alleen **22/80/443** bereikbaar
(3000, 5432, 111 en 1022 gefilterd). Verder opgeruimd:
- `HOST=127.0.0.1` gezet in `src/.env` — de backend bond op `0.0.0.0:3000` en luistert nu
  alleen nog op loopback (nginx praat er via 127.0.0.1 mee). Defense-in-depth naast iptables.
- **`rpcbind`** luisterde op `0.0.0.0:111` zonder enige functie voor deze app → gestopt,
  `disable`d en `mask`ed (rpcbind is een bekende amplificatie-vector als hij ooit open komt te staan).
- **Weesproces opgeruimd:** een `sshd` van een afgebroken `do-release-upgrade` luisterde
  sinds 31 mei op poort 1022. Geen upgrade-proces actief; killed.
- **Nog te doen (OCI-console, alleen Niels):** controleer of de Ingress-regel voor poort
  3000 nog in de VCN Security List staat en haal hem weg. Extern is 3000 dicht (iptables),
  dus dit is opruimen, geen gat.

**✅ Stap 3.2 — TLS/headers (nginx).** HTTP→HTTPS-redirect werkt; Let's Encrypt via certbot
(`certbot.timer` actief). De **API** stuurde al HSTS + nosniff + frame-options (die komen van
`helmet()`), maar de **statische frontend** (`goldfishstudy.app`) had géén security-headers →
toegevoegd (HSTS 1 jaar + includeSubDomains, nosniff, SAMEORIGIN, Referrer-Policy).
- **Bonus (hoort bij 2.7):** de nginx access-log logde de **volledige query string**, dus het
  JWT van `/ws?token=...` stond leesbaar in `/var/log/nginx/access.log`. Er is nu een
  `noquery`-logformaat (`$uri` i.p.v. `$request`) actief op het API-serverblok.
- Opgeruimd: twee stale backup-configs in `sites-enabled/` (nginx laadde die mee; één
  serveerde de frontend nog over plain HTTP op het oude, verlopen IP `92.5.235.225`).

**✅ Stap 3.3 — SSH-hardening.** `PasswordAuthentication no` stond al goed; `PermitRootLogin`
stond op `without-password` en is nu **`no`**. Geverifieerd: `ubuntu`-login met key werkt,
`root@…` wordt geweigerd. `MaxStartups 100:30:200` (uit een eerdere sessie) blijft staan.
fail2ban is bewust **niet** geïnstalleerd: de SSH-resets kwamen van volle half-open slots,
en dat is met MaxStartups verholpen.

**✅ Stap 3.4 — Patches en runtime.**
- ✅ `unattended-upgrades` actief; Node **v22** (actieve LTS).
- ✅ **pm2 startte niet bij boot** — er was geen `pm2-ubuntu.service`. `pm2 startup` +
  `pm2 save` gedaan; na een reboot komt de backend nu vanzelf terug (getest).
- ✅ **OS-upgrade uitgevoerd: Ubuntu 20.04 → 22.04 → 24.04.4 LTS** (security-support tot
  april 2029, dus geen ESM/Pro meer nodig). Zie het kopje hieronder — er zaten drie
  voetangels in die bij een volgende machine weer opduiken.

### OS-upgrade 20.04 → 24.04 (12 juli 2026) — wat erbij kwam kijken

Blijft binnen **Always Free**: die hangt aan de *shape* (`VM.Standard.E2.1.Micro`, waarvan er
twee gratis zijn) en Ubuntu is een Always Free-eligible image; een in-place upgrade verandert
niets aan shape of storage. Boot-volume-snapshot vooraf is óók gratis (5 volume-backups
inbegrepen).

Vooraf: 2 GB **swap** aangemaakt (de VM heeft 952 MB RAM — een dist-upgrade OOM't daar zonder
swap; hij is tijdens de upgrade ook echt aangesproken). Verse DB-dump + alle serverconfigs
off-box gehaald, en Niels maakte een boot-volume-snapshot.

Drie dingen die misgingen of stil fout hadden kunnen gaan:

1. **NodeSource blokkeerde de upgrade.** `do-release-upgrade` faalde met
   `pkgProblemResolver::Resolve generated breaks` — in het log: `DEBUG Foreign: nodejs`. De
   Node uit de NodeSource-repo botst met die van Ubuntu. Oplossing: repo tijdelijk weg,
   `nodejs` verwijderen (de app ligt er dan uit), upgraden, en Node 22 daarna opnieuw
   installeren + `pm2 resurrect`. De `pm2`-module in `/usr/lib/node_modules` overleeft dat.
2. **Postgres migreert NIET vanzelf mee.** De release-upgrade liet `postgresql-12` gewoon
   staan (er was geen `postgresql`-metapakket), en bij het installeren van een nieuwe versie
   komt er een **lege** cluster naast de oude. Zonder `pg_upgradecluster` praat de app dus
   tegen een lege database. Gedaan: 12 → 14 (op jammy) en 14 → 16 (op noble), elke keer met
   een rij-controle vóór/na (`users=3 cards=811`, beide keren gelijk) en de oude cluster pas
   daarná gedropt.
3. **De non-interactieve upgrader reboot niet zelf** — `/var/run/reboot-required` blijft staan.
   Handmatig rebooten hoort bij de procedure.

Bonusvondst tijdens de nacontrole: `/etc/iptables/rules.v4` bevatte de regelset **dubbel**
(alles ná de `REJECT` is dode code), en dat verdubbelde bij elke boot. Bestand herschreven
naar één schone set; na een reboot blijft het nu op 7 regels staan.

**◐ Stap 3.5 — Database.**
- ✅ Postgres luistert alleen op `localhost`; `pg_hba` staat alleen peer (socket) en md5 op
  127.0.0.1 toe. App-rol `goldfish` is **geen** superuser (geen createdb/createrole) en heeft
  alleen DML; alle tabellen zijn eigendom van `postgres`.
- ✅ **Er was géén enkele backup.** Nu: `/usr/local/bin/goldfish-backup.sh` (pg_dump | gzip),
  dagelijks 03:30 via `/etc/cron.d/goldfish-backup` als user `postgres`, naar
  `/var/backups/goldfish`, **14 dagen retentie**, met een sanity-check op de dump. Dumps zijn
  leesbaar voor groep `ubuntu` (scp), niet voor de wereld.
- ✅ **Testrestore gelukt**: dump teruggezet in een tijdelijke database; rij-aantallen exact
  gelijk aan live (3 users, 52 decks, 811 cards, 7 deck_shares, 17 migraties).
- ⚠️ **Nog te doen: off-box-kopie.** Alles staat nu op dezelfde VM — dat beschermt tegen een
  `DROP`/bug, niet tegen verlies van de machine. Gekozen richting: **Oracle Object Storage**.
  Nodig van Niels: een bucket + een **Pre-Authenticated Request (PUT)**-URL uit de OCI-console;
  daarna is het één regel in `goldfish-backup.sh` (de `UPLOAD_HOOK` staat er al, uitgecommentarieerd).

**✅ Stap 3.6 — `JWT_SECRET`.** 64 hex-tekens = **32 random bytes**. Sterk genoeg; geen rotatie
nodig (en rotatie logt iedereen uit).

## Fase 4 — Detectie en proces

**Stap 4.1 — Security-logging.** Log zonder PII/tokens: mislukte logins per IP,
rate-limit-hits, 401/403-aantallen, WS-auth-failures. Gestructureerde console-regels
(pm2/journald bewaart ze) + logrotatie.
*Acceptatie:* een mislukte login is terug te vinden met timestamp en IP, zonder wachtwoord/token.

**Stap 4.2 — Dependency-proces.** `npm audit` als pre-deploy-stap in `DEPLOY.md`; lockfile
altijd committen; geen nieuwe dependencies zonder noodzaak (de lijst is bewust kort — zo houden).
*Acceptatie:* gedocumenteerde check in `DEPLOY.md`.

**◐ Stap 4.3 — Security-regressietests.** Grotendeels gedekt:
(a) IDOR zonder share → `sharing.test.js`; (b) `can_edit` wel/niet → `edit-rights.test.js`;
(c) toegang weg na revoke/unfollow/kick → `sharing.test.js` + `groups.test.js`;
(d) verlopen/ingetrokken JWT → `auth-401.test.js` (REST) + `ws.test.js` (WS);
(e) rate limiters + blocklist + WS-limieten → `security-hardening.test.js` (nieuw).
**Nog open:** (f) oversized bodies → 413/400.

**Stap 4.4 — Gebruikersdata en privacy (uitgebreid door sharing).**
Ontwerp een account-verwijderflow: wissen van users, decks, cards, progress, stats, tokens,
tombstones — **plus** contacts, deck_shares, groups, group_members, group_decks. Denk na over
de randgevallen die sharing introduceert: wat gebeurt er met decks die anderen volgen als de
eigenaar zijn account wist, en met een groep waarvan de owner vertrekt?
Documenteer waar welke persoonsgegevens staan (e-mail staat in `users` en lekt via
`GET /contacts` naar geaccepteerde contacten — groepsresponses bevatten bewust nooit e-mail).
*Acceptatie:* kort ontwerpdocument + datamap; implementatie in overleg met Niels.

---

## Stand van zaken (2026-07-12)

- **Fase 1 — klaar.** Geen IDOR, geen secrets in git, geen error-lekken. Eén nieuwe
  bevinding (1.5, e-mail-enumeratie via contacten) → gemitigeerd in 2.6.
- **Fase 2 — klaar op de frontend-helft van 2.7 na.** `npm test` groen (267 tests).
  **De code staat nog niet op de server** (branch `security-hardening-fase-2`).
- **Fase 3 — klaar op drie punten na** (die hieronder als ⚠️ staan). De infra-wijzigingen
  zijn al **live**: ze zitten in de serverconfig, niet in de repo, dus ze wachten niet op een deploy.
- **Fase 4 — 4.3 grotendeels gedekt; 4.1, 4.2 en 4.4 open.**

**Wat nog moet — in volgorde:**

1. **Beslissing Niels: off-box backup** (3.5). Bucket + PAR-URL uit de OCI-console; de
   upload-hook staat klaar in `goldfish-backup.sh`.
2. **Opruimen in de OCI-console** (3.1): eventuele resterende 3000-ingress-regel.
3. Fase 2 deployen (`git pull` + `pm2 restart`) — geen migratie nodig, geen schema-wijziging.
4. Frontend-helft van 2.7 (WS-token uit de URL).
5. Fase 4: 4.1 (security-logging), 4.2 (`npm audit` in DEPLOY.md), 4.4 (account-verwijderflow).

De server draait na de upgrade op: Ubuntu 24.04.4, kernel 6.17, nginx 1.24, PostgreSQL 16.14,
Node 22.23. Alle hardening uit fase 3 is ná twee release-upgrades en een reboot opnieuw
geverifieerd (loopback-bind, sshd, firewall, rpcbind, noquery-log, backup-cron, pm2-bij-boot).

Niet doen zonder overleg: `JWT_SECRET` roteren (logt iedereen uit), JWT-levensduur
verkorten/refresh-tokens invoeren (grote frontend-impact), dependencies major-updaten.
