// Na de opschoning kent de backend nog maar één naamset:
// remote/core/stable/recent. De oude ltm/stm-namen bestaan niet meer (kolommen
// en vertaallaag zijn verwijderd in migratie 005). Alle API-routes zitten onder
// het /v2-prefix; ongeprefixte paden bestaan niet meer.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import {
  tokenFor,
  createUser,
  createDeck,
  createCard,
  cleanupUser,
  closePool,
} from "./helpers.js";

let user, token, deck, card;

before(async () => {
  user = await createUser();
  token = tokenFor(user.id);
  deck = await createDeck(user.id);
  card = await createCard(deck.id);
});

after(async () => {
  await cleanupUser(user.id);
  await closePool();
});

describe("één naamset: remote/core/stable/recent", () => {
  test("GET /version meldt alleen v2", async () => {
    const res = await request(app).get("/version");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.versions, ["v2"]);
    assert.equal(res.body.latest, "v2");
    assert.equal(res.body.min, "v2");
  });

  test("POST /v2/review/progress schrijft en leest de nieuwe namen, geen ltm/stm", async () => {
    const res = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, remote_score: 5, stable_score: 4, recent_score: 1, due_date: "2030-06-01", repetitions: "xx" });

    assert.equal(res.status, 200);
    assert.equal(res.body.remote_score, 5);
    assert.equal(res.body.stable_score, 4);
    assert.equal(res.body.recent_score, 1);
    assert.ok(!("ltm_score" in res.body), "oude veldnamen mogen niet meer voorkomen");
    assert.ok(!("stm_score" in res.body));
  });

  test("update zonder recent_score laat de recent-waarde intact", async () => {
    const res = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, remote_score: 2, due_date: "2030-07-01", repetitions: "xxx" });

    assert.equal(res.status, 200);
    assert.equal(res.body.remote_score, 2);
    assert.equal(res.body.recent_score, 1, "recent_score mag niet gereset worden");
  });

  test("alle API-routes zitten onder /v2; ongeprefixt bestaat niet meer", async () => {
    const v2 = await request(app)
      .get(`/v2/review/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(v2.status, 200);
    const entry = v2.body.find((c) => c.id === card.id);
    assert.ok("remote_score" in entry);
    assert.ok(!("ltm_score" in entry));

    const plain = await request(app)
      .get(`/review/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(plain.status, 404, "ongeprefixte paden bestaan niet meer");
  });

  test("stats: core/remote-namen worden opgeslagen en teruggelezen", async () => {
    const post = await request(app)
      .post("/v2/stats/update")
      .set("Authorization", `Bearer ${token}`)
      .send({
        date: "2026-06-12",
        deck_id: deck.id,
        deck_delta: {
          cards_practiced: 3,
          cards_correct_first_try: 2,
          core_cards_practiced: 1,
          core_correct_first_try: 1,
          avg_remote_score: 3.4,
          avg_stable_score: 1.8,
        },
        daily_delta: { cards_practiced_today: 3, correct_first_try_today: 2 },
        daily_snapshot: { total_cards: 10, total_core_cards: 4, avg_remote_score: 3.4, avg_stable_score: 1.8 },
      });
    assert.equal(post.status, 200);

    const get = await request(app)
      .get(`/v2/stats/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(get.status, 200);
    const row = get.body[0];
    assert.equal(row.core_cards_practiced, 1);
    assert.equal(row.avg_remote_score, "3.40");
    assert.ok(!("ltm_cards_practiced" in row), "oude kolommen mogen niet meer voorkomen");
  });
});
