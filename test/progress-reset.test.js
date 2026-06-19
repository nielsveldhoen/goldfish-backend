// Punt 5: DELETE /review/progress/:card_id — idempotente reset, juiste
// 403/404-semantiek, en de verwijdering is zichtbaar via /sync/changes
// (progress-record met deleted_at gezet).
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

let user, token, deck, card;
let otherUser, otherToken;

before(async () => {
  user = await createUser();
  token = tokenFor(user.id);
  deck = await createDeck(user.id);
  card = await createCard(deck.id);
  await createProgress(user.id, card.id);

  otherUser = await createUser();
  otherToken = tokenFor(otherUser.id);
});

after(async () => {
  await cleanupUser(user.id);
  await cleanupUser(otherUser.id);
  await closePool();
});

describe("DELETE /review/progress/:card_id", () => {
  test("reset, idempotentie, sync en opnieuw beginnen", async () => {
    const since = new Date(Date.now() - 1000).toISOString();

    // 1. Reset → 200
    const res = await request(app)
      .delete(`/v2/review/progress/${card.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { message: "Progress reset" });

    // 2. Idempotent: nogmaals → ook 200
    const res2 = await request(app)
      .delete(`/v2/review/progress/${card.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res2.status, 200);
    assert.deepEqual(res2.body, { message: "Progress reset" });

    // 3. Zichtbaar via /sync/changes als progress-record met deleted_at
    const syncRes = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(syncRes.status, 200);
    const deleted = syncRes.body.progress.find((p) => p.card_id === card.id);
    assert.ok(deleted, "gereset progress-record moet in /sync/changes zitten");
    assert.ok(deleted.deleted_at, "progress-record moet deleted_at gezet hebben");

    // 4. Kaart telt weer als nieuw / zonder voortgang
    const deckRes = await request(app)
      .get(`/v2/review/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(deckRes.status, 200);
    const entry = deckRes.body.find((c) => c.id === card.id);
    assert.ok(entry, "kaart moet nog bestaan");
    assert.equal(entry.progress_id, null, "voortgang moet weg zijn na reset");

    // 5. Opnieuw reviewen maakt een vers (niet-deleted) record
    const upsert = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, remote_score: 1, due_date: "2026-07-01" });
    assert.equal(upsert.status, 200);
    assert.equal(upsert.body.deleted_at, null, "nieuwe review heft de soft-delete op");
  });

  test("kaart van een andere gebruiker → 403", async () => {
    const res = await request(app)
      .delete(`/v2/review/progress/${card.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    assert.equal(res.status, 403);
  });

  test("onbestaande kaart → 404", async () => {
    const res = await request(app)
      .delete(`/v2/review/progress/${FAKE_UUID}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 404);
  });

  test("ongeldig uuid-formaat → 404", async () => {
    const res = await request(app)
      .delete("/v2/review/progress/not-a-uuid")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 404);
  });
});
