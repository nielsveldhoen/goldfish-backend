#!/usr/bin/env bash
#
# Goldfish — de hele stapel lokaal draaien: database, backend en webapp.
#
#   ./scripts/dev.sh                  # lokale database (podman)
#   ./scripts/dev.sh --db remote      # PRODUCTIE-database via een SSH-tunnel
#   ./scripts/dev.sh --db copy        # KOPIE van de productie-DB in de lokale container
#   ./scripts/dev.sh --db copy --fresh  # … en die kopie eerst opnieuw ophalen
#   ./scripts/dev.sh --no-build       # bestaande build/web hergebruiken (scheelt ~30 s)
#   ./scripts/dev.sh --status         # wat draait er, en waar
#   ./scripts/dev.sh --stop           # alles afsluiten
#
# Wat het opzet:
#   1. database   — podman-container met migrations/000_baseline.sql, OF een
#                   SSH-tunnel naar de productie-DB op 127.0.0.1:5433, OF een
#                   pg_dump van productie teruggezet in diezelfde container
#                   (--db copy: echte data, maar niets raakt productie; een
#                   bestaande kopie wordt hergebruikt tot je --fresh meegeeft)
#   2. backend    — node src/index.js op 0.0.0.0:3000
#   3. webapp     — flutter build web + een statische server op :8090
#   4. verificatie— /version, de webapp, en de URL's die je op je telefoon opent
#
# Bereikbaar maken voor andere devices gaat via Tailscale; het script vertelt je
# welke `tailscale serve`-mappings het verwacht en wat je moet draaien als ze
# ontbreken (dat vraagt sudo en doet het script bewust niet zelf).
#
# NB: dit deployt NIETS naar productie. Daarvoor zijn deploy.sh en deploy-web.sh.
set -euo pipefail

# ── CONFIG ────────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_CONTAINER="${GOLDFISH_DB_CONTAINER:-goldfish-db}"
DB_IMAGE="${GOLDFISH_DB_IMAGE:-docker.io/library/postgres:18-alpine}"
DB_PORT="${GOLDFISH_DB_PORT:-5432}"
DB_PASSWORD="${GOLDFISH_DB_PASSWORD:-goldfish-lokaal}"
TUNNEL_PORT="${GOLDFISH_TUNNEL_PORT:-5433}"
API_PORT="${GOLDFISH_API_PORT:-3000}"
WEB_PORT="${GOLDFISH_WEB_PORT:-8090}"
# MagicDNS-naam van deze machine, bijv. fedora.tail556dec.ts.net.
TS_HOST="${GOLDFISH_TS_HOST:-$(tailscale status --json 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' \
  2>/dev/null || true)}"
TS_HOST="${TS_HOST:-localhost}"
TS_API_PORT="${GOLDFISH_TS_API_PORT:-10000}"

# Server waar de productie-DB draait (alleen voor --db remote).
SSH_KEY="${GOLDFISH_SSH_KEY:-}"
if [[ -z "$SSH_KEY" ]]; then
  for c in "$HOME/.ssh/fedora-hetzner" "$HOME/.ssh/ssh-key-2026-05-31-goldfish.key"; do
    [[ -f "$c" ]] && { SSH_KEY="$c"; break; }
  done
  SSH_KEY="${SSH_KEY:-$HOME/.ssh/fedora-hetzner}"
fi
SSH_TARGET="${GOLDFISH_SSH_TARGET:-root@178.104.88.142}"
REMOTE_ENV="${GOLDFISH_REMOTE_ENV:-/home/goldfish/backend/src/.env}"

FLUTTER_DIR="${GOLDFISH_FLUTTER_DIR:-}"
if [[ -z "$FLUTTER_DIR" ]]; then
  for c in "$HOME/projects/goldfish/frontend" /mnt/c/programming/goldfish/goldfish_v1; do
    [[ -d "$c" ]] && { FLUTTER_DIR="$c"; break; }
  done
fi

RUN_DIR="${TMPDIR:-/tmp}/goldfish-dev"
mkdir -p "$RUN_DIR"

