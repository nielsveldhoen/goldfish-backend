// GET /v2/sync/changes — deck-rijen dragen tallies (total/new/due) en een deck
// komt óók mee als alleen zijn kaarten of eigen voortgang sinds `since`
// wijzigden, zodat het dashboard geen aparte summary-fetch nodig heeft.
// Plus: ?snapshots=contacts,groups levert die lijsten integraal mee.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import {
  tokenFor,
  createUser,
  createDeck,
  createCard,
  createProgress,
  createContact,
  cleanupUser,
  closePool,
} from "./helpers.js";

const createdUserIds = [];
// Binnen de full-resync-horizon, anders antwoordt de server { full_resync }.
const RECENT = new Date(Date.now() - 864e5).toISOString();

function getSync(token, since, extra = "") {
  return request(app)
    .get(`/v2/sync/changes?since=${encodeURIComponent(since)}${extra}`)
    .set("Authorization", `Bearer ${token}`);
}

async function dbNowIso() {
  const { rows } = await pool.query(`SELECT NOW() AS now`);
  return rows[0].now.toISOString();
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("GET /v2/sync/changes — deck-tallies in de delta", () => {
  test("een deck-rij in de delta draagt total/new/due", async () => {
    const user = await createUser();
    createdUserIds.push(user.id);
    const token = tokenFor(user.id);
    const deck = await createDeck(user.id);
    await createCard(deck.id);
    await createCard(deck.id);

    const res = await getSync(token, RECENT);
    assert.equal(res.status, 200);
    const row = res.body.decks.find((d) => d.id === deck.id);
    assert.ok(row, "deck in delta");
    assert.equal(Number(row.total_count), 2);
    assert.equal(Number(row.new_count), 2);
    assert.equal(Number(row.due_count), 0);
  });

  test("alleen een voortgangswijziging levert de deck-rij (met tallies) opnieuw", async () => {
    const user = await createUser();
    createdUserIds.push(user.id);
    const token = tokenFor(user.id);
    const deck = await createDeck(user.id);
    const card = await createCard(deck.id);

    // Watermerk ná deck+kaart, met marge (de server trekt een overlapvenster af).
    await new Promise((r) => setTimeout(r, 20));
    const since = await dbNowIso();
    const quiet = await getSync(token, since);
    assert.equal(quiet.status, 200);
    // Binnen het overlapvenster kan de deck-rij nog dubbel komen; wat telt is
    // dat hij NA een voortgangswijziging zeker komt, mét bijgewerkte tallies.
    await createProgress(user.id, card.id);
    await pool.query(
      `UPDATE user_card_progress SET repetitions = 'x', due_date = NOW() - interval '1 hour', updated_at = NOW()
       WHERE user_id = $1 AND card_id = $2`,
      [user.id, card.id]
    );

    const res = await getSync(token, since);
    assert.equal(res.status, 200);
    const row = res.body.decks.find((d) => d.id === deck.id);
    assert.ok(row, "deck-rij meegeleverd na voortgangswijziging");
    assert.equal(Number(row.total_count), 1);
    assert.equal(Number(row.new_count), 0);
    assert.equal(Number(row.due_count), 1);
    const prow = res.body.progress.find((p) => p.card_id === card.id);
    assert.ok(prow, "voortgangsrij in delta");
    assert.equal(prow.deck_id, deck.id, "voortgangsrij draagt deck_id");
  });
});

describe("GET /v2/sync/changes — snapshots", () => {
  test("zonder ?snapshots geen contacts/groups-velden", async () => {
    const user = await createUser();
    createdUserIds.push(user.id);
    const res = await getSync(tokenFor(user.id), RECENT);
    assert.equal(res.status, 200);
    assert.ok(!("contacts" in res.body));
    assert.ok(!("groups" in res.body));
  });

  test("?snapshots=contacts,groups levert beide lijsten integraal", async () => {
    const a = await createUser();
    const b = await createUser();
    createdUserIds.push(a.id, b.id);
    await createContact(a.id, b.id, "accepted");

    const res = await getSync(tokenFor(a.id), RECENT, "&snapshots=contacts,groups");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.contacts));
    assert.equal(res.body.contacts.length, 1);
    assert.equal(res.body.contacts[0].user_id, b.id);
    assert.equal(res.body.contacts[0].status, "accepted");
    assert.ok(Array.isArray(res.body.groups));
    assert.equal(res.body.groups.length, 0);
  });

  test("onbekende snapshot-namen worden genegeerd", async () => {
    const user = await createUser();
    createdUserIds.push(user.id);
    const res = await getSync(tokenFor(user.id), RECENT, "&snapshots=bogus,contacts");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.contacts));
    assert.ok(!("groups" in res.body));
  });
});
