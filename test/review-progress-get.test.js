// Punt 12: GET /review/progress/:card_id — licht endpoint voor de
// save_progress-merge in de client, zodat die niet meer het complete deck
// (/review/deck/:id) hoeft te downloaden per review-antwoord.
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

const FAKE_UUID = "11111111-1111-4111-8111-111111111111";

let user, token, deck, card, freshCard;
let otherUser, otherToken;

before(async () => {
  user = await createUser();
  token = tokenFor(user.id);
  deck = await createDeck(user.id);
  card = await createCard(deck.id);
  freshCard = await createCard(deck.id);
  await createProgress(user.id, card.id);

  otherUser = await createUser();
  otherToken = tokenFor(otherUser.id);
});

after(async () => {
  await cleanupUser(user.id);
  await cleanupUser(otherUser.id);
  await closePool();
});

describe("GET /review/progress/:card_id", () => {
  test("kaart met voortgang → één rij in /review/deck-vorm", async () => {
    const res = await request(app)
      .get(`/v2/review/progress/${card.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, card.id);
    assert.equal(res.body.deck_id, deck.id);
    assert.equal(res.body.question, "vraag?");
    assert.equal(res.body.repetitions, "x");
    assert.equal(res.body.remote_score, 2);
    assert.ok(res.body.progress_id, "progress_id moet gezet zijn");
    assert.ok(res.body.progress_updated_at, "progress_updated_at moet gezet zijn");
    assert.equal("owner_id" in res.body, false, "interne owner_id mag niet lekken");
  });

  test("kaart zonder voortgang → rij met lege progress-velden", async () => {
    const res = await request(app)
      .get(`/v2/review/progress/${freshCard.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, freshCard.id);
    assert.equal(res.body.progress_id, null);
    assert.equal(res.body.repetitions, null);
  });

  test("gereset (soft-deleted) voortgang telt als geen voortgang", async () => {
    const resetCard = await createCard(deck.id);
    await createProgress(user.id, resetCard.id);
    await request(app)
      .delete(`/v2/review/progress/${resetCard.id}`)
      .set("Authorization", `Bearer ${token}`);

    const res = await request(app)
      .get(`/v2/review/progress/${resetCard.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.progress_id, null, "soft-deleted voortgang mag niet terugkomen");
  });

  test("kaart van een andere gebruiker → 403", async () => {
    const res = await request(app)
      .get(`/v2/review/progress/${card.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    assert.equal(res.status, 403);
  });

  test("onbestaande kaart → 404", async () => {
    const res = await request(app)
      .get(`/v2/review/progress/${FAKE_UUID}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 404);
  });

  test("ongeldig uuid-formaat → 404", async () => {
    const res = await request(app)
      .get("/v2/review/progress/not-a-uuid")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 404);
  });

  test("zonder token → 401", async () => {
    const res = await request(app).get(`/v2/review/progress/${card.id}`);
    assert.equal(res.status, 401);
  });
});