# ── ARGUMENTEN ────────────────────────────────────────────────────────────────
DB_MODE=local
DO_BUILD=1
FRESH_COPY=0
ACTION=start
for arg in "$@"; do
  case "$arg" in
    --db) ;;                              # "--db remote" — de waarde volgt hieronder
    --db=local|local)   DB_MODE=local ;;
    --db=remote|remote) DB_MODE=remote ;;
    --db=copy|copy)     DB_MODE=copy ;;
    --fresh)     FRESH_COPY=1 ;;
    --no-build)  DO_BUILD=0 ;;
    --status)    ACTION=status ;;
    --stop)      ACTION=stop ;;
    --help|-h)   sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Onbekende optie: $arg (zie --help)" >&2; exit 2 ;;
  esac
done

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$OFF"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s !! %s%s\n' "$YELLOW" "$*" "$OFF"; }
die()  { printf '%s !! %s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }
ok()   { printf '%s ✓  %s%s\n' "$GREEN" "$*" "$OFF"; }

port_busy() { ss -tln 2>/dev/null | grep -q ":$1[[:space:]]"; }

# De backend start als `node <REPO_DIR>/src/index.js`, maar een handmatig gestarte
# instance heet vaak `node src/index.js`. Beide patronen dus, anders blijft er een
# oude instance op poort 3000 zitten (zie de poortcheck bij het starten).
kill_backend() {
  local killed=0
  pkill -f "node $REPO_DIR/src/index.js" 2>/dev/null && killed=1
  pkill -f 'node src/index\.js' 2>/dev/null && killed=1
  (( killed )) && info "oude backend gestopt" || info "geen oude backend gevonden"
}

# De productie-tunnel draait onder een bewaker die ssh herstart zodra de
# verbinding wegvalt. Een losse `ssh -f` bleef na een netwerkhik dicht; de
# backend kreeg dan ECONNREFUSED, elke write uit de app een 500, en de
# wachtrij op de telefoon liep vol zonder dat iemand het zag.
TUNNEL_PATTERN="L $TUNNEL_PORT:127.0.0.1:5432"
KEEPER_TAG="goldfish-tunnel-keeper"

close_tunnel() {
  # Eerst de bewaker, anders start hij de tunnel meteen opnieuw.
  pkill -f "$KEEPER_TAG" 2>/dev/null && info "tunnelbewaker gestopt" || true
  pkill -f "$TUNNEL_PATTERN" 2>/dev/null && info "SSH-tunnel gesloten" || true
}

open_tunnel() {
  close_tunnel
  for i in $(seq 1 10); do port_busy "$TUNNEL_PORT" || break; sleep 0.5; done
  # Argumenten via $1..$3, zodat de commandline van de bewaker zelf niet op
  # TUNNEL_PATTERN matcht (alleen de ssh eronder doet dat).
  ( nohup bash -c '
      while true; do
        echo "[$(date -Is)] tunnel openen"
        ssh -i "$1" -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
          -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
          -L "$2:127.0.0.1:5432" "$3"
        rc=$?
        echo "[$(date -Is)] tunnel weg (exit $rc) — over 5 s opnieuw"
        sleep 5
      done' "$KEEPER_TAG" "$SSH_KEY" "$TUNNEL_PORT" "$SSH_TARGET" \
      >>"$RUN_DIR/tunnel.log" 2>&1 & ) >/dev/null 2>&1 </dev/null
  for i in $(seq 1 30); do port_busy "$TUNNEL_PORT" && break; sleep 0.5; done
  port_busy "$TUNNEL_PORT" || die "Kon de SSH-tunnel niet openen. Log: $RUN_DIR/tunnel.log"
  info "tunnel geopend: 127.0.0.1:$TUNNEL_PORT → $SSH_TARGET (met bewaker, log: $RUN_DIR/tunnel.log)"
}

# host:port van de database waar de draaiende backend mee verbonden is, gelezen
# uit de environment van het proces op API_PORT (zonder wachtwoord). Leeg als
# er geen backend draait of het proces niet van ons is.
backend_db() {
  local pid
  pid="$(ss -tlnp 2>/dev/null | grep ":$API_PORT[[:space:]]" | grep -oP 'pid=\K[0-9]+' | head -1)"
  [[ -n "$pid" && -r "/proc/$pid/environ" ]] || return 0
  tr '\0' '\n' <"/proc/$pid/environ" | grep -m1 '^DATABASE_URL=' | cut -d= -f2- \
    | python3 -c 'import sys, urllib.parse; u = urllib.parse.urlsplit(sys.stdin.read().strip()); print(f"{u.hostname}:{u.port}")' \
    2>/dev/null || true
}

# ── STOP / STATUS ─────────────────────────────────────────────────────────────
stop_all() {
  step "Afsluiten"
  kill_backend
  pkill -f "serve_web.py $WEB_PORT" 2>/dev/null \
    || pkill -f "http.server $WEB_PORT" 2>/dev/null \
    && info "webserver gestopt" || info "webserver draaide niet"
  close_tunnel
  if podman container exists "$DB_CONTAINER" 2>/dev/null; then
    podman stop "$DB_CONTAINER" >/dev/null && info "database gestopt (data is weg: --rm)"
  fi
  ok "Klaar"
}

# Staat er een productie-kopie in de lokale container? Print dan het tijdstip
# van de dump (leeg = geen kopie / geen database).
local_copy_stamp() {
  podman exec "$DB_CONTAINER" psql -U postgres -d goldfish -tAc \
    "SELECT to_char(taken_at, 'YYYY-MM-DD HH24:MI') FROM _dev_copy_of_prod" 2>/dev/null || true
}

show_status() {
  step "Status"
  if podman container exists "$DB_CONTAINER" 2>/dev/null; then
    local stamp; stamp="$(local_copy_stamp)"
    if [[ -n "$stamp" ]]; then
      info "database:  container '$DB_CONTAINER' op :$DB_PORT — KOPIE van productie (stand $stamp)"
    else
      info "database:  container '$DB_CONTAINER' op :$DB_PORT — lokale baseline"
    fi
  else
    info "database:  container draait niet"
  fi
  local tunnel_open=0 keeper=""
  port_busy "$TUNNEL_PORT" && tunnel_open=1
  pgrep -f "$KEEPER_TAG" >/dev/null 2>&1 && keeper=" (met bewaker)"
  (( tunnel_open )) \
    && info "tunnel:    127.0.0.1:$TUNNEL_PORT → productie-DB$keeper" \
    || info "tunnel:    niet open$keeper"
  if curl -s --max-time 3 "http://127.0.0.1:$API_PORT/version" >/dev/null 2>&1; then
    local v; v="$(curl -s --max-time 3 "http://127.0.0.1:$API_PORT/version")"
    info "backend:   :$API_PORT — $v"
    # Niet raden uit de tunnel: kijk waar de backend echt heen wijst.
    local db; db="$(backend_db)"
    if [[ "$db" == *":$TUNNEL_PORT" ]]; then
      info "           → PRODUCTIE-database via de tunnel ($db)"
      (( tunnel_open )) || warn "Tunnel is dicht: de backend kan zijn database niet bereiken.
    Writes uit de app krijgen een 500 en blijven in de wachtrij staan.
    Herstel: $0 --db remote --no-build"
    elif [[ "$db" == *":$DB_PORT" ]]; then
      info "           → lokale container ($db; kopie of baseline, zie 'database:')"
    elif [[ -n "$db" ]]; then
      info "           → database $db"
    else
      info "           → database onbekend (backend-proces niet leesbaar)"
    fi
  else
    info "backend:   draait niet"
  fi
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$WEB_PORT/" 2>/dev/null \
    && info "webapp:    :$WEB_PORT" || info "webapp:    draait niet"
  info "logs:      $RUN_DIR"
}

case "$ACTION" in
  stop)   stop_all; exit 0 ;;
  status) show_status; exit 0 ;;
