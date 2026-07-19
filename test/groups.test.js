// Groepen (Release B): aanmaken, joinen met code+wachtwoord, invites via
// contacten, catalogus (decks toevoegen/toevoegen-aan-dashboard), kick/leave
// met share-revoke, privacy (geen e-mailadressen in group-responses).
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

// Groepsbeheer is pro (GROUP_MANAGEMENT, EXAM_PLAN.md §4): testusers krijgen
// standaard een actief pro-abonnement zodat de bestaande flows blijven werken;
// de gating-tests onderaan vragen expliciet { pro: false }.
async function grantPro(userId) {
  await pool.query(
    `INSERT INTO subscriptions (user_id, product_key) VALUES ($1, 'pro')`,
    [userId]
  );
}

async function expirePro(userId) {
  await pool.query(
    `UPDATE subscriptions
     SET started_at = NOW() - interval '2 days', expires_at = NOW() - interval '1 day'
     WHERE user_id = $1`,
    [userId]
  );
}

async function freshUser({ pro = true } = {}) {
  const user = await createUser();
  createdUserIds.push(user.id);
  if (pro) await grantPro(user.id);
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

// Controleert dat een group-object nergens e-mailadressen lekt.
function assertNoEmails(groupObject) {
  for (const member of groupObject.members) {
    assert.equal(member.email, undefined, "member mag geen email-veld hebben");
  }
  for (const deck of groupObject.decks) {
    assert.equal(deck.email, undefined);
  }
}

describe("Groepen", () => {
  test("aanmaken, joinen (code+wachtwoord), catalogus, dashboard-add", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: member, token: memberToken } = await freshUser();

    // Aanmaken: te kort wachtwoord → 400.
    const short = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Studieclub", password: "kort" });
    assert.equal(short.status, 400);

    const create = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Studieclub", password: "geheim-wachtwoord" });
    assert.equal(create.status, 201);
    const group = create.body;
    assert.ok(group.join_code, "join_code in de response");
    assert.equal(group.join_password_hash, undefined, "hash lekt nooit");
    assert.equal(group.members.length, 1);
    assert.equal(group.members[0].role, "owner");
    assertNoEmails(group);

    // Joinen met fout wachtwoord → 404 (geen onderscheid met onbekende code).
    const wrongPw = await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ code: group.join_code, password: "fout-wachtwoord" });
    assert.equal(wrongPw.status, 404);

    const join = await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ code: group.join_code, password: "geheim-wachtwoord" });
    assert.equal(join.status, 201);
    assert.equal(join.body.members.length, 2);

    const again = await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ code: group.join_code, password: "geheim-wachtwoord" });
    assert.equal(again.status, 409);

    // Lid voegt eigen deck aan de catalogus toe.
    const memberDeck = await createDeck(member.id, "Deck van lid");
    await createCard(memberDeck.id);
    const addToCatalog = await request(app)
      .post(`/v2/groups/${group.id}/decks`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ deck_id: memberDeck.id });
    assert.equal(addToCatalog.status, 201);
    assert.equal(addToCatalog.body.decks.length, 1);
    assert.equal(addToCatalog.body.decks[0].deck_id, memberDeck.id);

    // Andermans deck toevoegen kan niet (alleen eigen decks).
    const ownerDeck = await createDeck(owner.id, "Deck van owner");
    const notMine = await request(app)
      .post(`/v2/groups/${group.id}/decks`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ deck_id: ownerDeck.id });
    assert.equal(notMine.status, 404);

    // Owner voegt catalogus-deck (van het lid) aan zijn dashboard toe.
    const add = await request(app)
      .post(`/v2/groups/${group.id}/decks/${memberDeck.id}/add`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(add.status, 201);
    assert.equal(add.body.kind, "group");
    assert.equal(add.body.group_id, group.id);

    const ownerDecks = await request(app)
      .get("/v2/decks")
      .set("Authorization", `Bearer ${ownerToken}`);
    const sharedIn = ownerDecks.body.find((d) => d.id === memberDeck.id);
    assert.ok(sharedIn, "catalogus-deck staat op het dashboard");
    assert.equal(sharedIn.role, "recipient");
    assert.equal(sharedIn.can_edit, false);

    // Eigen deck uit de catalogus aan je dashboard "toevoegen" is zinloos.
    const ownAdd = await request(app)
      .post(`/v2/groups/${group.id}/decks/${memberDeck.id}/add`)
      .set("Authorization", `Bearer ${memberToken}`);
    assert.equal(ownAdd.status, 400);
    assert.equal(ownAdd.body.error, "own_deck");

    // can_add_decks uitzetten blokkeert nieuwe catalogus-toevoegingen.
    const perm = await request(app)
      .put(`/v2/groups/${group.id}/members/${member.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_add_decks: false });
    assert.equal(perm.status, 200);

    const memberDeck2 = await createDeck(member.id, "Tweede deck");
    const blocked = await request(app)
      .post(`/v2/groups/${group.id}/decks`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ deck_id: memberDeck2.id });
    assert.equal(blocked.status, 403);

    // Niet-lid ziet de groep niet.
    const { token: strangerToken } = await freshUser();
    const strangerList = await request(app)
      .get("/v2/groups")
      .set("Authorization", `Bearer ${strangerToken}`);
    assert.ok(!strangerList.body.some((g) => g.id === group.id));
  });

  test("invites via contacten: alleen contacten, accept/decline, WS", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();
    const { user: stranger } = await freshUser();
    await createContact(owner.id, friend.id);

    const create = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Inviteclub", password: "geheim-wachtwoord" });
    const group = create.body;

    // Niet-contact uitnodigen → 403.
    const noContact = await request(app)
      .post(`/v2/groups/${group.id}/invites`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ user_id: stranger.id });
    assert.equal(noContact.status, 403);

    const connFriend = await connectCollector(friendToken);

    const invite = await request(app)
      .post(`/v2/groups/${group.id}/invites`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ user_id: friend.id });
    assert.equal(invite.status, 201);

    await sleep(200);
    const inviteEvent = connFriend.events.find((e) => e.type === "group_invite_received");
    assert.ok(inviteEvent, "invitee moet group_invite_received krijgen");
    assert.equal(inviteEvent.payload[0].id, group.id);
    assertNoEmails(inviteEvent.payload[0]);

    // Invite zichtbaar in GET /groups van de invitee (status invited).
    const friendGroups = await request(app)
      .get("/v2/groups")
      .set("Authorization", `Bearer ${friendToken}`);
    const invitedGroup = friendGroups.body.find((g) => g.id === group.id);
    assert.ok(invitedGroup);
    const myMember = invitedGroup.members.find((m) => m.user_id === friend.id);
    assert.equal(myMember.status, "invited");

    // Accepteren → actief lid.
    const accept = await request(app)
      .post(`/v2/groups/${group.id}/invites/accept`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(accept.status, 200);
    const accepted = accept.body.members.find((m) => m.user_id === friend.id);
    assert.equal(accepted.status, "active");

    // Nogmaals accepteren → 404 (niets pending meer).
    const reAccept = await request(app)
      .post(`/v2/groups/${group.id}/invites/accept`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(reAccept.status, 404);

    connFriend.socket.close();
  });

  test("kick revoket shares + decks van vertrekkend lid gaan mee de groep uit", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: memberA, token: tokenA } = await freshUser();
    const { user: memberB, token: tokenB } = await freshUser();

    const create = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Kickclub", password: "geheim-wachtwoord" });
    const group = create.body;

    for (const token of [tokenA, tokenB]) {
      await request(app)
        .post("/v2/groups/join")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: group.join_code, password: "geheim-wachtwoord" });
    }

    // A zet een deck in de catalogus; B voegt het toe aan zijn dashboard.
    const deckA = await createDeck(memberA.id, "Deck van A");
    const cardA = await createCard(deckA.id);
    await request(app)
      .post(`/v2/groups/${group.id}/decks`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ deck_id: deckA.id });
    await request(app)
      .post(`/v2/groups/${group.id}/decks/${deckA.id}/add`)
      .set("Authorization", `Bearer ${tokenB}`);
    await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ card_id: cardA.id, remote_score: 1, due_date: "2026-08-01", repetitions: "x" });

    const connA = await connectCollector(tokenA);
    const connB = await connectCollector(tokenB);
    const since = new Date(Date.now() - 60_000).toISOString();

    // Owner kickt A → A's deck verdwijnt uit de catalogus én bij B.
    const kick = await request(app)
      .delete(`/v2/groups/${group.id}/members/${memberA.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(kick.status, 204);

    await sleep(250);
    assert.ok(connA.events.find((e) => e.type === "group_removed"),
      "gekickt lid moet group_removed krijgen");
    const bRemoved = connB.events.find((e) => e.type === "deck_removed");
    assert.ok(bRemoved, "B moet deck_removed krijgen voor het deck van A");
    assert.equal(bRemoved.payload[0].id, deckA.id);

    const bSync = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${tokenB}`);
    assert.deepEqual(bSync.body.removed_deck_ids, [deckA.id]);

    const bProgress = await pool.query(
      `SELECT deleted_at FROM user_card_progress WHERE user_id = $1 AND card_id = $2`,
      [memberB.id, cardA.id]
    );
    assert.ok(bProgress.rows[0].deleted_at, "B's progress op A's deck is soft-deleted");

    // De groep bestaat nog voor B; A is eruit.
    const bGroups = await request(app)
      .get("/v2/groups")
      .set("Authorization", `Bearer ${tokenB}`);
    const g = bGroups.body.find((x) => x.id === group.id);
    assert.ok(g);
    assert.ok(!g.members.some((m) => m.user_id === memberA.id));
    assert.equal(g.decks.length, 0, "catalogus is leeg na vertrek van A");

    // Owner kan zichzelf niet kicken/verlaten.
    const ownerLeave = await request(app)
      .delete(`/v2/groups/${group.id}/members/${owner.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(ownerLeave.status, 400);

    connA.socket.close();
    connB.socket.close();
  });

  test("groep verwijderen: shares gerevoket, leden krijgen group_removed", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: member, token: memberToken } = await freshUser();

    const create = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Ophefclub", password: "geheim-wachtwoord" });
    const group = create.body;

    await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ code: group.join_code, password: "geheim-wachtwoord" });

    // Owner-deck in catalogus, lid voegt toe aan dashboard.
    const deck = await createDeck(owner.id, "Groepsdeck");
    await createCard(deck.id);
    await request(app)
      .post(`/v2/groups/${group.id}/decks`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ deck_id: deck.id });
    await request(app)
      .post(`/v2/groups/${group.id}/decks/${deck.id}/add`)
      .set("Authorization", `Bearer ${memberToken}`);

    const connMember = await connectCollector(memberToken);
    const since = new Date(Date.now() - 60_000).toISOString();

    // Niet-owner mag niet opheffen.
    const notOwner = await request(app)
      .delete(`/v2/groups/${group.id}`)
      .set("Authorization", `Bearer ${memberToken}`);
    assert.equal(notOwner.status, 404);

    const del = await request(app)
      .delete(`/v2/groups/${group.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(del.status, 204);

    await sleep(250);
    assert.ok(connMember.events.find((e) => e.type === "group_removed"));
    assert.ok(connMember.events.find((e) => e.type === "deck_removed"));

    const memberSync = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${memberToken}`);
    assert.deepEqual(memberSync.body.removed_deck_ids, [deck.id]);

    const groups = await request(app)
      .get("/v2/groups")
      .set("Authorization", `Bearer ${memberToken}`);
    assert.ok(!groups.body.some((g) => g.id === group.id));

    connMember.socket.close();
  });

  test("wachtwoord wijzigen: oud wachtwoord werkt niet meer, nieuw wel", async () => {
    const { token: ownerToken } = await freshUser();
    const { token: joinerToken } = await freshUser();

    const create = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "PW-club", password: "oud-wachtwoord" });
    const group = create.body;

    const change = await request(app)
      .put(`/v2/groups/${group.id}/password`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ password: "nieuw-wachtwoord" });
    assert.equal(change.status, 200);

    const oldPw = await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${joinerToken}`)
      .send({ code: group.join_code, password: "oud-wachtwoord" });
    assert.equal(oldPw.status, 404);

    const newPw = await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${joinerToken}`)
      .send({ code: group.join_code, password: "nieuw-wachtwoord" });
    assert.equal(newPw.status, 201);
  });
});

