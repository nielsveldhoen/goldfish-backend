// Eigenaarloze decks (ACCOUNT_DELETION_PLAN.md §5/§7): een deck-delete met
// actieve subscribers orphant het deck i.p.v. het te verwijderen — de
// subscriber houdt toegang, progress en edit-recht; de ex-eigenaar raakt het
// kwijt (incl. removed_deck_ids voor zijn offline apparaten). De sweep in
// purgeTombstones ruimt orphans zonder subscribers op.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import "../src/config/env.js";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import { purgeTombstones } from "../src/jobs/purgeTombstones.js";
import {
  tokenFor, createUser, createDeck, createCard, createProgress,
  createAcceptedShare, cleanupDeck, cleanupUser, closePool,
} from "./helpers.js";

const createdUserIds = [];
const createdDeckIds = [];

async function freshUser() {
  const user = await createUser();
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id) };
}

after(async () => {
  for (const id of createdDeckIds) await cleanupDeck(id);
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("Deck-delete met subscribers → orphan", () => {
  test("subscriber houdt deck, progress en edit-recht; ex-eigenaar raakt het kwijt", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: sub, token: subToken } = await freshUser();

    const deck = await createDeck(owner.id, "Blijft leven");
    createdDeckIds.push(deck.id);
    const card = await createCard(deck.id);
    const ownerProgress = await createProgress(owner.id, card.id);
    const subProgress = await createProgress(sub.id, card.id);
    await createAcceptedShare(deck.id, owner.id, sub.id, { canEdit: true });

    const since = new Date(Date.now() - 60_000).toISOString();

    const del = await request(app)
      .delete(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.orphaned, true);
    assert.equal(del.body.subscribers, 1);

    // Deck bestaat nog, eigenaarloos, niet publiek, geen tombstone.
    const deckRow = await pool.query(`SELECT * FROM decks WHERE id = $1`, [deck.id]);
    assert.equal(deckRow.rowCount, 1);
    assert.equal(deckRow.rows[0].user_id, null);
    assert.equal(deckRow.rows[0].is_public, false);
    assert.equal(deckRow.rows[0].deleted_at, null);

    // Subscriber: leestoegang met role recipient, owner_username null,
    // edit-recht intact.
    const subView = await request(app)
      .get(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${subToken}`);
    assert.equal(subView.status, 200);
    assert.equal(subView.body.role, "recipient");
    assert.equal(subView.body.owner_username, null);
    assert.equal(subView.body.can_edit, true);

    // Editor kan nog kaarten schrijven.
    const newCard = await request(app)
      .post(`/v2/cards`)
      .set("Authorization", `Bearer ${subToken}`)
      .send({ deck_id: deck.id, question: "nog?", answer: "ja" });
    assert.equal(newCard.status, 201);

    // Progress: subscriber intact, ex-eigenaar soft-deleted.
    const progRows = await pool.query(
      `SELECT user_id, deleted_at FROM user_card_progress WHERE id = ANY($1::uuid[])`,
      [[ownerProgress.id, subProgress.id]]
    );
    const byUser = Object.fromEntries(progRows.rows.map((r) => [r.user_id, r.deleted_at]));
    assert.equal(byUser[sub.id], null, "subscriber-progress blijft leven");
    assert.notEqual(byUser[owner.id], null, "eigenaar-progress is soft-deleted");

    // Ex-eigenaar: deck weg uit zijn lijst én in removed_deck_ids voor zijn
    // (offline) apparaten; subscriber krijgt juist géén removal maar het deck.
    const ownerList = await request(app)
      .get(`/v2/decks`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.ok(!ownerList.body.some((d) => d.id === deck.id));

    const ownerSync = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.ok(ownerSync.body.removed_deck_ids.includes(deck.id));
    assert.ok(!ownerSync.body.decks.some((d) => d.id === deck.id));

    const subSync = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${subToken}`);
    assert.deepEqual(subSync.body.removed_deck_ids, []);
    const syncedDeck = subSync.body.decks.find((d) => d.id === deck.id);
    assert.ok(syncedDeck, "orphan komt met de sync-delta van de subscriber mee");
    assert.equal(syncedDeck.owner_username, null);
  });

  test("zonder subscribers blijft het gewone soft-delete-pad gelden", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: invitee } = await freshUser();

    const deck = await createDeck(owner.id, "Gaat gewoon weg");
    // Alleen een pending invite — telt niet als subscriber. accepted_at
    // expliciet NULL: de kolom heeft DEFAULT now() (migratie 018), net als
    // de share-route dat expliciet doet.
    await pool.query(
      `INSERT INTO deck_shares (deck_id, owner_id, recipient_id, kind, accepted_at)
       VALUES ($1, $2, $3, 'invited', NULL)`,
      [deck.id, owner.id, invitee.id]
    );

    const del = await request(app)
      .delete(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.orphaned, false);

    const deckRow = await pool.query(`SELECT * FROM decks WHERE id = $1`, [deck.id]);
    assert.equal(deckRow.rows[0].user_id, owner.id, "tombstone houdt zijn eigenaar");
    assert.notEqual(deckRow.rows[0].deleted_at, null);
  });

  test("bulk-delete splitst per deck in orphan en tombstone", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: sub } = await freshUser();

    const kept = await createDeck(owner.id, "Met volger");
    createdDeckIds.push(kept.id);
    const gone = await createDeck(owner.id, "Zonder volger");
    await createAcceptedShare(kept.id, owner.id, sub.id);

    const res = await request(app)
      .post(`/v2/decks/bulk-delete`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ deck_ids: [kept.id, gone.id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 2);
    assert.deepEqual([...res.body.ids].sort(), [kept.id, gone.id].sort());
    assert.deepEqual(res.body.orphaned_ids, [kept.id]);

    const rows = await pool.query(
      `SELECT id, user_id, deleted_at FROM decks WHERE id = ANY($1::uuid[])`,
      [[kept.id, gone.id]]
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    assert.equal(byId[kept.id].user_id, null);
    assert.equal(byId[kept.id].deleted_at, null);
    assert.notEqual(byId[gone.id].deleted_at, null);
  });
});