esac

# ── 1. DATABASE ───────────────────────────────────────────────────────────────
step "1/4  Database ($DB_MODE)"

ensure_local_container() {
  command -v podman >/dev/null || die "podman ontbreekt (of gebruik een systeem-PostgreSQL; zie DEV_SETUP.md)."
  if podman container exists "$DB_CONTAINER" 2>/dev/null; then
    info "container '$DB_CONTAINER' draait al"
  else
    podman run --rm -d --name "$DB_CONTAINER" \
      -e POSTGRES_PASSWORD=postgres -p "$DB_PORT:5432" "$DB_IMAGE" >/dev/null
    podman exec "$DB_CONTAINER" bash -c \
      'for i in $(seq 1 60); do pg_isready -U postgres -q && exit 0; sleep 1; done; exit 1' \
      || die "Postgres in de container kwam niet op."
    info "container gestart op :$DB_PORT"
  fi
  if ! podman exec "$DB_CONTAINER" psql -U postgres -tAc \
        "SELECT 1 FROM pg_roles WHERE rolname='goldfish'" | grep -q 1; then
    podman exec "$DB_CONTAINER" psql -U postgres -q \
      -c "CREATE ROLE goldfish LOGIN PASSWORD '$DB_PASSWORD';"
    info "rol goldfish aangemaakt"
  fi
}

