#!/usr/bin/env bash
#
# Goldfish web — statische site (site/) + Flutter-webbuild naar de Hetzner-server.
#
#   ./scripts/deploy-web.sh --build   # eerst de app bouwen (WSL: via de Windows-flutter, ~8 min)
#   ./scripts/deploy-web.sh           # de bestaande build/web-prod/ + site/ deployen
#   ./scripts/deploy-web.sh --dry-run # laat zien wat er zou veranderen
#
# Indeling op de server (nginx: nginx/goldfish-site.conf):
#   /var/www/goldfish-site/        ← site/        (landingspagina's, op /)
#   /var/www/goldfish-site/app/    ← build/web-prod/ (de app, op /app/)
#
# Wat het doet:
#   1. build (optioneel) — flutter build web --release --base-href /app/ → build/web-prod
#   2. terugrolkopie     — /var/www/goldfish-site → /var/www/goldfish-site.bak-prev
#   3. rsync             — site/ → webroot, build → webroot/app/ (beide met --delete)
#   4. chown             — goldfish:goldfish (nginx leest het gewoon)
#   5. verify            — site en app antwoorden; md5 van de live main.dart.js vs lokaal
#
# De productiebuild staat bewust in build/web-prod, niet in build/web: daar zet
# scripts/dev.sh zijn build neer, die naar de laptop wijst en op / hoort.
#
# Let op: een HTTP 200 zegt niets over de versie — daarom de md5-vergelijking.
set -euo pipefail

# ── CONFIG ────────────────────────────────────────────────────────────────────
# Sleutel en Flutter-repo heten per dev-machine anders; zonder env-var pakken we
# de eerste die bestaat (Fedora eerst, dan de oude WSL-laptop).
SSH_KEY="${GOLDFISH_SSH_KEY:-}"
if [[ -z "$SSH_KEY" ]]; then
  for candidate in "$HOME/.ssh/fedora-hetzner" "$HOME/.ssh/ssh-key-2026-05-31-goldfish.key"; do
    [[ -f "$candidate" ]] && { SSH_KEY="$candidate"; break; }
  done
  SSH_KEY="${SSH_KEY:-$HOME/.ssh/fedora-hetzner}"
fi
SSH_TARGET="${GOLDFISH_SSH_TARGET:-root@178.104.88.142}"
FLUTTER_DIR="${GOLDFISH_FLUTTER_DIR:-}"
if [[ -z "$FLUTTER_DIR" ]]; then
  for candidate in "$HOME/projects/goldfish/frontend" /mnt/c/programming/goldfish/goldfish_v1; do
    [[ -d "$candidate" ]] && { FLUTTER_DIR="$candidate"; break; }
  done
  FLUTTER_DIR="${FLUTTER_DIR:-$HOME/projects/goldfish/frontend}"
fi
SITE_DIR="${GOLDFISH_SITE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/site}"
WEB_ROOT="${GOLDFISH_WEB_ROOT:-/var/www/goldfish-site}"
APP_PATH="app"                                                  # moet kloppen met --base-href en nginx
WEB_OWNER="${GOLDFISH_WEB_OWNER:-goldfish:goldfish}"
WEB_URL="${GOLDFISH_WEB_URL:-https://goldfishstudy.app}"
API_URL="${GOLDFISH_API_URL:-https://api.goldfishstudy.app}"   # hoort in de build te staan

DRY_RUN=0
DO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build)   DO_BUILD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         echo "Onbekende optie: $arg (zie --help)" >&2; exit 2 ;;
  esac
