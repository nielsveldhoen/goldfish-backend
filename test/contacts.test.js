// Contacten-feature: uitnodigen op e-mailadres, accepteren, afwijzen/verwijderen.
// Online-only (geen sync-delta): REST-responses + WS-events (contact_invited /
// contact_accepted / contact_rejected) per gebruiker in diens eigen perspectief.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import WebSocket from "ws";
import request from "supertest";
import "../src/config/env.js";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import { createWsServer } from "../src/ws.js";
import { tokenFor, createUser, cleanupUser, closePool } from "./helpers.js";

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

// Verbindt een user via WS en verzamelt alle inkomende events. De handshake
// registreert de socket pas ná een async revocatie-lookup; even wachten.
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

describe("Contacten-feature", () => {
  test("volledig scenario: invite → accept → delete, met WS-events per perspectief", async () => {
    const { user: A, token: tokenA } = await freshUser();
    const { user: B, token: tokenB } = await freshUser();

    const connA = await connectCollector(tokenA);
    const connB = await connectCollector(tokenB);

    // 1. A nodigt B uit op e-mailadres (hoofdletters → case-insensitief).
    const invite = await request(app)
      .post("/v2/contacts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: B.email.toUpperCase() });

    assert.equal(invite.status, 201);
    assert.equal(invite.body.status, "pending_outgoing");
    assert.equal(invite.body.user_id, B.id);
    assert.equal(invite.body.email, B.email);
    const relId = invite.body.id;
    assert.ok(relId);

    await sleep(150);

    // WS: B krijgt pending_incoming, A (eigen device) pending_outgoing.
    const bInvited = connB.events.find((e) => e.type === "contact_invited");
    const aInvited = connA.events.find((e) => e.type === "contact_invited");
    assert.ok(bInvited, "B moet contact_invited krijgen");
    assert.equal(bInvited.payload[0].status, "pending_incoming");
    assert.equal(bInvited.payload[0].user_id, A.id);
    assert.equal(bInvited.payload[0].id, relId);
    assert.ok(aInvited, "A moet contact_invited krijgen (eigen andere devices)");
    assert.equal(aInvited.payload[0].status, "pending_outgoing");

    // GET bij B toont het inkomende verzoek.
    const bList = await request(app)
      .get("/v2/contacts")
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(bList.status, 200);
    assert.equal(bList.body.length, 1);
    assert.equal(bList.body[0].status, "pending_incoming");
    assert.equal(bList.body[0].user_id, A.id);
    assert.equal(bList.body[0].email, A.email);

    // 2. B accepteert.
    connA.events.length = 0;
    connB.events.length = 0;
    const accept = await request(app)
      .post(`/v2/contacts/${relId}/accept`)
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(accept.status, 200);
    assert.equal(accept.body.status, "accepted");
    assert.equal(accept.body.user_id, A.id);

    await sleep(150);
    const aAccepted = connA.events.find((e) => e.type === "contact_accepted");
    const bAccepted = connB.events.find((e) => e.type === "contact_accepted");
    assert.ok(aAccepted, "A moet contact_accepted krijgen");
    assert.equal(aAccepted.payload[0].status, "accepted");
    assert.equal(aAccepted.payload[0].user_id, B.id);
    assert.ok(bAccepted, "B moet contact_accepted krijgen");
    assert.equal(bAccepted.payload[0].status, "accepted");
    assert.equal(bAccepted.payload[0].user_id, A.id);

    // 3. B verwijdert de relatie → hard delete, WS-event met alleen het id.
    connA.events.length = 0;
    connB.events.length = 0;
    const del = await request(app)
      .delete(`/v2/contacts/${relId}`)
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(del.status, 204);
    assert.deepEqual(del.body, {});

    await sleep(150);
    const aRejected = connA.events.find((e) => e.type === "contact_rejected");
    assert.ok(aRejected, "A moet contact_rejected krijgen");
    assert.deepEqual(aRejected.payload[0], { id: relId });

    // Hard weg aan beide kanten.
    const { rowCount } = await pool.query(`SELECT 1 FROM contacts WHERE id = $1`, [relId]);
    assert.equal(rowCount, 0);
    const aList = await request(app)
      .get("/v2/contacts")
      .set("Authorization", `Bearer ${tokenA}`);
    assert.deepEqual(aList.body, []);

    connA.socket.close();
    connB.socket.close();
  });

  test("randgevallen: onbekend e-mail 404, zichzelf 400, dubbel 409", async () => {
    const { user: A, token: tokenA } = await freshUser();
    const { user: B } = await freshUser();

    // Onbekend e-mailadres.
    const unknown = await request(app)
      .post("/v2/contacts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: "niemand@nergens.test" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "user_not_found");

    // Zichzelf.
    const self = await request(app)
      .post("/v2/contacts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: A.email });
    assert.equal(self.status, 400);
    assert.equal(self.body.error, "cannot_invite_self");

    // Ongeldig formaat.
    const badFmt = await request(app)
      .post("/v2/contacts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: "geen-email" });
    assert.equal(badFmt.status, 400);
    assert.equal(badFmt.body.error, "invalid_email");

    // Eerste uitnodiging A→B lukt.
    const first = await request(app)
      .post("/v2/contacts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: B.email });
    assert.equal(first.status, 201);

    // Tweede uitnodiging voor hetzelfde paar (zelfde richting) → 409.
    const dupe = await request(app)
      .post("/v2/contacts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: B.email });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.error, "already_exists");

    // Kruisende uitnodiging B→A (andere richting) → óók 409.
    const tokenB = tokenFor(B.id);
    const cross = await request(app)
      .post("/v2/contacts")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ email: A.email });
    assert.equal(cross.status, 409);
    assert.equal(cross.body.error, "already_exists");
  });

  test("accept: alleen de addressee mag; requester → 404, dubbel accept → 409", async () => {
    const { user: A, token: tokenA } = await freshUser();
    const { user: B, token: tokenB } = await freshUser();

    const invite = await request(app)
      .post("/v2/contacts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: B.email });
    const relId = invite.body.id;

    // A (de requester) mag niet accepteren → 404.
    const wrongAccept = await request(app)
      .post(`/v2/contacts/${relId}/accept`)
      .set("Authorization", `Bearer ${tokenA}`);
    assert.equal(wrongAccept.status, 404);

    // B accepteert → 200.
    const ok = await request(app)
      .post(`/v2/contacts/${relId}/accept`)
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(ok.status, 200);

    // Nogmaals accepteren → 409 (niet meer pending).
    const again = await request(app)
      .post(`/v2/contacts/${relId}/accept`)
      .set("Authorization", `Bearer ${tokenB}`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "not_pending");
  });

  test("delete: annuleren (uitgaand) mag door requester; vreemde → 404", async () => {
    const { user: A, token: tokenA } = await freshUser();
    const { user: B } = await freshUser();
    const { token: tokenC } = await freshUser();

    const invite = await request(app)
      .post("/v2/contacts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: B.email });
    const relId = invite.body.id;

    // Onbetrokken derde → 404.
    const outsider = await request(app)
      .delete(`/v2/contacts/${relId}`)
      .set("Authorization", `Bearer ${tokenC}`);
    assert.equal(outsider.status, 404);

    // Requester annuleert eigen uitgaande uitnodiging → 204.
    const cancel = await request(app)
      .delete(`/v2/contacts/${relId}`)
      .set("Authorization", `Bearer ${tokenA}`);
    assert.equal(cancel.status, 204);

    // Tweede delete → 404 (al weg).
    const gone = await request(app)
      .delete(`/v2/contacts/${relId}`)
      .set("Authorization", `Bearer ${tokenA}`);
    assert.equal(gone.status, 404);
  });

  test("auth: zonder token → 401", async () => {
    const res = await request(app).get("/v2/contacts");
    assert.equal(res.status, 401);
  });
});