if [[ "$DB_MODE" == local ]]; then
  ensure_local_container
  if [[ -n "$(local_copy_stamp)" ]]; then
    die "De lokale container bevat een KOPIE van productie (stand $(local_copy_stamp)).
    Gebruik --db copy om daarmee verder te werken, of verwijder de container
    (podman rm -f $DB_CONTAINER) voor een lege baseline."
  fi
  # Database en baseline alleen aanmaken als ze er nog niet zijn.
  if ! podman exec "$DB_CONTAINER" psql -U postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='goldfish'" | grep -q 1; then
    podman exec "$DB_CONTAINER" psql -U postgres -q \
      -c "CREATE DATABASE goldfish OWNER goldfish;"
    info "database aangemaakt"
  fi
  applied="$(podman exec "$DB_CONTAINER" psql -U postgres -d goldfish -tAc \
    "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo 0)"
  if [[ "$applied" -eq 0 ]]; then
    podman exec -i -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" \
      psql -U goldfish -h 127.0.0.1 -d goldfish -v ON_ERROR_STOP=1 -q \
      < "$REPO_DIR/migrations/000_baseline.sql" >/dev/null
    info "baseline geladen"
  else
    info "schema staat al ($applied migraties)"
  fi
  export DATABASE_URL="postgresql://goldfish:$DB_PASSWORD@localhost:$DB_PORT/goldfish"
  ok "Lokale database klaar (leeg: geen accounts, geen decks)"

elif [[ "$DB_MODE" == copy ]]; then
  ensure_local_container
  # Een eventuele tunnel dicht: alles moet aantoonbaar lokaal zijn.
  close_tunnel
  stamp="$(local_copy_stamp)"
  if [[ -n "$stamp" && "$FRESH_COPY" -eq 0 ]]; then
    info "bestaande kopie hergebruikt (stand $stamp); verse kopie: --db copy --fresh"
  else
    [[ -f "$SSH_KEY" ]] || die "SSH-sleutel niet gevonden: $SSH_KEY"
    DUMP="$RUN_DIR/prod-copy.dump"
    info "pg_dump van productie ophalen (alleen lezen) …"
    ssh -i "$SSH_KEY" -o ConnectTimeout=15 "$SSH_TARGET" \
      "sudo -u postgres pg_dump -Fc --no-owner --no-privileges goldfish" > "$DUMP" \
      || die "pg_dump op $SSH_TARGET mislukte."
    [[ -s "$DUMP" ]] || die "Lege dump ontvangen."
    taken_at="$(date -u +'%Y-%m-%d %H:%M:%SZ')"
    info "dump: $(du -h "$DUMP" | cut -f1) — stand $taken_at"
    # De backend mag niet meer aan de oude database hangen als we hem droppen.
    kill_backend
    podman exec "$DB_CONTAINER" psql -U postgres -q \
      -c "DROP DATABASE IF EXISTS goldfish WITH (FORCE);" \
      -c "CREATE DATABASE goldfish OWNER goldfish;"
    # Terugzetten als de app-rol zelf, zodat alle objecten van goldfish zijn
    # (pgcrypto is een trusted extension: de database-eigenaar mag 'm maken).
    podman exec -i -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" \
      pg_restore -U goldfish -h 127.0.0.1 -d goldfish --no-owner --no-privileges \
      --exit-on-error --single-transaction < "$DUMP" \
      || die "pg_restore mislukte (dump: $DUMP)."
    podman exec -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" \
      psql -U goldfish -h 127.0.0.1 -d goldfish -q \
      -c "CREATE TABLE _dev_copy_of_prod (taken_at timestamptz NOT NULL);" \
      -c "INSERT INTO _dev_copy_of_prod VALUES ('$taken_at');"
    rm -f "$DUMP"
    stamp="$(local_copy_stamp)"
    info "kopie teruggezet: $(podman exec "$DB_CONTAINER" psql -U postgres -d goldfish -tAc \
      "SELECT count(*) || ' users, ' || (SELECT count(*) FROM decks) || ' decks, ' || (SELECT count(*) FROM cards) || ' cards' FROM users")"
  fi
  export DATABASE_URL="postgresql://goldfish:$DB_PASSWORD@localhost:$DB_PORT/goldfish"
  ok "Kopie van de productie-database klaar (stand $stamp) — productie wordt niet geraakt"

