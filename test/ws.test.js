// Punt 2 (WS) en punt 4: close code 4001 bij ongeldige/verlopen tokens,
// pong op ping-frames, en onparseerbare tekstberichten zonder disconnect.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import "../src/config/env.js";

// Korte heartbeat zodat de expiry-check in de test snel draait;
// moet gezet zijn vóór ws.js geïmporteerd wordt.
process.env.WS_HEARTBEAT_INTERVAL_MS = "200";
const { createWsServer } = await import("../src/ws.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";

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
  test("zonder token → close 4001", async () => {
    const { code } = await waitForClose(connect(""));
    assert.equal(code, 4001);
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
