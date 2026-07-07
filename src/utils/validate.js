// Kleine handmatige validatielaag voor alle write-routes. Geen zod/joi:
// de behoefte is beperkt (lengtes, ranges, types) en dit houdt de
// dependency-lijst kort.
//
// Conventie: elke check geeft een foutmelding (string) terug bij ongeldige
// input en null als het veld in orde is. Routes vertalen dat naar een
// 400 { error: <melding> }.

export const LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 2000,
  TAGS_MAX_COUNT: 50,
  TAG_MAX: 100,
  QUESTION_MAX: 10_000,
  ANSWER_MAX: 10_000,
  REPETITIONS_MAX: 2000,
  // Nieuwe wachtwoorden (register + reset). Bij login geldt een ruimere
  // bovengrens zodat vóór deze limiet aangemaakte wachtwoorden blijven werken.
  PASSWORD_MAX: 128,
  PASSWORD_LOGIN_MAX: 1024,
  EMAIL_MAX: 254,
  USERNAME_MAX: 64,
  // Stats-tellers zijn deltas per request; per reviewsessie meer dan dit is
  // geen reëel gebruik en corrumpeert alleen de cumulatieve tellers.
  STATS_DELTA_MAX: 10_000,
  TOTAL_CARDS_MAX: 1_000_000,
};

// Postgres smallint — scores buiten deze range geven anders een 22P02/22003.
const SMALLINT_MIN = -32768;
const SMALLINT_MAX = 32767;

// `required` = veld moet aanwezig én niet-leeg zijn; anders is undefined/null
// toegestaan (partial updates).
export function invalidString(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    return required ? `${name} is required` : null;
  }
  if (typeof value !== "string") return `${name} must be a string`;
  if (required && value.length === 0) return `${name} is required`;
  if (value.length > max) return `${name} too long (max ${max} characters)`;
  return null;
}

export function invalidBoolean(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") return `${name} must be a boolean`;
  return null;
}

export function invalidTags(tags) {
  if (tags === undefined || tags === null) return null;
  if (!Array.isArray(tags)) return "tags must be an array of strings";
  if (tags.length > LIMITS.TAGS_MAX_COUNT) {
    return `Too many tags (max ${LIMITS.TAGS_MAX_COUNT})`;
  }
  for (const tag of tags) {
    if (typeof tag !== "string") return "tags must be an array of strings";
    if (tag.length > LIMITS.TAG_MAX) {
      return `Tag too long (max ${LIMITS.TAG_MAX} characters)`;
    }
  }
  return null;
}

// Scores (remote/stable/recent): integer binnen smallint-range.
export function invalidScore(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < SMALLINT_MIN || value > SMALLINT_MAX) {
    return `${name} must be an integer between ${SMALLINT_MIN} and ${SMALLINT_MAX}`;
  }
  return null;
}

// Stats-deltas: niet-negatieve integer met een sane bovengrens — negatief of
// absurd groot zou de cumulatieve tellers permanent corrumperen.
export function invalidCounterDelta(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > LIMITS.STATS_DELTA_MAX) {
    return `${name} must be an integer between 0 and ${LIMITS.STATS_DELTA_MAX}`;
  }
  return null;
}

// Absolute aantallen (total_cards e.d.): niet-negatieve integer.
export function invalidTotal(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > LIMITS.TOTAL_CARDS_MAX) {
    return `${name} must be an integer between 0 and ${LIMITS.TOTAL_CARDS_MAX}`;
  }
  return null;
}

// Gemiddelde scores: eindig getal binnen smallint-range (kolommen zijn numeric,
// maar alles daarbuiten is per definitie corrupt).
export function invalidAvg(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)
      || value < SMALLINT_MIN || value > SMALLINT_MAX) {
    return `${name} must be a finite number`;
  }
  return null;
}

// Datums (due_date, stats-date, client_updated_at): string die Date kan parsen.
export function invalidDate(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    return required ? `${name} is required` : null;
  }
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    return `${name} must be a valid date`;
  }
  return null;
}

// Geeft de eerste foutmelding uit een lijst checks, of null als alles ok is.
// Gebruik: const err = firstError(invalidString(...), invalidTags(...));
export function firstError(...errors) {
  return errors.find((e) => e !== null && e !== undefined) ?? null;
}