describe("Sweep van orphans zonder subscribers (purgeTombstones)", () => {
  test("tombstonet een orphan zonder actieve share, laat één mét staan", async () => {
    const { user: owner } = await freshUser();
    const { user: sub } = await freshUser();

    const abandoned = await createDeck(owner.id, "Verlaten orphan");
    createdDeckIds.push(abandoned.id);
    const alive = await createDeck(owner.id, "Levende orphan");
    createdDeckIds.push(alive.id);

    await createAcceptedShare(alive.id, owner.id, sub.id);
    // Orphan-toestand nabootsen; bij `abandoned` is de laatste volger al
    // ontvolgd (gerevokete rij — telt niet als subscriber).
    await pool.query(
      `UPDATE decks SET user_id = NULL, is_public = false WHERE id = ANY($1::uuid[])`,
      [[abandoned.id, alive.id]]
    );
    await pool.query(
      `INSERT INTO deck_shares (deck_id, owner_id, recipient_id, kind, accepted_at, revoked_at)
       VALUES ($1, NULL, $2, 'invited', NOW(), NOW())`,
      [abandoned.id, sub.id]
    );

    await purgeTombstones();

    const rows = await pool.query(
      `SELECT id, deleted_at FROM decks WHERE id = ANY($1::uuid[])`,
      [[abandoned.id, alive.id]]
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.deleted_at]));
    assert.notEqual(byId[abandoned.id], null, "orphan zonder subscribers is getombstoned");
    assert.equal(byId[alive.id], null, "orphan mét subscriber blijft leven");

    // De verse tombstone (en zijn share-rijen) blijven binnen de retentie
    // staan — een tweede run mag hem dus niet hard verwijderen.
    await purgeTombstones();
    const still = await pool.query(`SELECT 1 FROM decks WHERE id = $1`, [abandoned.id]);
    assert.equal(still.rowCount, 1);
  });
});
