// GET /v2/stats/decks — batch-variant van /stats/deck/:deckId: alle deck_stats
// van de gebruiker in één request, gegroepeerd per deck. Optioneel ?ids=...;
// alleen levende decks; levend deck zonder stats → lege array (wel een key).
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
async function freshUser() {
  const user = await createUser();
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id) };
}

// Schrijft via de echte schrijfweg (POST /stats/update), zoals stats-changes.test.js.
async function postStats(token, deckId, date) {
  const res = await request(app)
    .post("/v2/stats/update")
    .set("Authorization", `Bearer ${token}`)
    .send({
      date,
      deck_id: deckId,
      deck_delta: {
        cards_practiced: 2,
        cards_correct_first_try: 1,
        core_cards_practiced: 0,
        core_correct_first_try: 0,
        avg_remote_score: 3.0,
        avg_stable_score: 2.0,
      },
      daily_delta: { cards_practiced_today: 2, correct_first_try_today: 1 },
      daily_snapshot: {
        total_cards: 10,
        total_core_cards: 0,
        avg_remote_score: 3.0,
        avg_stable_score: 2.0,
      },
    });
  assert.equal(res.status, 200, `POST /stats/update faalde: ${JSON.stringify(res.body)}`);
}

function getBatch(token, ids) {
  const url = ids === undefined ? "/v2/stats/decks" : `/v2/stats/decks?ids=${encodeURIComponent(ids)}`;
  return request(app).get(url).set("Authorization", `Bearer ${token}`);
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("GET /v2/stats/decks", () => {
  test("zonder ids → alle levende decks, gegroepeerd, nieuw→oud; deck zonder stats → lege array", async () => {
    const { user, token } = await freshUser();
    const deckA = await createDeck(user.id, "A");
    const deckB = await createDeck(user.id, "B");
    await postStats(token, deckA.id, "2026-06-01");
    await postStats(token, deckA.id, "2026-06-02");

    const res = await getBatch(token);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [deckA.id, deckB.id].sort());
    assert.equal(res.body[deckA.id].length, 2);
    assert.equal(res.body[deckA.id][0].date, "2026-06-02", "per deck nieuw→oud gesorteerd");
    assert.equal(res.body[deckA.id][1].date, "2026-06-01");
    assert.deepEqual(res.body[deckB.id], [], "levend deck zonder stats krijgt wél een key");
  });

  test("rijen identiek aan GET /stats/deck/:deckId", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    await postStats(token, deck.id, "2026-06-01");

    const single = await request(app)
      .get(`/v2/stats/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    const batch = await getBatch(token);
    assert.deepEqual(batch.body[deck.id], single.body);
  });

  test("?ids beperkt tot de gevraagde decks", async () => {
    const { user, token } = await freshUser();
    const deckA = await createDeck(user.id, "A");
    const deckB = await createDeck(user.id, "B");
    await postStats(token, deckA.id, "2026-06-01");
    await postStats(token, deckB.id, "2026-06-01");

    const res = await getBatch(token, deckA.id);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), [deckA.id]);
  });

  test("soft-deleted deck en andermans deck worden stilzwijgend genegeerd", async () => {
    const { user, token } = await freshUser();
    const { user: other } = await freshUser();
    const liveDeck = await createDeck(user.id, "live");
    const deadDeck = await createDeck(user.id, "dood");
    const otherDeck = await createDeck(other.id, "andermans");
    await postStats(token, deadDeck.id, "2026-06-01");
    await pool.query(`UPDATE decks SET deleted_at = NOW() WHERE id = $1`, [deadDeck.id]);

    const all = await getBatch(token);
    assert.deepEqual(Object.keys(all.body), [liveDeck.id], "dood deck valt weg zonder ids");

    const asked = await getBatch(token, `${liveDeck.id},${deadDeck.id},${otherDeck.id}`);
    assert.equal(asked.status, 200);
    assert.deepEqual(Object.keys(asked.body), [liveDeck.id], "dood/andermans id: geen key, geen fout");
  });

  test("ongeldige ids → 400", async () => {
    const { token } = await freshUser();
    const res = await getBatch(token, "geen-uuid");
    assert.equal(res.status, 400);
    const empty = await getBatch(token, ",,");
    assert.equal(empty.status, 400);
  });

  test("zonder token → 401", async () => {
    const res = await request(app).get("/v2/stats/decks");
    assert.equal(res.status, 401);
  });
});
