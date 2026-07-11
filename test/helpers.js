import "../src/config/env.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../src/db.js";

export function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

export function expiredTokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "-10s" });
}

export function wrongSecretTokenFor(userId) {
  return jwt.sign({ userId }, "not-the-real-secret", { expiresIn: "1h" });
}

export async function createUser() {
  const suffix = crypto.randomBytes(6).toString("hex");
  const result = await pool.query(
    `INSERT INTO users (email, username, password_hash, email_verified)
     VALUES ($1, $2, $3, true)
     RETURNING *`,
    [`test-${suffix}@goldfish.test`, `test-${suffix}`, "x"]
  );
  return result.rows[0];
}

export async function createDeck(userId, title = "Testdeck") {
  const result = await pool.query(
    `INSERT INTO decks (user_id, title) VALUES ($1, $2) RETURNING *`,
    [userId, title]
  );
  return result.rows[0];
}

export async function createCard(deckId) {
  const result = await pool.query(
    `INSERT INTO cards (deck_id, question, answer)
     VALUES ($1, 'vraag?', 'antwoord') RETURNING *`,
    [deckId]
  );
  return result.rows[0];
}

export async function createProgress(userId, cardId) {
  const result = await pool.query(
    `INSERT INTO user_card_progress (user_id, card_id, remote_score, stable_score, due_date, repetitions, is_core)
     VALUES ($1, $2, 2, 1, '2026-01-01', 'x', false) RETURNING *`,
    [userId, cardId]
  );
  return result.rows[0];
}

// Wederzijds geaccepteerd contact tussen twee users (voorwaarde voor delen).
export async function createContact(userIdA, userIdB, status = "accepted") {
  const result = await pool.query(
    `INSERT INTO contacts (requester_id, addressee_id, status)
     VALUES ($1, $2, $3) RETURNING *`,
    [userIdA, userIdB, status]
  );
  return result.rows[0];
}

export async function cleanupUser(userId) {
  // Sharing/groepen eerst: deck_shares en group_decks hebben FK's zonder
  // cascade naar decks, en deck_shares.group_id verwijst naar groups.
  await pool.query(
    `DELETE FROM deck_shares
     WHERE owner_id = $1 OR recipient_id = $1
        OR deck_id IN (SELECT id FROM decks WHERE user_id = $1)
        OR group_id IN (SELECT id FROM groups WHERE owner_id = $1)`,
    [userId]
  );
  await pool.query(
    `DELETE FROM group_decks
     WHERE added_by = $1
        OR deck_id IN (SELECT id FROM decks WHERE user_id = $1)
        OR group_id IN (SELECT id FROM groups WHERE owner_id = $1)`,
    [userId]
  );
  await pool.query(
    `DELETE FROM group_members
     WHERE user_id = $1 OR group_id IN (SELECT id FROM groups WHERE owner_id = $1)`,
    [userId]
  );
  await pool.query(`DELETE FROM groups WHERE owner_id = $1`, [userId]);
  await pool.query(
    `DELETE FROM contacts WHERE requester_id = $1 OR addressee_id = $1`,
    [userId]
  );
  await pool.query(`DELETE FROM user_card_progress WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM deck_stats WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM user_daily_snapshot WHERE user_id = $1`, [userId]);
  await pool.query(
    `DELETE FROM cards WHERE deck_id IN (SELECT id FROM decks WHERE user_id = $1)`,
    [userId]
  );
  await pool.query(`DELETE FROM decks WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

export async function closePool() {
  await pool.end();
}
