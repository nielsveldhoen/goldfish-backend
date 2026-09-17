# Goldfish — deploy

De productie draait sinds **16-07-2026 op Hetzner Cloud** (daarvóór Oracle Always Free; die
is verlaten na drie storingen in twee dagen). Backend achter **nginx**, met **pm2** als
procesmanager; de webfrontend is een statische Flutter-build op dezelfde server.

## Er zijn drie doelen. Kies er één

| Doel | Commando | Database | Raakt productie? |
|---|---|---|---|
| **1. Lokaal draaien** — ontwikkelen, testen, op je telefoon bekijken | `./scripts/dev.sh` | lege lokale DB (podman + `000_baseline.sql`) | nee |
| **2. Lokaal draaien met echte data** — een bug reproduceren die alleen in jouw account optreedt | `./scripts/dev.sh --db remote` | **productie**, via SSH-tunnel | **ja, schrijvend** |
| **2b. Lokaal draaien op een kopie van productie** — testen met je eigen decks zonder risico (nieuwe scheduler, sync-wijzigingen) | `./scripts/dev.sh --db copy` | pg_dump van productie, teruggezet in de lokale container | nee (dump is alleen lezen) |
| **3. Echt deployen** — de wereld ziet het | `./scripts/deploy.sh` + `./scripts/deploy-web.sh` | productie | **ja** |

Doel 1 en 2 zetten dezelfde stapel op — database, backend op `:3000`, webapp op `:8090` — en
verschillen alleen in waar de data vandaan komt. Doel 3 zet code op de server.

Twijfel je? Begin bij doel 1. Nieuwe machine? Eerst **[DEV_SETUP.md](DEV_SETUP.md)**.

---

## Back-up van de productie-database

```bash
mkdir -p ~/goldfish-backups
ssh -i ~/.ssh/fedora-hetzner root@178.104.88.142 \
  'sudo -u postgres pg_dump -Fc goldfish' > ~/goldfish-backups/goldfish-prod-$(date -u +%Y%m%d-%H%M).dump
```

Alleen lezen op de server; de dump is een custom-format `pg_dump` (~200 kB) en bevat
schema, data én eigendom. Controleer een verse dump door hem in de lokale container terug
te zetten en de rijen te tellen:

```bash
podman exec goldfish-db psql -U postgres -c "DROP DATABASE IF EXISTS goldfish_verify WITH (FORCE);" \
  -c "CREATE DATABASE goldfish_verify OWNER goldfish;"
podman exec -i -e PGPASSWORD=goldfish-lokaal goldfish-db \
  pg_restore -U goldfish -h 127.0.0.1 -d goldfish_verify --no-owner --no-privileges \
  --exit-on-error --single-transaction < ~/goldfish-backups/<dump>
podman exec goldfish-db psql -U postgres -d goldfish_verify -tAc \
  "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM decks), (SELECT count(*) FROM cards), (SELECT count(*) FROM user_card_progress)"
podman exec goldfish-db psql -U postgres -c "DROP DATABASE goldfish_verify WITH (FORCE);"
```

### Terugzetten op productie (destructief!)

Dit wist de huidige productiedata en zet de stand van de dump terug. Alles wat gebruikers
sinds de dump hebben gedaan is dan weg. Doe het bewust, stap voor stap:

```bash
DUMP=~/goldfish-backups/goldfish-prod-YYYYMMDD-HHMM.dump
K=~/.ssh/fedora-hetzner; T=root@178.104.88.142

# 1. backend stil (anders houdt hij verbindingen op de database open)
ssh -i $K $T "runuser -l goldfish -c 'pm2 stop goldfish-backend'"

# 2. eerst een dump van de HUIDIGE stand, voor het geval het terugzetten fout was
ssh -i $K $T 'sudo -u postgres pg_dump -Fc goldfish' > ~/goldfish-backups/pre-restore-$(date -u +%Y%m%d-%H%M).dump

# 3. dump naar de server en terugzetten
scp -i $K "$DUMP" $T:/tmp/restore.dump
ssh -i $K $T 'sudo -u postgres psql -c "DROP DATABASE goldfish WITH (FORCE);" \
                                  -c "CREATE DATABASE goldfish OWNER postgres;" \
  && sudo -u postgres pg_restore -d goldfish --exit-on-error --single-transaction /tmp/restore.dump \
  && rm /tmp/restore.dump'

# 4. backend weer aan en controleren
ssh -i $K $T "runuser -l goldfish -c 'pm2 start goldfish-backend'"
curl -s https://api.goldfish.<domein>/version
```

