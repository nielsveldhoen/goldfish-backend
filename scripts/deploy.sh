#!/usr/bin/env bash
#
# Goldfish backend — deploy naar de Hetzner-server.
#
#   ./scripts/deploy.sh              # volledige deploy (vraagt om bevestiging)
#   ./scripts/deploy.sh --dry-run    # laat zien wat er zou gebeuren, wijzigt niets
#   ./scripts/deploy.sh --skip-tests # tests overslaan (alleen bij haast/hotfix)
#   ./scripts/deploy.sh --yes        # niet om bevestiging vragen
#
# Wat het doet, in deze volgorde:
#   1. preflight  — sleutel, tooling, verbinding, schone werkdirectory
#   2. tests      — npm test + npm audit (lokaal)
#   3. rsync      — code naar /home/goldfish/backend (ZONDER src/.env)
#   4. migraties  — ontbrekende migraties als postgres, na een DB-dump
#   5. deps       — npm ci --omit=dev als user goldfish
#   6. restart    — pm2 restart goldfish-backend
#   7. verify     — lokale + publieke healthcheck, laatste logregels
#
# Alles is te overrulen via environment variables (zie CONFIG hieronder), zodat
# dit script ook vanaf een andere machine of naar een andere server werkt.
set -euo pipefail

# ── CONFIG ────────────────────────────────────────────────────────────────────
SSH_KEY="${GOLDFISH_SSH_KEY:-$HOME/.ssh/ssh-key-2026-05-31-goldfish.key}"
SSH_TARGET="${GOLDFISH_SSH_TARGET:-root@178.104.88.142}"
REMOTE_DIR="${GOLDFISH_REMOTE_DIR:-/home/goldfish/backend}"
APP_USER="${GOLDFISH_APP_USER:-goldfish}"
PM2_APP="${GOLDFISH_PM2_APP:-goldfish-backend}"
DB_NAME="${GOLDFISH_DB:-goldfish}"
API_URL="${GOLDFISH_API_URL:-https://api.goldfishstudy.app}"
WEB_URL="${GOLDFISH_WEB_URL:-https://goldfishstudy.app}"

# Migraties 001 en 002 zijn ouder dan de schema_migrations-tracking en staan
# daarom niet in de tabel. Nooit automatisch (her)draaien — 002 mag maar één
# keer draaien en zou tokens dubbel hashen.
LEGACY_MIGRATIONS="001_progress_deleted_at 002_hash_verification_tokens"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── ARGUMENTEN ────────────────────────────────────────────────────────────────
DRY_RUN=0
SKIP_TESTS=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --help|-h)    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            echo "Onbekende optie: $arg (zie --help)" >&2; exit 2 ;;
  esac
done

