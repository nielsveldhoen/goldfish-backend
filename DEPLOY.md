# Goldfish backend — deploy- en migratienotitie

## Wat er nodig is

- **Domeinnaam** met een A-record (en evt. AAAA-record) dat naar het
  server-IP wijst, bijv. `api.goldfish.example`.
- **Open poorten: 80 en 443** (80 voor de Let's Encrypt ACME-challenge en de
  automatische http→https-redirect, 443 voor het verkeer zelf). Poort 3000
  hoeft (en hoort) NIET open te staan naar buiten.
- **Caddy** als reverse proxy (termineert TLS, regelt certificaten
  automatisch): https://caddyserver.com/docs/install

## Stappen

### 1. Database-migraties (als `postgres`-superuser)

De SQL-bestanden staan in [`migrations/`](migrations/) — zie de README daar.

```bash
sudo -u postgres psql -d goldfish -f migrations/001_progress_deleted_at.sql
sudo -u postgres psql -d goldfish -f migrations/002_hash_verification_tokens.sql   # éénmalig!
```

### 2. Environment

Kopieer `.env.example` naar `src/.env` en vul alles in. Belangrijk in
productie:

- `HOST=127.0.0.1` — de app is dan alleen via de proxy bereikbaar.
- `APP_URL=https://<jouw-domein>` — verificatielinks in e-mails wijzen
  anders naar het verkeerde adres.
- `JWT_SECRET` — lang en willekeurig; staat nooit in de code.

### 3. Caddy

Zet de `Caddyfile` uit deze repo op zijn plek (meestal `/etc/caddy/Caddyfile`)
en geef het caddy-proces de variabele `GOLDFISH_DOMAIN=<jouw-domein>` mee
(bij systemd: `Environment=GOLDFISH_DOMAIN=...` in een drop-in, of via
`/etc/caddy/caddy.env`). Caddy haalt en vernieuwt het certificaat zelf.

- WebSockets (`/ws`) worden automatisch geproxy'd; geen extra config nodig.
- Access logging staat standaard uit. Het `log`-blok in de Caddyfile
  redigeert de query string (`?token=...`) zodat JWT's en
  verificatietokens nooit in access logs belanden. Gebruik je tóch een
  eigen log-config, hou die filtering dan in stand — of log helemaal niet.

### 4. App starten

```bash
npm install
npm start           # of via systemd/pm2, met restart-on-failure
```

De app logt requests alleen als methode + pad (zonder query string) en logt
nooit Authorization-headers, wachtwoorden of tokens.

### 5. Controle

```bash
curl https://<jouw-domein>/            # → "Goldfish API running 🐟"
curl -I http://<jouw-domein>/          # → 308 redirect naar https
npm test                               # integratietests (lokaal, vereist DB)
```

## Wat er gewijzigd is t.o.v. de vorige versie (juni 2026)

- `"type": "module"` stond niet in `package.json`, waardoor de app op een
  kale checkout niet startte; gefixt. `npm start` / `npm run dev` toegevoegd.
- App bindt op `HOST` (default `0.0.0.0`, in productie `127.0.0.1` zetten).
- `trust proxy` aangezet (één hop) zodat rate limiting per echt client-IP
  werkt achter de proxy i.p.v. alle gebruikers samen te tellen.
- `helmet` security headers + JSON body-limit van 1 MB.
- Wachtwoorden: minimaal 8 tekens afgedwongen bij registratie
  (hashing was al argon2).
- E-mailverificatietokens worden sha256-gehasht opgeslagen en zijn
  gegarandeerd single-use.
- WebSocket: server-side heartbeat (dode verbindingen worden na ~60 s
  opgeruimd), close code `4001` bij ongeldige/verlopen tokens — ook als het
  token tijdens een open verbinding verloopt. Onparseerbare berichten worden
  genegeerd.
- Nieuw endpoint `DELETE /review/progress/:card_id` (zie BACKEND_API.md),
  inclusief soft-delete die via `/sync/changes` naar andere apparaten gaat.
- Nieuw WS-event `progress_deleted`.
- Integratietests in `test/` (`npm test`).
