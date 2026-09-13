// POST /v2/stats/update — cards_added/cards_removed op deck_stats: optelbare
// tellers voor kaartmutaties, die de markering in de statistiekgrafiek voeden.
// Een gereset kaart stuurt de client als beide tegelijk.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
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

// Een kaartmutatie komt binnen zonder oefentellers: refreshDeckStats stuurt
// nul geoefende kaarten en alleen de mutatie plus de verse gemiddelden.
function churnBody(deckId, date, deckDelta) {
  return {
    date,
    deck_id: deckId,
    deck_delta: {
      cards_practiced: 0,
      cards_correct_first_try: 0,
      core_cards_practiced: 0,
      core_correct_first_try: 0,
      avg_remote_score: 3.0,
      avg_stable_score: 2.0,
      ...deckDelta,
    },
  };
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("POST /v2/stats/update — cards_added/cards_removed", () => {
  test("worden opgeslagen en teruggegeven op deck_stats", async () => {
    const { token, deck } = await freshUserWithDeck();
    const res = await postUpdate(
      token,
      churnBody(deck.id, "2026-09-01", { cards_added: 48, total_cards: 148 })
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.deck_stats.cards_added, 48);
    assert.equal(res.body.deck_stats.cards_removed, 0);
  });

  test("een tweede write telt op in plaats van te overschrijven", async () => {
    const { token, deck } = await freshUserWithDeck();
    await postUpdate(token, churnBody(deck.id, "2026-09-02", { cards_added: 10 }));
    const res = await postUpdate(
      token,
      churnBody(deck.id, "2026-09-02", { cards_added: 5, cards_removed: 2 })
    );
    assert.equal(res.body.deck_stats.cards_added, 15);
    assert.equal(res.body.deck_stats.cards_removed, 2);
  });

  test("weggelaten tellers laten de bestaande stand staan (delta 0, geen null)", async () => {
    const { token, deck } = await freshUserWithDeck();
    await postUpdate(token, churnBody(deck.id, "2026-09-03", { cards_added: 7 }));

    // Een gewone review-flush noemt de mutatietellers niet.
    const review = await postUpdate(token, {
      date: "2026-09-03",
      deck_id: deck.id,
      deck_delta: {
        cards_practiced: 3,
        cards_correct_first_try: 2,
        core_cards_practiced: 0,
        core_correct_first_try: 0,
        avg_remote_score: 3.0,
        avg_stable_score: 2.0,
      },
    });
    assert.equal(review.body.deck_stats.cards_added, 7, "blijft staan");
    assert.equal(review.body.deck_stats.cards_practiced, 3);
  });

  test("een gereset kaart komt als toegevoegd én verwijderd binnen", async () => {
    const { token, deck } = await freshUserWithDeck();
    const res = await postUpdate(
      token,
      churnBody(deck.id, "2026-09-04", { cards_added: 1, cards_removed: 1 })
    );
    assert.equal(res.body.deck_stats.cards_added, 1);
    assert.equal(res.body.deck_stats.cards_removed, 1);
  });

  test("een nieuwe rij zonder mutaties staat op 0, niet op null", async () => {
    const { token, deck } = await freshUserWithDeck();
    const res = await postUpdate(token, churnBody(deck.id, "2026-09-05", {}));
    assert.equal(res.body.deck_stats.cards_added, 0);
    assert.equal(res.body.deck_stats.cards_removed, 0);
  });

  test("negatieve of absurde mutaties worden geweigerd (400)", async () => {
    const { token, deck } = await freshUserWithDeck();
    const negative = await postUpdate(
      token,
      churnBody(deck.id, "2026-09-06", { cards_removed: -1 })
    );
    assert.equal(negative.status, 400);

    const absurd = await postUpdate(
      token,
      churnBody(deck.id, "2026-09-06", { cards_added: 1_000_000 })
    );
    assert.equal(absurd.status, 400);
  });
});
