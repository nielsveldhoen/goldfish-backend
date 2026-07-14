// Account-verwijdering (ACCOUNT_DELETION_PLAN.md §6): DELETE /v2/auth/me
// (wachtwoord-herbevestiging, bedenktijd, token-revocatie), POST
// /v2/auth/me/restore (annuleren), en de definitieve wis door
// purgeDeletedAccounts — het kroonjuweel: nergens verwijst nog een rij naar
// de gewiste gebruiker, maar volgers van zijn gedeelde decks houden alles.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import argon2 from "argon2";
import "../src/config/env.js";
import app from "../src/app.js";
import { pool } from "../src/db.js";
import { purgeDeletedAccounts } from "../src/jobs/purgeDeletedAccounts.js";
import {
  tokenFor, createUser, createDeck, createCard, createProgress,
  createContact, createAcceptedShare, cleanupDeck, cleanupGroup,
  cleanupUser, closePool,
} from "./helpers.js";

const PASSWORD = "geheim-wachtwoord-1";

const createdUserIds = [];
const createdDeckIds = [];
const createdGroupIds = [];

async function freshUser({ withPassword = false } = {}) {
  const user = await createUser();
  createdUserIds.push(user.id);
  if (withPassword) {
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
      await argon2.hash(PASSWORD),
      user.id,
    ]);
  }
  return { user, token: tokenFor(user.id) };
}

after(async () => {
  for (const id of createdDeckIds) await cleanupDeck(id);
  for (const id of createdGroupIds) await cleanupGroup(id);
  for (const id of createdUserIds) await cleanupUser(id);
  await closePool();
});

