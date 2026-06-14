// API-versionering: v1 (en de ongeprefixte legacy-paden) spreekt de oude
// veldnamen (ltm/stm), v2 de nieuwe (remote/stable/recent). Beide versies
// werken op dezelfde data; de DB-triggers houden oude en nieuwe kolommen
// synchroon (migrations/003).
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

describe("API-versionering ltm/stm ↔ remote/stable", () => {
  test("GET /version meldt beschikbare versies", async () => {
    const res = await request(app).get("/version");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.versions, ["v1", "v2"]);
    assert.equal(res.body.latest, "v2");
    assert.equal(res.body.min, "v1");
  });

  test("MIN_API_VERSION=2 sluit v1 af met 410, v2 en /version blijven werken", async (t) => {
    process.env.MIN_API_VERSION = "2";
    t.after(() => {
      delete process.env.MIN_API_VERSION;
    });

    for (const path of ["/review/due", "/v1/review/due"]) {
      const res = await request(app)
        .get(path)
        .set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 410, `${path} moet 410 geven`);
      assert.equal(res.body.error, "api_version_unsupported");
      assert.equal(res.body.min_version, "v2");
    }

    const v2Res = await request(app)
      .get("/v2/review/due")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(v2Res.status, 200, "v2 moet gewoon blijven werken");

    const versionRes = await request(app).get("/version");
    assert.equal(versionRes.status, 200, "/version moet altijd bereikbaar blijven");
    assert.deepEqual(versionRes.body.versions, ["v2"]);
    assert.equal(versionRes.body.min, "v2");
  });

  test("ongeprefixt POST /review/progress accepteert oude veldnamen en antwoordt met oude veldnamen", async () => {
    const res = await request(app)
      .post("/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, ltm_score: 3, stm_score: 2, due_date: "2030-01-01", repetitions: "x" });

    assert.equal(res.status, 200);
    assert.equal(res.body.ltm_score, 3);
    assert.equal(res.body.stm_score, 2);
    assert.equal(res.body.remote_score, undefined, "v1-response mag geen nieuwe veldnamen bevatten");
    assert.equal(res.body.stable_score, undefined);
    assert.equal(res.body.recent_score, undefined, "recent bestaat niet in v1");
  });

  test("v2 leest dezelfde data terug onder nieuwe veldnamen", async () => {
    const res = await request(app)
      .get(`/v2/review/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 200);
    const row = res.body.find((r) => r.id === card.id);
    assert.ok(row, "kaart moet in de v2-response zitten");
    assert.equal(row.remote_score, 3);
    assert.equal(row.stable_score, 2);
    assert.equal(row.recent_score, 0);
    assert.equal(row.ltm_score, undefined, "v2-response mag geen oude veldnamen bevatten");
    assert.equal(row.stm_score, undefined);
  });

  test("v2 POST /review/progress schrijft remote/stable/recent, v1 ziet ltm/stm", async () => {
    const v2Res = await request(app)
      .post("/v2/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, remote_score: 5, stable_score: 4, recent_score: 1, due_date: "2030-06-01", repetitions: "xx" });

    assert.equal(v2Res.status, 200);
    assert.equal(v2Res.body.remote_score, 5);
    assert.equal(v2Res.body.stable_score, 4);
    assert.equal(v2Res.body.recent_score, 1);
    assert.equal(v2Res.body.ltm_score, undefined);

    const v1Res = await request(app)
      .get(`/v1/review/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    const row = v1Res.body.find((r) => r.id === card.id);
    assert.equal(row.ltm_score, 5, "DB-trigger moet ltm_score gelijk houden aan remote_score");
    assert.equal(row.stm_score, 4);
    assert.equal(row.recent_score, undefined);
  });

  test("v1-update zonder recent_score laat de recent-waarde intact", async () => {
    const res = await request(app)
      .post("/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, ltm_score: 2, due_date: "2030-07-01", repetitions: "xxx" });
    assert.equal(res.status, 200);

    const v2Res = await request(app)
      .get(`/v2/review/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    const row = v2Res.body.find((r) => r.id === card.id);
    assert.equal(row.remote_score, 2);
    assert.equal(row.recent_score, 1, "recent_score mag niet gereset worden door een v1-write");
  });

  test("summary: /review/ltm/summary (v1) en /v2/review/remote/summary geven dezelfde data onder eigen veldnamen", async () => {
    // markeer de kaart als core zodat de summary iets telt
    await request(app)
      .post("/review/progress")
      .set("Authorization", `Bearer ${token}`)
      .send({ card_id: card.id, is_core: true });

    const v1Res = await request(app)
      .get("/review/ltm/summary")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(v1Res.status, 200);
    assert.equal(v1Res.body.total_ltm_count, "1");
    assert.ok("avg_ltm_score" in v1Res.body);
    assert.ok(!("avg_remote_score" in v1Res.body));
    assert.ok(!("avg_recent_score" in v1Res.body));

    const v2Res = await request(app)
      .get("/v2/review/remote/summary")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(v2Res.status, 200);
    assert.equal(v2Res.body.total_remote_count, "1");
    assert.ok("avg_remote_score" in v2Res.body);
    assert.ok("avg_recent_score" in v2Res.body);
    assert.ok(!("avg_ltm_score" in v2Res.body));
  });

  test("stats: v1-body met ltm-namen en v2-uitlezing met remote-namen", async () => {
    const v1Res = await request(app)
      .post("/stats/update")
      .set("Authorization", `Bearer ${token}`)
      .send({
        date: "2026-06-12",
        deck_id: deck.id,
        deck_delta: {
          cards_practiced: 3,
          cards_correct_first_try: 2,
          ltm_cards_practiced: 1,
          ltm_correct_first_try: 1,
          avg_ltm_score: 3.4,
          avg_stm_score: 1.8,
        },
        daily_delta: { cards_practiced_today: 3, correct_first_try_today: 2 },
        daily_snapshot: { total_cards: 10, total_ltm_cards: 4, avg_ltm_score: 3.4, avg_stm_score: 1.8 },
      });

    assert.equal(v1Res.status, 200);
    assert.equal(v1Res.body.deck_stats.ltm_cards_practiced, 1);
    assert.equal(v1Res.body.deck_stats.remote_cards_practiced, undefined);
    assert.equal(v1Res.body.daily_snapshot.total_ltm_cards, 4);

    const v2Res = await request(app)
      .get(`/v2/stats/deck/${deck.id}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(v2Res.status, 200);
    const row = v2Res.body[0];
    assert.equal(row.remote_cards_practiced, 1);
    assert.equal(row.avg_remote_score, "3.40");
    assert.equal(row.ltm_cards_practiced, undefined);
    assert.ok("avg_recent_score" in row);
  });

  test("sync: v1 levert oude namen, v2 nieuwe namen voor progress-records", async () => {
    const since = "2000-01-01T00:00:00.000Z";

    const v1Res = await request(app)
      .get(`/sync/changes?since=${since}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(v1Res.status, 200);
    const v1Row = v1Res.body.progress.find((p) => p.card_id === card.id);
    assert.ok("ltm_score" in v1Row);
    assert.ok(!("remote_score" in v1Row));
    assert.ok(!("recent_score" in v1Row));

    const v2Res = await request(app)
      .get(`/v2/sync/changes?since=${since}`)
      .set("Authorization", `Bearer ${token}`);
    const v2Row = v2Res.body.progress.find((p) => p.card_id === card.id);
    assert.ok("remote_score" in v2Row);
    assert.ok("recent_score" in v2Row);
    assert.ok(!("ltm_score" in v2Row));
  });
});
