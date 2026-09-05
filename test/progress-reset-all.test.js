// DELETE /review/progress/:card_id/all — de reset die over álle deelnemers
// loopt. Wordt gebruikt als een vraag inhoudelijk verandert: de statistieken
// van iedereen die het deck heeft slaan dan nergens meer op.
import { test, describe, before, after } from "node:test";
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
  createAcceptedShare,
  cleanupUser,
  closePool,
} from "./helpers.js";

const FAKE_UUID = "11111111-1111-4111-8111-111111111111";

let owner, ownerToken, deck, card;
let reader, readerToken;
let editor, editorToken;
let stranger, strangerToken;

before(async () => {
  owner = await createUser();
  ownerToken = tokenFor(owner.id);
  deck = await createDeck(owner.id);
  card = await createCard(deck.id);

  // Twee deelnemers met eigen voortgang op dezelfde kaart: één die alleen mag
  // lezen, één met bewerkrecht.
  reader = await createUser();
  readerToken = tokenFor(reader.id);
  await createAcceptedShare(deck.id, owner.id, reader.id);

  editor = await createUser();
  editorToken = tokenFor(editor.id);
  await createAcceptedShare(deck.id, owner.id, editor.id, { canEdit: true });

  stranger = await createUser();
  strangerToken = tokenFor(stranger.id);

  for (const u of [owner, reader, editor]) {
    await createProgress(u.id, card.id);
  }
});

after(async () => {
  for (const u of [owner, reader, editor, stranger]) {
    await cleanupUser(u.id);
  }
  await closePool();
});

async function liveProgressCount() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM user_card_progress
     WHERE card_id = $1 AND deleted_at IS NULL`,
    [card.id]
  );
  return rows[0].n;
}

describe("DELETE /review/progress/:card_id/all", () => {
  test("alleen wie mag bewerken mag resetten", async () => {
    // Onbekende kaart / geen toegang: allebei 404 — een vreemde mag niet eens
    // te weten komen dat de kaart bestaat.
    const missing = await request(app)
      .delete(`/v2/review/progress/${FAKE_UUID}/all`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(missing.status, 404);

    const outsider = await request(app)
      .delete(`/v2/review/progress/${card.id}/all`)
      .set("Authorization", `Bearer ${strangerToken}`);
    assert.equal(outsider.status, 404);

    // Wél toegang, geen bewerkrecht: 403, en niemands voortgang gaat eraan.
    const readOnly = await request(app)
      .delete(`/v2/review/progress/${card.id}/all`)
      .set("Authorization", `Bearer ${readerToken}`);
    assert.equal(readOnly.status, 403);
    assert.equal(await liveProgressCount(), 3);
  });

  test("de eigenaar reset iedereen in één keer, en het is idempotent", async () => {
    const since = new Date(Date.now() - 1000).toISOString();

    const res = await request(app)
      .delete(`/v2/review/progress/${card.id}/all`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.affected, 3, "alle drie de deelnemers");
    assert.equal(await liveProgressCount(), 0);

    // Elke deelnemer ziet zijn eigen reset terug in /sync/changes.
    for (const token of [ownerToken, readerToken, editorToken]) {
      const sync = await request(app)
        .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
        .set("Authorization", `Bearer ${token}`);
      assert.equal(sync.status, 200);
      const row = sync.body.progress.find((p) => p.card_id === card.id);
      assert.ok(row, "gereset record moet in /sync/changes zitten");
      assert.ok(row.deleted_at, "record moet deleted_at gezet hebben");
    }

    // Nog een keer: niets meer te resetten, nog steeds 200.
    const again = await request(app)
      .delete(`/v2/review/progress/${card.id}/all`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(again.status, 200);
    assert.equal(again.body.affected, 0);
  });

  test("een recipient met bewerkrecht mag het ook", async () => {
    // Weer aan de slag na de reset: het bestaande (soft-deleted) record leeft
    // op, zoals POST /review/progress het ook zou doen — een tweede INSERT kan
    // niet, de unieke sleutel (user_id, card_id) blijft bezet.
    await pool.query(
      `UPDATE user_card_progress SET deleted_at = NULL
       WHERE user_id = $1 AND card_id = $2`,
      [reader.id, card.id]
    );
    assert.equal(await liveProgressCount(), 1);

    const res = await request(app)
      .delete(`/v2/review/progress/${card.id}/all`)
      .set("Authorization", `Bearer ${editorToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.affected, 1);
    assert.equal(await liveProgressCount(), 0);
  });
});
