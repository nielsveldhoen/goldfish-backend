// POST /auth/register — registratie is atomair (user + verificatietoken in
// één transactie), duplicate email → 400, en een falende verificatiemail is
// geen registratiefout: 200 met email_sent:false terwijl user + token wél in
// de DB staan (de gebruiker kan via /auth/resend-verification opnieuw mailen).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import { mailer } from "../src/utils/sendVerificationEmail.js";
import { cleanupUser, closePool } from "./helpers.js";

const createdUserIds = [];

function freshEmail() {
  return `reg-${crypto.randomBytes(6).toString("hex")}@goldfish.test`;
}

function register(body) {
  return request(app).post("/v2/auth/register").send(body);
}

async function userByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [
    email,
  ]);
  return rows[0];
}

async function tokenCountFor(userId) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM email_verification_tokens WHERE user_id = $1`,
    [userId]
  );
  return rowCount;
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("POST /auth/register", () => {
  test("succes: 200 met email_sent:true, user + verificatietoken in de DB", async (t) => {
    const sendMock = t.mock.method(mailer, "sendVerificationEmail", async () => {});

    const email = freshEmail();
    const res = await register({ email, password: "wachtwoord123" });

    assert.equal(res.status, 200);
    assert.equal(res.body.email_sent, true);

    const user = await userByEmail(email);
    assert.ok(user, "user hoort in de DB te staan");
    createdUserIds.push(user.id);
    assert.equal(user.email_verified, false);
    assert.equal(await tokenCountFor(user.id), 1);
    assert.equal(sendMock.mock.callCount(), 1);
  });

  test("duplicate registratie → 400 'Email or username already exists'", async (t) => {
    t.mock.method(mailer, "sendVerificationEmail", async () => {});

    const email = freshEmail();
    const first = await register({ email, password: "wachtwoord123" });
    assert.equal(first.status, 200);
    createdUserIds.push((await userByEmail(email)).id);

    const dup = await register({ email, password: "anderwachtwoord" });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.error, "Email or username already exists");
  });

  test("mail-fout → 200 met email_sent:false, user + token staan wél in de DB", async (t) => {
    t.mock.method(mailer, "sendVerificationEmail", async () => {
      throw new Error("resend down");
    });

    const email = freshEmail();
    const res = await register({ email, password: "wachtwoord123" });

    assert.equal(res.status, 200);
    assert.equal(res.body.email_sent, false);
    assert.match(res.body.message, /could not be sent/);

    const user = await userByEmail(email);
    assert.ok(user, "account hoort ondanks mail-fout te bestaan");
    createdUserIds.push(user.id);
    assert.equal(
      await tokenCountFor(user.id),
      1,
      "verificatietoken hoort in de DB te staan"
    );
  });
});
