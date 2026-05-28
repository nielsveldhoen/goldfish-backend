import pkg from "pg";
import { readFileSync } from "fs";

const { Pool, types } = pkg;
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: "postgresql://goldfish:Pgewoonzo1S@localhost:5432/goldfish",
});

// ── log parser (port van Dart RepetitionService) ───────────────────────────

function parseLog(log) {
  const entries = [];
  let year = 0, month = 0, i = 0;

  while (i < log.length) {
    if (i + 5 <= log.length && log[i + 4] === "*") {
      const y = parseInt(log.substring(i, i + 4));
      if (!isNaN(y)) { year = y; i += 5; continue; }
    }
    if (i + 3 <= log.length && log[i + 2] === "#") {
      const m = parseInt(log.substring(i, i + 2));
      if (!isNaN(m)) { month = m; i += 3; continue; }
    }
    if (i + 3 <= log.length && (log[i + 2] === "C" || log[i + 2] === "F")) {
      const d = parseInt(log.substring(i, i + 2));
      if (!isNaN(d) && year > 0 && month > 0) {
        if (log[i + 2] === "F") {
          entries.push({ date: new Date(year, month - 1, d), correct: false, difficulty: null });
          i += 3;
        } else {
          let diff = null, advance = 3;
          if (i + 3 < log.length) {
            const code = log.charCodeAt(i + 3);
            if (code >= 65 && code <= 70) { // A–F
              diff = code - 65;
              advance = 4;
            }
          }
          entries.push({ date: new Date(year, month - 1, d), correct: true, difficulty: diff });
          i += advance;
        }
        continue;
      }
    }
    i++;
  }
  return entries;
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetween(a, b) {
  return Math.floor((toMidnight(b) - toMidnight(a)) / 86400000);
}

function toMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function computeLtmScore(entriesUpToDate) {
  const all = entriesUpToDate;
  const last10 = all.length > 10 ? all.slice(all.length - 10) : all;
  if (last10.length === 0) return 0;

  const correctCount = last10.filter((e) => e.correct).length;
  const part1 = (correctCount / last10.length * 100) / 365;

  let streakStartIdx = all.length;
  for (let i = all.length - 1; i >= 0; i--) {
    if (!all[i].correct) break;
    streakStartIdx = i;
  }
  if (streakStartIdx >= all.length) return 0;

  const gapDays = Math.min(365, Math.max(0, daysBetween(all[streakStartIdx].date, all[all.length - 1].date)));
  return Math.min(100, Math.max(0, part1 * gapDays));
}

function computeStmScore(entriesUpToDate, ltmScore, today) {
  const todayMidnight = toMidnight(today);
  const cutoff = todayMidnight - 30 * 86400000;

  const window = entriesUpToDate.filter((e) => toMidnight(e.date) >= cutoff);
  if (window.length === 0) return ltmScore;

  let maxPoints = 0, actualPoints = 0;
  for (const e of window) {
    const d = Math.floor((todayMidnight - toMidnight(e.date)) / 86400000);
    const w = Math.pow(1.1, 30 - d);
    maxPoints += w;
    actualPoints += e.correct ? w : -w;
  }
  const part1 = maxPoints === 0 ? 0 : Math.min(1, Math.max(0, actualPoints / maxPoints));

  let streak = 0, foundWrong = false;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].correct) streak++;
    else { foundWrong = true; break; }
  }
  if (!foundWrong) streak = 7;
  const part2 = Math.min(streak, 7) / 7;

  return Math.max(ltmScore, Math.min(100, Math.max(0, part1 * part2 * 100)));
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const { rows: progressRows } = await pool.query(`
    SELECT
      ucp.user_id,
      ucp.card_id,
      ucp.repetitions,
      ucp.is_core,
      c.deck_id,
      c.created_at AS card_created_at
    FROM user_card_progress ucp
    JOIN cards c ON c.id = ucp.card_id
    WHERE ucp.repetitions != ''
  `);

  // deck_stats: { "userId|deckId|dateStr" → { ...counters, scores: [{ltm, stm}] } }
  const deckStatsMap = new Map();
  // daily_snapshot: { "userId|dateStr" → { cards_practiced, correct_first_try } }
  const dailyMap = new Map();
  // scores per user per date: { "userId|dateStr" → [{ltm, stm}] }
  const userScoresMap = new Map();
  // total_cards per user per date: computed separately below
  // ltm_cards per user per date: track which cardIds are ltm
  const coreCardsByUser = new Map(); // userId → Set of cardIds that are currently core

  for (const row of progressRows) {
    const { user_id, card_id, deck_id, repetitions, is_core } = row;

    if (!coreCardsByUser.has(user_id)) coreCardsByUser.set(user_id, new Set());
    if (is_core) coreCardsByUser.get(user_id).add(card_id);

    const allEntries = parseLog(repetitions);
    if (allEntries.length === 0) continue;

    for (let i = 0; i < allEntries.length; i++) {
      const entry = allEntries[i];
      const dateStr = toDateStr(entry.date);
      const entriesUpToNow = allEntries.slice(0, i + 1);

      const ltm = computeLtmScore(entriesUpToNow);
      const stm = computeStmScore(entriesUpToNow, ltm, entry.date);

      // deck_stats
      const deckKey = `${user_id}|${deck_id}|${dateStr}`;
      if (!deckStatsMap.has(deckKey)) {
        deckStatsMap.set(deckKey, {
          user_id, deck_id, date: dateStr,
          cards_practiced: 0, cards_correct_first_try: 0,
          ltm_cards_practiced: 0, ltm_correct_first_try: 0,
          scores: [],
        });
      }
      const ds = deckStatsMap.get(deckKey);
      ds.cards_practiced++;
      if (entry.correct) ds.cards_correct_first_try++;
      if (is_core) {
        ds.ltm_cards_practiced++;
        if (entry.correct) ds.ltm_correct_first_try++;
      }
      ds.scores.push({ ltm, stm });

      // daily
      const dailyKey = `${user_id}|${dateStr}`;
      if (!dailyMap.has(dailyKey)) {
        dailyMap.set(dailyKey, { user_id, date: dateStr, cards_practiced: 0, correct_first_try: 0, core_practiced: 0, core_correct: 0 });
      }
      const dm = dailyMap.get(dailyKey);
      dm.cards_practiced++;
      if (entry.correct) dm.correct_first_try++;
      if (is_core) {
        dm.core_practiced++;
        if (entry.correct) dm.core_correct++;
      }

      // user scores
      if (!userScoresMap.has(dailyKey)) userScoresMap.set(dailyKey, []);
      userScoresMap.get(dailyKey).push({ ltm, stm });
    }
  }

  // total_cards per user per date
  const { rows: cardRows } = await pool.query(`
    SELECT c.deck_id, d.user_id, c.created_at
    FROM cards c
    JOIN decks d ON d.id = c.deck_id
    WHERE c.deleted_at IS NULL AND d.deleted_at IS NULL
  `);

  // Collect all unique dates per user
  const userDates = new Map(); // userId → Set of dateStrs
  for (const [key] of dailyMap) {
    const [userId, dateStr] = key.split("|");
    if (!userDates.has(userId)) userDates.set(userId, new Set());
    userDates.get(userId).add(dateStr);
  }

  // For each user+date, count cards created <= that date
  const totalCardsMap = new Map(); // "userId|dateStr" → {total, ltm}
  for (const [userId, dates] of userDates) {
    const userCards = cardRows.filter((r) => r.user_id === userId);
    const ltmCards = coreCardsByUser.get(userId) || new Set();

    for (const dateStr of dates) {
      const dateMidnight = new Date(dateStr).getTime();
      let total = 0, totalLtm = 0;
      for (const card of userCards) {
        if (toMidnight(new Date(card.created_at)) <= dateMidnight) {
          total++;
          if (ltmCards.has(card.card_id)) totalLtm++; // won't match (card_id vs id), fix below
        }
      }
      totalCardsMap.set(`${userId}|${dateStr}`, { total, totalLtm });
    }
  }

  // Fix: cardRows has no card_id, get it
  const { rows: cardIdRows } = await pool.query(`
    SELECT c.id AS card_id, c.deck_id, d.user_id, c.created_at
    FROM cards c
    JOIN decks d ON d.id = c.deck_id
    WHERE c.deleted_at IS NULL AND d.deleted_at IS NULL
  `);

  for (const [userId, dates] of userDates) {
    const userCards = cardIdRows.filter((r) => r.user_id === userId);
    const ltmCards = coreCardsByUser.get(userId) || new Set();

    for (const dateStr of dates) {
      const dateMidnight = new Date(dateStr).getTime();
      let total = 0, totalLtm = 0;
      for (const card of userCards) {
        if (toMidnight(new Date(card.created_at)) <= dateMidnight) {
          total++;
          if (ltmCards.has(card.card_id)) totalLtm++;
        }
      }
      totalCardsMap.set(`${userId}|${dateStr}`, { total, totalLtm });
    }
  }

  // ── insert deck_stats ──────────────────────────────────────────────────
  console.log(`Inserting ${deckStatsMap.size} deck_stats rows...`);
  for (const ds of deckStatsMap.values()) {
    const avgLtm = ds.scores.length ? ds.scores.reduce((s, x) => s + x.ltm, 0) / ds.scores.length : null;
    const avgStm = ds.scores.length ? ds.scores.reduce((s, x) => s + x.stm, 0) / ds.scores.length : null;

    await pool.query(
      `INSERT INTO deck_stats
         (user_id, deck_id, date, cards_practiced, cards_correct_first_try,
          ltm_cards_practiced, ltm_correct_first_try, avg_ltm_score, avg_stm_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, deck_id, date) DO NOTHING`,
      [ds.user_id, ds.deck_id, ds.date, ds.cards_practiced, ds.cards_correct_first_try,
       ds.ltm_cards_practiced, ds.ltm_correct_first_try,
       avgLtm !== null ? avgLtm.toFixed(2) : null,
       avgStm !== null ? avgStm.toFixed(2) : null]
    );
  }

  // ── insert user_daily_snapshot ─────────────────────────────────────────
  console.log(`Inserting ${dailyMap.size} user_daily_snapshot rows...`);
  for (const dm of dailyMap.values()) {
    const key = `${dm.user_id}|${dm.date}`;
    const totals = totalCardsMap.get(key) || { total: 0, totalLtm: 0 };
    const scores = userScoresMap.get(key) || [];
    const avgLtm = scores.length ? scores.reduce((s, x) => s + x.ltm, 0) / scores.length : null;
    const avgStm = scores.length ? scores.reduce((s, x) => s + x.stm, 0) / scores.length : null;

    await pool.query(
      `INSERT INTO user_daily_snapshot
         (user_id, date, total_cards, total_ltm_cards, cards_practiced_today,
          correct_first_try_today, core_practiced_today, core_correct_first_try_today,
          avg_ltm_score, avg_stm_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, date) DO NOTHING`,
      [dm.user_id, dm.date, totals.total, totals.totalLtm, dm.cards_practiced,
       dm.correct_first_try, dm.core_practiced, dm.core_correct,
       avgLtm !== null ? avgLtm.toFixed(2) : null,
       avgStm !== null ? avgStm.toFixed(2) : null]
    );
  }

  console.log("Done.");
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
