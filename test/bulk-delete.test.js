// POST /cards/bulk-delete en POST /decks/bulk-delete — soft-delete in één
// transactie met cascade op de voortgangsrecords. Idempotent en tolerant:
// onbekende, al verwijderde of andermans ids worden stilzwijgend genegeerd.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/db.js";
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

function bulkDelete(token, path, body) {
  return request(app)
    .post(path)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

async function deletedAtOf(table, id) {
  const result = await pool.query(`SELECT deleted_at FROM ${table} WHERE id = $1`, [id]);
  return result.rows[0].deleted_at;
}

async function progressDeletedAt(progressId) {
  return deletedAtOf("user_card_progress", progressId);
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("POST /cards/bulk-delete", () => {
  test("soft-delete van meerdere kaarten + cascade op progress", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const cardA = await createCard(deck.id);
    const cardB = await createCard(deck.id);
    const progress = await createProgress(user.id, cardA.id);

    const res = await bulkDelete(token, "/v2/cards/bulk-delete", {
      card_ids: [cardA.id, cardB.id],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 2);
    assert.deepEqual(res.body.ids.sort(), [cardA.id, cardB.id].sort());

    assert.notEqual(await deletedAtOf("cards", cardA.id), null);
    assert.notEqual(await deletedAtOf("cards", cardB.id), null);
    assert.notEqual(await progressDeletedAt(progress.id), null, "progress mee-gesoftdelete");
  });

  test("onbekende, andermans en al verwijderde ids worden stilzwijgend genegeerd", async () => {
    const { user, token } = await freshUser();
    const { user: other } = await freshUser();
    const deck = await createDeck(user.id);
    const otherDeck = await createDeck(other.id);
    const ownCard = await createCard(deck.id);
    const otherCard = await createCard(otherDeck.id);
    const nonexistent = "00000000-0000-0000-0000-000000000000";

    const res = await bulkDelete(token, "/v2/cards/bulk-delete", {
      card_ids: [ownCard.id, otherCard.id, nonexistent, "geen-uuid"],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);
    assert.deepEqual(res.body.ids, [ownCard.id]);

    assert.equal(await deletedAtOf("cards", otherCard.id), null, "andermans kaart onaangeroerd");
  });

  test("idempotent: tweede call op dezelfde ids → 200 met deleted: 0", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const card = await createCard(deck.id);

    const first = await bulkDelete(token, "/v2/cards/bulk-delete", { card_ids: [card.id] });
    assert.equal(first.status, 200);
    assert.equal(first.body.deleted, 1);

    const second = await bulkDelete(token, "/v2/cards/bulk-delete", { card_ids: [card.id] });
    assert.equal(second.status, 200);
    assert.equal(second.body.deleted, 0);
    assert.deepEqual(second.body.ids, []);
  });

  test("400 bij ontbrekende of lege card_ids of meer dan 500 ids", async () => {
    const { token } = await freshUser();
    const uuid = "00000000-0000-0000-0000-000000000000";

    assert.equal((await bulkDelete(token, "/v2/cards/bulk-delete", {})).status, 400);
    assert.equal((await bulkDelete(token, "/v2/cards/bulk-delete", { card_ids: [] })).status, 400);
    assert.equal(
      (await bulkDelete(token, "/v2/cards/bulk-delete", { card_ids: Array(501).fill(uuid) })).status,
      400
    );
  });

  test("zonder token → 401", async () => {
    const res = await request(app)
      .post("/v2/cards/bulk-delete")
      .send({ card_ids: ["00000000-0000-0000-0000-000000000000"] });
    assert.equal(res.status, 401);
  });
});

describe("POST /decks/bulk-delete", () => {
  test("soft-delete van meerdere decks + cascade op progress van alle kaarten", async () => {
    const { user, token } = await freshUser();
    const deckA = await createDeck(user.id, "A");
    const deckB = await createDeck(user.id, "B");
    const cardA = await createCard(deckA.id);
    const cardB = await createCard(deckB.id);
    const progressA = await createProgress(user.id, cardA.id);
    const progressB = await createProgress(user.id, cardB.id);

    const res = await bulkDelete(token, "/v2/decks/bulk-delete", {
      deck_ids: [deckA.id, deckB.id],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 2);
    assert.deepEqual(res.body.ids.sort(), [deckA.id, deckB.id].sort());

    assert.notEqual(await deletedAtOf("decks", deckA.id), null);
    assert.notEqual(await deletedAtOf("decks", deckB.id), null);
    assert.notEqual(await progressDeletedAt(progressA.id), null, "progress deck A mee-gesoftdelete");
    assert.notEqual(await progressDeletedAt(progressB.id), null, "progress deck B mee-gesoftdelete");
  });

  test("onbekende, andermans en al verwijderde ids worden stilzwijgend genegeerd", async () => {
    const { user, token } = await freshUser();
    const { user: other } = await freshUser();
    const ownDeck = await createDeck(user.id);
    const otherDeck = await createDeck(other.id);
    const nonexistent = "00000000-0000-0000-0000-000000000000";

    const res = await bulkDelete(token, "/v2/decks/bulk-delete", {
      deck_ids: [ownDeck.id, otherDeck.id, nonexistent, "geen-uuid"],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);
    assert.deepEqual(res.body.ids, [ownDeck.id]);

    assert.equal(await deletedAtOf("decks", otherDeck.id), null, "andermans deck onaangeroerd");
  });

  test("idempotent: tweede call op dezelfde ids → 200 met deleted: 0", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);

    const first = await bulkDelete(token, "/v2/decks/bulk-delete", { deck_ids: [deck.id] });
    assert.equal(first.status, 200);
    assert.equal(first.body.deleted, 1);

    const second = await bulkDelete(token, "/v2/decks/bulk-delete", { deck_ids: [deck.id] });
    assert.equal(second.status, 200);
    assert.equal(second.body.deleted, 0);
    assert.deepEqual(second.body.ids, []);
  });

  test("400 bij ontbrekende of lege deck_ids of meer dan 100 ids", async () => {
    const { token } = await freshUser();
    const uuid = "00000000-0000-0000-0000-000000000000";

    assert.equal((await bulkDelete(token, "/v2/decks/bulk-delete", {})).status, 400);
    assert.equal((await bulkDelete(token, "/v2/decks/bulk-delete", { deck_ids: [] })).status, 400);
    assert.equal(
      (await bulkDelete(token, "/v2/decks/bulk-delete", { deck_ids: Array(101).fill(uuid) })).status,
      400
    );
  });

  test("zonder token → 401", async () => {
    const res = await request(app)
      .post("/v2/decks/bulk-delete")
      .send({ deck_ids: ["00000000-0000-0000-0000-000000000000"] });
    assert.equal(res.status, 401);
  });
});
