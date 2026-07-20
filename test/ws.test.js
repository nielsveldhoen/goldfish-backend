// Punt 2 (WS) en punt 4: close code 4001 bij ongeldige/verlopen tokens,
// pong op ping-frames, en onparseerbare tekstberichten zonder disconnect.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import "../src/config/env.js";
import { pool } from "../src/db.js";

// Korte heartbeat zodat de expiry-check in de test snel draait, en een korte
// auth-timeout zodat het "geen token"-pad niet 5s hoeft te wachten; beide
// moeten gezet zijn vóór ws.js geïmporteerd wordt.
process.env.WS_HEARTBEAT_INTERVAL_MS = "200";
process.env.WS_AUTH_TIMEOUT_MS = "300";
const { createWsServer, broadcast } = await import("../src/ws.js");
const { createUser, cleanupUser, closePool } = await import("./helpers.js");

// De handshake checkt sinds migratie 013 het revocatie-watermerk in de DB,
// dus een geldige verbinding vereist een échte user (zie before()).
let USER_ID;

let server, port, wss;

before(async () => {
  USER_ID = (await createUser()).id;
  server = http.createServer();
  wss = createWsServer(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  wss.close();
  await new Promise((resolve) => server.close(resolve));
  await cleanupUser(USER_ID);
  await closePool();
});

function connect(query) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
}

function waitForClose(socket) {
  return new Promise((resolve) => {
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.on("error", () => {}); // close volgt altijd nog
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WebSocket auth en robuustheid", () => {
  // Zonder token in de URL wacht de server op een auth-bericht (SECURITY_PLAN
  // 2.7); komt dat niet binnen de auth-timeout, dan 4003 — géén 4001, want er
  // is geen token beoordeeld en de client mag (moet) gewoon reconnecten.
  test("zonder token → close 4003 na de auth-timeout", async () => {
    const { code } = await waitForClose(connect(""));
    assert.equal(code, 4003);
  });

  test("ongeldig token → close 4001", async () => {
    const { code } = await waitForClose(connect("?token=not.a.jwt"));
    assert.equal(code, 4001);
  });

  test("verlopen token → close 4001", async () => {
    const expired = jwt.sign({ userId: USER_ID }, process.env.JWT_SECRET, {
      expiresIn: "-10s",
    });
    const { code } = await waitForClose(connect(`?token=${expired}`));
    assert.equal(code, 4001);
  });

  test("geldig token: ping-frame → pong, rommelberichten → geen disconnect", async () => {
    const token = jwt.sign({ userId: USER_ID }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    const socket = connect(`?token=${token}`);
    await waitForOpen(socket);

    // Onparseerbare tekstberichten (oude clients sturen "ping") → negeren
    socket.send("ping");
    socket.send("{not json");

    // Ping-frame moet beantwoord worden met een pong-frame
    const pongReceived = new Promise((resolve) => socket.on("pong", resolve));
    socket.ping();
    await pongReceived;

    // Twee heartbeat-intervallen later moet de verbinding nog openstaan
    await sleep(500);
    assert.equal(socket.readyState, WebSocket.OPEN, "verbinding mag niet gesloten zijn");

    socket.close();
  });

  test("broadcast: payload is op de draad altijd een array", async () => {
    const token = jwt.sign({ userId: USER_ID }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    const socket = connect(`?token=${token}`);
    await waitForOpen(socket);

    // De handshake registreert de socket pas ná de async revocatie-lookup;
    // een broadcast vlak na client-side open kan daar nog vóór vallen. In
    // productie dekt de catchup-sync dat venster af; hier even wachten.
    await sleep(150);

    const received = [];
    socket.on("message", (data) => received.push(JSON.parse(data.toString())));

    broadcast(USER_ID, "card_created", { id: "a" }); // los object → gewrapt
    broadcast(USER_ID, "card_deleted", [{ id: "b" }, { id: "c" }]); // array → as-is
    broadcast(USER_ID, "deck_deleted", []); // lege array → geen bericht

    await sleep(200);

    assert.equal(received.length, 2);
    assert.deepEqual(received[0].payload, [{ id: "a" }]);
    assert.equal(received[0].type, "card_created");
    assert.deepEqual(received[1].payload, [{ id: "b" }, { id: "c" }]);
    assert.ok(received[0].server_time);

    socket.close();
  });

  test("ingetrokken token (revocatie-watermerk) → close 4001", async () => {
    const revoked = await createUser();
    try {
      const token = jwt.sign({ userId: revoked.id }, process.env.JWT_SECRET, {
        expiresIn: "1h",
      });
      // Watermerk ná de iat van het token (interval tegen zelfde-seconde-randgeval)
      await pool.query(
        `UPDATE users SET tokens_valid_after = NOW() + interval '1 second' WHERE id = $1`,
        [revoked.id]
      );
      const { code } = await waitForClose(connect(`?token=${token}`));
      assert.equal(code, 4001);
    } finally {
      await cleanupUser(revoked.id);
    }
  });

  test("token verloopt tijdens de verbinding → close 4001", async () => {
    const shortLived = jwt.sign({ userId: USER_ID }, process.env.JWT_SECRET, {
      expiresIn: "1s",
    });
    const socket = connect(`?token=${shortLived}`);
    await waitForOpen(socket);

    const { code } = await waitForClose(socket);
    assert.equal(code, 4001);
  });
});