De productiedatabase `goldfish` is eigendom van `postgres`; de app verbindt als de rol
`goldfish`. Die rol staat los van de database en overleeft een drop/restore, dus je hoeft
hem niet opnieuw aan te maken.

## Doel 2b — lokaal draaien op een kopie van productie

```bash
./scripts/dev.sh --db copy            # eerste keer: dump ophalen en terugzetten; daarna hergebruik
./scripts/dev.sh --db copy --fresh    # de kopie weggooien en opnieuw van productie halen
./scripts/dev.sh --db copy --no-build # zelfde, zonder de webapp opnieuw te bouwen
```

Wat het doet: `sudo -u postgres pg_dump -Fc goldfish` op de server via SSH (alleen lezen),
de lokale database `goldfish` in de podman-container droppen en opnieuw aanmaken, de dump
als de app-rol `goldfish` terugzetten, en een markertabel `_dev_copy_of_prod` met het
dump-tijdstip aanmaken. `--status` toont dat tijdstip. De SSH-tunnel wordt gesloten, zodat
niets meer naar productie kan schrijven. Je logt in met je productie-account en -wachtwoord
(de hashes zitten in de dump). Zolang de marker bestaat hergebruikt `--db copy` de kopie en
weigert `./scripts/dev.sh` (doel 1) te starten — die verwacht een lege baseline; verwijder
dan eerst de container (`podman rm -f goldfish-db`) of gebruik `--db copy`.

`min_client_build` staat in de kopie op de productiewaarde (8), dus de `--status`-hint
"min_client_build > 0 ⇒ productie" gaat hier niet op; kijk naar de regel `database:`.

## Doel 1 — lokaal draaien (lege database)

```bash
./scripts/dev.sh                 # database + backend + webapp bouwen en serveren
./scripts/dev.sh --no-build      # bestaande build/web hergebruiken (scheelt ~30 s)
./scripts/dev.sh --status        # wat draait er, en op welke database
./scripts/dev.sh --stop          # alles afsluiten
```

Wat het doet: een podman-container met PostgreSQL 18 starten en vullen met
`migrations/000_baseline.sql`, `node src/index.js` op `0.0.0.0:3000` zetten, de Flutter-webapp
bouwen en op `:8090` serveren, en tot slot controleren of `/version` antwoordt en of CORS klopt.

De database is **leeg** — geen accounts, geen decks. Registreren kan, maar inloggen eist een
geverifieerd e-mailadres, en zonder geldige `RESEND_API_KEY` komt die mail nooit aan. Keur
daarom met de hand goed:

```bash
podman exec goldfish-db psql -U postgres -d goldfish \
  -c "UPDATE users SET email_verified = true WHERE email = 'jouw@adres';"
```

De container draait met `--rm`: na `--stop` of een reboot is je lokale data weg en laadt het
script de baseline opnieuw. Dat is de bedoeling — het is een wegwerpdatabase.

