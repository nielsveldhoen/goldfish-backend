// GET /v2/stats/changes — incrementele stats-delta met advance-only watermark,
// in dezelfde stijl als /review/core en /sync/changes (filter updated_at > since,
// server_time = DB NOW(), strikt `>`). Aparte cursor; loopt niet mee op /sync.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import {
  tokenFor,
  createUser,
  createDeck,
  cleanupUser,
  closePool,
} from "./helpers.js";

const PAST = "2000-01-01T00:00:00.000Z";

// Per-test verse user zodat since=epoch een bekende, geïsoleerde set teruggeeft.
const createdUserIds = [];
async function freshUserWithDeck() {
  const user = await createUser();
  const deck = await createDeck(user.id);
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id), deck };
}

// Voegt een stats-paar toe via de echte schrijfweg (POST /stats/update).
async function postStats(token, deckId, date, overrides = {}) {
  const res = await request(app)
    .post("/v2/stats/update")
    .set("Authorization", `Bearer ${token}`)
    .send({
      date,
      deck_id: deckId,
      deck_delta: {
        cards_practiced: 2,
        cards_correct_first_try: 1,
        core_cards_practiced: 0,
        core_correct_first_try: 0,
        avg_remote_score: 3.0,
        avg_stable_score: 2.0,
        ...(overrides.deck_delta || {}),
      },
      daily_delta: {
        cards_practiced_today: 2,
        correct_first_try_today: 1,
        ...(overrides.daily_delta || {}),
      },
      daily_snapshot: {
        total_cards: 10,
        total_core_cards: 0,
        avg_remote_score: 3.0,
        avg_stable_score: 2.0,
        ...(overrides.daily_snapshot || {}),
      },
    });
  assert.equal(res.status, 200, `POST /stats/update faalde: ${JSON.stringify(res.body)}`);
  return res.body;
}

