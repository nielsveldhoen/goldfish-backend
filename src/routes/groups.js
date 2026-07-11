// Groepen-routes (SHARING_PLAN.md, Release B). Besloten clubs met een
// deelbare join-code + geheim join-wachtwoord en een deck-catalogus.
// Lidmaatschap geeft GEEN deck-toegang: pas het "toevoegen" van een
// catalogus-deck maakt een deck_shares-rij (kind='group') aan — daardoor
// blijft deck_shares de enige toegangswaarheid en zijn join/leave/kick
// goedkoop (geen share-fan-out).
//
// Online-only Hive-data zoals contacts: geen sync-delta; de client leest
// GET /v2/groups en verwerkt de WS-events group_updated (vol object),
// group_invite_received (vol object), group_removed ({id}) en deck_removed.
// In group-responses staan NOOIT e-mailadressen — alleen user_id + username.
import crypto from "crypto";
import express from "express";
import argon2 from "argon2";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { broadcast, broadcastGroup } from "../ws.js";
import { LIMITS, invalidString, invalidBoolean, firstError } from "../utils/validate.js";
import { revokeShares } from "../utils/deckAccess.js";

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Join is een wachtwoord-verifiërend endpoint: zelfde brute-force-profiel als
// de auth-limiter.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts, try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Join-code: deelbare identificatie (niet geheim). Alfabet zonder
// verwarrende tekens (geen I/O/0/1); 8 tekens ≈ 40 bits — botsingen vangt de
// UNIQUE af met een retry.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateJoinCode() {
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function invalidGroupPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters";
  }
  if (password.length > LIMITS.PASSWORD_MAX) {
    return `Password too long (max ${LIMITS.PASSWORD_MAX} characters)`;
  }
  return null;
}

