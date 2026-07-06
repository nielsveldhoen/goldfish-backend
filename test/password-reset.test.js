// Wachtwoord-reset + JWT-revocatie (migratie 013).
//
// - POST /v2/auth/forgot-password: altijd dezelfde 200 (anti-enumeration);
//   bij een bekend adres komt er een gehasht token in de DB en gaat er
//   (fire-and-forget) een mail uit.
// - GET/POST /auth/reset-password (buiten /v2, browser-flow): geldig token →
//   formulier → nieuwe hash, email_verified=true, alle JWT's ingetrokken
//   (tokens_valid_after), token single-use.
// - POST /v2/auth/logout-all: bestaand token is daarna overal 401.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import argon2 from "argon2";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import { mailer } from "../src/utils/sendVerificationEmail.js";
import { createUser, cleanupUser, tokenFor, closePool } from "./helpers.js";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const createdUserIds = [];

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

async function trackUser() {
  const user = await createUser();
  createdUserIds.push(user.id);
  return user;
}

async function resetTokenCount(userId) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM password_reset_tokens WHERE user_id = $1`,
    [userId]
  );
  return rowCount;
}

// Plant een bekend reset-token direct in de DB (zoals forgot-password zou doen).
async function plantResetToken(userId, { expired = false } = {}) {
  const raw = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + (expired ? -1 : 1) * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, sha256(raw), expiresAt]
  );
  return raw;
}

describe("POST /v2/auth/forgot-password", () => {
  test("onbekend e-mailadres → generieke 200, geen token, geen mail", async (t) => {
    const mailMock = t.mock.method(mailer, "sendPasswordResetEmail", async () => {});

    const res = await request(app)
      .post("/v2/auth/forgot-password")
      .send({ email: `nobody-${crypto.randomBytes(6).toString("hex")}@goldfish.test` });

    assert.equal(res.status, 200);
    assert.match(res.body.message, /If your email exists/);
    await new Promise((r) => setImmediate(r)); // fire-and-forget mail laten afronden
    assert.equal(mailMock.mock.callCount(), 0);
  });

  test("bekend e-mailadres → zelfde generieke 200, token in DB, mail verstuurd", async (t) => {
    const mailMock = t.mock.method(mailer, "sendPasswordResetEmail", async () => {});
    const user = await trackUser();

    const res = await request(app)
      .post("/v2/auth/forgot-password")
      .send({ email: user.email });

    assert.equal(res.status, 200);
    assert.match(res.body.message, /If your email exists/);
    assert.equal(await resetTokenCount(user.id), 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(mailMock.mock.callCount(), 1);
    // Mail bevat het RUWE token; in de DB staat alleen de hash.
    const rawToken = mailMock.mock.calls[0].arguments[1];
    const { rowCount } = await pool.query(
      `SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND token = $2`,
      [user.id, sha256(rawToken)]
    );
    assert.equal(rowCount, 1);
  });

  test("nieuwe aanvraag vervangt het oude token", async (t) => {
    t.mock.method(mailer, "sendPasswordResetEmail", async () => {});
    const user = await trackUser();

    await plantResetToken(user.id);
    await request(app).post("/v2/auth/forgot-password").send({ email: user.email });

    assert.equal(await resetTokenCount(user.id), 1, "oude token hoort vervangen te zijn");
  });
});

describe("GET /auth/reset-password (browser-formulier)", () => {
  test("geldig token → 200 met formulier", async () => {
    const user = await trackUser();
    const raw = await plantResetToken(user.id);

    const res = await request(app).get(`/auth/reset-password?token=${raw}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /<form method="POST"/);
  });

  test("onbekend of verlopen token → 400 foutpagina", async () => {
    const user = await trackUser();
    const expiredRaw = await plantResetToken(user.id, { expired: true });

    for (const token of ["deadbeef", expiredRaw]) {
      const res = await request(app).get(`/auth/reset-password?token=${token}`);
      assert.equal(res.status, 400);
      assert.match(res.text, /ongeldig of verlopen/i);
    }
  });
});

describe("POST /auth/reset-password", () => {
  test("geslaagde reset: nieuw wachtwoord werkt, e-mail geverifieerd, oude JWT's ingetrokken, token single-use", async () => {
    const user = await trackUser();
    await pool.query(`UPDATE users SET email_verified = false WHERE id = $1`, [user.id]);
    const oldJwt = tokenFor(user.id);

    // Het oude token werkt vóór de reset...
    const before = await request(app)
      .get("/v2/auth/me")
      .set("Authorization", `Bearer ${oldJwt}`);
    assert.equal(before.status, 200);

    const raw = await plantResetToken(user.id);
    const res = await request(app)
      .post("/auth/reset-password")
      .type("form")
      .send({ token: raw, password: "nieuwwachtwoord1", confirm: "nieuwwachtwoord1" });
    assert.equal(res.status, 200);
    assert.match(res.text, /Wachtwoord gewijzigd/);

    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [user.id]);
    assert.ok(await argon2.verify(rows[0].password_hash, "nieuwwachtwoord1"));
    assert.equal(rows[0].email_verified, true, "reset bewijst mailbox-bezit");
    assert.equal(await resetTokenCount(user.id), 0, "token hoort single-use te zijn");

    // ...en is ná de reset ingetrokken (revocatie-watermerk)
    const after = await request(app)
      .get("/v2/auth/me")
      .set("Authorization", `Bearer ${oldJwt}`);
    assert.equal(after.status, 401);

    // Hergebruik van het reset-token faalt
    const reuse = await request(app)
      .post("/auth/reset-password")
      .type("form")
      .send({ token: raw, password: "nogeenwachtwoord1" });
    assert.equal(reuse.status, 400);
  });

  test("JSON-variant werkt en antwoordt met JSON", async () => {
    const user = await trackUser();
    const raw = await plantResetToken(user.id);

    const res = await request(app)
      .post("/auth/reset-password")
      .send({ token: raw, password: "nieuwwachtwoord1" });
    assert.equal(res.status, 200);
    assert.match(res.body.message, /Password updated/);
  });

  test("te kort wachtwoord → 400, wachtwoord ongewijzigd", async () => {
    const user = await trackUser();
    const raw = await plantResetToken(user.id);

    const res = await request(app)
      .post("/auth/reset-password")
      .send({ token: raw, password: "kort" });
    assert.equal(res.status, 400);

    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
    assert.equal(rows[0].password_hash, "x", "hash hoort onaangeroerd te zijn");
  });
});

describe("POST /v2/auth/logout-all", () => {
  test("trekt alle bestaande tokens in", async () => {
    const user = await trackUser();
    const jwt = tokenFor(user.id);

    const res = await request(app)
      .post("/v2/auth/logout-all")
      .set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 200);

    const after = await request(app)
      .get("/v2/auth/me")
      .set("Authorization", `Bearer ${jwt}`);
    assert.equal(after.status, 401);
  });
});
