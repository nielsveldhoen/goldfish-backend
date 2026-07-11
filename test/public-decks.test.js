// Publieke decks (PUBLIC_DECKS_PLAN.md): is_public is onomkeerbaar en de
// publieke bibliotheek is zoek-gestuurd (search verplicht, min. 2 tekens).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import "../src/config/env.js";
import app from "../src/app.js";
import { tokenFor, createUser, createDeck, cleanupUser, closePool } from "./helpers.js";

const createdUserIds = [];
async function freshUser() {
  const user = await createUser();
  createdUserIds.push(user.id);
  return { user, token: tokenFor(user.id) };
}

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("Publieke decks", () => {
  test("is_public is onomkeerbaar: terugzetten → 400, idempotent true oké", async () => {
    const { user: owner, token } = await freshUser();
    const deck = await createDeck(owner.id, "Onomkeerbaar publiek GF-test");

    // Privé → privé mag gewoon (er is nog niets onomkeerbaars gebeurd).
    const stillPrivate = await request(app)
      .put(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ is_public: false });
    assert.equal(stillPrivate.status, 200);
    assert.equal(stillPrivate.body.is_public, false);

    const makePublic = await request(app)
      .put(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ is_public: true });
    assert.equal(makePublic.status, 200);
    assert.equal(makePublic.body.is_public, true);

    // Terugzetten is geblokkeerd.
    const undo = await request(app)
      .put(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ is_public: false });
    assert.equal(undo.status, 400);
    assert.equal(undo.body.error, "is_public_irreversible");

    // Nogmaals true is idempotent; een PUT zónder is_public laat de vlag staan.
    const again = await request(app)
      .put(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ is_public: true });
    assert.equal(again.status, 200);
    assert.equal(again.body.is_public, true);

    const titleOnly = await request(app)
      .put(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Nog steeds publiek GF-test" });
    assert.equal(titleOnly.status, 200);
    assert.equal(titleOnly.body.is_public, true);
  });

  test("GET /decks/public vereist een zoekterm van minstens 2 tekens", async () => {
    const { user: owner, token: ownerToken } = await freshUser();
    const { token: readerToken } = await freshUser();

    const deck = await createDeck(owner.id, "Middenwoord xyzzyq GF-test");
    await request(app)
      .put(`/v2/decks/${deck.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ is_public: true });

    // Geen, lege, te korte of alleen-whitespace zoekterm → 400 search_required.
    for (const qs of ["", "?search=", "?search=a", `?search=${encodeURIComponent("  a ")}`]) {
      const res = await request(app)
        .get(`/v2/decks/public${qs}`)
        .set("Authorization", `Bearer ${readerToken}`);
      assert.equal(res.status, 400, `verwacht 400 voor "${qs}"`);
      assert.equal(res.body.error, "search_required");
    }

    // Substring midden in een titelwoord matcht (ILIKE %term%).
    const mid = await request(app)
      .get("/v2/decks/public?search=zzy")
      .set("Authorization", `Bearer ${readerToken}`);
    assert.equal(mid.status, 200);
    assert.ok(mid.body.some((d) => d.id === deck.id), "middenstuk van woord moet matchen");
  });
});
