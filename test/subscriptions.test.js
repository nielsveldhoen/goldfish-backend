// Abonnementen + entitlements (migratie 022): GET /v2/subscriptions,
// entitlements in GET /v2/auth/me en het requireEntitlement-middleware.
// Rijen worden rechtstreeks via SQL aangemaakt — er is bewust geen
// schrijf-endpoint voor clients.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import "../src/config/env.js";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import { requireEntitlement } from "../src/middleware/entitlements.js";
import { ENTITLEMENTS } from "../src/config/products.js";
import { tokenFor, createUser, cleanupUser, closePool } from "./helpers.js";

const createdUserIds = [];
async function freshUser() {
  const user = await createUser();
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id) };
}

// interval-notatie: bijv. "-1 hour" (verleden) of "30 days" (toekomst).
async function insertSubscription(userId, productKey, { startedAt = "-1 hour", expiresAt = null, canceledAt = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, product_key, started_at, expires_at, canceled_at)
     VALUES ($1, $2,
             NOW() + $3::interval,
             CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() + $4::interval END,
             CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() + $5::interval END)
     RETURNING *`,
    [userId, productKey, startedAt, expiresAt, canceledAt]
  );
  return rows[0];
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("Abonnementen & entitlements", () => {
  test("zonder abonnementen: lege lijst en geen entitlements", async () => {
    const { token } = await freshUser();

    const res = await request(app)
      .get("/v2/subscriptions")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.subscriptions, []);
    assert.deepEqual(res.body.entitlements, []);

    const me = await request(app)
      .get("/v2/auth/me")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.entitlements, []);
  });

  test("actief abonnement geeft entitlement in /subscriptions én /auth/me", async () => {
    const { user, token } = await freshUser();
    await insertSubscription(user.id, "pro_speech", { expiresAt: "30 days" });

    const res = await request(app)
      .get("/v2/subscriptions")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.subscriptions.length, 1);
    assert.equal(res.body.subscriptions[0].product_key, "pro_speech");
    assert.equal(res.body.subscriptions[0].active, true);
    assert.deepEqual(res.body.entitlements, ["speech_recognition"]);

    const me = await request(app)
      .get("/v2/auth/me")
      .set("Authorization", `Bearer ${token}`);
    assert.deepEqual(me.body.entitlements, ["speech_recognition"]);
  });

  test("meerdere abonnementen naast elkaar stapelen hun entitlements", async () => {
    const { user, token } = await freshUser();
    await insertSubscription(user.id, "pro_speech");
    await insertSubscription(user.id, "pro_ai_check");
    await insertSubscription(user.id, "pro_exams", { expiresAt: "1 year" });

    const res = await request(app)
      .get("/v2/subscriptions")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.body.subscriptions.length, 3);
    assert.deepEqual(res.body.entitlements,
      ["ai_answer_check", "exam_planning", "speech_recognition"]);
  });

  test("verlopen of nog niet gestart telt niet mee; historie blijft zichtbaar", async () => {
    const { user, token } = await freshUser();
    await insertSubscription(user.id, "pro_exams", { startedAt: "-2 days", expiresAt: "-1 day" });
    await insertSubscription(user.id, "pro_speech", { startedAt: "1 day" });

    const res = await request(app)
      .get("/v2/subscriptions")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.body.subscriptions.length, 2);
    assert.ok(res.body.subscriptions.every((s) => s.active === false));
    assert.deepEqual(res.body.entitlements, []);
  });

  test("opgezegd maar nog niet verlopen blijft actief (app-store-semantiek)", async () => {
    const { user, token } = await freshUser();
    await insertSubscription(user.id, "pro_ai_check",
      { expiresAt: "10 days", canceledAt: "-1 hour" });

    const res = await request(app)
      .get("/v2/subscriptions")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.body.subscriptions[0].active, true);
    assert.deepEqual(res.body.entitlements, ["ai_answer_check"]);
  });

  test("onbekende product_key breekt niets en geeft geen entitlements", async () => {
    const { user, token } = await freshUser();
    await insertSubscription(user.id, "niet_bestaand_product");

    const res = await request(app)
      .get("/v2/subscriptions")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.subscriptions[0].active, true);
    assert.deepEqual(res.body.entitlements, []);
  });

  test("requireEntitlement: 403 zonder, doorlaten mét actief abonnement", async () => {
    const { user } = await freshUser();

    // Mini-app: gesimuleerde auth (req.user) + de echte poortwachter.
    const mini = express();
    mini.use((req, _res, next) => { req.user = { id: user.id }; next(); });
    mini.get("/pro", requireEntitlement(ENTITLEMENTS.SPEECH_RECOGNITION),
      (_req, res) => res.json({ ok: true }));

    const denied = await request(mini).get("/pro");
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "entitlement_required");
    assert.equal(denied.body.entitlement, "speech_recognition");

    await insertSubscription(user.id, "pro_speech");
    const allowed = await request(mini).get("/pro");
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body, { ok: true });
  });
});
