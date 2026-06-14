// Punt 3: een 409 stale_write bevat altijd het VOLLEDIGE actuele object in
// "current" — dezelfde velden als de normale GET-response. De client past
// "current" lokaal toe bij een conflict.
import { test, describe, before, after } from "node:test";
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

// Ouder dan elke updated_at die de DB kan hebben → forceert het conflictpad.
const STALE_TIMESTAMP = "2000-01-01T00:00:00.000Z";

let user, token, deck, card;

before(async () => {
  user = await createUser();
  token = tokenFor(user.id);
  deck = await createDeck(user.id);
  card = await createCard(deck.id);
  await createProgress(user.id, card.id);
});

after(async () => {
  await cleanupUser(user.id);
  await closePool();
});

function assertStaleWriteShape(res, referenceObject) {
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "stale_write");
  assert.ok(res.body.current, "409 moet een current-object bevatten");

  const expectedKeys = Object.keys(referenceObject).sort();
  const actualKeys = Object.keys(res.body.current).sort();
  assert.deepEqual(
    actualKeys,
    expectedKeys,
    "current moet exact dezelfde velden hebben als de normale GET-response"
  );
}

describe("409 stale_write bevat het volledige actuele object", () => {
  test("PUT /decks/:id", async () => {
    const getRes = await request(app)
      .get(`/decks/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(getRes.status, 200);

    const res = await request(app)
      .put(`/decks/${deck.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Nieuwe titel", client_updated_at: STALE_TIMESTAMP });

    assertStaleWriteShape(res, getRes.body);
    assert.equal(res.body.current.id, deck.id);
    assert.equal(res.body.current.title, deck.title, "titel mag niet gewijzigd zijn");
  });

  test("PUT /cards/:id", async () => {
    const getRes = await request(app)
      .get(`/cards/${card.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(getRes.status, 200);

    const res = await request(app)
      .put(`/cards/${card.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "Nieuwe vraag", client_updated_at: STALE_TIMESTAMP });

    assertStaleWriteShape(res, getRes.body);
    assert.equal(res.body.current.id, card.id);
    assert.equal(res.body.current.question, card.question, "vraag mag niet gewijzigd zijn");
  });

  test("POST /review/progress (volledige upsert)", async () => {
    // Referentie: de normale 200-response van POST /review/progress zelf.
    const okRes = await request(app)
      .post("/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, ltm_score: 3, due_date: "2026-07-01" });
    assert.equal(okRes.status, 200);

    const res = await request(app)
      .post("/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({
        card_id: card.id,
        ltm_score: 5,
        due_date: "2026-08-01",
        client_updated_at: STALE_TIMESTAMP,
      });

    assertStaleWriteShape(res, okRes.body);
    assert.equal(res.body.current.card_id, card.id);
    assert.equal(res.body.current.ltm_score, 3, "score mag niet gewijzigd zijn");
  });

  test("POST /review/progress (alleen is_core)", async () => {
    const okRes = await request(app)
      .post("/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, ltm_score: 3, due_date: "2026-07-01" });
    assert.equal(okRes.status, 200);

    const res = await request(app)
      .post("/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, is_core: true, client_updated_at: STALE_TIMESTAMP });

    assertStaleWriteShape(res, okRes.body);
  });
});
