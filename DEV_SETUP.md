# Goldfish backend — dev-machine opzetten (opdracht voor de AI-assistent)

Dit bestand is bedoeld om aan een AI-assistent op een **nieuwe dev-machine** te geven.
Doel: de backend lokaal kunnen draaien, `npm test` draaien, en vanaf deze machine kunnen
deployen naar de productieserver.

Werk de stappen in volgorde af en **verifieer elke stap** met het meegegeven commando voor je
verder gaat. Stop en vraag het aan Niels zodra iets afwijkt — gok niet.

---

## Wat Niels moet meebrengen van de oude machine

De repo bevat alles wat niet geheim is, inclusief het startschema. Er blijven twee dingen over:

1. **Een SSH-sleutel voor de productieserver.** Op de Fedora-machine is dat
   `~/.ssh/fedora-hetzner` (ed25519, fingerprint `SHA256:eCYqALGjjPtBoMDqcqtjaaeSycSY5u37fZId4xjrtBk`);
   het publieke deel staat al in `/root/.ssh/authorized_keys` op de server. Op de oude laptop
   heet hij `~/.ssh/ssh-key-2026-05-31-goldfish.key`. Beide namen kent `scripts/deploy.sh`
   vanzelf; een andere naam geef je mee met `GOLDFISH_SSH_KEY`.
2. **Een SSH-sleutel voor GitHub**, om te kunnen pushen (op deze machine: `~/.ssh/fedora-github`,
   via `~/.ssh/config` aan `github.com` gekoppeld). Een nieuwe aanmaken en in GitHub zetten mag ook.

Optioneel: de **`RESEND_API_KEY`** — alleen nodig als je lokaal verificatie- en reset-mails wilt
zien vertrekken. Zonder geldige key falen alleen die mails; de rest van de app en de tests
werken gewoon.

Het lokale databaseschema hoef je **niet** mee te brengen: dat staat als
[`migrations/000_baseline.sql`](migrations/000_baseline.sql) in de repo.

---

## Stap 1 — Tooling

```bash
sudo dnf install -y git nodejs npm rsync openssh-clients curl postgresql postgresql-server
node -v        # moet v22.x of hoger zijn
```

Is Node ouder dan 22: installeer NodeSource of `nvm` en zorg dat `node -v` v22+ geeft. De
productieserver draait Node 22; lager lokaal betekent dat je verschillen niet ziet.

## Stap 2 — SSH-sleutels op hun plek

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/fedora-hetzner ~/.ssh/fedora-github
```

Die `chmod 600` is niet optioneel: ssh weigert een sleutel die voor anderen leesbaar is, en
`deploy.sh` stopt er in de preflight op. Verifieer allebei:

```bash
ssh -i ~/.ssh/fedora-hetzner root@178.104.88.142 'hostname'    # → niels-server
ssh -T git@github.com                                          # → "Hi nielsveldhoen!"
```

Werkt de eerste niet, ga dan **niet** zelf sleutels aanmaken of `authorized_keys` aanpassen —
meld het aan Niels.

## Stap 3 — Repo klonen

```bash
mkdir -p ~/projects/goldfish && cd ~/projects/goldfish
git clone git@github.com:nielsveldhoen/goldfish-backend.git backend
cd backend && npm install        # inclusief devDependencies; lokaal geen --omit=dev
```

De Flutter-frontend is een aparte repo (`goldfish-frontend`) en valt buiten deze instructie;
alleen `scripts/deploy-web.sh` heeft hem nodig.

## Stap 4 — Lokale database

Begin met `migrations/000_baseline.sql` — dat is het startschema (18 tabellen op het niveau van
migratie 024, plus een gevulde `schema_migrations`). Alleen `migrations/` draaien op een lege
database werkt niet: 001..024 bouwen voort op tabellen die ooit met de hand zijn aangemaakt.

```bash
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql

# Kies een lokaal wachtwoord; dit heeft NIETS te maken met het productiewachtwoord.
sudo -u postgres psql -c "CREATE ROLE goldfish LOGIN PASSWORD 'kies-iets-lokaals';"
sudo -u postgres createdb -O goldfish goldfish

# Laden ALS goldfish: dan is die eigenaar en heb je lokaal geen GRANT-gedoe.
# pgcrypto zit in de baseline en is sinds PG13 een trusted extension, dus de
# eigenaar van de database mag hem zelf aanmaken — geen superuser nodig.
psql "postgresql://goldfish:kies-iets-lokaals@localhost:5432/goldfish" \
  -v ON_ERROR_STOP=1 -f migrations/000_baseline.sql
```

Verifieer:

```bash
psql "postgresql://goldfish:kies-iets-lokaals@localhost:5432/goldfish" \
  -c '\dt' -c 'SELECT count(*), max(version) FROM schema_migrations;'
