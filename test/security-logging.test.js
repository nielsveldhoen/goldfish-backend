// SECURITY_PLAN.md 4.1 (security-logging) en 4.3(f) (oversized bodies).
//
// De kern van 4.1 is niet alleen "er wordt gelogd", maar vooral: het log lekt
// zélf niets. Een securitylog vol e-mailadressen en tokens is een nieuw lek.
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import { tokenFor, expiredTokenFor, wrongSecretTokenFor, createUser, cleanupUser, closePool } from "./helpers.js";

const BUILD = { "X-Client-Build": "999999" };

// securityEvent schrijft één JSON-regel naar stderr (console.warn).
let captured = [];
const originalWarn = console.warn;

beforeEach(() => {
  captured = [];
  console.warn = (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed.tag === "security") captured.push(parsed);
    } catch {
      /* geen security-event */
    }
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

const eventsOfType = (type) => captured.filter((e) => e.event === type);

describe("security-logging (4.1)", () => {
  let user;

  before(async () => {
    user = await createUser();
  });

  after(async () => {
    await cleanupUser(user.id);
    await closePool();
  });

  test("mislukte login logt ip + reden, en NOOIT het e-mailadres of wachtwoord", async () => {
    const secret = "een-heel-geheim-wachtwoord-42";
    await request(app)
      .post("/v2/auth/login")
      .set(BUILD)
      .send({ identifier: user.email, password: secret });

    const events = eventsOfType("login_failed");
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "bad_password"); // account bestaat wél
    assert.ok(events[0].ip, "ip ontbreekt");

    // Het cruciale deel: geen PII of geheimen in de regel.
    const raw = JSON.stringify(events[0]);
    assert.ok(!raw.includes(user.email), "e-mailadres lekt in het log!");
    assert.ok(!raw.includes(secret), "wachtwoord lekt in het log!");
  });

  test("onbekend account geeft een andere reden-code (aanval herkenbaar)", async () => {
    await request(app)
      .post("/v2/auth/login")
      .set(BUILD)
      .send({ identifier: "bestaat-niet@goldfish.test", password: "x".repeat(12) });

    assert.equal(eventsOfType("login_failed")[0].reason, "unknown_account");
  });

  test("geweigerde tokens loggen de reden: verlopen vs ongeldige handtekening vs ontbrekend", async () => {
    await request(app).get("/v2/decks").set(BUILD)
      .set("Authorization", `Bearer ${expiredTokenFor(user.id)}`);
    await request(app).get("/v2/decks").set(BUILD)
      .set("Authorization", `Bearer ${wrongSecretTokenFor(user.id)}`);
    await request(app).get("/v2/decks").set(BUILD);

    const reasons = eventsOfType("token_rejected").map((e) => e.reason);
    assert.deepEqual(reasons, ["expired", "invalid_signature", "missing"]);

    // Het token zelf staat nergens in het log.
    const raw = JSON.stringify(captured);
    assert.ok(!raw.includes("Bearer"), "token lekt in het log!");
    assert.ok(!raw.includes("eyJ"), "JWT lekt in het log!");
  });

  test("een ingetrokken token (logout-all) logt reason=revoked", async () => {
    const token = tokenFor(user.id);
    await request(app).post("/v2/auth/logout-all").set(BUILD)
      .set("Authorization", `Bearer ${token}`);

    captured = [];
    const res = await request(app).get("/v2/decks").set(BUILD)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 401);
    assert.equal(eventsOfType("token_rejected")[0].reason, "revoked");
  });

  test("een rate-limit-hit wordt gelogd met limiter-naam en pad", async () => {
    // De auth-limiter (20/15min) is het snelst te raken.
    for (let i = 0; i < 21; i++) {
      await request(app).post("/v2/auth/login").set(BUILD)
        .send({ identifier: "ratelimit@goldfish.test", password: "xxxxxxxxxxxx" });
    }

    const hits = eventsOfType("rate_limit_hit");
    assert.ok(hits.length >= 1, "geen rate_limit_hit gelogd");
    assert.equal(hits[0].limiter, "auth");
    assert.equal(hits[0].path, "/v2/auth/login");
  });
});

// closePool() staat bewust alleen in de suite hierboven: de pool is gedeeld,
// en twee keer end() aanroepen laat de tweede suite falen.
describe("oversized bodies (4.3f)", () => {
  test("body boven de 1 MB → 413 met JSON, niet een HTML-stacktrace", async () => {
    const res = await request(app)
      .post("/v2/auth/login")
      .set(BUILD)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ identifier: "a@b.cd", password: "x".repeat(1024 * 1024 + 100) }));

    assert.equal(res.status, 413);
    assert.equal(res.body.error, "Payload too large");
    assert.ok(!JSON.stringify(res.body).includes("at "), "stack trace in de response!");
  });

  test("kapotte JSON → 400 met JSON, geen 500", async () => {
    const res = await request(app)
      .post("/v2/auth/login")
      .set(BUILD)
      .set("Content-Type", "application/json")
      .send('{"identifier": "a@b.cd", "password":');

    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Invalid request body");
  });
});