else
  [[ -f "$SSH_KEY" ]] || die "SSH-sleutel niet gevonden: $SSH_KEY"
  warn "PRODUCTIE-database. Alles wat je in de app doet is een echte wijziging."
  # Altijd vers openen: een al openstaande tunnel kan een losse ssh zonder
  # bewaker zijn.
  open_tunnel
  # Wachtwoord uit de server-.env; komt nergens op schijf en wordt niet geprint.
  prod_line="$(ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$SSH_TARGET" \
    "grep -m1 '^DATABASE_URL=' $REMOTE_ENV")" || die "Kan $REMOTE_ENV niet lezen."
  DATABASE_URL="$(PRODLINE="$prod_line" TP="$TUNNEL_PORT" python3 - <<'PY'
import os, urllib.parse
line = os.environ["PRODLINE"].split("=", 1)[1].strip().strip('"').strip("'")
u = urllib.parse.urlsplit(line)
pw = urllib.parse.quote(u.password or "", safe="")
netloc = f"{u.username}:{pw}@127.0.0.1:{os.environ['TP']}"
print(urllib.parse.urlunsplit((u.scheme, netloc, u.path, u.query, u.fragment)))
PY
)"
  export DATABASE_URL
  export DISABLE_BACKGROUND_JOBS=1   # geen purge-jobs vanaf een laptop op productie
  ok "Verbonden met de productie-database (opruimjobs uitgeschakeld)"
fi

# ── 2. BACKEND ────────────────────────────────────────────────────────────────
step "2/4  Backend"
[[ -f "$REPO_DIR/src/.env" ]] || die "src/.env ontbreekt — zie DEV_SETUP.md stap 5."
# Welke database gaan we gebruiken? Zonder wachtwoord, puur om te kunnen zien of
# je op de lokale of de productie-DB zit.
info "database: $(python3 - <<'PY'
import os, urllib.parse
u = urllib.parse.urlsplit(os.environ["DATABASE_URL"])
print(f"{u.hostname}:{u.port}{u.path}")
PY
)"

kill_backend
# Pas starten als de poort echt vrij is; anders crasht node op EADDRINUSE en
# antwoordt de OUDE instance nog — dan lijkt alles goed terwijl je op de
# verkeerde database zit. Die fout is hier één keer gemaakt.
for i in $(seq 1 10); do port_busy "$API_PORT" || break; sleep 1; done
if port_busy "$API_PORT"; then
  die "Poort $API_PORT is nog bezet door:
    $(ss -tlnp 2>/dev/null | grep ":$API_PORT[[:space:]]" | sed 's/.*users://')
    Sluit dat af (./scripts/dev.sh --stop) en probeer opnieuw."
fi
# De >/dev/null op de subshell is nodig: zonder dat houdt hij de stdout van het
# script open, en dan blijft `./dev.sh | tail` eeuwig wachten op EOF.
( cd "$REPO_DIR" && nohup node "$REPO_DIR/src/index.js" >"$RUN_DIR/backend.log" 2>&1 & ) \
  >/dev/null 2>&1 </dev/null
for i in $(seq 1 15); do
  curl -s --max-time 2 "http://127.0.0.1:$API_PORT/version" >/dev/null 2>&1 && break
  sleep 1
done
version_json="$(curl -s --max-time 5 "http://127.0.0.1:$API_PORT/version" || true)"
[[ -n "$version_json" ]] || die "Backend antwoordt niet. Log: $RUN_DIR/backend.log"
ok "Backend op :$API_PORT — $version_json"

# ── 3. WEBAPP ─────────────────────────────────────────────────────────────────
step "3/4  Webapp"
[[ -n "$FLUTTER_DIR" && -d "$FLUTTER_DIR" ]] || die "Flutter-repo niet gevonden.
    Geef het pad mee: GOLDFISH_FLUTTER_DIR=/pad/naar/frontend $0"

# Waar praat de webapp straks met de API? Als tailscale serve de API publiceert
# gebruiken we die https-URL (werkt op je telefoon), anders localhost.
if tailscale serve status 2>/dev/null | grep -q ":$TS_API_PORT"; then
  API_BASE_URL="https://$TS_HOST:$TS_API_PORT"
  WEB_URL="https://$TS_HOST"
