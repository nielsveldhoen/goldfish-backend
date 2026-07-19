// Examens (EXAM_PLAN.md): CRUD met embedded deck_ids (set-replace),
// persoonlijk + groep, entitlement-gating (schrijven pro, lezen/DELETE vrij),
// snapshot in /sync/changes en het progress-veld longest_in_streak_hours.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import "../src/config/env.js";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import {
  tokenFor, createUser, createDeck, createCard,
  cleanupUser, closePool,
} from "./helpers.js";

const createdUserIds = [];

async function grantPro(userId) {
  await pool.query(
    `INSERT INTO subscriptions (user_id, product_key) VALUES ($1, 'pro')`,
    [userId]
  );
}

async function expirePro(userId) {
  await pool.query(
    `UPDATE subscriptions
     SET started_at = NOW() - interval '2 days', expires_at = NOW() - interval '1 day'
     WHERE user_id = $1`,
    [userId]
  );
}

async function freshUser({ pro = true } = {}) {
  const user = await createUser();
  createdUserIds.push(user.id);
  if (pro) await grantPro(user.id);
  return { user, token: tokenFor(user.id) };
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

const EXAM_DATE = "2026-09-14T07:00:00.000Z";

// `since` vlak in het verleden: recente delta, geen full_resync.
function recentSince() {
  return new Date(Date.now() - 1000).toISOString();
}

async function syncExams(token) {
  const res = await request(app)
    .get(`/v2/sync/changes?since=${encodeURIComponent(recentSince())}`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.exams), "sync-response heeft een exams-array");
  return res.body.exams;
}

