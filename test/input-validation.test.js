// Inputbegrenzing en id-afhandeling op de write-routes:
//  - lengtes/ranges (titels, vragen/antwoorden, tags, scores, stats-deltas,
//    wachtwoord-maximum) → 400 i.p.v. een Postgres-fout die als 500 strandt
//  - malformed UUID's op :id-routes → 404/leeg i.p.v. 22P02 → 500
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import {
  tokenFor,
  createUser,
  createDeck,
  createCard,
  createProgress,
  cleanupUser,
  closePool,
} from "./helpers.js";

const createdUserIds = [];
async function freshUser() {
  const user = await createUser();
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id) };
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

const auth = (req, token) => req.set("Authorization", `Bearer ${token}`);

describe("inputbegrenzing decks", () => {
  test("titel boven het maximum → 400", async () => {
    const { token } = await freshUser();
    const res = await auth(request(app).post("/v2/decks"), token)
      .send({ title: "x".repeat(201) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /title/i);
  });

  test("te veel of te lange tags → 400", async () => {
    const { token } = await freshUser();

    const tooMany = await auth(request(app).post("/v2/decks"), token)
      .send({ title: "ok", tags: Array.from({ length: 51 }, (_, i) => `t${i}`) });
    assert.equal(tooMany.status, 400);

    const tooLong = await auth(request(app).post("/v2/decks"), token)
      .send({ title: "ok", tags: ["x".repeat(101)] });
    assert.equal(tooLong.status, 400);

    const wrongType = await auth(request(app).post("/v2/decks"), token)
      .send({ title: "ok", tags: [42] });
    assert.equal(wrongType.status, 400);
  });

  test("non-boolean inactive → 400 (geen 22P02 → 500)", async () => {
    const { token } = await freshUser();
    const res = await auth(request(app).post("/v2/decks"), token)
      .send({ title: "ok", inactive: "ja" });
    assert.equal(res.status, 400);
  });

  test("PUT met te lange titel → 400; geldige update blijft werken", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);

    const bad = await auth(request(app).put(`/v2/decks/${deck.id}`), token)
      .send({ title: "x".repeat(201) });
    assert.equal(bad.status, 400);

    const ok = await auth(request(app).put(`/v2/decks/${deck.id}`), token)
      .send({ title: "nieuwe titel" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.title, "nieuwe titel");
  });
});

describe("malformed UUID's → 404/leeg i.p.v. 500", () => {
  test("GET/PUT/DELETE /decks/:id met malformed id → 404", async () => {
    const { token } = await freshUser();
    for (const call of [
      request(app).get("/v2/decks/not-a-uuid"),
      request(app).put("/v2/decks/not-a-uuid").send({ title: "x" }),
      request(app).delete("/v2/decks/not-a-uuid"),
    ]) {
      const res = await auth(call, token);
      assert.equal(res.status, 404, `verwachtte 404, kreeg ${res.status}`);
    }
  });

  test("GET/PUT/DELETE /cards/:id met malformed id → 404", async () => {
    const { token } = await freshUser();
    for (const call of [
      request(app).get("/v2/cards/not-a-uuid"),
      request(app).put("/v2/cards/not-a-uuid").send({ question: "x" }),
      request(app).delete("/v2/cards/not-a-uuid"),
    ]) {
      const res = await auth(call, token);
      assert.equal(res.status, 404, `verwachtte 404, kreeg ${res.status}`);
    }
  });

  test("GET /cards?deck_id=malformed → lege array; GET /stats/deck/malformed → lege array", async () => {
    const { token } = await freshUser();

    const cards = await auth(request(app).get("/v2/cards?deck_id=not-a-uuid"), token);
    assert.equal(cards.status, 200);
    assert.deepEqual(cards.body, []);

    const stats = await auth(request(app).get("/v2/stats/deck/not-a-uuid"), token);
    assert.equal(stats.status, 200);
    assert.deepEqual(stats.body, []);
  });
});

