#!/usr/bin/env bash
#
# Goldfish webfrontend — Flutter-webbuild naar de Hetzner-server.
#
#   ./scripts/deploy-web.sh --build   # eerst bouwen (WSL: via de Windows-flutter, ~8 min)
#   ./scripts/deploy-web.sh           # alleen de bestaande build/web/ deployen
#   ./scripts/deploy-web.sh --dry-run # laat zien wat er zou veranderen
#
# Wat het doet:
#   1. build (optioneel) — flutter build web --release in de Flutter-repo
#   2. terugrolkopie     — /var/www/goldfish → /var/www/goldfish.bak-prev
#   3. rsync             — build/web/ → /var/www/goldfish/ (met --delete)
#   4. chown             — goldfish:goldfish (nginx leest het gewoon)
#   5. verify            — md5 van de live main.dart.js vs de lokale build
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
WEB_ROOT="${GOLDFISH_WEB_ROOT:-/var/www/goldfish}"
WEB_OWNER="${GOLDFISH_WEB_OWNER:-goldfish:goldfish}"
WEB_URL="${GOLDFISH_WEB_URL:-https://goldfishstudy.app}"

DRY_RUN=0
DO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build)   DO_BUILD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

if (( DO_BUILD )); then
  step "1/5  Flutter-webbuild (~8 minuten)"
  if [[ "$FLUTTER_DIR" == /mnt/c/* ]] && command -v cmd.exe >/dev/null; then
    # In WSL móet de Windows-flutter bouwen: de Linux-flutter struikelt over de
    # Windows-paden in .dart_tool/package_config.json.
    ( cd "$FLUTTER_DIR" && cmd.exe /c "flutter build web --release" )
  else
    ( cd "$FLUTTER_DIR" && flutter build web --release )
  fi
  ok "Build klaar"
else
  step "1/5  Build overslaan (geen --build)"
fi

BUILD_DIR="$FLUTTER_DIR/build/web"
[[ -f "$BUILD_DIR/main.dart.js" ]] || die "Geen build gevonden in $BUILD_DIR — draai eerst met --build."
info "build: $BUILD_DIR ($(date -r "$BUILD_DIR/main.dart.js" '+%Y-%m-%d %H:%M'))"

local_md5="$(md5sum "$BUILD_DIR/main.dart.js" | cut -d' ' -f1)"
info "lokale main.dart.js md5: $local_md5"

if (( DRY_RUN )); then
  step "DRY RUN — wat rsync zou doen"
  rsync -azn --delete --itemize-changes -e "ssh -i $SSH_KEY" \
    "$BUILD_DIR/" "$SSH_TARGET:$WEB_ROOT/"
  ok "Dry run klaar — niets gewijzigd."
  exit 0
fi

# ── 2. TERUGROLKOPIE ──────────────────────────────────────────────────────────
step "2/5  Terugrolkopie maken"
# rsync draait met --delete; zonder deze kopie is de vorige build onherstelbaar weg.
remote "rm -rf $WEB_ROOT.bak-prev && cp -a $WEB_ROOT $WEB_ROOT.bak-prev"
ok "Vorige build staat in $WEB_ROOT.bak-prev"

# ── 3. RSYNC ──────────────────────────────────────────────────────────────────
step "3/5  Build overzetten"
rsync -az --delete --info=stats1 -e "ssh -i $SSH_KEY" \
  "$BUILD_DIR/" "$SSH_TARGET:$WEB_ROOT/"
ok "Bestanden staan op de server"

# ── 4. EIGENAAR ───────────────────────────────────────────────────────────────
step "4/5  Eigenaar herstellen"
remote "chown -R $WEB_OWNER $WEB_ROOT"
ok "chown $WEB_OWNER $WEB_ROOT"

# ── 5. VERIFICATIE ────────────────────────────────────────────────────────────
step "5/5  Verificatie"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$WEB_URL/" || echo "geen antwoord")"
[[ "$code" == "200" ]] && ok "$WEB_URL/ → 200" || warn "$WEB_URL/ → $code"

live_md5="$(curl -s --max-time 30 "$WEB_URL/main.dart.js" | md5sum | cut -d' ' -f1)"
if [[ "$live_md5" == "$local_md5" ]]; then
  ok "live main.dart.js komt overeen met de lokale build ($live_md5)"
else
  warn "md5 wijkt af — live: $live_md5, lokaal: $local_md5"
  warn "Waarschijnlijk cache (Cloudflare staat grijs, dus normaal geen CDN-cache). Hard refresh en check opnieuw."
fi

printf '\n%s✓ Webdeploy klaar.%s Terugrollen: ssh -i %s %s "rsync -a --delete %s.bak-prev/ %s/"\n' \
  "$GREEN" "$OFF" "$SSH_KEY" "$SSH_TARGET" "$WEB_ROOT" "$WEB_ROOT"