describe("Examens", () => {
  test("persoonlijk examen: CRUD, set-replace en sync-snapshot", async () => {
    const { user, token } = await freshUser();
    const deck1 = await createDeck(user.id, "Anatomie 1");
    const deck2 = await createDeck(user.id, "Anatomie 2");

    const create = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Deeltoets 2", exam_date: EXAM_DATE, deck_ids: [deck1.id] });
    assert.equal(create.status, 201);
    const exam = create.body;
    assert.equal(exam.name, "Deeltoets 2");
    assert.equal(new Date(exam.exam_date).toISOString(), EXAM_DATE);
    assert.equal(exam.group_id, null);
    assert.equal(exam.owner_id, user.id);
    assert.deepEqual(exam.deck_ids, [deck1.id]);

    const list = await request(app)
      .get("/v2/exams")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    // Snapshot in de sync — óók zonder dat er iets aan decks/cards wijzigde.
    let exams = await syncExams(token);
    assert.equal(exams.length, 1);
    assert.deepEqual(exams[0].deck_ids, [deck1.id]);

    // Set-replace: beide decks, nieuwe naam.
    const update = await request(app)
      .put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Deeltoets 2 (herzien)", deck_ids: [deck1.id, deck2.id] });
    assert.equal(update.status, 200);
    assert.equal(update.body.name, "Deeltoets 2 (herzien)");
    assert.deepEqual([...update.body.deck_ids].sort(),
      [deck1.id, deck2.id].sort());
    assert.ok(new Date(update.body.updated_at) > new Date(exam.updated_at),
      "updated_at bumpt (ook nodig voor stale-writes)");

    // Stale write → 409 met current.
    const stale = await request(app)
      .put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Oud", client_updated_at: "2020-01-01T00:00:00Z" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "stale_write");
    assert.equal(stale.body.current.name, "Deeltoets 2 (herzien)");

    // Verwijderen: weg uit GET én sync.
    const del = await request(app)
      .delete(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(del.status, 200);
    const after = await request(app)
      .get("/v2/exams")
      .set("Authorization", `Bearer ${token}`);
    assert.deepEqual(after.body, []);
    exams = await syncExams(token);
    assert.deepEqual(exams, []);
  });

  test("validatie: naam/datum/deck_ids-grenzen en vreemde decks", async () => {
    const { token } = await freshUser();
    const other = await freshUser();
    const otherDeck = await createDeck(other.user.id, "Niet van mij");

    const noName = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ exam_date: EXAM_DATE });
    assert.equal(noName.status, 400);

    const badDate = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X", exam_date: "geen-datum" });
    assert.equal(badDate.status, 400);

    const badIds = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X", exam_date: EXAM_DATE, deck_ids: ["geen-uuid"] });
    assert.equal(badIds.status, 400);

    const tooMany = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "X", exam_date: EXAM_DATE,
        deck_ids: Array.from({ length: 51 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
      });
    assert.equal(tooMany.status, 400);

    // Andermans (niet-gedeeld) deck telt als ontoegankelijk.
    const foreign = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X", exam_date: EXAM_DATE, deck_ids: [otherDeck.id] });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.error, "deck_not_accessible");
  });

  test("entitlements: schrijven pro, lezen en DELETE vrij", async () => {
    const { user, token } = await freshUser();

    const create = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Voor verloop", exam_date: EXAM_DATE });
    assert.equal(create.status, 201);
    const exam = create.body;

    await expirePro(user.id);

    const denied = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Nieuw", exam_date: EXAM_DATE });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "entitlement_required");
    assert.equal(denied.body.entitlement, "exam_planning");

    const editDenied = await request(app)
      .put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Aangepast" });
    assert.equal(editDenied.status, 403);

    // Lezen (GET + sync) blijft vrij…
    const list = await request(app)
      .get("/v2/exams")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal((await syncExams(token)).length, 1);

    // …en opruimen ook: een examen jaagt de scheduling op.
    const del = await request(app)
      .delete(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(del.status, 200);
  });

  test("groepsexamen: rechtenladder, catalogusregel en toegangsverlies", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { user: member, token: memberToken } = await freshUser();
    const { token: strangerToken } = await freshUser();

    const groupRes = await request(app)
      .post("/v2/groups")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Examenclub", password: "wachtwoord123" });
    assert.equal(groupRes.status, 201);
    const group = groupRes.body;

    await request(app)
      .post("/v2/groups/join")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ code: group.join_code, password: "wachtwoord123" });

    // Owner zet een eigen deck in de catalogus; dat mag in het groepsexamen.
    const catalogDeck = await createDeck(owner.id, "Catalogusdeck");
    await request(app)
      .post(`/v2/groups/${group.id}/decks`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ deck_id: catalogDeck.id });

    // Deck buiten de catalogus → 400, ook al is het je eigen deck.
    const ownerPrivate = await createDeck(owner.id, "Privédeck");
    const outside = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Groepstoets", exam_date: EXAM_DATE,
              group_id: group.id, deck_ids: [ownerPrivate.id] });
    assert.equal(outside.status, 400);
    assert.equal(outside.body.error, "deck_not_in_group");

    const create = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Groepstoets", exam_date: EXAM_DATE,
              group_id: group.id, deck_ids: [catalogDeck.id] });
    assert.equal(create.status, 201);
    const exam = create.body;
    assert.equal(exam.group_id, group.id);

    // Elk actief lid ziet het examen (GET + sync); een buitenstaander niet.
    const memberList = await request(app)
      .get("/v2/exams")
      .set("Authorization", `Bearer ${memberToken}`);
    assert.equal(memberList.body.length, 1);
    assert.deepEqual(memberList.body[0].deck_ids, [catalogDeck.id]);
    assert.equal((await syncExams(memberToken)).length, 1);
    const strangerList = await request(app)
      .get("/v2/exams")
      .set("Authorization", `Bearer ${strangerToken}`);
    assert.deepEqual(strangerList.body, []);

    // can_add_decks-lid (default true) mag bewerken…
    const memberEdit = await request(app)
      .put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Groepstoets v2" });
    assert.equal(memberEdit.status, 200);

    // …maar zonder can_add_decks niet meer (schrijfrecht weg → 404).
    await request(app)
      .put(`/v2/groups/${group.id}/members/${member.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ can_add_decks: false });
    const blocked = await request(app)
      .put(`/v2/exams/${exam.id}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Mag niet" });
    assert.equal(blocked.status, 404);

    // Nieuw groepsexamen aanmaken is dan ook dicht (403 not_allowed).
    const createBlocked = await request(app)
      .post("/v2/exams")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "X", exam_date: EXAM_DATE, group_id: group.id });
    assert.equal(createBlocked.status, 403);
    assert.equal(createBlocked.body.error, "not_allowed_to_manage_exams");

    // Kick → examen verdwijnt uit lijst én snapshot van het ex-lid.
    await request(app)
      .delete(`/v2/groups/${group.id}/members/${member.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const afterKick = await request(app)
      .get("/v2/exams")
      .set("Authorization", `Bearer ${memberToken}`);
    assert.deepEqual(afterKick.body, []);
    assert.deepEqual(await syncExams(memberToken), []);

    // Deck uit de catalogus → het examen-object krimpt (zonder updated_at-eis).
    await request(app)
      .delete(`/v2/groups/${group.id}/decks/${catalogDeck.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const shrunk = await request(app)
      .get("/v2/exams")
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.deepEqual(shrunk.body[0].deck_ids, []);
  });

  test("longest_in_streak_hours: upload, terug in responses, behoud bij oude client", async () => {
    const { user, token } = await freshUser();
    const deck = await createDeck(user.id);
    const card = await createCard(deck.id);

    const bad = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, remote_score: 5, due_date: EXAM_DATE,
              longest_in_streak_hours: -1 });
    assert.equal(bad.status, 400);

    const save = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, remote_score: 5, due_date: EXAM_DATE,
              repetitions: "x", longest_in_streak_hours: 123 });
    assert.equal(save.status, 200);
    assert.equal(save.body.longest_in_streak_hours, 123);

    // Sync levert het veld mee (SELECT * op user_card_progress).
    const sync = await request(app)
      .get(`/v2/sync/changes?since=${encodeURIComponent(recentSince())}`)
      .set("Authorization", `Bearer ${token}`);
    const progressRow = sync.body.progress.find((p) => p.card_id === card.id);
    assert.equal(progressRow.longest_in_streak_hours, 123);

    // Oude client (veld weg) laat de waarde staan.
    const withoutField = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, remote_score: 6, due_date: EXAM_DATE });
    assert.equal(withoutField.status, 200);
    assert.equal(withoutField.body.longest_in_streak_hours, 123);

    // Core-only write raakt het veld ook niet aan.
    const coreOnly = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, is_core: true });
    assert.equal(coreOnly.status, 200);
    assert.equal(coreOnly.body.longest_in_streak_hours, 123);

    // /review/deck/:id levert het veld in de expliciete kolomlijst.
    const deckRows = await request(app)
      .get(`/v2/review/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(deckRows.body[0].longest_in_streak_hours, 123);
  });
});
