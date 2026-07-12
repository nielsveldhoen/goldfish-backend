# Goldfish backend — deploy

De server draait op **Oracle Cloud (Always Free)**, achter **nginx**, met **pm2** als
procesmanager. Deze notitie beschrijft de deploy zoals hij nu écht werkt — een eerdere versie
beschreef nog Caddy; dat klopt niet meer sinds de domein/TLS-migratie.

## Productie in het kort

| | |
|---|---|
| Server | Ubuntu 24.04 LTS, `ubuntu@141.148.226.78` (static reserved IP) |
| Repo op de server | `/home/ubuntu/goldfish/goldfish-backend` |
| Proces | pm2, naam **`goldfish-backend`** (start automatisch bij boot) |
| Reverse proxy | nginx → `127.0.0.1:3000`; TLS via Let's Encrypt/certbot |
| Database | PostgreSQL 16, alleen op localhost; app-rol `goldfish` (DML-only) |
| Env | **`src/.env`** (let op: niet in de repo-root), staat niet in git |
| Backups | dagelijks 03:30 → `/var/backups/goldfish` + off-box naar OCI Object Storage |

---

## Pre-deploy checklist

```bash
npm test          # alle tests groen (vereist een lokale DB)
npm audit         # geen bekende kwetsbaarheden
```

**`npm audit` hoort bij elke deploy.** De dependency-lijst is bewust kort — houd dat zo, en
voeg niets toe zonder noodzaak. Vindt `npm audit` iets:

- **patch/minor fix** (`npm audit fix`): doen, lockfile committen, tests draaien.
- **major/breaking fix**: niet zomaar doen. Beoordeel eerst of het lek dit aanvalsoppervlak
  raakt (veel meldingen zitten in code-paden die wij niet gebruiken) en overleg met Niels.

Commit **altijd** de `package-lock.json` — de server installeert met `npm ci`, dus alles wat
niet in de lockfile staat, komt er niet op.

## Deployen

De server **pullt zelf van GitHub**; alles moet dus gecommit én gepusht zijn.

```bash
git push origin main

ssh -i ~/.ssh/ssh-key-2026-05-31-goldfish.key ubuntu@141.148.226.78

cd /home/ubuntu/goldfish/goldfish-backend

# 1. Welke migraties draaiden er al? Vergelijk met migrations/ en draai alleen wat ontbreekt.
sudo -u postgres psql -d goldfish -c "SELECT version FROM schema_migrations ORDER BY version;"
#    (001 en 002 zijn ouder dan deze tracking en staan er niet in — dat klopt.)

# 2. Code ophalen
git pull --ff-only

# 3. Nieuwe migraties draaien — als postgres, want de tabellen zijn van postgres
#    en de app-rol mag geen DDL.
sudo -u postgres psql -d goldfish -v ON_ERROR_STOP=1 -f migrations/0XX_naam.sql

# 4. Dependencies (nodig zodra package-lock.json wijzigde)
npm ci --omit=dev

# 5. Herstarten
pm2 restart goldfish-backend --update-env

# 6. Controleren
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/      # → 200
pm2 logs goldfish-backend --lines 30 --nostream                      # → geen fouten
```

Extern nacontroleren:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.goldfishstudy.app/version   # → 200
curl -s -o /dev/null -w "%{http_code}\n" https://goldfishstudy.app/              # → 200
```

Wijzigt de API? Werk **beide** `BACKEND_API.md`-bestanden bij (backend + frontend-repo).

## Environment (`src/.env`)

Kopieer `.env.example`. In productie zijn deze cruciaal:

- **`HOST=127.0.0.1`** — de app luistert dan alleen op loopback en is uitsluitend via nginx
  bereikbaar. Zonder deze regel bindt hij op `0.0.0.0` (de default in `src/index.js`).
- **`TRUST_PROXY=1`** — alleen zetten wanneer de app achter nginx staat. Zonder proxy weglaten:
  anders kan iedereen met een verzonnen `X-Forwarded-For` de rate limiters omzeilen.
- **`APP_URL=https://api.goldfishstudy.app`** — verificatie- en reset-links in mails wijzen
  anders naar het verkeerde adres.
- **`CORS_ORIGINS`** — komma-gescheiden productie-origins (nu de twee frontend-domeinen).
  Localhost is altijd toegestaan (dev), requests zónder Origin (native apps) ook.
- **`JWT_SECRET`** — 32 random bytes. **Roteren logt iedereen uit**; alleen na overleg.

## Rollback

```bash
cd /home/ubuntu/goldfish/goldfish-backend
git log --oneline -5
git reset --hard <vorige-commit>
npm ci --omit=dev
pm2 restart goldfish-backend --update-env
```

Let op: een **migratie draait niet vanzelf terug**. De meeste hebben een `_down.sql` — die moet
je expliciet draaien, en alleen als de nieuwe versie echt niet te redden is. Bij twijfel: eerst
een dump maken (`sudo -u postgres /usr/local/bin/goldfish-backup.sh`).

## Backups

- Dagelijks 03:30 via `/etc/cron.d/goldfish-backup` → `/var/backups/goldfish` (14 dagen), plus
  upload naar de OCI-bucket `goldfish-backups` via een **write-only** PAR-URL
  (`/etc/goldfish-backup.env`, root-only).
- Handmatig een backup maken: `sudo -u postgres /usr/local/bin/goldfish-backup.sh`
- Log: `/var/log/goldfish-backup.log`. **Een mislukte off-box-upload (verlopen PAR!) logt een
  waarschuwing maar laat de lokale backup slagen** — check dit log af en toe.
- Terugzetten: `gunzip -c <dump>.sql.gz | sudo -u postgres psql -d <db>`. Test een restore
  altijd eerst in een aparte database, nooit rechtstreeks over `goldfish` heen.

## Security

De maatregelen en hun status staan in [SECURITY_PLAN.md](SECURITY_PLAN.md). Kort:

- Rate limiters staan centraal in `src/middleware/limiters.js`; elke hit wordt gelogd.
- Security-events (mislukte logins, geweigerde tokens, WS-auth-fouten, limiet-hits) gaan als
  JSON naar stderr, met tag `security` en **zonder** tokens, wachtwoorden of e-mailadressen:
  ```bash
  pm2 logs goldfish-backend --lines 200 --nostream | grep '"tag":"security"'
  ```
- De app logt requests als methode + pad, **zonder query string** (daar zit het WS-token in);
  nginx logt om dezelfde reden met het `noquery`-formaat.