done

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$OFF"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s !! %s%s\n' "$YELLOW" "$*" "$OFF"; }
die()  { printf '%s !! %s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }
ok()   { printf '%s ✓  %s%s\n' "$GREEN" "$*" "$OFF"; }
remote() { ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$SSH_TARGET" "$@"; }

# ── 1. BUILD ──────────────────────────────────────────────────────────────────
[[ -f "$SSH_KEY" ]] || die "SSH-sleutel niet gevonden: $SSH_KEY
    Geef een ander pad: GOLDFISH_SSH_KEY=/pad/naar/key $0"
key_perms="$(stat -c '%a' "$SSH_KEY")"
[[ "$key_perms" == "600" || "$key_perms" == "400" ]] || die "SSH-sleutel heeft mode $key_perms; ssh weigert dat.
    Herstel met: chmod 600 $SSH_KEY"

[[ -d "$FLUTTER_DIR" ]] || die "Flutter-repo niet gevonden: $FLUTTER_DIR
    Geef het juiste pad mee: GOLDFISH_FLUTTER_DIR=/pad/naar/frontend $0"
[[ -f "$SITE_DIR/index.html" ]] || die "Statische site niet gevonden: $SITE_DIR
    Geef het juiste pad mee: GOLDFISH_SITE_DIR=/pad/naar/site $0"

BUILD_DIR="$FLUTTER_DIR/build/web-prod"

if (( DO_BUILD )); then
  step "1/5  Flutter-webbuild (~8 minuten)"
  build_args="build web --release --base-href /$APP_PATH/"
  if [[ "$FLUTTER_DIR" == /mnt/c/* ]] && command -v cmd.exe >/dev/null; then
    # In WSL móet de Windows-flutter bouwen: de Linux-flutter struikelt over de
    # Windows-paden in .dart_tool/package_config.json. Relatief uitvoerpad,
    # want cmd.exe kent /mnt/c niet.
    ( cd "$FLUTTER_DIR" && cmd.exe /c "flutter $build_args --output build\\web-prod" )
  else
    ( cd "$FLUTTER_DIR" && flutter $build_args --output "$BUILD_DIR" )
  fi
  ok "Build klaar"
else
  step "1/5  Build overslaan (geen --build)"
fi

[[ -f "$BUILD_DIR/main.dart.js" ]] || die "Geen build gevonden in $BUILD_DIR — draai eerst met --build."
info "build: $BUILD_DIR ($(date -r "$BUILD_DIR/main.dart.js" '+%Y-%m-%d %H:%M'))"

# De app staat op /app/; een build met een andere <base href> laadt daar zijn
# eigen main.dart.js niet (wit scherm).
grep -q "<base href=\"/$APP_PATH/\">" "$BUILD_DIR/index.html" \
  || die "De build heeft niet <base href=\"/$APP_PATH/\">. Bouw opnieuw: $0 --build"

# Wijst deze build wel naar de productie-API? scripts/dev.sh bouwt met een
# --dart-define naar een tailnet- of localhost-adres; zo'n build op productie
# zetten geeft een site die de API van iemands laptop probeert te bereiken.
# `|| true`: grep geeft exit 1 als het niets vindt — een schone build dus — en
# met pipefail zou set -e de deploy daar zonder een woord afbreken. Precies
# andersom als bedoeld: de dev-build kwam er langs, de goede build niet.
dev_url="$(grep -oE 'https?://(localhost|127\.0\.0\.1|[a-z0-9-]+\.[a-z0-9-]+\.ts\.net)(:[0-9]+)?' \
  "$BUILD_DIR/main.dart.js" | sort -u | head -3 | tr '\n' ' ' || true)"
if [[ -n "$dev_url" ]]; then
  die "Deze build wijst naar een dev-adres: $dev_url
    Bouw opnieuw voor productie: $0 --build  (zónder --dart-define)"
fi
grep -q "$API_URL" "$BUILD_DIR/main.dart.js" \
  || warn "De productie-API-URL ($API_URL) staat niet in de build. Controleer dit vóór je doorgaat."

local_md5="$(md5sum "$BUILD_DIR/main.dart.js" | cut -d' ' -f1)"
info "lokale main.dart.js md5: $local_md5"
info "site: $SITE_DIR"

# De site gaat met --delete naar de webroot, maar /app/ is van de app en
# README.md en .git (site/ is een eigen repo) horen niet op goldfishstudy.app.
site_rsync() {
  rsync -az --delete "$@" --exclude "/$APP_PATH/" --exclude README.md --exclude .git --exclude .gitignore \
    -e "ssh -i $SSH_KEY" "$SITE_DIR/" "$SSH_TARGET:$WEB_ROOT/"
}
app_rsync() {
  rsync -az --delete "$@" -e "ssh -i $SSH_KEY" "$BUILD_DIR/" "$SSH_TARGET:$WEB_ROOT/$APP_PATH/"
}

if (( DRY_RUN )); then
  step "DRY RUN — wat rsync zou doen"
  info "site → $WEB_ROOT/"
  site_rsync -n --itemize-changes
  info "app → $WEB_ROOT/$APP_PATH/"
  app_rsync -n --itemize-changes | grep -v '^\.' || true
  ok "Dry run klaar — niets gewijzigd."
  exit 0
fi

# ── 2. TERUGROLKOPIE ──────────────────────────────────────────────────────────
step "2/5  Terugrolkopie maken"
# rsync draait met --delete; zonder deze kopie is de vorige stand onherstelbaar weg.
remote "mkdir -p $WEB_ROOT/$APP_PATH && rm -rf $WEB_ROOT.bak-prev && cp -a $WEB_ROOT $WEB_ROOT.bak-prev"
ok "Vorige stand staat in $WEB_ROOT.bak-prev"

# ── 3. RSYNC ──────────────────────────────────────────────────────────────────
step "3/5  Site en app overzetten"
site_rsync --info=stats1
ok "Site staat op de server"
app_rsync --info=stats1
ok "App staat op de server"

# ── 4. EIGENAAR ───────────────────────────────────────────────────────────────
step "4/5  Eigenaar herstellen"
remote "chown -R $WEB_OWNER $WEB_ROOT"
ok "chown $WEB_OWNER $WEB_ROOT"

# ── 5. VERIFICATIE ────────────────────────────────────────────────────────────
step "5/5  Verificatie"
for path in / "/$APP_PATH/"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$WEB_URL$path" || echo "geen antwoord")"
  [[ "$code" == "200" ]] && ok "$WEB_URL$path → 200" || warn "$WEB_URL$path → $code"
done

live_md5="$(curl -s --max-time 30 "$WEB_URL/$APP_PATH/main.dart.js" | md5sum | cut -d' ' -f1)"
if [[ "$live_md5" == "$local_md5" ]]; then
  ok "live main.dart.js komt overeen met de lokale build ($live_md5)"
else
  warn "md5 wijkt af — live: $live_md5, lokaal: $local_md5"
  warn "Wijst nginx al naar $WEB_ROOT? Zie 'Eenmalig: omschakelen' in DEPLOY.md."
fi

printf '\n%s✓ Webdeploy klaar.%s Terugrollen: ssh -i %s %s "rsync -a --delete %s.bak-prev/ %s/"\n' \
  "$GREEN" "$OFF" "$SSH_KEY" "$SSH_TARGET" "$WEB_ROOT" "$WEB_ROOT"