describe("inputbegrenzing cards", () => {
  test("vraag/antwoord boven het maximum → 400 (single, bulk en PUT)", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const long = "x".repeat(10_001);

    const single = await auth(request(app).post("/v2/cards"), token)
      .send({ deck_id: deck.id, question: long, answer: "a" });
    assert.equal(single.status, 400);

    const bulk = await auth(request(app).post("/v2/cards/bulk"), token)
      .send({ deck_id: deck.id, cards: [{ question: "q", answer: long }] });
    assert.equal(bulk.status, 400);

    const card = await createCard(deck.id);
    const put = await auth(request(app).put(`/v2/cards/${card.id}`), token)
      .send({ answer: long });
    assert.equal(put.status, 400);
  });

  test("bulk: response houdt request-volgorde (multi-row insert)", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);

    const cards = Array.from({ length: 25 }, (_, i) => ({
      question: `vraag ${i}`,
      answer: `antwoord ${i}`,
    }));
    const res = await auth(request(app).post("/v2/cards/bulk"), token)
      .send({ deck_id: deck.id, cards });

    assert.equal(res.status, 201);
    assert.equal(res.body.length, 25);
    res.body.forEach((row, i) => {
      assert.equal(row.question, `vraag ${i}`, "volgorde moet de request volgen");
      assert.equal(row.deck_id, deck.id);
      assert.ok(row.id);
    });
  });
});

describe("inputbegrenzing review/progress", () => {
  test("score buiten smallint-range → 400 (geen 22003 → 500)", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const card = await createCard(deck.id);

    const res = await auth(request(app).post("/v2/review/progress"), token)
      .send({ card_id: card.id, remote_score: 40_000, due_date: "2026-08-01" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /remote_score/);
  });

  test("ongeldige due_date en te lange repetitions → 400", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const card = await createCard(deck.id);

    const badDate = await auth(request(app).post("/v2/review/progress"), token)
      .send({ card_id: card.id, remote_score: 3, due_date: "geen-datum" });
    assert.equal(badDate.status, 400);

    const badReps = await auth(request(app).post("/v2/review/progress"), token)
      .send({ card_id: card.id, remote_score: 3, due_date: "2026-08-01", repetitions: "x".repeat(2001) });
    assert.equal(badReps.status, 400);
  });

  test("geldige write blijft werken (regressie)", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const card = await createCard(deck.id);

    const res = await auth(request(app).post("/v2/review/progress"), token)
      .send({ card_id: card.id, remote_score: 3, stable_score: 2, due_date: "2026-08-01", repetitions: "1" });
    assert.equal(res.status, 200);
    assert.equal(res.body.remote_score, 3);
  });
});

describe("inputbegrenzing stats", () => {
  test("negatieve of absurde deltas → 400 (tellers niet te corrumperen)", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);

    const negative = await auth(request(app).post("/v2/stats/update"), token)
      .send({ date: "2026-06-01", deck_id: deck.id, deck_delta: { cards_practiced: -5 } });
    assert.equal(negative.status, 400);

    const absurd = await auth(request(app).post("/v2/stats/update"), token)
      .send({ date: "2026-06-01", deck_id: deck.id, deck_delta: { cards_practiced: 1_000_000 } });
    assert.equal(absurd.status, 400);

    const nonInt = await auth(request(app).post("/v2/stats/update"), token)
      .send({ date: "2026-06-01", deck_id: deck.id, deck_delta: { cards_practiced: 1.5 } });
    assert.equal(nonInt.status, 400);
  });

  test("malformed deck_id → 403 (zelfde uitkomst als onbekend deck), ongeldige date → 400", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);

    const badId = await auth(request(app).post("/v2/stats/update"), token)
      .send({ date: "2026-06-01", deck_id: "not-a-uuid", deck_delta: { cards_practiced: 1 } });
    assert.equal(badId.status, 403);

    const badDate = await auth(request(app).post("/v2/stats/update"), token)
      .send({ date: "geen-datum", deck_id: deck.id, deck_delta: { cards_practiced: 1 } });
    assert.equal(badDate.status, 400);
  });
});

describe("wachtwoord-maximum", () => {
  test("registratie met wachtwoord > 128 tekens → 400", async () => {
    const res = await request(app)
      .post("/v2/auth/register")
      .send({ email: "lang-ww@goldfish.test", password: "x".repeat(129) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /too long/i);
  });
});
