// Cijfer bij een examen + de regel dat een verlopen examen geen decks meer
// krijgt (besluit Niels 2026-09-16).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import "../src/config/env.js";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import {
  tokenFor, createUser, createDeck, cleanupUser, closePool,
} from "./helpers.js";

const createdUserIds = [];

async function freshUser({ pro = true } = {}) {
  const user = await createUser();
  createdUserIds.push(user.id);
  if (pro) {
    await pool.query(
      `INSERT INTO subscriptions (user_id, product_key) VALUES ($1, 'pro')`,
      [user.id]
    );
  }
  return { user, token: tokenFor(user.id) };
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

const future = (days) => new Date(Date.now() + days * 864e5).toISOString();
const past = (days) => new Date(Date.now() - days * 864e5).toISOString();

async function makeExam(token, { date, deckIds = [] } = {}) {
  const res = await request(app).post("/v2/exams")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Tentamen", exam_date: date, deck_ids: deckIds });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/// Een examen met een datum in het verleden: de POST-route staat dat toe
/// (je mag een examen dat geweest is vastleggen), dus zo bouwen we er een.
async function makePastExam(token, deckIds) {
  const exam = await makeExam(token, { date: future(1), deckIds });
  await pool.query(`UPDATE exams SET exam_date = $1 WHERE id = $2`,
    [past(1), exam.id]);
  return exam;
}

describe("Examencijfer", () => {
  test("cijfer zetten, teruglezen en weer wissen", async () => {
    const { token } = await freshUser();
    const exam = await makePastExam(token);
    assert.equal(exam.grade, null, "nieuw examen heeft geen cijfer");

    const set = await request(app).put(`/v2/exams/${exam.id}/grade`)
      .set("Authorization", `Bearer ${token}`).send({ grade: "7,5" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.grade, "7,5");

    const list = await request(app).get("/v2/exams")
      .set("Authorization", `Bearer ${token}`);
    const found = (list.body.exams ?? list.body).find((e) => e.id === exam.id);
    assert.equal(found.grade, "7,5");

    const cleared = await request(app).put(`/v2/exams/${exam.id}/grade`)
      .set("Authorization", `Bearer ${token}`).send({ grade: "" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.grade, null);
  });

  test("witruimte wordt getrimd", async () => {
    const { token } = await freshUser();
    const exam = await makePastExam(token);
    const set = await request(app).put(`/v2/exams/${exam.id}/grade`)
      .set("Authorization", `Bearer ${token}`).send({ grade: "  A  " });
    assert.equal(set.body.grade, "A");
  });

  test("een examen dat nog moet komen krijgt geen cijfer", async () => {
    const { token } = await freshUser();
    const exam = await makeExam(token, { date: future(10) });
    const set = await request(app).put(`/v2/exams/${exam.id}/grade`)
      .set("Authorization", `Bearer ${token}`).send({ grade: "8" });
    assert.equal(set.status, 400);
    assert.equal(set.body.error, "exam_not_yet_taken");
  });

  test("wissen mag wel op een toekomstig examen", async () => {
    // Stel je vult een cijfer in en schuift de datum daarna vooruit: het
    // cijfer moet dan nog weg kunnen.
    const { token } = await freshUser();
    const exam = await makePastExam(token);
    await request(app).put(`/v2/exams/${exam.id}/grade`)
      .set("Authorization", `Bearer ${token}`).send({ grade: "8" });
    await pool.query(`UPDATE exams SET exam_date = $1 WHERE id = $2`,
      [future(10), exam.id]);

    const cleared = await request(app).put(`/v2/exams/${exam.id}/grade`)
      .set("Authorization", `Bearer ${token}`).send({ grade: "" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.grade, null);
  });

  test("zonder pro kun je nog steeds een cijfer invullen", async () => {
    const pro = await freshUser();
    const exam = await makePastExam(pro.token);
    // Abonnement laten verlopen: schrijven op /exams is dan pro-geblokkeerd.
    await pool.query(
      `UPDATE subscriptions SET started_at = NOW() - interval '2 days',
                                expires_at = NOW() - interval '1 day'
       WHERE user_id = $1`, [pro.user.id]);

    const planning = await request(app).put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${pro.token}`).send({ name: "Anders" });
    assert.equal(planning.status, 403, "plannen is pro");

    const grade = await request(app).put(`/v2/exams/${exam.id}/grade`)
      .set("Authorization", `Bearer ${pro.token}`).send({ grade: "6" });
    assert.equal(grade.status, 200, "cijfer invullen is vrij");
    assert.equal(grade.body.grade, "6");
  });

  test("te lang cijfer → 400", async () => {
    const { token } = await freshUser();
    const exam = await makePastExam(token);
    const res = await request(app).put(`/v2/exams/${exam.id}/grade`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "x".repeat(17) });
    assert.equal(res.status, 400);
  });

  test("het examen van iemand anders → 404", async () => {
    const a = await freshUser();
    const b = await freshUser();
    const exam = await makePastExam(a.token);
    const res = await request(app).put(`/v2/exams/${exam.id}/grade`)
      .set("Authorization", `Bearer ${b.token}`).send({ grade: "9" });
    assert.equal(res.status, 404);
  });

  test("onbekend id → 404", async () => {
    const { token } = await freshUser();
    const res = await request(app)
      .put(`/v2/exams/00000000-0000-0000-0000-000000000000/grade`)
      .set("Authorization", `Bearer ${token}`).send({ grade: "9" });
    assert.equal(res.status, 404);
  });
});

describe("Verlopen examen krijgt geen decks meer", () => {
  test("deck toevoegen aan een verlopen examen → 400", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "A");
    const exam = await makePastExam(token);

    const res = await request(app).put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${token}`).send({ deck_ids: [deck.id] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "exam_has_passed");

    const links = await pool.query(
      `SELECT count(*)::int AS n FROM exam_decks WHERE exam_id = $1`, [exam.id]);
    assert.equal(links.rows[0].n, 0, "niets gekoppeld");
  });

  test("deck loskoppelen van een verlopen examen mag wel", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "A");
    const exam = await makePastExam(token, [deck.id]);

    const res = await request(app).put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${token}`).send({ deck_ids: [] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.deck_ids, []);
  });

  test("naam of datum wijzigen van een verlopen examen mag", async () => {
    const { token } = await freshUser();
    const exam = await makePastExam(token);
    const res = await request(app).put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${token}`).send({ name: "Herkansing" });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, "Herkansing");
  });

  test("een verlopen examen naar de toekomst schuiven maakt koppelen weer mogelijk",
    async () => {
      const { user, token } = await freshUser();
      const deck = await createDeck(user.id, "A");
      const exam = await makePastExam(token);

      const res = await request(app).put(`/v2/exams/${exam.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ exam_date: future(5), deck_ids: [deck.id] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.deck_ids, [deck.id]);
    });

  test("een toekomstig examen krijgt gewoon decks", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "A");
    const exam = await makeExam(token, { date: future(5) });
    const res = await request(app).put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${token}`).send({ deck_ids: [deck.id] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.deck_ids, [deck.id]);
  });
});