// Pro-gating (EXAM_PLAN.md §4): aanmaken/wijzigen vereist GROUP_MANAGEMENT;
// joinen, opruimen en modereren blijven vrij — ook met een verlopen abo.
describe("Groepen: pro-gating (GROUP_MANAGEMENT)", () => {
  test("zonder pro: groep aanmaken 403; joinen en vertrekken vrij", async () => {
    const { token: ownerToken } = await freshUser();
    const { user: freeUser, token: freeToken } = await freshUser({ pro: false });

    const denied = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${freeToken}`)
      .send({ name: "Gratis club", password: "wachtwoord123" });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "entitlement_required");
    assert.equal(denied.body.entitlement, "group_management");

    const create = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Club", password: "wachtwoord123" });
    assert.equal(create.status, 201);
    const group = create.body;

    const join = await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${freeToken}`)
      .send({ code: group.join_code, password: "wachtwoord123" });
    assert.equal(join.status, 201, "joinen moet zonder pro kunnen");

    // Deck aan de catalogus toevoegen is wél gegate voor het gratis lid.
    const deck = await createDeck(freeUser.id, "Gratis deck");
    const addDeck = await request(app)
      .post(`/v2/groups/${group.id}/decks`)
      .set("Authorization", `Bearer ${freeToken}`)
      .send({ deck_id: deck.id });
    assert.equal(addDeck.status, 403);
    assert.equal(addDeck.body.code, "entitlement_required");

    const leave = await request(app)
      .delete(`/v2/groups/${group.id}/members/${freeUser.id}`)
      .set("Authorization", `Bearer ${freeToken}`);
    assert.equal(leave.status, 204, "zelf vertrekken moet zonder pro kunnen");
  });

  test("owner met verlopen pro: modereren en opheffen vrij, wijzigen 403", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: joiner, token: joinerToken } = await freshUser({ pro: false });

    const create = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Verloopclub", password: "wachtwoord123", require_approval: true });
    const group = create.body;

    await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${joinerToken}`)
      .send({ code: group.join_code, password: "wachtwoord123" });

    await expirePro(owner.id);

    // Beheer is dicht…
    const edit = await request(app)
      .put(`/v2/groups/${group.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Nieuwe naam" });
    assert.equal(edit.status, 403);
    assert.equal(edit.body.code, "entitlement_required");

    // …maar de join-flow en moderatie blijven werken.
    const approve = await request(app)
      .post(`/v2/groups/${group.id}/members/${joiner.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(approve.status, 200, "approve moet zonder pro kunnen");

    const kick = await request(app)
      .delete(`/v2/groups/${group.id}/members/${joiner.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(kick.status, 204, "kick moet zonder pro kunnen");

    const destroy = await request(app)
      .delete(`/v2/groups/${group.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(destroy.status, 204, "opheffen moet zonder pro kunnen");
  });

  test("catalogus-carve-out: eigen deck terugtrekken vrij, andermans deck vereist pro", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: member, token: memberToken } = await freshUser();

    const create = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Carve-out", password: "wachtwoord123" });
    const group = create.body;

    await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ code: group.join_code, password: "wachtwoord123" });

    // Lid (nog mét pro) zet zijn deck in de catalogus.
    const deck = await createDeck(member.id, "Lid-deck");
    const add = await request(app)
      .post(`/v2/groups/${group.id}/decks`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ deck_id: deck.id });
    assert.equal(add.status, 201);

    // Owner zonder pro mag andermans deck niet uit de catalogus halen.
    await expirePro(owner.id);
    const ownerPull = await request(app)
      .delete(`/v2/groups/${group.id}/decks/${deck.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(ownerPull.status, 403);
    assert.equal(ownerPull.body.code, "entitlement_required");

    // Het lid zelf mag zijn eigen deck ook zonder pro terugtrekken.
    await expirePro(member.id);
    const memberPull = await request(app)
      .delete(`/v2/groups/${group.id}/decks/${deck.id}`)
      .set("Authorization", `Bearer ${memberToken}`);
    assert.equal(memberPull.status, 204);
  });
});
