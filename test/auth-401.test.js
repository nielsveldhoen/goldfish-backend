// Punt 2: alle beveiligde endpoints geven bij ontbrekend/ongeldig/verlopen
// JWT altijd exact 401 terug (nooit 403 of 500). De client logt uit op 401.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app.js";
import { tokenFor, expiredTokenFor, wrongSecretTokenFor } from "./helpers.js";

const FAKE_UUID = "11111111-1111-4111-8111-111111111111";

const PROTECTED_ENDPOINTS = [
  ["get", "/auth/me"],
  ["get", "/decks"],
  ["get", `/decks/${FAKE_UUID}`],
  ["post", "/decks"],
  ["put", `/decks/${FAKE_UUID}`],
  ["delete", `/decks/${FAKE_UUID}`],
  ["get", "/cards"],
  ["get", `/cards/${FAKE_UUID}`],
  ["post", "/cards"],
  ["post", "/cards/bulk"],
  ["put", `/cards/${FAKE_UUID}`],
  ["delete", `/cards/${FAKE_UUID}`],
  ["get", "/review/due"],
  ["get", `/review/new?deck_id=${FAKE_UUID}`],
  ["get", `/review/deck/${FAKE_UUID}`],
  ["post", "/review/progress"],
  ["delete", `/review/progress/${FAKE_UUID}`],
  ["get", "/review/decks/summary"],
  ["get", "/review/ltm/summary"],
  ["get", "/sync/changes?since=2026-01-01T00:00:00.000Z"],
  ["post", "/stats/update"],
  ["get", `/stats/deck/${FAKE_UUID}`],
  ["get", "/stats/daily"],
];

const INVALID_AUTH_VARIANTS = [
  ["zonder Authorization-header", null],
  ["met kapot token", "Bearer not.a.jwt"],
  ["met verlopen token", `Bearer ${expiredTokenFor(FAKE_UUID)}`],
  ["met token van verkeerde secret", `Bearer ${wrongSecretTokenFor(FAKE_UUID)}`],
  ["met verkeerd auth-schema", `Basic ${tokenFor(FAKE_UUID)}`],
];

describe("401-semantiek op alle beveiligde endpoints", () => {
  for (const [method, path] of PROTECTED_ENDPOINTS) {
    for (const [label, header] of INVALID_AUTH_VARIANTS) {
      test(`${method.toUpperCase()} ${path} ${label} → 401`, async () => {
        let req = request(app)[method](path);
        if (header) req = req.set("Authorization", header);
        const res = await req.send({});
        assert.equal(
          res.status,
          401,
          `verwachtte 401, kreeg ${res.status}: ${JSON.stringify(res.body)}`
        );
      });
    }
  }
});
