// Fase 4 (HOURLY_SRS_V4_PLAN.md): een deck dat in een examen komt laat de
// kaarten van dat deck direct vervallen, voor iedereen die het examen aangaat.
// Eruit halen doet de server níets — dat is de client-herberekening
// (ExamScheduling), want de server interpreteert het repetitielog niet.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import request from "supertest";
import "../src/config/env.js";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import {
  tokenFor, createUser, createDeck, createCard, cleanupUser, closePool,
} from "./helpers.js";

const createdUserIds = [];

async function freshUser() {
  const user = await createUser();
  createdUserIds.push(user.id);
  await pool.query(
    `INSERT INTO subscriptions (user_id, product_key) VALUES ($1, 'pro')`,
    [user.id]
  );
  return { user, token: tokenFor(user.id) };
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

const future = (days) => new Date(Date.now() + days * 864e5).toISOString();
const past = (days) => new Date(Date.now() - days * 864e5).toISOString();

/// Kaart met voortgang die ver in de toekomst staat.
async function cardWithProgress(userId, deckId, { dueInDays = 90 } = {}) {
  const card = await createCard(deckId);
  await pool.query(
    `INSERT INTO user_card_progress
       (user_id, card_id, remote_score, stable_score, recent_score,
        due_date, repetitions, is_core, longest_in_streak_hours)
     VALUES ($1, $2, 80, 70, 75, $3, '[3]2026*09#01&09A', false, 768)`,
    [userId, card.id, future(dueInDays)]
  );
  return card;
}

async function dueOf(userId, cardId) {
  const r = await pool.query(
    `SELECT due_date FROM user_card_progress WHERE user_id = $1 AND card_id = $2`,
    [userId, cardId]
  );
  return r.rows[0]?.due_date ?? null;
}

const isDue = (d) => d !== null && d.getTime() <= Date.now() + 1000;

describe("Examen: kaarten laten vervallen (fase 4)", () => {
  test("POST met deck_ids laat de kaarten van die decks vervallen", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "Examendeck");
    const other = await createDeck(user.id, "Rustig deck");
    const card = await cardWithProgress(user.id, deck.id);
    const untouched = await cardWithProgress(user.id, other.id);

    const res = await request(app).post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Tentamen", exam_date: future(30), deck_ids: [deck.id] });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    assert.ok(isDue(await dueOf(user.id, card.id)), "kaart in het examen is due");
    assert.ok(!isDue(await dueOf(user.id, untouched.id)),
      "kaart buiten het examen blijft staan");
  });

  test("PUT die een deck toevoegt laat alleen dát deck vervallen", async () => {
    const { user, token } = await freshUser();
    const deckA = await createDeck(user.id, "A");
    const deckB = await createDeck(user.id, "B");
    const cardA = await cardWithProgress(user.id, deckA.id);
    const cardB = await cardWithProgress(user.id, deckB.id);

    const created = await request(app).post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "T", exam_date: future(30), deck_ids: [deckA.id] });
    assert.equal(created.status, 201);
    assert.ok(isDue(await dueOf(user.id, cardA.id)));

    // A terugzetten op een verre datum; een PUT die B toevoegt mag A niet
    // opnieuw aanraken (A was al gekoppeld).
    const farA = future(90);
    await pool.query(
      `UPDATE user_card_progress SET due_date = $1 WHERE user_id = $2 AND card_id = $3`,
      [farA, user.id, cardA.id]
    );

    const put = await request(app).put(`/v2/exams/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ deck_ids: [deckA.id, deckB.id] });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    assert.ok(isDue(await dueOf(user.id, cardB.id)), "nieuw deck vervalt");
    assert.ok(!isDue(await dueOf(user.id, cardA.id)),
      "al gekoppeld deck wordt niet opnieuw verzet");
  });

  test("deck eruit halen verandert de voortgang niet (client herberekent)", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "A");
    const card = await cardWithProgress(user.id, deck.id);

    const created = await request(app).post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "T", exam_date: future(30), deck_ids: [deck.id] });
    assert.equal(created.status, 201);

    const far = future(60);
    await pool.query(
      `UPDATE user_card_progress SET due_date = $1 WHERE user_id = $2 AND card_id = $3`,
      [far, user.id, card.id]
    );
    const before = await dueOf(user.id, card.id);

    const put = await request(app).put(`/v2/exams/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ deck_ids: [] });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.deck_ids, []);
    assert.deepEqual(await dueOf(user.id, card.id), before,
      "server laat de due-datum met rust");
  });

  test("een verschoven examendatum laat alle gekoppelde decks opnieuw vervallen",
    async () => {
      const { user, token } = await freshUser();
      const deck = await createDeck(user.id, "A");
      const card = await cardWithProgress(user.id, deck.id);

      const created = await request(app).post("/v2/exams")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "T", exam_date: future(30), deck_ids: [deck.id] });
      assert.equal(created.status, 201);

      const far = future(90);
      await pool.query(
        `UPDATE user_card_progress SET due_date = $1 WHERE user_id = $2 AND card_id = $3`,
        [far, user.id, card.id]
      );

      const put = await request(app).put(`/v2/exams/${created.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ exam_date: future(10) });
      assert.equal(put.status, 200);
      assert.ok(isDue(await dueOf(user.id, card.id)),
        "nieuwe datum → planning opnieuw richten");
    });

  test("een naamswijziging raakt de planning niet", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "A");
    const card = await cardWithProgress(user.id, deck.id);

    const created = await request(app).post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "T", exam_date: future(30), deck_ids: [deck.id] });
    assert.equal(created.status, 201);
    const far = future(90);
    await pool.query(
      `UPDATE user_card_progress SET due_date = $1 WHERE user_id = $2 AND card_id = $3`,
      [far, user.id, card.id]
    );

    const put = await request(app).put(`/v2/exams/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Andere naam" });
    assert.equal(put.status, 200);
    assert.ok(!isDue(await dueOf(user.id, card.id)));
  });

  test("een examen in het verleden laat niets vervallen", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "A");
    const card = await cardWithProgress(user.id, deck.id);

    const res = await request(app).post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Geweest", exam_date: past(1), deck_ids: [deck.id] });
    assert.equal(res.status, 201);
    assert.ok(!isDue(await dueOf(user.id, card.id)));
  });

  test("kaarten die al due zijn worden niet opnieuw geschreven", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "A");
    const card = await cardWithProgress(user.id, deck.id);
    const alreadyDue = new Date(Date.now() - 3600_000).toISOString();
    await pool.query(
      `UPDATE user_card_progress SET due_date = $1, updated_at = $1
       WHERE user_id = $2 AND card_id = $3`,
      [alreadyDue, user.id, card.id]
    );
    const before = await pool.query(
      `SELECT updated_at FROM user_card_progress WHERE user_id = $1 AND card_id = $2`,
      [user.id, card.id]
    );

    const res = await request(app).post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "T", exam_date: future(30), deck_ids: [deck.id] });
    assert.equal(res.status, 201);

    const afterRow = await pool.query(
      `SELECT due_date, updated_at FROM user_card_progress
       WHERE user_id = $1 AND card_id = $2`,
      [user.id, card.id]
    );
    assert.deepEqual(afterRow.rows[0].updated_at, before.rows[0].updated_at,
      "geen ruis in de sync-delta voor een kaart die al due was");
    assert.equal(afterRow.rows[0].due_date.toISOString(), alreadyDue);
  });

  test("kaart zonder voortgangsrij blijft zonder voortgangsrij", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "A");
    const fresh = await createCard(deck.id); // nooit beantwoord

    const res = await request(app).post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "T", exam_date: future(30), deck_ids: [deck.id] });
    assert.equal(res.status, 201);

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM user_card_progress WHERE card_id = $1`,
      [fresh.id]
    );
    assert.equal(rows.rows[0].n, 0, "nieuwe kaart is al 'nieuw', geen rij nodig");
  });

  test("groepsexamen laat de kaarten van álle actieve leden vervallen", async () => {
    const owner = await freshUser();
    const member = await freshUser();
    const outsider = await freshUser();

    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    const group = await pool.query(
      `INSERT INTO groups (owner_id, name, join_code, join_password_hash)
       VALUES ($1, 'Klas', $2, 'x') RETURNING id`,
      [owner.user.id, code]
    );
    const groupId = group.rows[0].id;
    for (const [u, role] of [[owner.user.id, "owner"], [member.user.id, "member"]]) {
      await pool.query(
        `INSERT INTO group_members (group_id, user_id, role, status, can_add_decks)
         VALUES ($1, $2, $3, 'active', true)`,
        [groupId, u, role]
      );
    }
    const deck = await createDeck(owner.user.id, "Groepsdeck");
    await pool.query(
      `INSERT INTO group_decks (group_id, deck_id, added_by) VALUES ($1, $2, $3)`,
      [groupId, deck.id, owner.user.id]
    );
    const card = await createCard(deck.id);
    for (const u of [owner.user.id, member.user.id, outsider.user.id]) {
      await pool.query(
        `INSERT INTO user_card_progress
           (user_id, card_id, remote_score, stable_score, recent_score,
            due_date, repetitions, is_core)
         VALUES ($1, $2, 80, 70, 75, $3, '[3]2026*09#01&09A', false)`,
        [u, card.id, future(90)]
      );
    }

    const res = await request(app).post("/v2/exams")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ name: "Klassentoets", exam_date: future(20),
              deck_ids: [deck.id], group_id: groupId });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    assert.ok(isDue(await dueOf(owner.user.id, card.id)), "owner");
    assert.ok(isDue(await dueOf(member.user.id, card.id)), "actief lid");
    assert.ok(!isDue(await dueOf(outsider.user.id, card.id)),
      "niet-lid houdt zijn eigen planning");
  });

  test("vervallen rijen komen mee in de sync-delta", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id, "A");
    const card = await cardWithProgress(user.id, deck.id);

    const since = new Date(Date.now() + 500).toISOString();
    await new Promise((r) => setTimeout(r, 1100));

    const res = await request(app).post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "T", exam_date: future(30), deck_ids: [deck.id] });
    assert.equal(res.status, 201);

    const sync = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(since)}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(sync.status, 200);
    const ids = (sync.body.progress ?? []).map((p) => p.card_id);
    assert.ok(ids.includes(card.id),
      `vervallen kaart zit in de delta (kreeg: ${JSON.stringify(ids)})`);
  });
});
