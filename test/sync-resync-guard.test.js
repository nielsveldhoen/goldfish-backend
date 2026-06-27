// Full-resync-guard op GET /v2/sync/changes (en defensief op /v2/review/core):
// is `since` ouder dan SYNC_RESYNC_HORIZON_DAYS (of leeg/weg), dan kunnen
// tombstones in dat venster al gepurged zijn → geen delta maar
// { full_resync: true, server_time }. Binnen de horizon: normale delta, géén
// full_resync-veld. Behoud van 400 bij ongeldig ISO.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import {
  SYNC_RESYNC_HORIZON_DAYS,
} from "../src/config/retention.js";
import {
  tokenFor,
  createUser,
  createDeck,
  cleanupUser,
  closePool,
} from "./helpers.js";

const DAY_MS = 864e5;
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

const createdUserIds = [];
async function freshUserWithDeck() {
  const user = await createUser();
  const deck = await createDeck(user.id);
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id), deck };
}

function getSync(token, since) {
  const url =
    since === undefined
      ? "/v2/sync/changes"
      : `/v2/sync/changes?since=${encodeURIComponent(since)}`;
  return request(app).get(url).set("Authorization", `Bearer ${token}`);
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("GET /v2/sync/changes — full-resync-guard", () => {
  test("since ouder dan de horizon → { full_resync: true }", async () => {
    const { token } = await freshUserWithDeck();
    const res = await getSync(token, isoDaysAgo(SYNC_RESYNC_HORIZON_DAYS + 5));
    assert.equal(res.status, 200);
    assert.equal(res.body.full_resync, true);
    assert.ok(res.body.server_time, "server_time aanwezig");
    assert.ok(!("decks" in res.body), "geen delta-velden bij full_resync");
  });

  test("ontbrekende since → full_resync (nieuwe installatie)", async () => {
    const { token } = await freshUserWithDeck();
    const res = await getSync(token, undefined);
    assert.equal(res.status, 200);
    assert.equal(res.body.full_resync, true);
    assert.ok(res.body.server_time);
  });

  test("since binnen de horizon → normale delta (geen full_resync-veld)", async () => {
    const { token, deck } = await freshUserWithDeck();
    // 5 dagen geleden valt binnen de horizon (default 75 d); het zojuist
    // aangemaakte deck heeft updated_at = nu > since en komt dus in de delta.
    const res = await getSync(token, isoDaysAgo(5));
    assert.equal(res.status, 200);
    assert.equal(res.body.full_resync, undefined, "geen full_resync-veld in een delta");
    assert.ok(Array.isArray(res.body.decks), "delta heeft decks-array");
    assert.ok(
      res.body.decks.some((d) => d.id === deck.id),
      "het verse deck zit in de delta"
    );
    assert.ok(res.body.server_time);
  });

  test("ongeldig ISO-formaat → 400 (ook al zou het 'oud' kunnen lijken)", async () => {
    const { token } = await freshUserWithDeck();
    const res = await getSync(token, "niet-een-datum");
    assert.equal(res.status, 400);
  });
});

describe("GET /v2/review/core — full-resync-guard (defensief)", () => {
  test("since ouder dan de horizon → { full_resync: true }", async () => {
    const { token } = await freshUserWithDeck();
    const res = await request(app)
      .get(`/v2/review/core?since=${encodeURIComponent(isoDaysAgo(SYNC_RESYNC_HORIZON_DAYS + 5))}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.full_resync, true);
    assert.ok(res.body.server_time);
    assert.ok(!("cards" in res.body), "geen delta-velden bij full_resync");
  });

  test("since binnen de horizon → normale delta (cards-array, geen full_resync)", async () => {
    const { token } = await freshUserWithDeck();
    const res = await request(app)
      .get(`/v2/review/core?since=${encodeURIComponent(isoDaysAgo(5))}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.full_resync, undefined);
    assert.ok(Array.isArray(res.body.cards));
  });
});