// ========================
// Canonieke group-objecten
// ========================
// Eén vorm voor alle kijkers: de client leidt zijn eigen rol/rechten af uit
// members[] (hij kent zijn user_id). join_code is zichtbaar voor leden —
// zonder wachtwoord is de code onbruikbaar, en zo kan elk lid nieuwe mensen
// aandragen.
async function fetchGroupObjects(db, groupIds) {
  if (groupIds.length === 0) return [];

  const [groups, members, decks] = await Promise.all([
    db.query(
      `SELECT id, name, description, join_code, owner_id, created_at, updated_at
       FROM groups WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [groupIds]
    ),
    db.query(
      `SELECT m.group_id, m.user_id, u.username, m.role, m.status,
              m.can_add_decks, m.created_at
       FROM group_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ANY($1::uuid[])
       ORDER BY m.created_at ASC`,
      [groupIds]
    ),
    db.query(
      `SELECT gd.group_id, gd.deck_id, d.title, d.description,
              gd.added_by, u.username AS added_by_username, gd.created_at AS added_at,
              (SELECT COUNT(*) FROM cards c
               WHERE c.deck_id = d.id AND c.deleted_at IS NULL) AS card_count
       FROM group_decks gd
       JOIN decks d ON d.id = gd.deck_id
       JOIN users u ON u.id = gd.added_by
       WHERE gd.group_id = ANY($1::uuid[]) AND d.deleted_at IS NULL
       ORDER BY gd.created_at DESC`,
      [groupIds]
    ),
  ]);

  return groups.rows.map((g) => ({
    ...g,
    members: members.rows
      .filter((m) => m.group_id === g.id)
      .map(({ group_id, ...m }) => m),
    decks: decks.rows
      .filter((d) => d.group_id === g.id)
      .map(({ group_id, ...d }) => d),
  }));
}

async function fetchGroupObject(db, groupId) {
  const [group] = await fetchGroupObjects(db, [groupId]);
  return group ?? null;
}

// Stuur het bijgewerkte group-object naar alle leden (vol object, zodat de
// client zijn Hive-box direct kan bijwerken). Fire-and-forget.
function pushGroupUpdate(groupId) {
  fetchGroupObject(pool, groupId)
    .then((group) => {
      if (group) return broadcastGroup(groupId, "group_updated", [group]);
    })
    .catch((err) => console.error("[groups] group_updated broadcast failed:", err));
}

// Actief lidmaatschap van req.user in group :id, of null. `forUpdate` binnen
// transacties (lockt de member-rij).
async function activeMembership(db, groupId, userId, { forUpdate = false } = {}) {
  const { rows } = await db.query(
    `SELECT m.* FROM group_members m
     JOIN groups g ON g.id = m.group_id
     WHERE m.group_id = $1 AND m.user_id = $2 AND m.status = 'active'
       AND g.deleted_at IS NULL
     ${forUpdate ? "FOR UPDATE OF m" : ""}`,
    [groupId, userId]
  );
  return rows[0] ?? null;
}

// ========================
// GET /groups — alle groepen waar ik lid van ben (ook openstaande invites)
// ========================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.group_id FROM group_members m
       JOIN groups g ON g.id = m.group_id
       WHERE m.user_id = $1 AND g.deleted_at IS NULL`,
      [req.user.id]
    );

    const groups = await fetchGroupObjects(pool, rows.map((r) => r.group_id));
    res.json(groups);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// POST /groups — groep aanmaken
// ========================
router.post("/", authMiddleware, async (req, res) => {
  const { name, description, password } = req.body;

  const invalid = firstError(
    invalidString(name, "name", LIMITS.TITLE_MAX, { required: true }),
    invalidString(description, "description", LIMITS.DESCRIPTION_MAX),
    invalidGroupPassword(password),
  );
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  // Hashen vóór pool.connect(): argon2 is bewust traag en hoeft geen
  // DB-connectie bezet te houden (zelfde patroon als auth.js).
  let hash;
  try {
    hash = await argon2.hash(password);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // join_code-botsing (23505 op de UNIQUE) is astronomisch zeldzaam; een
    // paar retries volstaan.
    let group;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await client.query(
          `INSERT INTO groups (owner_id, name, description, join_code, join_password_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [req.user.id, name, description || null, generateJoinCode(), hash]
        );
        group = result.rows[0];
        break;
      } catch (err) {
        if (err.code === "23505" && attempt < 2) continue;
        throw err;
      }
    }

    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [group.id, req.user.id]
    );

    await client.query("COMMIT");

    const groupObject = await fetchGroupObject(pool, group.id);
    // Eigen andere devices krijgen de nieuwe groep ook.
    broadcast(req.user.id, "group_updated", [groupObject]);

    res.status(201).json(groupObject);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// POST /groups/join — lid worden met code + wachtwoord
// ========================
// 404 bij onbekende code én bij fout wachtwoord: geen onderscheid lekken
// (de code is deelbaar, maar bevestigen dat hij bestaat helpt een gokker).
router.post("/join", authMiddleware, joinLimiter, async (req, res) => {
  const { code, password } = req.body;

  if (typeof code !== "string" || code.length === 0 || code.length > 32
      || typeof password !== "string" || password.length === 0
      || password.length > LIMITS.PASSWORD_LOGIN_MAX) {
    return res.status(400).json({ error: "code and password are required" });
  }

  try {
    const groupRes = await pool.query(
      `SELECT id, join_password_hash FROM groups
       WHERE join_code = $1 AND deleted_at IS NULL`,
      [code.toUpperCase().trim()]
    );

    // Ook bij onbekende code een argon2-verify draaien zou timing gelijk
    // trekken, maar de join-limiter (20/15min) maakt dat hier overbodig.
    if (groupRes.rowCount === 0
        || !(await argon2.verify(groupRes.rows[0].join_password_hash, password))) {
      return res.status(404).json({ error: "group_not_found" });
    }

    const groupId = groupRes.rows[0].id;

    // Upsert: een openstaande invite wordt door een geslaagde join
    // geactiveerd; een bestaand actief lid krijgt 409.
    const member = await pool.query(
      `INSERT INTO group_members (group_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')
       ON CONFLICT (group_id, user_id)
       DO UPDATE SET status = 'active', updated_at = NOW()
         WHERE group_members.status = 'invited'
       RETURNING *`,
      [groupId, req.user.id]
    );

    if (member.rowCount === 0) {
      return res.status(409).json({ error: "already_member" });
    }

    const groupObject = await fetchGroupObject(pool, groupId);
    broadcastGroup(groupId, "group_updated", [groupObject])
      .catch((err) => console.error("[groups] broadcast failed:", err));

    res.status(201).json(groupObject);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// PUT /groups/:id — naam/omschrijving (owner)
// ========================
router.put("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Group not found" });
  }

  const invalid = firstError(
    invalidString(name, "name", LIMITS.TITLE_MAX),
    invalidString(description, "description", LIMITS.DESCRIPTION_MAX),
  );
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  try {
    const result = await pool.query(
      `UPDATE groups
       SET name = COALESCE($1, name),
           description = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE description END
       WHERE id = $3 AND owner_id = $4 AND deleted_at IS NULL
       RETURNING id`,
      [name ?? null, description !== undefined ? description : null, id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupObject = await fetchGroupObject(pool, id);
    broadcastGroup(id, "group_updated", [groupObject])
      .catch((err) => console.error("[groups] broadcast failed:", err));

    res.json(groupObject);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// PUT /groups/:id/password — join-wachtwoord wisselen (owner, na een kick)
// ========================
router.put("/:id/password", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Group not found" });
  }

  const invalid = invalidGroupPassword(password);
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  try {
    const hash = await argon2.hash(password);
    const result = await pool.query(
      `UPDATE groups SET join_password_hash = $1
       WHERE id = $2 AND owner_id = $3 AND deleted_at IS NULL
       RETURNING id`,
      [hash, id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Group not found" });
    }

    res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// DELETE /groups/:id — groep opheffen (owner)
// ========================
// Revoket alle groepsshares (met progress-cascade waar het de laatste bron
// was), hard-delete van leden + catalogus, soft-delete van de groep zelf
// (gerevokete shares blijven ernaar verwijzen voor removed_deck_ids).
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Group not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const groupCheck = await client.query(
      `SELECT id FROM groups
       WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [id, req.user.id]
    );
    if (groupCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Group not found" });
    }

    // Ledenlijst vóór de delete pakken — daarna is hij weg.
    const members = await client.query(
      `SELECT user_id FROM group_members WHERE group_id = $1`,
      [id]
    );

    const removed = await revokeShares(client, { groupId: id });

    await client.query(`DELETE FROM group_decks WHERE group_id = $1`, [id]);
    await client.query(`DELETE FROM group_members WHERE group_id = $1`, [id]);
    await client.query(`UPDATE groups SET deleted_at = NOW() WHERE id = $1`, [id]);

    await client.query("COMMIT");

    for (const { user_id } of members.rows) {
      broadcast(user_id, "group_removed", [{ id }]);
    }
    for (const { deck_id, recipient_id } of removed) {
      broadcast(recipient_id, "deck_removed", [{ id: deck_id }]);
    }

    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// POST /groups/:id/invites — contact uitnodigen (elk actief lid)
// ========================
router.post("/:id/invites", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Group not found" });
  }
  if (typeof user_id !== "string" || !UUID_RE.test(user_id)) {
    return res.status(400).json({ error: "user_id is required" });
  }
  if (user_id === req.user.id) {
    return res.status(400).json({ error: "cannot_invite_self" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!(await activeMembership(client, id, req.user.id))) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Group not found" });
    }

    // Alleen eigen geaccepteerde contacten uitnodigen — zo kan niemand
    // willekeurige user_ids spammen.
    const contactCheck = await client.query(
      `SELECT 1 FROM contacts
       WHERE status = 'accepted'
         AND least(requester_id, addressee_id) = least($1::uuid, $2::uuid)
         AND greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`,
      [req.user.id, user_id]
    );
    if (contactCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "not_a_contact" });
    }

    const inserted = await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, invited_by)
       VALUES ($1, $2, 'member', 'invited', $3)
       ON CONFLICT (group_id, user_id) DO NOTHING
       RETURNING id`,
      [id, user_id, req.user.id]
    );

    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "already_exists" });
    }

    await client.query("COMMIT");

    const groupObject = await fetchGroupObject(pool, id);
    broadcast(user_id, "group_invite_received", [groupObject]);
    broadcastGroup(id, "group_updated", [groupObject], { excludeUserId: user_id })
      .catch((err) => console.error("[groups] broadcast failed:", err));

    res.status(201).json(groupObject);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// POST /groups/:id/invites/accept — uitnodiging accepteren
// ========================
router.post("/:id/invites/accept", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Group not found" });
  }

  try {
    const result = await pool.query(
      `UPDATE group_members m SET status = 'active', updated_at = NOW()
       FROM groups g
       WHERE m.group_id = $1 AND m.user_id = $2 AND m.status = 'invited'
         AND g.id = m.group_id AND g.deleted_at IS NULL
       RETURNING m.id`,
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Invite not found" });
    }

    const groupObject = await fetchGroupObject(pool, id);
    broadcastGroup(id, "group_updated", [groupObject])
      .catch((err) => console.error("[groups] broadcast failed:", err));

    res.json(groupObject);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// DELETE /groups/:id/invites — uitnodiging afwijzen
// ========================
router.delete("/:id/invites", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Group not found" });
  }

  try {
    const result = await pool.query(
      `DELETE FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND status = 'invited'
       RETURNING id`,
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Invite not found" });
    }

    // Eigen devices ruimen de aanvraag op; de leden zien hem verdwijnen.
    broadcast(req.user.id, "group_removed", [{ id }]);
    pushGroupUpdate(id);

    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// PUT /groups/:id/members/:user_id — bevoegdheden zetten (owner)
// ========================
router.put("/:id/members/:user_id", authMiddleware, async (req, res) => {
  const { id, user_id } = req.params;
  const { can_add_decks } = req.body;

  if (!UUID_RE.test(id) || !UUID_RE.test(user_id)) {
    return res.status(404).json({ error: "Member not found" });
  }

  const invalid = invalidBoolean(can_add_decks, "can_add_decks");
  if (invalid || can_add_decks === undefined) {
    return res.status(400).json({ error: invalid ?? "can_add_decks is required" });
  }

  try {
    const result = await pool.query(
      `UPDATE group_members m SET can_add_decks = $1, updated_at = NOW()
       FROM groups g
       WHERE m.group_id = $2 AND m.user_id = $3 AND m.role <> 'owner'
         AND g.id = m.group_id AND g.owner_id = $4 AND g.deleted_at IS NULL
       RETURNING m.id`,
      [can_add_decks, id, user_id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    const groupObject = await fetchGroupObject(pool, id);
    broadcastGroup(id, "group_updated", [groupObject])
      .catch((err) => console.error("[groups] broadcast failed:", err));

    res.json(groupObject);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// DELETE /groups/:id/members/:user_id — kick (owner) of zelf verlaten
// ========================
// Gevolgen: de shares van dit lid op deze groep worden gerevoket, en de decks
// die dit lid zélf had toegevoegd gaan mee de groep uit (het zijn zijn decks) —
// inclusief revoke van de shares van álle leden op die decks.
router.delete("/:id/members/:user_id", authMiddleware, async (req, res) => {
  const { id, user_id } = req.params;

  if (!UUID_RE.test(id) || !UUID_RE.test(user_id)) {
    return res.status(404).json({ error: "Member not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const groupRes = await client.query(
      `SELECT owner_id FROM groups WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id]
    );
    if (groupRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Group not found" });
    }

    const isSelf = user_id === req.user.id;
    const isOwner = groupRes.rows[0].owner_id === req.user.id;

    if (!isSelf && !isOwner) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Member not found" });
    }
    // De owner verlaat zijn groep niet — hij heft hem op (DELETE /groups/:id).
    if (isSelf && isOwner) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "owner_cannot_leave" });
    }

    const memberRes = await client.query(
      `DELETE FROM group_members
       WHERE group_id = $1 AND user_id = $2
       RETURNING status`,
      [id, user_id]
    );
    if (memberRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Member not found" });
    }

    // 1. De groepsshares van het vertrekkende lid zelf.
    const removedOwn = await revokeShares(client, { groupId: id, recipientId: user_id });

    // 2. Zijn eigen toegevoegde decks gaan mee de groep uit.
    const pulledDecks = await client.query(
      `DELETE FROM group_decks
       WHERE group_id = $1 AND added_by = $2
       RETURNING deck_id`,
      [id, user_id]
    );
    let removedOthers = [];
    if (pulledDecks.rowCount > 0) {
      removedOthers = await revokeShares(client, {
        groupId: id,
        deckIds: pulledDecks.rows.map((r) => r.deck_id),
      });
    }

    await client.query("COMMIT");

    broadcast(user_id, "group_removed", [{ id }]);
    pushGroupUpdate(id);
    for (const { deck_id, recipient_id } of [...removedOwn, ...removedOthers]) {
      broadcast(recipient_id, "deck_removed", [{ id: deck_id }]);
    }

    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// POST /groups/:id/decks — eigen deck aan de catalogus toevoegen