# ── HULPFUNCTIES ──────────────────────────────────────────────────────────────
BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$OFF"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s !! %s%s\n' "$YELLOW" "$*" "$OFF"; }
die()  { printf '%s !! %s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }
ok()   { printf '%s ✓  %s%s\n' "$GREEN" "$*" "$OFF"; }

# Draait een commando op de server. Alle remote-uitvoer komt gewoon door.
remote() { ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$SSH_TARGET" "$@"; }

# ── 1. PREFLIGHT ──────────────────────────────────────────────────────────────
step "1/7  Preflight"

[[ -f "$SSH_KEY" ]] || die "SSH-sleutel niet gevonden: $SSH_KEY
    Zet hem neer (mode 600) of geef een ander pad: GOLDFISH_SSH_KEY=/pad/naar/key $0"

perms="$(stat -c '%a' "$SSH_KEY")"
[[ "$perms" == "600" || "$perms" == "400" ]] || die "SSH-sleutel heeft mode $perms; ssh weigert dat.
    Herstel met: chmod 600 $SSH_KEY"

for tool in rsync ssh npm curl; do
  command -v "$tool" >/dev/null || die "'$tool' ontbreekt op deze machine."
done

cd "$REPO_DIR"

if git rev-parse --git-dir >/dev/null 2>&1; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  info "branch: $branch  ($(git rev-parse --short HEAD) $(git log -1 --pretty=%s | cut -c1-60))"
  if [[ -n "$(git status --porcelain)" ]]; then
    warn "Werkdirectory is niet schoon — je deployt ongecommitte wijzigingen."
    git status --short | sed 's/^/    /'
  fi
fi

remote "true" || die "Kan niet inloggen op $SSH_TARGET met $SSH_KEY."
info "verbinding met $SSH_TARGET: ok"
ok "Preflight klaar"

# ── 2. TESTS ──────────────────────────────────────────────────────────────────
step "2/7  Tests en audit"
if (( SKIP_TESTS )); then
  warn "Overgeslagen (--skip-tests)."
else
  npm test || die "Tests falen — niet deployen. (Vereist een lokale DB; zie DEPLOY.md.)"
  ok "Tests groen"
  npm audit --omit=dev || warn "npm audit meldt iets. Beoordeel het vóór je doorgaat (zie DEPLOY.md)."
fi

# ── 3. WELKE MIGRATIES ONTBREKEN ──────────────────────────────────────────────
step "3/7  Migratiestand vergelijken"
applied="$(remote "sudo -u postgres psql -d $DB_NAME -tAc \
  'SELECT version FROM schema_migrations ORDER BY version;'")" \
  || die "Kan schema_migrations niet lezen op de server."

pending=()
for file in migrations/[0-9]*.sql; do
  version="$(basename "$file" .sql)"
  [[ "$version" == *_down ]] && continue
  grep -qx -- "$version" <<<"$applied" && continue
  grep -qw -- "$version" <<<"$LEGACY_MIGRATIONS" && continue
  pending+=("$file")
done

info "toegepast op de server: $(wc -l <<<"$applied") migraties (laatste: $(tail -1 <<<"$applied"))"
if (( ${#pending[@]} )); then
  warn "Nog te draaien: ${#pending[@]}"
  printf '    - %s\n' "${pending[@]}"
else
  info "geen nieuwe migraties"
fi

# ── BEVESTIGING ───────────────────────────────────────────────────────────────
if (( DRY_RUN )); then
  step "DRY RUN — rsync-verschillen (er wordt niets gewijzigd)"
  rsync -azn --delete --itemize-changes \
    --exclude node_modules --exclude .git --exclude test \
    --exclude 'src/.env' --exclude '.env*' \
    -e "ssh -i $SSH_KEY" "$REPO_DIR/" "$SSH_TARGET:$REMOTE_DIR/"
  ok "Dry run klaar — niets gewijzigd."
  exit 0
fi

if (( ! ASSUME_YES )); then
  printf '\n%sDeployen naar %s (%s)? [j/N] %s' "$BOLD" "$SSH_TARGET" "$REMOTE_DIR" "$OFF"
  read -r answer
  [[ "$answer" =~ ^[jJyY]$ ]] || die "Afgebroken."
fi

# ── 4. CODE OVERZETTEN ────────────────────────────────────────────────────────
step "4/7  Code overzetten (rsync)"
# --exclude 'src/.env' is ESSENTIEEL: de productie-.env staat alleen op de
# server; zonder deze regel overschrijft je dev-.env de productiegeheimen.
# Excludes worden ook niet verwijderd door --delete, dus node_modules en de
# .env op de server blijven staan.
rsync -az --delete --info=stats1 \
  --exclude node_modules --exclude .git --exclude test \
  --exclude 'src/.env' --exclude '.env*' \
  -e "ssh -i $SSH_KEY" "$REPO_DIR/" "$SSH_TARGET:$REMOTE_DIR/"
remote "chown -R $APP_USER:$APP_USER $REMOTE_DIR"
ok "Code staat op de server"

# ── 5. MIGRATIES ──────────────────────────────────────────────────────────────
step "5/7  Migraties"
if (( ${#pending[@]} )); then
  info "eerst een verse DB-dump maken..."
  remote "sudo -u postgres /usr/local/bin/goldfish-backup.sh" \
    || warn "Backup-script faalde. Ga alleen door als je weet waarom."
  for file in "${pending[@]}"; do
    version="$(basename "$file" .sql)"
    info "draaien: $version"
    # Via stdin, want postgres kan niet lezen in /home/goldfish.
    # Elke migratie is transactioneel en zet zelf zijn rij in schema_migrations.
    remote "sudo -u postgres psql -d $DB_NAME -v ON_ERROR_STOP=1 -q" < "$file" \
      || die "Migratie $version faalde. De transactie is teruggedraaid; de oude code draait nog."
  done
  ok "${#pending[@]} migratie(s) toegepast"
else
  info "niets te doen"
fi

# ── 6. DEPENDENCIES + RESTART ─────────────────────────────────────────────────
step "6/7  Dependencies en herstart"
# npm ci verwijdert node_modules en installeert exact de lockfile.
remote "runuser -l $APP_USER -c 'cd ~/backend && npm ci --omit=dev --no-audit --no-fund'"
ok "Dependencies geïnstalleerd"

# pm2 restart is veilig; de pm2-DAEMON nooit killen (dan faalt pm2-goldfish.service).
remote "runuser -l $APP_USER -c 'pm2 restart $PM2_APP --update-env'"
ok "pm2 herstart"

# ── 7. VERIFICATIE ────────────────────────────────────────────────────────────
step "7/7  Verificatie"
local_code=""
for attempt in 1 2 3 4 5; do
  local_code="$(remote "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/version" || true)"
  [[ "$local_code" == "200" ]] && break
  info "app antwoordt nog niet (poging $attempt, http $local_code) — 3s wachten"
  sleep 3
done
[[ "$local_code" == "200" ]] || die "App geeft geen 200 op localhost:3000/version (kreeg: $local_code).
    Bekijk de logs:  ssh -i $SSH_KEY $SSH_TARGET \"runuser -l $APP_USER -c 'pm2 logs $PM2_APP --lines 50 --nostream'\"
    Terugrollen:     zie DEPLOY.md → Rollback"
ok "localhost:3000/version → 200"

for url in "$API_URL/version" "$WEB_URL/"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo "geen antwoord")"
  if [[ "$code" == "200" ]]; then ok "$url → 200"; else warn "$url → $code"; fi
done

info "versie volgens de server: $(curl -s --max-time 10 "$API_URL/version" || true)"

step "Laatste logregels"
remote "runuser -l $APP_USER -c 'pm2 logs $PM2_APP --lines 15 --nostream'" || true

printf '\n%s✓ Deploy klaar.%s Wijzigde de API? Werk beide BACKEND_API.md-bestanden bij.\n' "$GREEN" "$OFF"