else
  API_BASE_URL="http://localhost:$API_PORT"
  WEB_URL="http://localhost:$WEB_PORT"
  warn "Geen tailscale serve gevonden op :$TS_API_PORT — de build wijst naar localhost"
  warn "en werkt dus alleen op deze machine. Voor je telefoon eerst, met sudo:"
  warn "  sudo tailscale serve --bg --https=443            http://127.0.0.1:$WEB_PORT"
  warn "  sudo tailscale serve --bg --https=$TS_API_PORT http://127.0.0.1:$API_PORT"
fi
info "API_BASE_URL in de build: $API_BASE_URL"

if (( DO_BUILD )); then
  # --pwa-strategy=none: geen service worker. Die cachet index.html, en dan
  # krijg je op je telefoon of tablet een oude versie te zien terwijl je denkt
  # dat je de nieuwe test — vooral vervelend bij wijzigingen in index.html zelf,
  # want daar zit de service worker precies voor. Voor een testrun wil je altijd
  # zien wat er nu gebouwd is; deploy-web.sh laat de service worker staan.
  ( cd "$FLUTTER_DIR" && flutter build web --release --pwa-strategy=none \
      --dart-define=API_BASE_URL="$API_BASE_URL" ) >"$RUN_DIR/build.log" 2>&1 \
    || die "flutter build web faalde. Log: $RUN_DIR/build.log"
  info "gebouwd"
else
  [[ -f "$FLUTTER_DIR/build/web/main.dart.js" ]] \
    || die "Geen bestaande build in $FLUTTER_DIR/build/web — laat --no-build weg."
  warn "Build hergebruikt; als die met een andere API_BASE_URL is gemaakt, klopt hij niet."
fi

# serve_web.py in plaats van `python3 -m http.server`: die laatste stuurt geen
# Cache-Control, en dan hergebruikt je browser main.dart.js uit zijn cache
# terwijl je denkt de nieuwe build te bekijken.
pkill -f "serve_web.py $WEB_PORT" 2>/dev/null || true
pkill -f "http.server $WEB_PORT" 2>/dev/null || true
( nohup python3 "$REPO_DIR/scripts/serve_web.py" "$WEB_PORT" "$FLUTTER_DIR/build/web" \
    >"$RUN_DIR/web.log" 2>&1 & ) >/dev/null 2>&1 </dev/null
sleep 1
curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$WEB_PORT/" || die "Webserver antwoordt niet."
ok "Webapp op :$WEB_PORT"

# ── 4. VERIFICATIE ────────────────────────────────────────────────────────────
step "4/4  Verificatie"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X OPTIONS "$API_BASE_URL/v2/auth/login" \
  -H "Origin: $WEB_URL" -H 'Access-Control-Request-Method: POST' || echo 000)"
if [[ "$code" == "204" ]]; then
  ok "CORS: $WEB_URL mag bij de API"
else
  warn "CORS-preflight gaf $code. Staat $WEB_URL in CORS_ORIGINS in src/.env?"
fi

printf '\n%sOpenen:%s  %s\n' "$BOLD" "$OFF" "$WEB_URL"
if [[ "$DB_MODE" == remote ]]; then
  printf '%sLet op:%s je werkt in de PRODUCTIE-database — echte accounts, echte data.\n' "$RED" "$OFF"
elif [[ "$DB_MODE" == copy ]]; then
  printf 'KOPIE van productie (stand %s): je eigen account en decks, wachtwoord\n' "$(local_copy_stamp)"
  printf 'als op productie. Niets hiervan raakt de echte database. Verse kopie: --db copy --fresh\n'
else
  printf 'Lokale database: leeg. Registreren kan, maar inloggen vraagt een geverifieerd\n'
  printf 'account — zonder RESEND_API_KEY doe je dat met de hand:\n'
  printf "  podman exec %s psql -U postgres -d goldfish \\\\\n" "$DB_CONTAINER"
  printf "    -c \"UPDATE users SET email_verified = true WHERE email = 'jouw@adres';\"\n"
fi
printf 'Stoppen: %s --stop   ·   Status: %s --status   ·   Logs: %s\n' "$0" "$0" "$RUN_DIR"