```

Je hoort **18 tabellen** te zien en **22 | `024_exams`**. Staan er in `migrations/` bestanden met
een hoger nummer dan `024`, draai die dan na, in volgorde:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/025_....sql
```

Migratie `000`, `001` en `002` draai je nooit op een database die de baseline al heeft: `000`
faalt op bestaande tabellen, en `001`/`002` zijn ouder dan de tracking (`002` mag maar één keer
draaien, anders hasht hij tokens dubbel).

## Stap 5 — `src/.env` aanmaken

**Kopieer nooit de productie-`.env`.** Die staat uitsluitend op de server. Maak een verse; het
sjabloon is `.env.example` in de **repo-root**, terwijl de app `src/.env` leest:

```bash
cp .env.example src/.env
chmod 600 src/.env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # → JWT_SECRET
```

Vul in `src/.env` in:

| Key | Waarde op deze machine |
|---|---|
| `DATABASE_URL` | `postgresql://goldfish:kies-iets-lokaals@localhost:5432/goldfish` |
| `JWT_SECRET` | de zojuist gegenereerde string (hoeft niet gelijk te zijn aan productie) |
| `PORT` | `3000` |
| `APP_URL` | `http://localhost:3000` |
| `FROM_EMAIL` | `noreply@goldfishstudy.app` |
| `RESEND_API_KEY` | de key van Niels, of iets willekeurigs (dan falen alleen de mails) |
| `TRUST_PROXY` | **weglaten** — alleen achter nginx; lokaal zou het de rate limiter omzeilbaar maken |
| `HOST` | weglaten, tenzij je alleen op loopback wilt luisteren |

`src/.env` staat in `.gitignore`. Commit hem nooit, print de inhoud niet in logs of chat.

## Stap 6 — Draaien en testen

```bash
npm test               # 295 tests over 49 suites
npm run dev            # server op http://localhost:3000
curl -s localhost:3000/version
```

Dit is de echte verificatie van stap 4 en 5. Falen er tests met database-fouten (ontbrekende
kolom of tabel), dan loopt je schema achter op de code: draai de migraties boven 024 na.

**Bekende uitzondering:** `test/account-deletion.test.js` — "fout wachtwoord → 401, goed
wachtwoord → bedenktijd" faalt op een snelle machine. `DELETE /v2/auth/me` zet
`tokens_valid_after = NOW()`, en een JWT-`iat` telt in hele seconden; logt de test binnen
dezelfde seconde weer in, dan geldt het verse token als ingetrokken (zie de comment bij
`isRevoked` in `src/middleware/auth.js`). Dat is geen fout in je opzet. Alle overige 294 tests
horen groen te zijn.

## Stap 7 — Deployen vanaf deze machine

Lees eerst [DEPLOY.md](DEPLOY.md) — daar staat de volledige procedure, inclusief de valkuilen.
Kort:

```bash
./scripts/deploy.sh --dry-run   # eerst altijd dit; wijzigt niets
./scripts/deploy.sh
```

Het script vindt `~/.ssh/fedora-hetzner` zelf. Heet jouw sleutel anders, zet dan eenmalig:

```bash
echo 'export GOLDFISH_SSH_KEY=$HOME/.ssh/<jouw-sleutel>' >> ~/.bashrc
```

---

## Grenzen — niet doen zonder overleg met Niels

- **De productie-`.env` kopiëren of overschrijven.** De rsync in `scripts/deploy.sh` sluit
  `src/.env` bewust uit; haal die exclude er nooit uit.
- **Migraties handmatig op productie draaien.** Dat doet `scripts/deploy.sh`, na een DB-dump.
- **`000_baseline.sql` op productie draaien.** Alleen voor een lege dev-database.
- **`JWT_SECRET` roteren** — dat logt alle gebruikers uit.
- **De pm2-daemon killen** op de server (`pm2 kill`); daarna faalt `pm2-goldfish.service`.
  `pm2 restart goldfish-backend` is wel veilig.
- **Sleutels aanmaken of `authorized_keys` aanpassen** op de server.
- **Productiedata naar deze machine halen.** Voor ontwikkeling is het schema genoeg.

## Achtergrond

- [DEPLOY.md](DEPLOY.md) — server, deploy, rollback, backups, valkuilen
- [BACKEND_API.md](BACKEND_API.md) — API-contract; **bij elke API-wijziging ook de kopie in de
  Flutter-repo bijwerken**
- [migrations/README.md](migrations/README.md) — wat elke migratie doet en of hij herhaalbaar is
- [SECURITY_PLAN.md](SECURITY_PLAN.md) — securitymaatregelen en hun status
