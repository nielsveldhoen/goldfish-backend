# Goldfish — deploy

De productie draait sinds **16-07-2026 op Hetzner Cloud** (daarvóór Oracle Always Free; die
is verlaten na drie storingen in twee dagen). Backend achter **nginx**, met **pm2** als
procesmanager; de webfrontend is een statische Flutter-build op dezelfde server.

**De hele deploy zit in twee scripts:**

```bash
./scripts/deploy.sh          # backend: tests → rsync → migraties → npm ci → pm2 restart → healthcheck
./scripts/deploy-web.sh      # webfrontend: build/web/ → /var/www/goldfish (met terugrolkopie)
```

Draai eerst `./scripts/deploy.sh --dry-run` als je wilt zien wat er zou gebeuren; dat wijzigt
niets op de server. Nieuwe machine? Begin bij **[DEV_SETUP.md](DEV_SETUP.md)**.

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
