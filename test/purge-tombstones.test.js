// purgeTombstones() hard-delete soft-deletes ouder dan TOMBSTONE_RETENTION_DAYS
// (default 90) en laat jongere tombstones met rust. Kerngedrag: een tombstone
// van 100 d wordt verwijderd, één van 10 d blijft staan.
import "../src/config/env.js"; // env vóór db.js, anders mist de pool DATABASE_URL
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.js";
import { purgeTombstones } from "../src/jobs/purgeTombstones.js";
import {
  createUser,
  createDeck,
  createCard,
  createProgress,
  cleanupUser,
  closePool,
} from "./helpers.js";

const createdUserIds = [];

after(async () => {
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("purgeTombstones()", () => {
  test("verwijdert een tombstone van 100 d, behoudt er één van 10 d", async () => {
    const user = await createUser();
    createdUserIds.push(user.id);
    const deck = await createDeck(user.id);

    const oldCard = await createCard(deck.id);
    const youngCard = await createCard(deck.id);
    const oldProgress = await createProgress(user.id, oldCard.id);
    const youngProgress = await createProgress(user.id, youngCard.id);

    // Soft-delete met expliciete leeftijden.
    await pool.query(
      `UPDATE user_card_progress SET deleted_at = now() - interval '100 days' WHERE id = $1`,
      [oldProgress.id]
    );
    await pool.query(
      `UPDATE user_card_progress SET deleted_at = now() - interval '10 days' WHERE id = $1`,
      [youngProgress.id]
    );

    await purgeTombstones(); // default-retentie 90 d

    const oldRow = await pool.query(
      `SELECT 1 FROM user_card_progress WHERE id = $1`,
      [oldProgress.id]
    );
    const youngRow = await pool.query(
      `SELECT 1 FROM user_card_progress WHERE id = $1`,
      [youngProgress.id]
    );

    assert.equal(oldRow.rowCount, 0, "100 d-tombstone is hard verwijderd");
    assert.equal(youngRow.rowCount, 1, "10 d-tombstone blijft staan (binnen retentie)");
  });

  test("laat levende (niet-soft-deleted) rijen altijd staan", async () => {
    const user = await createUser();
    createdUserIds.push(user.id);
    const deck = await createDeck(user.id);
    const card = await createCard(deck.id);
    const progress = await createProgress(user.id, card.id);

    // Zelfs met retentie 0 mag een rij zonder deleted_at niet weg.
    await purgeTombstones(0);

    const row = await pool.query(
      `SELECT 1 FROM user_card_progress WHERE id = $1`,
      [progress.id]
    );
    assert.equal(row.rowCount, 1, "levende rij overleeft de purge");
  });
});
