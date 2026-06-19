// Client-versiegate: de server weigert API-calls van een te oude client met
// HTTP 426. Het minimum (Flutter buildNumber) staat in app_config en wordt per
// request vers gelezen; de client stuurt zijn build mee in X-Client-Build.
//
// De test zet het minimum in de gedeelde app_config en zet het in after() weer
// op 0. De suite draait serieel (--test-concurrency=1, zie package.json) zodat
// die globale toggle andere testbestanden niet raakt.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import { tokenFor, createUser, cleanupUser, closePool } from "./helpers.js";

let user, token;

async function setMinBuild(n) {
  await pool.query(
    `UPDATE app_config SET value = $1, updated_at = now() WHERE key = 'min_client_build'`,
    [String(n)]
  );
}

before(async () => {
  user = await createUser();
  token = tokenFor(user.id);
});

after(async () => {
  await setMinBuild(0); // poort weer open voor de rest van de suite
  await cleanupUser(user.id);
  await closePool();
});

describe("client-versiegate (X-Client-Build / min_client_build)", () => {
  test("GET /version meldt min_client_build en blijft open (geen header nodig)", async () => {
    await setMinBuild(100);
    const res = await request(app).get("/version");
    assert.equal(res.status, 200);
    assert.equal(res.body.min_client_build, 100);
  });

  test("te oude build → 426, ook met geldig token", async () => {
    await setMinBuild(100);
    const res = await request(app)
      .get("/v2/review/due")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Client-Build", "50");
    assert.equal(res.status, 426);
    assert.equal(res.body.error, "client_version_unsupported");
    assert.equal(res.body.min_client_build, 100);
  });

  test("ontbrekend header telt als build 0 → 426 zolang minimum > 0", async () => {
    await setMinBuild(100);
    const res = await request(app)
      .get("/v2/review/due")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 426);
  });

  test("build >= minimum komt door de gate", async () => {
    await setMinBuild(100);
    const res = await request(app)
      .get("/v2/review/due")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Client-Build", "100");
    assert.equal(res.status, 200, "gate door → normale response");
  });

  test("minimum 0 = poort open, geen header nodig", async () => {
    await setMinBuild(0);
    const res = await request(app)
      .get("/v2/review/due")
      .set("Authorization", `Bearer ${token}`);
    assert.notEqual(res.status, 426);
  });
});