// ========================
router.post("/:id/decks", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { deck_id } = req.body;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Group not found" });
  }
  if (typeof deck_id !== "string" || !UUID_RE.test(deck_id)) {
    return res.status(400).json({ error: "deck_id is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const membership = await activeMembership(client, id, req.user.id);
    if (!membership) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Group not found" });
    }
    if (!membership.can_add_decks) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "not_allowed_to_add_decks" });
    }

    // Alleen eigen decks in de catalogus.
    const deckCheck = await client.query(
      `SELECT d.id FROM decks d
       WHERE d.id = $1 AND d.user_id = $2 AND d.deleted_at IS NULL`,
      [deck_id, req.user.id]
    );
    if (deckCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deck not found" });
    }

    const inserted = await client.query(
      `INSERT INTO group_decks (group_id, deck_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, deck_id) DO NOTHING
       RETURNING id`,
      [id, deck_id, req.user.id]
    );

    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "already_exists" });
    }

    await client.query("COMMIT");

    const groupObject = await fetchGroupObject(pool, id);
    broadcastGroup(id, "group_updated", [groupObject])
      .catch((err) => console.error("[groups] broadcast failed:", err));

    res.status(201).json(groupObject);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// DELETE /groups/:id/decks/:deck_id — deck uit de catalogus
