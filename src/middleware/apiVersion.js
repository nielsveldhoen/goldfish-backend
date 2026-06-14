// Veldnaam-vertaling tussen API-versies.
//
// Intern (route-handlers + database) zijn de nieuwe namen canoniek:
//   ltm -> remote, stm -> stable, nieuw veld: recent
// v1 (en de ongeprefixte legacy-paden) spreekt de oude namen, v2 de nieuwe.
// De database houdt oude en nieuwe kolommen synchroon via triggers
// (zie migrations/003_rename_ltm_remote_stm_stable_add_recent.sql).

const NEW_TO_OLD = {
  remote_score: "ltm_score",
  stable_score: "stm_score",
  remote_cards_practiced: "ltm_cards_practiced",
  remote_correct_first_try: "ltm_correct_first_try",
  avg_remote_score: "avg_ltm_score",
  avg_stable_score: "avg_stm_score",
  total_remote_cards: "total_ltm_cards",
  total_remote_count: "total_ltm_count",
};

const OLD_TO_NEW = Object.fromEntries(
  Object.entries(NEW_TO_OLD).map(([neu, old]) => [old, neu])
);

// Velden zonder v1-equivalent: bestaan alleen in v2-responses.
const V2_ONLY = new Set(["recent_score", "avg_recent_score"]);

// Loopt recursief door een JSON-structuur en past per key `mapKey` toe.
// `mapKey(key, obj)` geeft de (eventueel hernoemde) key terug, of null om
// het veld in deze versie weg te laten.
function mapKeysDeep(value, mapKey) {
  if (Array.isArray(value)) return value.map((v) => mapKeysDeep(v, mapKey));
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const mapped = mapKey(key, value);
    if (mapped === null) continue;
    out[mapped] = mapKeysDeep(val, mapKey);
  }
  return out;
}

// v1-request: oude veldnamen -> canonieke (nieuwe) namen.
// Staat de nieuwe naam er al naast, dan wint die en vervalt de oude.
function v1RequestKey(key, obj) {
  const neu = OLD_TO_NEW[key];
  if (neu) return neu in obj ? null : neu;
  return key;
}

// v1-response: canonieke namen -> oude namen; v2-only velden vervallen.
// Database-rijen (SELECT */RETURNING *) bevatten beide kolomsets — dan
// vervalt de nieuwe naam omdat de oude er al naast staat.
function v1ResponseKey(key, obj) {
  if (V2_ONLY.has(key)) return null;
  const old = NEW_TO_OLD[key];
  if (old) return old in obj ? null : old;
  return key;
}

// v2-response: oude namen vervallen (of worden hernoemd als de nieuwe
// tegenhanger ontbreekt).
function v2ResponseKey(key, obj) {
  const neu = OLD_TO_NEW[key];
  if (neu) return neu in obj ? null : neu;
  return key;
}

// Laagste API-versie die de server nog accepteert. Standaard 1; zet
// MIN_API_VERSION=2 om v1 (en de ongeprefixte legacy-paden) af te sluiten —
// oudere clients krijgen dan op elke call een 410 met api_version_unsupported.
// Per request gelezen zodat tests dit kunnen variëren.
export function minApiVersion() {
  return Number(process.env.MIN_API_VERSION || 1);
}

export function apiVersion(version) {
  return (req, res, next) => {
    if (version < minApiVersion()) {
      return res.status(410).json({
        error: "api_version_unsupported",
        min_version: `v${minApiVersion()}`,
      });
    }

    req.apiVersion = version;

    if (version === 1 && req.body && typeof req.body === "object") {
      req.body = mapKeysDeep(req.body, v1RequestKey);
    }

    const originalJson = res.json.bind(res);
    res.json = (payload) =>
      originalJson(
        mapKeysDeep(payload, version === 1 ? v1ResponseKey : v2ResponseKey)
      );

    next();
  };
}