Wil je het op je telefoon of tablet bekijken: zie **[Testrun via Tailscale](#testrun-via-tailscale)**
hieronder. Dat werkt hetzelfde voor doel 1 en doel 2.

---

## Doel 2 — lokaal draaien tegen de productiedatabase

```bash
./scripts/dev.sh --db remote
```

Hetzelfde als doel 1, maar de backend praat via een SSH-tunnel (`127.0.0.1:5433`) met de
productie-DB. Je logt in met je echte account en ziet je echte decks. Het wachtwoord wordt bij
het starten uit de server-`src/.env` gelezen en leeft alleen in de environment van dat proces —
het komt niet op schijf en niet in je lokale `.env`.

**Wat je in de app doet, is een echte wijziging.** Een deck verwijderen is een deck verwijderen.
Er zit geen vangnet tussen; gebruik dit om te kíjken, niet om te experimenteren.

Het script zet `DISABLE_BACKGROUND_JOBS=1`, waardoor `src/index.js` de dagelijkse
`purgeDeletedAccounts` en `purgeTombstones` overslaat. Die hard-deleten rijen, en dat hoort de
server zelf te doen — niet een tweede instance op een laptop. Controleer in
`/tmp/goldfish-dev/backend.log` dat er "achtergrondjobs uitgeschakeld" staat.

Twijfel je of je op de goede database zit? `./scripts/dev.sh --status` toont het, en `/version`
verraadt het ook: `min_client_build` is `0` op de lokale baseline en `8` op productie.

Wil je je echte data zonder het risico, dan is het alternatief een dump naar de lokale
container. Dat haalt wel productiedata naar je machine — zie de grenzen in DEV_SETUP.md.

---

## Testrun via Tailscale

Zo bekijk je een draaiende testrun op je telefoon of tablet. Geldt voor doel 1 én doel 2 — de
stapel is dezelfde, alleen de database verschilt.

**Waarom niet gewoon het IP-adres?** De webapp draait op een kale `python3 -m http.server`.
Chrome upgradet een getypte hostname naar `https` en struikelt dan over die http-server, en op
een kale-IP-http-pagina is `crypto.subtle` er niet — dan gooit `flutter_secure_storage` vóór
`runApp` en krijg je een wit scherm. `tailscale serve` lost allebei op: een echt
Let's Encrypt-certificaat op een MagicDNS-naam, alleen binnen je tailnet.

### Eenmalig: de twee serve-mappings

```bash
sudo tailscale serve --bg --https=443   http://127.0.0.1:8090   # de webapp
sudo tailscale serve --bg --https=10000 http://127.0.0.1:3000   # de API
tailscale serve status                                          # controleren
```

`--bg` overleeft een reboot, dus dit doe je één keer per machine. Op Fedora staat het al:

```
https://fedora.tail556dec.ts.net        → 127.0.0.1:8090
https://fedora.tail556dec.ts.net:10000  → 127.0.0.1:3000
```

De API-poort is `10000` omdat `dev.sh` daarop detecteert (`GOLDFISH_TS_API_PORT`). Kies je een
andere, geef die dan bij élke `dev.sh`-aanroep mee — anders vindt het script de mapping niet.

Zet de tailnet-origin ook in `CORS_ORIGINS` in `src/.env`; localhost is altijd toegestaan, een
tailnet-hostnaam niet. Op Fedora staat er:

```
CORS_ORIGINS=https://fedora.tail556dec.ts.net,http://fedora.tail556dec.ts.net:8090,http://100.81.186.114:8090
```

### Elke testrun

```bash
cd ~/projects/goldfish/backend
./scripts/dev.sh                 # lege lokale database
./scripts/dev.sh --db remote     # of: de echte data — dan zijn het echte wijzigingen
```

**Kijk naar deze regel in stap 3/4 en niets anders:**

```
    API_BASE_URL in de build: https://fedora.tail556dec.ts.net:10000     ← goed
    API_BASE_URL in de build: http://localhost:3000                      ← alleen deze machine
```

Staat er `localhost`, dan vond het script geen serve-mapping op `:10000` en is de build
onbruikbaar op je tablet. Herstel de mapping en draai `dev.sh` opnieuw **zonder** `--no-build`.

Daarna open je op het device: **`https://fedora.tail556dec.ts.net`** — en **hard refreshen**.
De browser houdt `main.dart.js` vast en serveert anders stilletjes de vorige build. Op een
tablet is het tabblad sluiten en opnieuw openen het betrouwbaarst.

Een build met de tailnet-URL werkt óók gewoon op `http://localhost:8090` op deze machine: een
http-pagina mag een https-API aanroepen, en beide origins staan in CORS. Andersom niet. Bouw
dus altijd voor de tailnet-URL, ook als je zelf op je laptop kijkt.

### Controleren zonder de app te openen

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/                          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://fedora.tail556dec.ts.net/               # 200
curl -s -o /dev/null -w '%{http_code}\n' https://fedora.tail556dec.ts.net:10000/version  # 200
grep -c 'fedora.tail556dec.ts.net:10000' ~/projects/goldfish/frontend/build/web/main.dart.js
```

Die laatste is de beslissende: staat het getal op `0`, dan zit de verkeerde API-URL in de build,
wat de HTTP 200'en er ook van vinden.

```bash
./scripts/dev.sh --status        # wat draait er, en op welke database
./scripts/dev.sh --stop          # alles afsluiten (tunnel, backend, webserver)
tail -f /tmp/goldfish-dev/backend.log
```

### Valkuilen

- **De app laadt, maar er is niks te zien — geen decks, geen kaarten.** Bijna altijd een build
  met `API_BASE_URL=http://localhost:3000` die je op een ánder device opent: de app zoekt de API
  dan op de localhost van de tablet. Bewijs staat in `/tmp/goldfish-dev/backend.log` — alleen
  `GET /version` (dat is de webserver zelf), geen login en geen `/v2/decks`. Opnieuw bouwen.
- **`GOLDFISH_TS_API_PORT=<ongebruikte poort>`** forceert de localhost-tak van `dev.sh`. Handig
  als je expres alleen op deze machine wilt draaien, maar het breekt elk ander device. Gebruik
  het bewust, en bouw daarna opnieuw.
- **`--no-build` na een URL-wissel.** `API_BASE_URL` is een compile-time `--dart-define`; een
  hergebruikte build houdt de oude URL vast. Het script waarschuwt, maar gaat wél door.
- **Deze build nooit deployen.** In `build/web/` staat nu een app die naar je laptop wijst.
  `deploy-web.sh` zou die naar productie sturen — bouw eerst opnieuw zonder `--dart-define`, of
  gebruik `deploy-web.sh --build`.
- **Tailscale down of uitgelogd op het device.** `tailscale status` op beide kanten; de
  serve-mappings zijn tailnet-only en dus onbereikbaar vanaf een normaal netwerk.

---

## Doel 3 — echt deployen

```bash
./scripts/deploy.sh          # backend: tests → rsync → migraties → npm ci → pm2 restart → healthcheck
./scripts/deploy-web.sh      # webfrontend: build/web/ → /var/www/goldfish (met terugrolkopie)
```

Draai eerst `./scripts/deploy.sh --dry-run`; dat toont de migratiestand en de rsync-verschillen
en wijzigt niets op de server. De rest van dit document beschrijft deze twee scripts: wat ze
stap voor stap doen, hoe je terugrolt, en welke valkuilen eerder zijn misgegaan.

**Let op bij de webdeploy:** `deploy-web.sh` zet de build uit `build/web/` op de server. Heb je
daar net met `dev.sh` een build in gezet die naar je laptop wijst, dan zou je die naar productie
sturen. Bouw daarom altijd opnieuw zonder `--dart-define`, of met de productie-URL:

```bash
cd ~/projects/goldfish/frontend
flutter build web --release        # zonder dart-define ⇒ https://api.goldfishstudy.app
cd ~/projects/goldfish/backend && ./scripts/deploy-web.sh
```

`deploy-web.sh --build` doet precies dat: bouwen zonder overrides, en dan deployen.

---

## Productie in het kort

| | |
|---|---|
| Server | Hetzner Cloud `niels-server`, CX23 (2 vCPU / 4 GB / 40 GB), locatie DE, ~€8/mnd |
| Toegang | `ssh -i ~/.ssh/fedora-hetzner root@178.104.88.142` (login als **root**) |
| OS / stack | Ubuntu 26.04 LTS, PostgreSQL 18, Node 22 (NodeSource), nginx 1.28, pm2 7, certbot 4 |
| App-user | **`goldfish`** (niet root) — code in **`/home/goldfish/backend`** |
| Proces | pm2, naam **`goldfish-backend`**; systemd-unit `pm2-goldfish.service` (start na reboot) |
| Bind | `HOST=127.0.0.1`, `PORT=3000` — alleen via nginx bereikbaar (ufw: 22/80/443) |
| Reverse proxy | nginx sites: `goldfish` (apex + www) en `api-goldfishstudy` (proxy → 127.0.0.1:3000, incl. WS-upgrade) |
| Database | PostgreSQL 18, db `goldfish`, app-rol `goldfish` (DML-only; tabellen zijn van `postgres`) |
| Env | **`/home/goldfish/backend/src/.env`** (0600) — staat niet in git en gaat **nooit** mee met rsync |
| Webfrontend | statische build in `/var/www/goldfish`, owner `goldfish:goldfish` |
| TLS | Let's Encrypt via `certbot --nginx`, auto-renew via `certbot.timer` |
| DNS | Cloudflare, **DNS-only / grijze wolk** — proxien breekt certbot én de WebSocket |
| Backups | dagelijks 03:30 → `/var/backups/goldfish` (14 dagen). **Off-box backup ontbreekt nog** |

Er is bewust **geen** git-pull-deploy op deze server: de deploy is een `rsync` vanaf je laptop.
De server heeft geen deploy-key en hoeft niet bij GitHub te kunnen.

---

## Wat je op een nieuwe machine nodig hebt

De volledige opzet — tooling, sleutels, lokale database, `src/.env` — staat stap voor stap in
**[DEV_SETUP.md](DEV_SETUP.md)**. Wat je daar niet vandaan haalt maar moet meebrengen, is een
SSH-sleutel die de server kent:

| Sleutel | Machine | Opmerking |
|---|---|---|
| `~/.ssh/fedora-hetzner` | Fedora | ed25519, 09-08-2026, `SHA256:eCYqALGjjPtBoMDqcqtjaaeSycSY5u37fZId4xjrtBk` |
| `~/.ssh/ssh-key-2026-05-31-goldfish.key` | oude laptop | RSA-2048, sinds 31-05-2026 |

Beide staan in `/root/.ssh/authorized_keys` en beide worden door de deployscripts **automatisch
gevonden**; heet jouw sleutel anders, geef hem dan mee met `GOLDFISH_SSH_KEY`. Kopieer een
private key **niet** via een chatvenster of e-mail — USB-stick, wachtwoordmanager of `scp`.
Vergeet `chmod 600` niet, anders weigert ssh de sleutel.

Liever een **nieuwe** sleutel dan de bestaande kopiëren:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/goldfish-<machine>.key -C "goldfish deploy <machine>"
# publieke deel toevoegen op de server (vanaf een machine die er al in kan):
ssh -i ~/.ssh/fedora-hetzner root@178.104.88.142 \
  "echo '<inhoud van goldfish-<machine>.key.pub>' >> /root/.ssh/authorized_keys"
# en daarna deployen met:
GOLDFISH_SSH_KEY=~/.ssh/goldfish-<machine>.key ./scripts/deploy.sh
```

### Geheimen die alleen op de server (moeten blijven) staan

Voor het geval de server ooit opnieuw opgebouwd moet worden — dit is wat je dan terug moet
hebben, en wat je dus ergens veilig bewaard wilt hebben:

- `/home/goldfish/backend/src/.env` — `DATABASE_URL` (met het op 16-07-2026 geroteerde
  DB-wachtwoord), `JWT_SECRET` (**roteren = iedereen uitloggen**), `RESEND_API_KEY`,
  `FROM_EMAIL`, `APP_URL`, `CORS_ORIGINS`, `TRUST_PROXY=1`, `HOST=127.0.0.1`, `PORT=3000`.
- `/root/dbpw` — kopie van het DB-wachtwoord (root-only).
- Accounts, geen bestanden: **Hetzner Cloud** (console + rescue), **Cloudflare** (DNS),
  **Resend** (mail), **GitHub**. Zonder Cloudflare-toegang kun je geen certificaat vernieuwen
  na een IP-wissel.
- Let's Encrypt-certificaten in `/etc/letsencrypt` hoef je niet te bewaren — certbot haalt
  ze opnieuw op zolang de DNS klopt.

---

## Pre-deploy checklist

`./scripts/deploy.sh` doet dit zelf, maar los draaien kan ook:

```bash
npm test     # alle tests groen (vereist een lokale DB)
npm audit    # geen bekende kwetsbaarheden
```

**`npm audit` hoort bij elke deploy.** De dependency-lijst is bewust kort — houd dat zo. Vindt
audit iets:

- **patch/minor** (`npm audit fix`): doen, lockfile committen, tests draaien.
- **major/breaking**: niet zomaar. Beoordeel eerst of het lek dit aanvalsoppervlak raakt.

Commit **altijd** de `package-lock.json` — de server installeert met `npm ci`, dus wat niet in
de lockfile staat, komt er niet op. En wijzigde de API? Werk **beide** `BACKEND_API.md`-bestanden
bij (backend-repo én de Flutter-repo).

---

## Backend deployen

```bash
./scripts/deploy.sh
```

Stap voor stap, zodat je weet wat het script doet (en het handmatig kunt overdoen):

```bash
KEY=~/.ssh/fedora-hetzner        # of ~/.ssh/ssh-key-2026-05-31-goldfish.key
SRV=root@178.104.88.142

# 1. Welke migraties draaiden er al?
ssh -i $KEY $SRV "sudo -u postgres psql -d goldfish -tAc \
  'SELECT version FROM schema_migrations ORDER BY version;'"
#    000 (dev-baseline), 001 en 002 horen hier NIET in te staan — dat klopt.

# 2. Code overzetten. --exclude 'src/.env' is ESSENTIEEL (anders overschrijft je
#    dev-.env de productiegeheimen). Excludes worden ook niet door --delete gewist,
#    dus node_modules en de .env op de server blijven staan.
rsync -az --delete --exclude node_modules --exclude .git --exclude test --exclude .claude \
  --exclude 'src/.env' --exclude '.env*' \
  -e "ssh -i $KEY" ~/projects/goldfish/backend/ $SRV:/home/goldfish/backend/
ssh -i $KEY $SRV "chown -R goldfish:goldfish /home/goldfish/backend"

# 3. Eerst een dump, dan de ontbrekende migraties — als postgres, want de tabellen
#    zijn van postgres en de app-rol mag geen DDL. Via STDIN, want postgres kan niet
#    lezen in /home/goldfish. Elke migratie (003+) is transactioneel en zet zelf zijn
#    rij in schema_migrations.
ssh -i $KEY $SRV "sudo -u postgres /usr/local/bin/goldfish-backup.sh"
ssh -i $KEY $SRV "sudo -u postgres psql -d goldfish -v ON_ERROR_STOP=1" < migrations/0XX_naam.sql

# 4. Dependencies (nodig zodra package-lock.json wijzigde)
ssh -i $KEY $SRV "runuser -l goldfish -c 'cd ~/backend && npm ci --omit=dev'"

# 5. Herstarten — pm2 restart is veilig; de pm2-DAEMON nooit killen (zie Valkuilen)
ssh -i $KEY $SRV "runuser -l goldfish -c 'pm2 restart goldfish-backend --update-env'"

# 6. Controleren
ssh -i $KEY $SRV "curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/version"
ssh -i $KEY $SRV "runuser -l goldfish -c 'pm2 logs goldfish-backend --lines 30 --nostream'"
curl -s -o /dev/null -w "%{http_code}\n" https://api.goldfishstudy.app/version   # → 200
curl -s -o /dev/null -w "%{http_code}\n" https://goldfishstudy.app/              # → 200
```

Opties van het script:

| Optie | Effect |
|---|---|
| `--dry-run` | toont migratiestand en rsync-verschillen, wijzigt niets |
| `--skip-tests` | slaat `npm test`/`npm audit` over (alleen bij een hotfix) |
| `--yes` | vraagt niet om bevestiging |

Andere server of sleutel? Alles is te overrulen met environment variables, bijv.
`GOLDFISH_SSH_KEY=... GOLDFISH_SSH_TARGET=root@1.2.3.4 ./scripts/deploy.sh`.

---

## Webfrontend deployen

De Flutter-app is een eigen repo (`goldfish-frontend`). Het script zoekt hem op
`~/projects/goldfish/frontend` (Fedora) en anders op `/mnt/c/programming/goldfish/goldfish_v1`
(oude WSL-laptop, waar de WSL-kopie verouderd is); een ander pad geef je mee met
`GOLDFISH_FLUTTER_DIR`.

```bash
./scripts/deploy-web.sh --build     # bouwen én deployen (~8 min bouwen)
./scripts/deploy-web.sh             # alleen de bestaande build/web/ deployen
```

Handmatig komt dat neer op:

```bash
FE=~/projects/goldfish/frontend        # op de oude laptop: /mnt/c/programming/goldfish/goldfish_v1

# Op Linux gewoon de lokale flutter:
cd $FE && flutter build web --release

# In WSL MOET het de Windows-flutter zijn: de Linux-flutter breekt op de
# Windows-paden in .dart_tool/package_config.json, en /mnt/c/.../flutter/bin/flutter
# is vanuit WSL onbruikbaar (CRLF → "/usr/bin/env: 'bash\r'"). Het script kiest
# deze tak zelf zodra het pad met /mnt/c/ begint:
cd $FE && cmd.exe /c "flutter build web --release"

# Terugrolkopie — rsync draait met --delete, zonder kopie is de vorige build weg
ssh -i $KEY $SRV "rm -rf /var/www/goldfish.bak-prev && cp -a /var/www/goldfish /var/www/goldfish.bak-prev"

rsync -az --delete -e "ssh -i $KEY" build/web/ $SRV:/var/www/goldfish/
ssh -i $KEY $SRV "chown -R goldfish:goldfish /var/www/goldfish"
```

**Verifiëren doe je op de md5 van `main.dart.js`**, niet op een HTTP 200 — een 200 zegt niets
over de versie:

```bash
curl -s https://goldfishstudy.app/main.dart.js | md5sum
md5sum $FE/build/web/main.dart.js
```

---

## Rollback

**Backend** — er staat geen git-repo op de server, dus terugrollen doe je door de vórige
commit opnieuw te deployen:

```bash
git log --oneline -5
git checkout <vorige-commit>
./scripts/deploy.sh --skip-tests --yes
git checkout main          # niet vergeten
```

**Webfrontend**:

```bash
ssh -i $KEY $SRV "rsync -a --delete /var/www/goldfish.bak-prev/ /var/www/goldfish/ && \
  chown -R goldfish:goldfish /var/www/goldfish"
```

**Een migratie draait niet vanzelf terug.** De meeste hebben een `_down.sql` — draai die
expliciet, en alleen als de nieuwe versie echt niet te redden is:

```bash
ssh -i $KEY $SRV "sudo -u postgres /usr/local/bin/goldfish-backup.sh"        # eerst een dump
ssh -i $KEY $SRV "sudo -u postgres psql -d goldfish -v ON_ERROR_STOP=1" < migrations/0XX_naam_down.sql
```

---

## Valkuilen (elk hier eerder misgegaan)

- **`--exclude 'src/.env'` weglaten bij de rsync** overschrijft de productiegeheimen met je
  dev-`.env`. Beide deploy-paden hebben de exclude; laat hem staan.
- **De pm2-daemon handmatig killen** (`pm2 kill` + los `pm2 start`/`pm2 resurrect`) laat
  `~/.pm2/pm2.pid` ontbreken, waarna `pm2-goldfish.service` faalt met "Can't open PID file"
  (18-07-2026). `pm2 restart <app>` is wél veilig; na een daemon-kill herstarten via
  `systemctl start pm2-goldfish.service`.
- **`sudo -u postgres psql -f migrations/…`** faalt: postgres kan niet lezen in
  `/home/goldfish`. Voer migraties via stdin aan (`… psql … < bestand.sql`).
- **Cloudflare op oranje zetten** breekt de certbot-validatie en laat de WebSocket haperen.
  DNS-only houden.
- **`/var/www/goldfish` chownen naar www-data** — in de praktijk is de owner `goldfish:goldfish`;
  na elke rsync opnieuw chownen.

---

## Env-variabelen (`src/.env` op de server)

Uitgangspunt is `.env.example` (in de repo-root; de app leest `src/.env`). In productie zijn
deze cruciaal:

- **`HOST=127.0.0.1`** — de app luistert dan alleen op loopback en is uitsluitend via nginx
  bereikbaar. Zonder deze regel bindt hij op `0.0.0.0`.
- **`TRUST_PROXY=1`** — alleen achter nginx. Zonder proxy weglaten: anders omzeilt iedereen met
  een verzonnen `X-Forwarded-For` de rate limiters.
- **`APP_URL=https://api.goldfishstudy.app`** — verificatie- en reset-links in mails.
- **`CORS_ORIGINS=https://goldfishstudy.app,https://www.goldfishstudy.app`** — localhost is
  altijd toegestaan (dev), requests zónder Origin (native apps) ook.
- **`JWT_SECRET`** — 32+ random bytes. **Roteren logt iedereen uit**; alleen na overleg.

Wijzig je de `.env` op de server, dan is een `pm2 restart goldfish-backend --update-env` nodig.

---

## Backups

- Dagelijks 03:30 via `/etc/cron.d/goldfish-backup` → `/var/backups/goldfish` (14 dagen),
  script `/usr/local/bin/goldfish-backup.sh`, log `/var/log/goldfish-backup.log`.
- Handmatig: `ssh -i $KEY $SRV "sudo -u postgres /usr/local/bin/goldfish-backup.sh"`
- Terugzetten: `gunzip -c <dump>.sql.gz | sudo -u postgres psql -d <db>`. Test een restore
  altijd eerst in een aparte database, nooit rechtstreeks over `goldfish` heen.
- ⚠️ **Open punt: er is nog géén off-box kopie** — precies de les van de Oracle-storing. Kies
  een bestemming (Hetzner Storage Box, pull naar de laptop, andere cloud).

---

## Security

De maatregelen en hun status staan in [SECURITY_PLAN.md](SECURITY_PLAN.md). Kort:

- Rate limiters staan centraal in `src/middleware/limiters.js`; elke hit wordt gelogd.
- Security-events (mislukte logins, geweigerde tokens, WS-auth-fouten, limiet-hits) gaan als
  JSON naar stderr, met tag `security` en **zonder** tokens, wachtwoorden of e-mailadressen:
  ```bash
  ssh -i $KEY $SRV "runuser -l goldfish -c 'pm2 logs goldfish-backend --lines 200 --nostream'" \
    | grep '"tag":"security"'
  ```
- De app logt requests als methode + pad, **zonder** query string (daar zit het WS-token in);
  nginx logt om dezelfde reden met het `noquery`-formaat.
- Openstaand op deze box: sudo-user i.p.v. root-login, `limit_conn` per IP op het nginx-API-blok,
  en de rest van fase 3 uit SECURITY_PLAN.md.
