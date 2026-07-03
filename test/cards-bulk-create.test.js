// POST /cards/bulk — volgorde-garantie van de response (client mapt temp-ids
// op index), optioneel created_at per kaart (ongeldig/afwezig → DB-klok) en
// het maximum van 500 kaarten per request. Plus created_at op POST /cards.
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
async function freshUser() {
  const user = await createUser();
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id) };
}

function postBulk(token, body) {
  return request(app)
    .post("/v2/cards/bulk")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("POST /cards/bulk", () => {
  test("response-array heeft exact dezelfde volgorde als de request-array", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const cards = Array.from({ length: 10 }, (_, i) => ({
      question: `vraag ${i}?`,
      answer: `antwoord ${i}`,
    }));

    const res = await postBulk(token, { deck_id: deck.id, cards });
    assert.equal(res.status, 201);
    assert.equal(res.body.length, cards.length);
    res.body.forEach((card, i) => {
      assert.equal(card.question, cards[i].question, `index ${i} in volgorde`);
      assert.equal(card.answer, cards[i].answer);
      assert.ok(card.id, "server-id aanwezig voor temp-id-mapping");
    });
  });

  test("created_at per kaart wordt overgenomen; ontbrekend of ongeldig → DB-klok", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const offlineTs = "2026-01-15T09:30:00.000Z";

    const res = await postBulk(token, {
      deck_id: deck.id,
      cards: [
        { question: "offline?", answer: "ja", created_at: offlineTs },
        { question: "zonder?", answer: "ja" },
        { question: "ongeldig?", answer: "ja", created_at: "geen-datum" },
      ],
    });
    assert.equal(res.status, 201);

    assert.equal(new Date(res.body[0].created_at).toISOString(), offlineTs);
    for (const card of [res.body[1], res.body[2]]) {
      const age = Math.abs(Date.now() - new Date(card.created_at).getTime());
      assert.ok(age < 60_000, "valt terug op de DB-klok");
    }
  });

  test("meer dan 500 kaarten → 400", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const cards = Array.from({ length: 501 }, (_, i) => ({
      question: `v${i}`,
      answer: `a${i}`,
    }));

    const res = await postBulk(token, { deck_id: deck.id, cards });
    assert.equal(res.status, 400);
  });

  test("precies 500 kaarten mag wél", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const cards = Array.from({ length: 500 }, (_, i) => ({
      question: `v${i}`,
      answer: `a${i}`,
    }));

    const res = await postBulk(token, { deck_id: deck.id, cards });
    assert.equal(res.status, 201);
    assert.equal(res.body.length, 500);
  });
});

describe("POST /cards — created_at", () => {
  test("geldige created_at wordt overgenomen, ongeldige valt terug op DB-klok", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const offlineTs = "2026-02-01T12:00:00.000Z";

    const withTs = await request(app)
      .post("/v2/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({ deck_id: deck.id, question: "q", answer: "a", created_at: offlineTs });
    assert.equal(withTs.status, 201);
    assert.equal(new Date(withTs.body.created_at).toISOString(), offlineTs);

    const invalidTs = await request(app)
      .post("/v2/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({ deck_id: deck.id, question: "q2", answer: "a2", created_at: "nope" });
    assert.equal(invalidTs.status, 201);
    const age = Math.abs(Date.now() - new Date(invalidTs.body.created_at).getTime());
    assert.ok(age < 60_000, "valt terug op de DB-klok");
  });
});
