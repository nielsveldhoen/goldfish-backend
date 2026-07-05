// POST /v2/stats/update — total_cards/total_core_cards op deck_stats (absolute
// overschrijfwaarden in deck_delta) + daily_snapshot als optioneel deprecatiepad.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import {
  tokenFor,
  createUser,
  createDeck,
  cleanupUser,
  closePool,
} from "./helpers.js";

const createdUserIds = [];
async function freshUserWithDeck() {
  const user = await createUser();
  const deck = await createDeck(user.id);
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id), deck };
}

function postUpdate(token, body) {
  return request(app)
    .post("/v2/stats/update")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

// Minimale geldige body; deck_delta overrides + al-dan-niet daily_snapshot.
function body(deckId, date, { deckDelta = {}, dailySnapshot } = {}) {
  const b = {
    date,
    deck_id: deckId,
    deck_delta: {
      cards_practiced: 1,
      cards_correct_first_try: 1,
      core_cards_practiced: 0,
      core_correct_first_try: 0,
      avg_remote_score: 3.0,
      avg_stable_score: 2.0,
      ...deckDelta,
    },
    daily_delta: {
      cards_practiced_today: 1,
      correct_first_try_today: 1,
    },
  };
  if (dailySnapshot !== undefined) b.daily_snapshot = dailySnapshot;
  return b;
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("POST /v2/stats/update — deck_stats totals", () => {
  test("total_cards/total_core_cards worden opgeslagen en teruggegeven op deck_stats", async () => {
    const { token, deck } = await freshUserWithDeck();
    const res = await postUpdate(
      token,
      body(deck.id, "2026-07-01", {
        deckDelta: { total_cards: 42, total_core_cards: 18 },
        dailySnapshot: { total_cards: 42, total_core_cards: 18, avg_remote_score: 3.0, avg_stable_score: 2.0 },
      })
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.deck_stats.total_cards, 42);
    assert.equal(res.body.deck_stats.total_core_cards, 18);
  });

  test("weggelaten totals blijven null op een nieuwe rij; oudere clients breken niet", async () => {
    const { token, deck } = await freshUserWithDeck();
    const res = await postUpdate(
      token,
      body(deck.id, "2026-07-01", {
        dailySnapshot: { total_cards: 5, total_core_cards: 1, avg_remote_score: 3.0, avg_stable_score: 2.0 },
      })
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.deck_stats.total_cards, null);
    assert.equal(res.body.deck_stats.total_core_cards, null);
  });

  test("weggelaten totals bij een tweede write laten de bestaande waarde staan (overschrijven, geen delta)", async () => {
    const { token, deck } = await freshUserWithDeck();
    await postUpdate(
      token,
      body(deck.id, "2026-07-02", { deckDelta: { total_cards: 40, total_core_cards: 10 } })
    );

    // Tweede write zonder totals → onveranderd.
    const keep = await postUpdate(token, body(deck.id, "2026-07-02"));
    assert.equal(keep.body.deck_stats.total_cards, 40);
    assert.equal(keep.body.deck_stats.total_core_cards, 10);

    // Derde write met nieuwe absolute waarde → overschrijft (geen optelling).
    const overwrite = await postUpdate(
      token,
      body(deck.id, "2026-07-02", { deckDelta: { total_cards: 45 } })
    );
    assert.equal(overwrite.body.deck_stats.total_cards, 45);
    assert.equal(overwrite.body.deck_stats.total_core_cards, 10, "ongenoemde total_core_cards blijft staan");
  });

  test("het zetten van totals bumpt updated_at (voor /stats/changes)", async () => {
    const { token, deck } = await freshUserWithDeck();
    const first = await postUpdate(token, body(deck.id, "2026-07-03"));
    const before = first.body.deck_stats.updated_at;

    const second = await postUpdate(
      token,
      body(deck.id, "2026-07-03", { deckDelta: { total_cards: 99 } })
    );
    assert.ok(
      new Date(second.body.deck_stats.updated_at) > new Date(before),
      "updated_at moet vooruit zijn na het zetten van totals"
    );
  });
});

describe("POST /v2/stats/update — daily_snapshot optioneel", () => {
  test("zonder daily_snapshot → response.daily_snapshot is null en user_daily_snapshot wordt niet aangemaakt", async () => {
    const { user, token, deck } = await freshUserWithDeck();
    const res = await postUpdate(token, body(deck.id, "2026-07-04"));
    assert.equal(res.status, 200);
    assert.equal(res.body.daily_snapshot, null);
    assert.ok(res.body.deck_stats, "deck_stats wordt wel geschreven");

    const snap = await pool.query(
      `SELECT 1 FROM user_daily_snapshot WHERE user_id = $1 AND date = $2`,
      [user.id, "2026-07-04"]
    );
    assert.equal(snap.rowCount, 0, "geen snapshot-rij aangemaakt");
  });

  test("met daily_snapshot → snapshot wordt geschreven en teruggegeven", async () => {
    const { token, deck } = await freshUserWithDeck();
    const res = await postUpdate(
      token,
      body(deck.id, "2026-07-05", {
        dailySnapshot: { total_cards: 7, total_core_cards: 2, avg_remote_score: 3.0, avg_stable_score: 2.0 },
      })
    );
    assert.equal(res.status, 200);
    assert.ok(res.body.daily_snapshot, "snapshot terug");
    assert.equal(res.body.daily_snapshot.total_cards, 7);
  });

  test("ontbrekende deck_delta → 400", async () => {
    const { token, deck } = await freshUserWithDeck();
    const res = await postUpdate(token, { date: "2026-07-06", deck_id: deck.id });
    assert.equal(res.status, 400);
  });
});
