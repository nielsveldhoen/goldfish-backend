#!/usr/bin/env bash
#
# Goldfish — de productie-indeling (site op /, app op /app/) lokaal nabootsen.
#
#   ./scripts/test-site-local.sh           # opzetten + controles, container blijft draaien
#   ./scripts/test-site-local.sh --build   # eerst de productiebuild maken (build/web-prod)
#   ./scripts/test-site-local.sh --stop    # container weg
#
# Draait nginx 1.28 (zelfde versie als de server) in podman met exact
# nginx/goldfish-site.conf, en de webroot opgebouwd zoals deploy-web.sh hem op
# de server zet. Openen: http://localhost:8095
#
# De app in build/web-prod praat met de productie-API: kijken mag, maar wat je
# ingelogd doet is echt.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="$REPO_DIR/../site"
FLUTTER_DIR="${GOLDFISH_FLUTTER_DIR:-$REPO_DIR/../frontend}"
BUILD_DIR="$FLUTTER_DIR/build/web-prod"
WORK="${GOLDFISH_SITE_TEST_DIR:-/tmp/goldfish-site-test}"
PORT="${GOLDFISH_SITE_TEST_PORT:-8095}"
NAME=goldfish-site-test
IMAGE=docker.io/library/nginx:1.28-alpine
BASE="http://localhost:$PORT"

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$OFF"; }
ok()   { printf '%s ✓  %s%s\n' "$GREEN" "$*" "$OFF"; }
bad()  { printf '%s ✗  %s%s\n' "$RED" "$*" "$OFF"; FAILS=$((FAILS + 1)); }
die()  { printf '%s !! %s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

DO_BUILD=0
case "${1:-}" in
  --stop)  podman rm -f "$NAME" >/dev/null 2>&1 || true; echo "gestopt"; exit 0 ;;
  --build) DO_BUILD=1 ;;
  "")      ;;
  *)       die "Onbekende optie: $1" ;;
esac

if (( DO_BUILD )); then
  step "Productiebuild (--base-href /app/ → build/web-prod)"
  ( cd "$FLUTTER_DIR" && flutter build web --release --base-href /app/ --output "$BUILD_DIR" )
fi
[[ -f "$BUILD_DIR/main.dart.js" ]] || die "Geen build in $BUILD_DIR — draai met --build."

step "Webroot opbouwen in $WORK"
mkdir -p "$WORK/root/app"
rsync -a --delete --exclude /app/ --exclude README.md "$SITE_DIR/" "$WORK/root/"
rsync -a --delete "$BUILD_DIR/" "$WORK/root/app/"
cat > "$WORK/server.conf" <<'EOF'
server {
    listen 80;
    server_name _;
    # Lokaal zit er een poortmapping tussen; relatieve Location-headers
    # houden de redirects dan op de goede poort.
    absolute_redirect off;
    include /etc/nginx/snippets/goldfish-site.conf;
}
EOF
ok "site + app/ klaar"

step "nginx starten op :$PORT"
podman rm -f "$NAME" >/dev/null 2>&1 || true
podman run -d --name "$NAME" -p "127.0.0.1:$PORT:80" \
  -v "$WORK/root:/var/www/goldfish-site:ro,Z" \
  -v "$REPO_DIR/nginx/goldfish-site.conf:/etc/nginx/snippets/goldfish-site.conf:ro,Z" \
  -v "$WORK/server.conf:/etc/nginx/conf.d/default.conf:ro,Z" \
  "$IMAGE" >/dev/null
podman exec "$NAME" nginx -t 2>&1 | tail -1
for _ in $(seq 1 20); do curl -s -o /dev/null "$BASE/" && break; sleep 0.25; done

step "Controles"
FAILS=0
# expect <pad> <status> [Location | tekst in de body]
expect() {
  local path="$1" want="$2" extra="${3:-}" out code loc
  out="$(curl -s -D - -o "$WORK/body" "$BASE$path")"
  code="$(head -1 <<<"$out" | awk '{print $2}')"
  loc="$(grep -i '^location:' <<<"$out" | awk '{print $2}' | tr -d '\r' || true)"
  if [[ "$code" != "$want" ]]; then bad "$path → $code (verwacht $want)"; return; fi
  if [[ "$want" == 301 ]]; then
    [[ "$loc" == "$extra" ]] && ok "$path → 301 $loc" || bad "$path → 301 $loc (verwacht $extra)"
  elif [[ -n "$extra" ]]; then
    grep -q -- "$extra" "$WORK/body" && ok "$path → $code, bevat '$extra'" || bad "$path → $code, mist '$extra'"
  else
    ok "$path → $code"
  fi
}

expect /                          200 'spaced-repetition.html'
expect /spaced-repetition.html    200 '<h1'
expect /vs-anki.html              200 '<h1'
expect /vs-anki                   200 '<h1'
expect /style.css                 200
expect /robots.txt                200 'Sitemap'
expect /sitemap.xml               200 '<urlset'
expect /flutter_service_worker.js 200 'unregister'
expect /README.md                 404
expect /bestaat-niet              404 'noindex'
expect /app                       301 /app/
expect /app/                      200 '<base href="/app/">'
expect /app/login/signin          200 '<base href="/app/">'
expect /app/decks/123             200 '<base href="/app/">'
expect /app/main.dart.js          200
expect /app/flutter_bootstrap.js  200
expect /app/manifest.json         200 '"id": "/"'
expect /decks                     301 /app/decks
expect /decks/abc                 301 /app/decks/abc
expect /login/register            301 /app/login/register
expect /deck/abc?x=1              301 '/app/deck/abc?x=1'
expect /group/g/member/u          301 /app/group/g/member/u
expect /exams                     301 /app/exams
expect /contacts                  301 /app/contacts
expect /review                    301 /app/review
expect /decksxyz                  404

# Headers die ertoe doen.
hdr() { curl -s -o /dev/null -D - "$@" | tr -d '\r'; }
hdr "$BASE/app/" | grep -qi '^cache-control: no-cache' \
  && ok "/app/ → Cache-Control: no-cache" || bad "/app/ mist Cache-Control: no-cache"
hdr "$BASE/app/main.dart.js" | grep -qi '^cache-control: no-cache' \
  && ok "main.dart.js → Cache-Control: no-cache" || bad "main.dart.js mist Cache-Control: no-cache"
hdr -H 'Accept-Encoding: gzip' "$BASE/app/main.dart.js" | grep -qi '^content-encoding: gzip' \
  && ok "main.dart.js gaat gzipped" || bad "main.dart.js niet gzipped"
grep -q 'name="robots" content="noindex"' "$WORK/root/app/index.html" \
  && ok "app-index heeft noindex" || bad "app-index mist noindex"
if curl -s "$BASE/" | grep -q 'noindex'; then bad "de homepage heeft noindex!"; else ok "homepage zonder noindex"; fi

# Elk intern pad op de site moet bestaan (href="/…", geen /app/-routes).
for href in $(grep -ohE 'href="/[^"#]*"' "$WORK/root"/*.html | sort -u | sed 's/href="//; s/"$//'); do
  [[ "$href" == /app/* ]] && continue
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE$href")"
  [[ "$code" == 200 ]] || bad "link $href → $code"
done || true
ok "interne links van de site nagelopen"

echo
if (( FAILS )); then die "$FAILS controle(s) gefaald"; fi
printf '%s✓ Alles groen.%s Open %s en %s/app/ — stoppen: %s --stop\n' "$GREEN" "$OFF" "$BASE" "$BASE" "$0"
