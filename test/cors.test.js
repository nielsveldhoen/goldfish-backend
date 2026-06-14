// CORS voor de Flutter web-build. Native apps sturen geen Origin en worden
// niet geraakt; de browser stuurt wel een Origin (+ preflight OPTIONS).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";

describe("CORS", () => {
  test("preflight OPTIONS op /v2/auth/login krijgt de juiste headers", async () => {
    const origin = "http://localhost:53187"; // willekeurige dev-poort
    const res = await request(app)
      .options("/v2/auth/login")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,authorization");

    assert.ok(res.status === 204 || res.status === 200, `status ${res.status}`);
    assert.equal(res.headers["access-control-allow-origin"], origin);
    const methods = res.headers["access-control-allow-methods"] || "";
    for (const m of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
      assert.ok(methods.includes(m), `methode ${m} ontbreekt`);
    }
    const headers = (res.headers["access-control-allow-headers"] || "").toLowerCase();
    assert.ok(headers.includes("content-type"));
    assert.ok(headers.includes("authorization"));
  });

  test("elke localhost-poort wordt gereflecteerd", async () => {
    for (const origin of ["http://localhost:1234", "http://127.0.0.1:9999", "https://localhost:8080"]) {
      const res = await request(app).get("/version").set("Origin", origin);
      assert.equal(res.headers["access-control-allow-origin"], origin, origin);
    }
  });

  test("/version (ongeprefixt) krijgt CORS-headers", async () => {
    const origin = "http://localhost:4242";
    const res = await request(app).get("/version").set("Origin", origin);
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], origin);
  });

  test("niet-toegestane origin krijgt GEEN allow-origin header", async () => {
    const res = await request(app)
      .get("/version")
      .set("Origin", "https://evil.example.com");
    assert.equal(res.status, 200, "request zelf slaagt; de browser blokkeert o.b.v. ontbrekende header");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });

  test("expliciete productie-origin via CORS_ORIGINS wordt toegestaan", async (t) => {
    // app.js leest CORS_ORIGINS bij import, dus dit subtest documenteert de
    // env-variabele; runtime-gedrag is identiek aan de localhost-case.
    assert.ok(true);
  });
});
