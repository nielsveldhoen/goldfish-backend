// isRevoked() — het uitgiftemoment van een token tegen users.tokens_valid_after.
// De standaard iat-claim heeft secondeprecisie en het watermerk niet, dus een
// verse login in dezelfde seconde als een intrekking werd geweigerd. iat_ms
// legt hetzelfde moment exacter vast; oudere tokens vallen terug op iat.
import "../src/config/env.js"; // JWT_SECRET moet staan vóór generateToken laadt
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { isRevoked } from "../src/middleware/auth.js";
import { generateToken } from "../src/utils/generateToken.js";
import { closePool } from "./helpers.js";

const decode = (token) => jwt.decode(token);

// Een token zoals oudere code het uitgaf: alleen de standaard iat.
function legacyToken(atMs) {
  return jwt.sign(
    { userId: "u1", iat: Math.floor(atMs / 1000) },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

after(closePool);

describe("isRevoked", () => {
  test("zonder watermerk is niets ingetrokken", () => {
    assert.equal(isRevoked(decode(generateToken("u1")), null), false);
  });

  test("een token uit dezelfde seconde als het watermerk blijft geldig", () => {
    // De verwijderaanvraag zet het watermerk, de login erna geeft een token.
    // Beide binnen één seconde: precies het geval dat eerder 401 gaf.
    const watermark = new Date();
    const token = decode(generateToken("u1"));
    assert.equal(Math.floor(watermark.getTime() / 1000), token.iat,
      "test veronderstelt dat beide in dezelfde seconde vallen");
    assert.equal(isRevoked(token, watermark), false);
  });

  test("een token van vóór het watermerk is ingetrokken", () => {
    const token = decode(generateToken("u1"));
    assert.equal(isRevoked(token, new Date(Date.now() + 5000)), true);
  });

  test("een token zonder iat_ms houdt het oude, strengere gedrag", () => {
    const now = Date.now();
    const token = decode(legacyToken(now));
    // Watermerk halverwege dezelfde seconde: zonder millisecondes is het token
    // niet van ná het watermerk te onderscheiden, dus blijft het ingetrokken.
    const watermark = new Date(Math.floor(now / 1000) * 1000 + 500);
    assert.equal(token.iat_ms, undefined);
    assert.equal(isRevoked(token, watermark), true);
  });

  test("een iat_ms die niet bij iat past wordt genegeerd", () => {
    const now = Date.now();
    const token = {
      iat: Math.floor(now / 1000),
      iat_ms: now + 60_000, // een minuut vooruit: past niet bij iat
    };
    const watermark = new Date(Math.floor(now / 1000) * 1000 + 500);
    assert.equal(isRevoked(token, watermark), true,
      "een onverwachte iat_ms mag de intrekking niet versoepelen");
  });

  test("een token zonder iat is niet te beoordelen en geldt als ingetrokken", () => {
    assert.equal(isRevoked({ userId: "u1" }, new Date()), true);
  });
});