function getChanges(token, since) {
  let req = request(app).get(
    since === undefined ? "/v2/stats/changes" : `/v2/stats/changes?since=${encodeURIComponent(since)}`
  );
  return req.set("Authorization", `Bearer ${token}`);
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("GET /v2/stats/changes", () => {
  test("since in het verre verleden → volledige historie terug", async () => {
    const { token, deck } = await freshUserWithDeck();
    await postStats(token, deck.id, "2026-06-01");
    await postStats(token, deck.id, "2026-06-02");

    const res = await getChanges(token, PAST);
    assert.equal(res.status, 200);
    assert.equal(res.body.deck_stats.length, 2, "beide deck_stats-rijen terug");
    assert.equal(res.body.daily_snapshots.length, 2, "beide daily-rijen terug");
    assert.ok(res.body.server_time, "server_time aanwezig");

    // Responsevorm: avg_core_* zijn null als er geen core-kaarten geoefend zijn.
    const ds = res.body.deck_stats[0];
    assert.equal(ds.avg_core_remote_score, null);
    assert.equal(ds.avg_core_stable_score, null);
    assert.equal(ds.avg_core_recent_score, null);
    assert.match(ds.date, /^\d{4}-\d{2}-\d{2}$/, "date is YYYY-MM-DD");
    assert.ok("updated_at" in ds);

    const snap = res.body.daily_snapshots[0];
    assert.equal(snap.avg_core_remote_score, null);
    assert.equal(snap.avg_core_recent_score, null);
  });

  test("ontbrekende since → epoch → volledige historie (zoals /review/core)", async () => {
    const { token, deck } = await freshUserWithDeck();
    await postStats(token, deck.id, "2026-06-01");

    const res = await getChanges(token, undefined);
    assert.equal(res.status, 200);
    assert.equal(res.body.deck_stats.length, 1);
    assert.equal(res.body.daily_snapshots.length, 1);
  });

  test("since = vorige server_time, geen wijzigingen → lege arrays", async () => {
    const { token, deck } = await freshUserWithDeck();
    await postStats(token, deck.id, "2026-06-01");

    const first = await getChanges(token, PAST);
    assert.equal(first.status, 200);
    const watermark = first.body.server_time;

    const second = await getChanges(token, watermark);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.deck_stats, []);
    assert.deepEqual(second.body.daily_snapshots, []);
  });

  test("ongeldige since → 400", async () => {
    const { token } = await freshUserWithDeck();
    const res = await getChanges(token, "niet-een-datum");
    assert.equal(res.status, 400);
  });

  test("rij gewijzigd na het watermerk → komt terug met nieuwe updated_at (via POST /stats/update)", async () => {
    const { token, deck } = await freshUserWithDeck();
    const created = await postStats(token, deck.id, "2026-06-01");
    const firstUpdatedAt = created.deck_stats.updated_at;

    const first = await getChanges(token, PAST);
    const watermark = first.body.server_time;

    // "Device B" schrijft opnieuw op dezelfde (user, deck, date): de upsert
    // verhoogt de tellers en bumpt updated_at server-side.
    const updated = await postStats(token, deck.id, "2026-06-01");
    assert.ok(
      new Date(updated.deck_stats.updated_at) > new Date(firstUpdatedAt),
      "updated_at moet vooruit zijn gegaan"
    );

    const second = await getChanges(token, watermark);
    assert.equal(second.body.deck_stats.length, 1, "de bijgewerkte rij komt terug");
    assert.equal(second.body.deck_stats[0].date, "2026-06-01");
  });

  test("strikt `>`: een rij met updated_at == server_time wordt NIET dubbel geleverd, en `< grens` wel (geen verlies)", async () => {
    const { user, token, deck } = await freshUserWithDeck();

    // Rij met een exact gecontroleerde updated_at (INSERT bewaart de expliciete
    // waarde; de BEFORE UPDATE-trigger raakt INSERTs niet).
    const TS = "2026-03-01T12:00:00.000Z";
    await pool.query(
      `INSERT INTO deck_stats
         (user_id, deck_id, date, cards_practiced, cards_correct_first_try,
          core_cards_practiced, core_correct_first_try, updated_at)
       VALUES ($1, $2, $3, 0, 0, 0, 0, $4)`,
      [user.id, deck.id, "2026-03-01", TS]
    );

    // since == updated_at → strikt `>` sluit de rij uit (al geleverd in de
    // vorige call waarvan dit het server_time-watermerk was).
    const atBoundary = await getChanges(token, TS);
    assert.equal(atBoundary.status, 200);
    assert.equal(
      atBoundary.body.deck_stats.filter((r) => r.date === "2026-03-01").length,
      0,
      "rij op exact de grens komt niet opnieuw mee"
    );

    // since net vóór de grens → de rij komt mee (niet verloren).
    const justBefore = await getChanges(token, "2026-03-01T11:59:59.999Z");
    assert.equal(
      justBefore.body.deck_stats.filter((r) => r.date === "2026-03-01").length,
      1,
      "rij vlak na het watermerk wordt wél geleverd"
    );
  });

  test("trigger bumpt updated_at bij ELKE UPDATE, ook zonder dat de schrijver dat zet", async (t) => {
    // Vereist migratie 009 (trigger deck_stats_updated_at). Self-skip zolang
    // die nog niet als postgres is uitgevoerd; daarna dekt deze test de eis dat
    // de watermark server-side is en nooit van de client-klok komt.
    const trig = await pool.query(
      `SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'deck_stats'::regclass AND tgname = 'deck_stats_updated_at'`
    );
    if (trig.rowCount === 0) {
      t.skip("migratie 009 nog niet toegepast (trigger deck_stats_updated_at ontbreekt)");
      return;
    }

    const { user, deck } = await freshUserWithDeck();
    const ins = await pool.query(
      `INSERT INTO deck_stats
         (user_id, deck_id, date, cards_practiced, cards_correct_first_try,
          core_cards_practiced, core_correct_first_try, updated_at)
       VALUES ($1, $2, $3, 0, 0, 0, 0, $4)
       RETURNING updated_at`,
      [user.id, deck.id, "2026-04-01", "2026-04-01T00:00:00.000Z"]
    );
    const before = ins.rows[0].updated_at;

    // Rauwe UPDATE die updated_at NIET zelf zet → trigger moet hem bumpen.
    const upd = await pool.query(
      `UPDATE deck_stats SET cards_practiced = cards_practiced + 1
       WHERE user_id = $1 AND deck_id = $2 AND date = $3
       RETURNING updated_at`,
      [user.id, deck.id, "2026-04-01"]
    );
    assert.ok(
      new Date(upd.rows[0].updated_at) > new Date(before),
      "trigger moet updated_at server-side hebben opgehoogd"
    );
  });
});