describe("DELETE /v2/auth/me — aanvraag en annuleren", () => {
  test("fout wachtwoord → 401, goed wachtwoord → bedenktijd + alle tokens ingetrokken", async () => {
    const { user, token } = await freshUser({ withPassword: true });

    const wrong = await request(app)
      .delete(`/v2/auth/me`)
      .set("Authorization", `Bearer ${token}`)
      .send({ password: "niet-het-wachtwoord" });
    assert.equal(wrong.status, 401);

    const missing = await request(app)
      .delete(`/v2/auth/me`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(missing.status, 400);

    const ok = await request(app)
      .delete(`/v2/auth/me`)
      .set("Authorization", `Bearer ${token}`)
      .send({ password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.deletion_pending_until, "deadline zit in de response");

    const row = await pool.query(
      `SELECT deletion_requested_at, tokens_valid_after FROM users WHERE id = $1`,
      [user.id]
    );
    assert.notEqual(row.rows[0].deletion_requested_at, null);
    assert.notEqual(row.rows[0].tokens_valid_after, null);

    // Het oude token is per direct ingetrokken.
    const revoked = await request(app)
      .get(`/v2/auth/me`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(revoked.status, 401);

    // Opnieuw inloggen kan (bedenktijd) en meldt de openstaande verwijdering.
    const login = await request(app)
      .post(`/v2/auth/login`)
      .send({ identifier: user.email, password: PASSWORD });
    assert.equal(login.status, 200);
    assert.ok(login.body.deletion_pending_until, "login meldt de deadline");

    // Annuleren met het verse token; daarna is de melding weg.
    const restore = await request(app)
      .post(`/v2/auth/me/restore`)
      .set("Authorization", `Bearer ${login.body.token}`);
    assert.equal(restore.status, 200);

    const again = await request(app)
      .post(`/v2/auth/me/restore`)
      .set("Authorization", `Bearer ${login.body.token}`);
    assert.equal(again.status, 409, "tweede annulering → no_pending_deletion");

    const cleared = await pool.query(
      `SELECT deletion_requested_at FROM users WHERE id = $1`,
      [user.id]
    );
    assert.equal(cleared.rows[0].deletion_requested_at, null);
  });
});

describe("purgeDeletedAccounts — definitieve wis", () => {
  test("binnen de bedenktijd blijft het account onaangeroerd", async () => {
    const { user } = await freshUser();
    await pool.query(
      `UPDATE users SET deletion_requested_at = now() - interval '1 day' WHERE id = $1`,
      [user.id]
    );

    await purgeDeletedAccounts(); // default-grace 14 d

    const row = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [user.id]);
    assert.equal(row.rowCount, 1, "account binnen de bedenktijd overleeft de purge");
  });

  test("na de bedenktijd: account weg, gedeeld deck geörphand, volger houdt alles", async () => {
    const { user: leaver, token: leaverToken } = await freshUser();
    const { user: friend, token: friendToken } = await freshUser();

    await createContact(leaver.id, friend.id);

    // Gedeeld deck (friend volgt actief, met edit-recht en progress).
    const shared = await createDeck(leaver.id, "Blijft voor de volger");
    createdDeckIds.push(shared.id);
    const card = await createCard(shared.id);
    await createProgress(friend.id, card.id);
    await createProgress(leaver.id, card.id);
    await createAcceptedShare(shared.id, leaver.id, friend.id, { canEdit: true });

    // Privé deck zonder volgers en een eigen abonnement op andermans deck.
    const priv = await createDeck(leaver.id, "Gaat mee het graf in");
    const friendDeck = await createDeck(friend.id, "Van de vriend");
    await createAcceptedShare(friendDeck.id, friend.id, leaver.id);

    // Groep met de vriend als lid.
    const group = await pool.query(
      `INSERT INTO groups (owner_id, name, join_code, join_password_hash)
       VALUES ($1, 'Testgroep', 'ABCD2345', 'x') RETURNING id`,
      [leaver.id]
    );
    const groupId = group.rows[0].id;
    createdGroupIds.push(groupId);
    await pool.query(
      `INSERT INTO group_members (group_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active')`,
      [groupId, leaver.id, friend.id]
    );

    await pool.query(
      `UPDATE users SET deletion_requested_at = now() - interval '15 days' WHERE id = $1`,
      [leaver.id]
    );

    const result = await purgeDeletedAccounts();
    assert.ok(result.purged >= 1);

    // Kroonjuweel: geen enkele rij verwijst nog naar de gewiste gebruiker.
    const refs = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE id = $1)
       + (SELECT COUNT(*) FROM decks WHERE user_id = $1)
       + (SELECT COUNT(*) FROM deck_shares WHERE owner_id = $1 OR recipient_id = $1)
       + (SELECT COUNT(*) FROM groups WHERE owner_id = $1)
       + (SELECT COUNT(*) FROM group_members WHERE user_id = $1)
       + (SELECT COUNT(*) FROM group_decks WHERE added_by = $1)
       + (SELECT COUNT(*) FROM contacts WHERE requester_id = $1 OR addressee_id = $1)
       + (SELECT COUNT(*) FROM user_card_progress WHERE user_id = $1)
       AS refs`,
      [leaver.id]
    );
    assert.equal(Number(refs.rows[0].refs), 0);

    // Het gedeelde deck leeft eigenaarloos door; de volger houdt alles.
    const sharedRow = await pool.query(`SELECT * FROM decks WHERE id = $1`, [shared.id]);
    assert.equal(sharedRow.rows[0].user_id, null);
    assert.equal(sharedRow.rows[0].deleted_at, null);
    assert.equal(sharedRow.rows[0].is_public, false);

    const view = await request(app)
      .get(`/v2/decks/${shared.id}`)
      .set("Authorization", `Bearer ${friendToken}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.owner_username, null);
    assert.equal(view.body.can_edit, true);

    const friendProgress = await pool.query(
      `SELECT deleted_at FROM user_card_progress WHERE user_id = $1 AND card_id = $2`,
      [friend.id, card.id]
    );
    assert.equal(friendProgress.rows[0].deleted_at, null);

    // Het privé-deck is een eigenaarloze tombstone (blijft tot de
    // tombstone-purge bestaan, maar is voor iedereen weg).
    const privRow = await pool.query(`SELECT * FROM decks WHERE id = $1`, [priv.id]);
    assert.equal(privRow.rows[0].user_id, null);
    assert.notEqual(privRow.rows[0].deleted_at, null);
    createdDeckIds.push(priv.id);

    // Het deck van de vriend is onaangeroerd; alleen het abonnement van de
    // vertrekker is weg.
    const friendDeckRow = await pool.query(`SELECT user_id FROM decks WHERE id = $1`, [friendDeck.id]);
    assert.equal(friendDeckRow.rows[0].user_id, friend.id);

    // De groep is opgeheven: soft-deleted, eigenaarloos, leden weg.
    const groupRow = await pool.query(`SELECT * FROM groups WHERE id = $1`, [groupId]);
    assert.equal(groupRow.rows[0].owner_id, null);
    assert.notEqual(groupRow.rows[0].deleted_at, null);

    // Het ingetrokken token van de vertrekker kan sowieso nergens meer heen.
    const gone = await request(app)
      .get(`/v2/auth/me`)
      .set("Authorization", `Bearer ${leaverToken}`);
    assert.equal(gone.status, 401);
  });
});
