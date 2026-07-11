// Edit-rechten op gedeelde decks (EDIT_RIGHTS_PLAN.md): de deck-owner deelt
// per persoon can_edit uit (volledig kaartbeheer); deck-writes blijven
// owner-only. Dekt de permissions-route, de verruimde guards, het effectieve
// recht over meerdere bronnen (bool_or), de reset bij her-delen, de
// sync-delta, WS-events en het /shares/overview-overzicht.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import crypto from "crypto";
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

// Groep + actieve leden + catalogus-deck + share-rij rechtstreeks in de DB —
// de join/invite-flows zijn al gedekt door groups.test.js.
async function createGroupWithShare({ groupOwnerId, memberId, deckId, deckOwnerId }) {
  const code = crypto.randomBytes(4).toString("hex").toUpperCase();
  const group = (await pool.query(
    `INSERT INTO groups (owner_id, name, join_code, join_password_hash)
     VALUES ($1, 'Testgroep', $2, 'x') RETURNING *`,
    [groupOwnerId, code]
  )).rows[0];
  await pool.query(
    `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [group.id, groupOwnerId]
  );
  await pool.query(
    `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`,
    [group.id, memberId]
  );
  await pool.query(
    `INSERT INTO group_decks (group_id, deck_id, added_by) VALUES ($1, $2, $3)`,
    [group.id, deckId, deckOwnerId]
  );
  const share = (await pool.query(
    `INSERT INTO deck_shares (deck_id, owner_id, recipient_id, kind, group_id)
     VALUES ($1, $2, $3, 'group', $4) RETURNING *`,
    [deckId, deckOwnerId, memberId, group.id]
  )).rows[0];
  return { group, share };
}

// Gedeeld-en-geaccepteerd deck tussen owner en friend (contact vereist).
async function shareAndAccept(deckId, ownerToken, friendId, friendToken) {
  const share = await request(app)
    .post(`/v2/decks/${deckId}/share`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ recipient_id: friendId });
  assert.equal(share.status, 201);
  const accept = await request(app)
    .post(`/v2/decks/${deckId}/share/accept`)
    .set("Authorization", `Bearer ${friendToken}`);
  assert.equal(accept.status, 200);
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

describe("Edit-rechten op gedeelde decks", () => {
  test("permissions-route: owner-only, validatie, 404 zonder share", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    const { user: stranger, token: strangerToken } = await freshUser();
    await createContact(owner.id, friend.id);
    const deck = await createDeck(owner.id);

    // Geen share-rij → 404, ook voor de owner zelf.
    const noShare = await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: true });
    assert.equal(noShare.status, 404);

    await shareAndAccept(deck.id, ownerToken, friend.id, friendToken);

    // can_edit moet een boolean zijn.
    const badBody = await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: "ja" });
    assert.equal(badBody.status, 400);

    // Alleen de owner deelt rechten uit — recipient en buitenstaander 404.
    for (const t of [friendToken, strangerToken]) {
      const nope = await request(app)
        .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
        .set("Authorization", `Bearer ${t}`)
        .send({ can_edit: true });
      assert.equal(nope.status, 404);
    }

    const ok = await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.can_edit, true);
    assert.equal(ok.body.pending, false);
    void stranger;
  });

  test("editor: volledig kaartbeheer, geen deck-writes; intrekbaar", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    await createContact(owner.id, friend.id);
    const deck = await createDeck(owner.id, "Editbaar deck");
    const card = await createCard(deck.id);
    await shareAndAccept(deck.id, ownerToken, friend.id, friendToken);

    // Vóór de grant: alle kaart-writes geweigerd (regressie Release A).
    const preUpdate = await request(app)
      .put(`/v2/cards/${card.id}`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ question: "hack?", answer: "nee" });
    assert.equal(preUpdate.status, 404);
    const preCreate = await request(app)
      .post("/v2/cards")
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ deck_id: deck.id, question: "q?", answer: "a" });
    assert.equal(preCreate.status, 403);

    const connOwner = await connectCollector(ownerToken);
    const connFriend = await connectCollector(friendToken);

    // Grant → WS deck_access_changed bij de recipient.
    const grant = await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: true });
    assert.equal(grant.status, 200);
    await sleep(150);
    const accessEvent = connFriend.events.find((e) => e.type === "deck_access_changed");
    assert.ok(accessEvent, "recipient moet deck_access_changed krijgen");
    assert.equal(accessEvent.payload[0].deck_id, deck.id);
    assert.equal(accessEvent.payload[0].can_edit, true);

    // Deck-response draagt het echte recht: role blijft recipient.
    const deckRes = await request(app)
      .get(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(deckRes.body.role, "recipient");
    assert.equal(deckRes.body.can_edit, true);

    // Kaart bewerken → owner ziet card_updated live (broadcastDeck).
    connOwner.events.length = 0;
    const upd = await request(app)
      .put(`/v2/cards/${card.id}`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ question: "nieuw?", answer: "ja" });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.question, "nieuw?");
    await sleep(150);
    assert.ok(connOwner.events.some((e) => e.type === "card_updated"),
      "owner moet de editor-write live zien");

    // Kaart toevoegen + bulk + verwijderen: volledig kaartbeheer.
    const created = await request(app)
      .post("/v2/cards")
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ deck_id: deck.id, question: "extra?", answer: "ok" });
    assert.equal(created.status, 201);
    const bulk = await request(app)
      .post("/v2/cards/bulk")
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ deck_id: deck.id, cards: [{ question: "b1?", answer: "b1" }] });
    assert.equal(bulk.status, 201);
    const del = await request(app)
      .delete(`/v2/cards/${created.body.id}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(del.status, 200);
    const bulkDel = await request(app)
      .post("/v2/cards/bulk-delete")
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ card_ids: [bulk.body[0].id] });
    assert.equal(bulkDel.status, 200);
    assert.equal(bulkDel.body.deleted, 1);

    // Deck-writes blijven owner-only: metadata, delete, bulk-delete, delen.
    const deckPut = await request(app)
      .put(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ title: "Gekaapt" });
    assert.equal(deckPut.status, 404);
    const deckDel = await request(app)
      .delete(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(deckDel.status, 404);
    const bulkDeckDel = await request(app)
      .post("/v2/decks/bulk-delete")
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ deck_ids: [deck.id] });
    // Bulk-delete is tolerant (negeert andermans decks stilzwijgend) —
    // het deck mag hoe dan ook niet verdwijnen.
    assert.ok([200, 404].includes(bulkDeckDel.status));
    const stillThere = await request(app)
      .get(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(stillThere.status, 200);

    // Recht intrekken → kaart-writes weer dicht.
    const revokeEdit = await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: false });
    assert.equal(revokeEdit.status, 200);
    const postRevoke = await request(app)
      .put(`/v2/cards/${card.id}`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ question: "toch?", answer: "nee" });
    assert.equal(postRevoke.status, 404);

    connOwner.socket.close();
    connFriend.socket.close();
  });

  test("sync-delta levert het deck met de nieuwe can_edit na een toggle", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    await createContact(owner.id, friend.id);
    const deck = await createDeck(owner.id);
    await shareAndAccept(deck.id, ownerToken, friend.id, friendToken);

    const { rows } = await pool.query(`SELECT NOW() AS now`);
    const since = new Date(rows[0].now).toISOString();
    await sleep(20);

    await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: true });

    const delta = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(delta.status, 200);
    const deckRow = delta.body.decks.find((d) => d.id === deck.id);
    assert.ok(deckRow, "toggle moet het deck in de delta brengen");
    assert.equal(deckRow.can_edit, true);
    assert.equal(deckRow.role, "recipient");
  });

  test("pending uitnodiging: recht instelbaar, maar pas bruikbaar na accept", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    await createContact(owner.id, friend.id);
    const deck = await createDeck(owner.id);
    const card = await createCard(deck.id);

    await request(app)
      .post(`/v2/decks/${deck.id}/share`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ recipient_id: friend.id });

    const grant = await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: true });
    assert.equal(grant.status, 200);
    assert.equal(grant.body.pending, true);

    // Nog niet geaccepteerd → geen lees- of schrijftoegang.
    const write = await request(app)
      .put(`/v2/cards/${card.id}`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ question: "x?", answer: "y" });
    assert.equal(write.status, 404);

    // Na accept gaat het recht meteen in.
    await request(app)
      .post(`/v2/decks/${deck.id}/share/accept`)
      .set("Authorization", `Bearer ${friendToken}`);
    const write2 = await request(app)
      .put(`/v2/cards/${card.id}`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ question: "x?", answer: "y" });
    assert.equal(write2.status, 200);
  });

  test("publieke volgers krijgen geen edit-recht (subscribed → 404)", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: fan, token: fanToken } = await freshUser();
    const deck = await createDeck(owner.id);
    await pool.query(`UPDATE decks SET is_public = true WHERE id = $1`, [deck.id]);

    const follow = await request(app)
      .post(`/v2/decks/${deck.id}/follow`)
      .set("Authorization", `Bearer ${fanToken}`);
    assert.equal(follow.status, 201);

    const grant = await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${fan.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: true });
    assert.equal(grant.status, 404);
  });

  test("meerdere bronnen: bool_or, revoke van één bron, reset bij her-delen", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    await createContact(owner.id, friend.id);
    const deck = await createDeck(owner.id);
    const card = await createCard(deck.id);

    // Directe share + groepsshare op hetzelfde deck.
    await shareAndAccept(deck.id, ownerToken, friend.id, friendToken);
    await createGroupWithShare({
      groupOwnerId: owner.id, memberId: friend.id,
      deckId: deck.id, deckOwnerId: owner.id,
    });

    // Toggle zet béíde rijen; effectief recht = bool_or.
    await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: true });
    const { rows: shareRows } = await pool.query(
      `SELECT can_edit FROM deck_shares
       WHERE deck_id = $1 AND recipient_id = $2 AND revoked_at IS NULL`,
      [deck.id, friend.id]
    );
    assert.equal(shareRows.length, 2);
    assert.ok(shareRows.every((r) => r.can_edit === true), "toggle moet alle rijen zetten");

    // Directe share intrekken: groepsrij draagt het recht nog (bool_or).
    const revoke = await request(app)
      .delete(`/v2/decks/${deck.id}/share/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(revoke.status, 204);
    const stillEdit = await request(app)
      .put(`/v2/cards/${card.id}`)
      .set("Authorization", `Bearer ${friendToken}`)
      .send({ question: "nog steeds?", answer: "ja" });
    assert.equal(stillEdit.status, 200);

    // Her-delen na revoke: de directe rij komt terug als pending mét
    // can_edit=false (vers vertrouwen) — de groepsrij blijft onaangeroerd.
    const reshare = await request(app)
      .post(`/v2/decks/${deck.id}/share`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ recipient_id: friend.id });
    assert.equal(reshare.status, 201);
    assert.equal(reshare.body.can_edit, false);
    assert.equal(reshare.body.accepted_at, null);
  });

  test("/shares/overview: personen gededupliceerd, groepen, volgers", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    const { user: invitee } = await freshUser();
    const { token: fanToken } = await freshUser();
    await createContact(owner.id, friend.id);
    await createContact(owner.id, invitee.id);
    const deck = await createDeck(owner.id, "Overzichtsdeck");
    await pool.query(`UPDATE decks SET is_public = true WHERE id = $1`, [deck.id]);

    // friend: direct (geaccepteerd) + via groep, met edit-recht.
    await shareAndAccept(deck.id, ownerToken, friend.id, friendToken);
    const { group } = await createGroupWithShare({
      groupOwnerId: owner.id, memberId: friend.id,
      deckId: deck.id, deckOwnerId: owner.id,
    });
    await request(app)
      .put(`/v2/decks/${deck.id}/permissions/${friend.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_edit: true });

    // invitee: pending directe uitnodiging; fan: publieke volger.
    await request(app)
      .post(`/v2/decks/${deck.id}/share`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ recipient_id: invitee.id });
    await request(app)
      .post(`/v2/decks/${deck.id}/follow`)
      .set("Authorization", `Bearer ${fanToken}`);

    const overview = await request(app)
      .get("/v2/shares/overview")
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(overview.status, 200);
    const entry = overview.body.find((d) => d.deck_id === deck.id);
    assert.ok(entry, "gedeeld deck moet in het overzicht staan");
    assert.equal(entry.deck_title, "Overzichtsdeck");
    assert.equal(entry.is_public, true);
    assert.equal(entry.follower_count, 1);

    // friend: één regel ondanks twee rijen, met beide bronnen en het recht.
    const friendRow = entry.people.find((p) => p.user_id === friend.id);
    assert.ok(friendRow);
    assert.equal(friendRow.username, friend.username);
    assert.equal(friendRow.direct, true);
    assert.deepEqual(friendRow.via_groups, ["Testgroep"]);
    assert.equal(friendRow.can_edit, true);
    assert.equal(friendRow.pending, false);
    assert.equal(entry.people.filter((p) => p.user_id === friend.id).length, 1);

    const inviteeRow = entry.people.find((p) => p.user_id === invitee.id);
    assert.ok(inviteeRow);
    assert.equal(inviteeRow.pending, true);
    assert.equal(inviteeRow.can_edit, false);

    const groupRow = entry.groups.find((g) => g.group_id === group.id);
    assert.ok(groupRow, "catalogus-groep moet in het overzicht staan");
    assert.equal(groupRow.name, "Testgroep");
    assert.equal(groupRow.members_with_deck, 1);
    assert.equal(groupRow.member_count, 2);

    // Privacy: nergens e-mailadressen.
    assert.ok(!JSON.stringify(overview.body).includes("@goldfish.test"),
      "overview mag geen e-mailadressen lekken");

    // Andermans overview is leeg voor dit deck.
    const other = await request(app)
      .get("/v2/shares/overview")
      .set("Authorization", `Bearer ${friendToken}`);
    assert.ok(!other.body.some((d) => d.deck_id === deck.id));
  });
});