// ========================
// Toegestaan voor de toevoeger (eigen deck terugtrekken) en de group-owner.
// Revoket de groepsshares van alle leden op dit deck.
router.delete("/:id/decks/:deck_id", authMiddleware, async (req, res) => {
  const { id, deck_id } = req.params;

  if (!UUID_RE.test(id) || !UUID_RE.test(deck_id)) {
    return res.status(404).json({ error: "Deck not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const deleted = await client.query(
      `DELETE FROM group_decks gd
       USING groups g
       WHERE gd.group_id = $1 AND gd.deck_id = $2
         AND g.id = gd.group_id AND g.deleted_at IS NULL
         AND (gd.added_by = $3 OR g.owner_id = $3)
       RETURNING gd.id`,
      [id, deck_id, req.user.id]
    );

    if (deleted.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deck not found" });
    }

    const removed = await revokeShares(client, { groupId: id, deckId: deck_id });

    await client.query("COMMIT");

    pushGroupUpdate(id);
    for (const { deck_id: dId, recipient_id } of removed) {
      broadcast(recipient_id, "deck_removed", [{ id: dId }]);
    }

    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// POST /groups/:id/decks/:deck_id/add — catalogus-deck aan mijn dashboard
// ========================
// Dít maakt de deck_shares-rij (kind='group'). Het deck verschijnt daarna via
// de normale sync; weghalen kan met DELETE /decks/:id/follow.
router.post("/:id/decks/:deck_id/add", authMiddleware, async (req, res) => {
  const { id, deck_id } = req.params;

  if (!UUID_RE.test(id) || !UUID_RE.test(deck_id)) {
    return res.status(404).json({ error: "Deck not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!(await activeMembership(client, id, req.user.id))) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Group not found" });
    }

    const deckCheck = await client.query(
      `SELECT d.user_id FROM group_decks gd
       JOIN decks d ON d.id = gd.deck_id
       WHERE gd.group_id = $1 AND gd.deck_id = $2 AND d.deleted_at IS NULL`,
      [id, deck_id]
    );
    if (deckCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deck not found" });
    }
    // Eigen deck "toevoegen" is betekenisloos — dat staat al op je dashboard.
    if (deckCheck.rows[0].user_id === req.user.id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "own_deck" });
    }

    const share = await client.query(
      `INSERT INTO deck_shares (deck_id, owner_id, recipient_id, kind, group_id)
       VALUES ($1, $2, $3, 'group', $4)
       ON CONFLICT (deck_id, recipient_id, group_id) WHERE group_id IS NOT NULL
       DO UPDATE SET revoked_at = NULL, inactive = false, updated_at = NOW()
       RETURNING *`,
      [deck_id, deckCheck.rows[0].user_id, req.user.id, id]
    );

    await client.query("COMMIT");

    res.status(201).json(share.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
