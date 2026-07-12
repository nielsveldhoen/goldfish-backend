// Regressietests voor de hardening uit SECURITY_PLAN.md fase 2:
// wachtwoord-blocklist (2.5), timing-gelijke login (2.4), invite-limiter (2.6),
// WS-payloadlimiet (2.1), WS-verbindingslimiet (2.2) en WS-auth via het eerste
// bericht (2.7).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import request from "supertest";
import WebSocket from "ws";
import app from "../src/app.js";
import { createWsServer } from "../src/ws.js";
import { tokenFor, createUser, cleanupUser, closePool } from "./helpers.js";

const BUILD = { "X-Client-Build": "999999" };

describe("wachtwoord-blocklist (2.5)", () => {
  test("register weigert een veelgelekt wachtwoord", async () => {
    const res = await request(app)
      .post("/v2/auth/register")
      .set(BUILD)
      .send({ email: `blocklist-${Date.now()}@goldfish.test`, password: "password123" });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /too common/i);
  });

  test("blocklist is case-insensitief", async () => {
    const res = await request(app)
      .post("/v2/auth/register")
      .set(BUILD)
      .send({ email: `blocklist2-${Date.now()}@goldfish.test`, password: "Welkom123" });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /too common/i);
  });

  test("een gewoon wachtwoord passeert de blocklist (geen 400 op dát punt)", async () => {
    const res = await request(app)
      .post("/v2/auth/register")
      .set(BUILD)
      .send({ email: `ok-${Date.now()}@goldfish.test`, password: "correct horse battery" });

    // Registratie kan op de mailer stuiten; het gaat er hier om dat de
    // blocklist hem niet tegenhoudt.
    assert.notEqual(res.status, 400);

    // Opruimen: de user is echt aangemaakt.
    const { pool } = await import("../src/db.js");
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [
      res.request._data.email,
    ]);
    if (rows[0]) await cleanupUser(rows[0].id);
  });
});

describe("login-timing (2.4)", () => {
  test("onbekende gebruiker geeft 401 (en doet intern een argon2-verify)", async () => {
    const res = await request(app)
      .post("/v2/auth/login")
      .set(BUILD)
      .send({ identifier: "bestaat-echt-niet@goldfish.test", password: "iets-anders-1234" });

    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Invalid credentials");
  });
});

describe("invite-limiter (2.6)", () => {
  let user, token;

  before(async () => {
    user = await createUser();
    token = tokenFor(user.id);
  });

  after(async () => {
    await cleanupUser(user.id);
  });

  test("31e contact-uitnodiging binnen het venster → 429", async () => {
    let last;
    // 30 toegestaan (limiet), de 31e moet geweigerd worden. De adressen bestaan
    // niet → 404 user_not_found; precies het pad dat een enumerator zou gebruiken.
    for (let i = 0; i < 31; i++) {
      last = await request(app)
        .post("/v2/contacts")
        .set(BUILD)
        .set("Authorization", `Bearer ${token}`)
        .send({ email: `probe-${i}@goldfish.test` });
    }

    assert.equal(last.status, 429);
    assert.match(last.body.error, /too many invitations/i);
  });
});

describe("WebSocket-hardening (2.1, 2.2, 2.7)", () => {
  let user, token, server, port, wss;

  before(async () => {
    user = await createUser();
    token = tokenFor(user.id);
    server = http.createServer();
    wss = createWsServer(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(async () => {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await cleanupUser(user.id);
    await closePool();
  });

  const connect = (query = "") => new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  const opened = (socket) =>
    new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
  const closed = (socket) =>
    new Promise((resolve) => {
      socket.on("close", (code) => resolve(code));
      socket.on("error", () => {});
    });

  test("2.7 — token als eerste bericht authenticeert de verbinding", async () => {
    const socket = connect();
    await opened(socket);
    socket.send(JSON.stringify({ type: "auth", token }));

    // Blijft open: geen close binnen een halve seconde.
    const result = await Promise.race([
      closed(socket),
      new Promise((resolve) => setTimeout(() => resolve("still-open"), 500)),
    ]);

    assert.equal(result, "still-open");
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();
  });

  test("2.7 — een ongeldig token in het auth-bericht sluit met 4001", async () => {
    const socket = connect();
    await opened(socket);
    socket.send(JSON.stringify({ type: "auth", token: "geen-geldig-jwt" }));

    assert.equal(await closed(socket), 4001);
  });

  test("2.7 — query-token blijft werken (oude clients)", async () => {
    const socket = connect(`?token=${token}`);
    await opened(socket);

    const result = await Promise.race([
      closed(socket),
      new Promise((resolve) => setTimeout(() => resolve("still-open"), 500)),
    ]);

    assert.equal(result, "still-open");
    socket.close();
  });

  test("2.1 — een bericht groter dan 64 KiB sluit de socket", async () => {
    const socket = connect(`?token=${token}`);
    await opened(socket);

    socket.send("x".repeat(65 * 1024));

    // ws sluit met 1009 (message too big).
    assert.equal(await closed(socket), 1009);
  });

  test("2.2 — de 11e socket van dezelfde user sluit de oudste", async () => {
    const sockets = [];
    for (let i = 0; i < 10; i++) {
      const socket = connect(`?token=${token}`);
      await opened(socket);
      sockets.push(socket);
      // De registratie gebeurt na een async DB-lookup; even ademen zodat de
      // volgorde in `connections` de openingsvolgorde is.
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    const oldestClosed = closed(sockets[0]);

    const extra = connect(`?token=${token}`);
    await opened(extra);

    assert.equal(await oldestClosed, 4002);
    assert.equal(sockets[1].readyState, WebSocket.OPEN);
    assert.equal(extra.readyState, WebSocket.OPEN);

    for (const socket of [...sockets.slice(1), extra]) socket.close();
  });
});
