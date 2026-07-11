// Deck-sharing (Release A): delen met contacten, publieke bibliotheek,
// toegangsregels (recipient leest + eigen progress, geen writes), sync-delta
// (nieuw-gedeeld venster, removed_deck_ids) en WS-fan-out naar recipients.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import WebSocket from "ws";
import request from "supertest";
import "../src/config/env.js";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import { createWsServer } from "../src/ws.js";
import {
  tokenFor, createUser, createDeck, createCard, createContact,
  cleanupUser, closePool,
} from "./helpers.js";

const createdUserIds = [];
async function freshUser() {
  const user = await createUser();
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id) };
}

let server, port, wss;

before(async () => {
  server = http.createServer();
  wss = createWsServer(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  wss.close();
  await new Promise((resolve) => server.close(resolve));
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectCollector(token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const events = [];
  await new Promise((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  await sleep(150);
  return { socket, events };
}

describe("Deck-sharing", () => {
  test("delen met contact: toegang, read-only, share-state, WS", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    const { token: outsiderToken } = await freshUser();

    await createContact(owner.id, friend.id);
    const deck = await createDeck(owner.id, "Gedeeld deck");
    const card = await createCard(deck.id);

    const connFriend = await connectCollector(friendToken);

    // Delen met een niet-contact → 403.
    const outsider = await createUser();
    createdUserIds.push(outsider.id);
    const nope = await request(app)
      .post(`/v2/decks/${deck.id}/share`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ recipient_id: outsider.id });
    assert.equal(nope.status, 403);
    assert.equal(nope.body.error, "not_a_contact");

    // Happy path.
    const share = await request(app)
      .post(`/v2/decks/${deck.id}/share`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ recipient_id: friend.id });
    assert.equal(share.status, 201);
    assert.equal(share.body.kind, "invited");

    await sleep(150);
    const received = connFriend.events.find((e) => e.type === "share_received");
    assert.ok(received, "recipient moet share_received krijgen");
    assert.equal(received.payload[0].deck_id, deck.id);
    assert.equal(received.payload[0].owner_username, owner.username);

    // Recipient ziet het deck met role/can_edit/owner_username.
    const list = await request(app)
      .get("/v2/decks")
      .set("Authorization", `Bearer ${friendToken}`);
    const sharedDeck = list.body.find((d) => d.id === deck.id);
    assert.ok(sharedDeck, "gedeeld deck moet in de lijst staan");
    assert.equal(sharedDeck.role, "recipient");
    assert.equal(sharedDeck.can_edit, false);
    assert.equal(sharedDeck.owner_username, owner.username);
    assert.equal(sharedDeck.inactive, false);

    // Owner ziet zijn eigen deck als owner/can_edit.
    const ownList = await request(app)
      .get("/v2/decks")
      .set("Authorization", `Bearer ${ownerToken}`);
    const ownDeck = ownList.body.find((d) => d.id === deck.id);
    assert.equal(ownDeck.role, "owner");
    assert.equal(ownDeck.can_edit, true);

    // Recipient leest kaarten; outsider niet.
    const cards = await request(app)
      .get(`/v2/cards?deck_id=${deck.id}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(cards.status, 200);
    assert.equal(cards.body.length, 1);

    const outsiderCards = await request(app)
      .get(`/v2/cards?deck_id=${deck.id}`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    assert.equal(outsiderCards.body.length, 0);

    // Recipient schrijft en reset eigen progress.
    const progress = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ card_id: card.id, remote_score: 3, due_date: "2026-08-01", repetitions: "x" });
    assert.equal(progress.status, 200);
    assert.equal(progress.body.user_id, friend.id);

    const outsiderProgress = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${outsiderToken}`)
      .send({ card_id: card.id, remote_score: 3, due_date: "2026-08-01", repetitions: "x" });
    assert.equal(outsiderProgress.status, 403);

    const reset = await request(app)
      .delete(`/v2/review/progress/${card.id}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(reset.status, 200);

    // Writes op deck/kaarten blijven owner-only (404 voor recipient).
    const editDeck = await request(app)
      .put(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ title: "hack" });
    assert.equal(editDeck.status, 404);

    const editCard = await request(app)
      .put(`/v2/cards/${card.id}`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ question: "hack" });
    assert.equal(editCard.status, 404);

    const addCard = await request(app)
      .post("/v2/cards")
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ deck_id: deck.id, question: "q", answer: "a" });
    assert.equal(addCard.status, 403);

    // Archiefvlag van de recipient raakt de owner niet.
    const state = await request(app)
      .put(`/v2/decks/${deck.id}/share-state`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ inactive: true });
    assert.equal(state.status, 200);

    const friendView = await request(app)
      .get(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(friendView.body.inactive, true);

    const ownerView = await request(app)
      .get(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(ownerView.body.inactive, false);

    // WS: card_updated van de owner bereikt de recipient.
    connFriend.events.length = 0;
    await request(app)
      .put(`/v2/cards/${card.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ question: "nieuwe vraag?" });
    await sleep(200);
    const cardUpdated = connFriend.events.find((e) => e.type === "card_updated");
    assert.ok(cardUpdated, "recipient moet card_updated krijgen");
    assert.equal(cardUpdated.payload[0].question, "nieuwe vraag?");

    connFriend.socket.close();
  });

  test("sync: oud deck integraal bij nieuwe share; revoke → removed_deck_ids + progress-cascade", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    await createContact(owner.id, friend.id);

    const deck = await createDeck(owner.id, "Oud deck");
    const card = await createCard(deck.id);
    // Maak deck + kaart "oud": buiten elk redelijk since-venster.
    await pool.query(
      `UPDATE decks SET updated_at = NOW() - interval '10 days' WHERE id = $1`,
      [deck.id]
    );
    await pool.query(
      `UPDATE cards SET updated_at = NOW() - interval '10 days' WHERE id = $1`,
      [card.id]
    );

    const since = new Date(Date.now() - 60_000).toISOString();

    // Vóór de share: niets in de delta.
    const before = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(before.status, 200);
    assert.equal(before.body.decks.length, 0);
    assert.equal(before.body.cards.length, 0);

    await request(app)
      .post(`/v2/decks/${deck.id}/share`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ recipient_id: friend.id });

    // Na de share: deck én (oude) kaarten integraal in de delta.
    const afterShare = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(afterShare.body.decks.length, 1);
    assert.equal(afterShare.body.decks[0].id, deck.id);
    assert.equal(afterShare.body.decks[0].role, "recipient");
    assert.equal(afterShare.body.decks[0].can_edit, false);
    assert.equal(afterShare.body.cards.length, 1);
    assert.deepEqual(afterShare.body.removed_deck_ids, []);

    // Progress opbouwen, dan intrekken.
    await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ card_id: card.id, remote_score: 2, due_date: "2026-08-01", repetitions: "x" });

    const revoke = await request(app)
      .delete(`/v2/decks/${deck.id}/share/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(revoke.status, 204);

    const afterRevoke = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.deepEqual(afterRevoke.body.removed_deck_ids, [deck.id]);
    assert.equal(afterRevoke.body.decks.length, 0, "geen deck-rij meer na revoke");

    const progressRows = await pool.query(
      `SELECT deleted_at FROM user_card_progress WHERE user_id = $1 AND card_id = $2`,
      [friend.id, card.id]
    );
    assert.ok(progressRows.rows[0].deleted_at, "progress moet soft-deleted zijn na revoke");

    // Her-delen na revoke (upsert) werkt en levert het deck opnieuw.
    const reshare = await request(app)
      .post(`/v2/decks/${deck.id}/share`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ recipient_id: friend.id });
    assert.equal(reshare.status, 201);
    assert.equal(reshare.body.revoked_at, null);
  });

  test("publieke bibliotheek: discovery, follow/unfollow, routevolgorde", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { token: readerToken } = await freshUser();

    const publicDeck = await createDeck(owner.id, "Publiek spaans GF-test");
    await createCard(publicDeck.id);
    const privateDeck = await createDeck(owner.id, "Privé deck GF-test");
    await request(app)
      .put(`/v2/decks/${publicDeck.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ is_public: true });

    // Routevolgorde: /decks/public mag niet als /decks/:id matchen.
    const pub = await request(app)
      .get("/v2/decks/public?search=spaans GF-test")
      .set("Authorization", `Bearer ${readerToken}`);
    assert.equal(pub.status, 200);
    const found = pub.body.find((d) => d.id === publicDeck.id);
    assert.ok(found, "publiek deck moet vindbaar zijn");
    assert.equal(found.owner_username, owner.username);
    assert.equal(Number(found.card_count), 1);
    assert.ok(!pub.body.some((d) => d.id === privateDeck.id));

    // Eigen publieke decks niet in de eigen discovery.
    const ownPub = await request(app)
      .get("/v2/decks/public?search=spaans GF-test")
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.ok(!ownPub.body.some((d) => d.id === publicDeck.id));

    // Follow op niet-publiek deck → 404.
    const followPrivate = await request(app)
      .post(`/v2/decks/${privateDeck.id}/follow`)
      .set("Authorization", `Bearer ${readerToken}`);
    assert.equal(followPrivate.status, 404);

    // Follow + zichtbaar als recipient-deck.
    const follow = await request(app)
      .post(`/v2/decks/${publicDeck.id}/follow`)
      .set("Authorization", `Bearer ${readerToken}`);
    assert.equal(follow.status, 201);
    assert.equal(follow.body.kind, "subscribed");

    const list = await request(app)
      .get("/v2/decks")
      .set("Authorization", `Bearer ${readerToken}`);
    assert.ok(list.body.some((d) => d.id === publicDeck.id && d.role === "recipient"));

    // Unfollow → weg.
    const unfollow = await request(app)
      .delete(`/v2/decks/${publicDeck.id}/follow`)
      .set("Authorization", `Bearer ${readerToken}`);
    assert.equal(unfollow.status, 204);

    const listAfter = await request(app)
      .get("/v2/decks")
      .set("Authorization", `Bearer ${readerToken}`);
    assert.ok(!listAfter.body.some((d) => d.id === publicDeck.id));

    // GET /shares/sent toont de (subscribed) volger niet meer, en bevat
    // sowieso geen e-mailadressen.
    const sent = await request(app)
      .get("/v2/shares/sent")
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(sent.status, 200);
    assert.ok(!JSON.stringify(sent.body).includes("@"), "geen e-mail in shares/sent");
  });

  test("deck-delete van de owner levert de recipient een tombstone + WS", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    await createContact(owner.id, friend.id);

    const deck = await createDeck(owner.id, "Straks weg");
    await createCard(deck.id);
    await request(app)
      .post(`/v2/decks/${deck.id}/share`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ recipient_id: friend.id });

    const connFriend = await connectCollector(tokenFor(friend.id));
    const since = new Date(Date.now() - 60_000).toISOString();

    await request(app)
      .delete(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    await sleep(200);
    const deleted = connFriend.events.find((e) => e.type === "deck_deleted");
    assert.ok(deleted, "recipient moet deck_deleted krijgen");
    assert.equal(deleted.payload[0].id, deck.id);

    const syncRes = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${friendToken}`);
    const tombstone = syncRes.body.decks.find((d) => d.id === deck.id);
    assert.ok(tombstone, "tombstone moet in de delta zitten");
    assert.ok(tombstone.deleted_at, "tombstone heeft deleted_at");

    connFriend.socket.close();
  });
});
