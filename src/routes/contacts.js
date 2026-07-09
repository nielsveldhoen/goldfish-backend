import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { broadcast } from "../ws.js";
import { LIMITS } from "../utils/validate.js";

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bewust simpele e-mailcheck: één @ met iets ervoor en een punt-domein erachter.
// De echte bron van waarheid is het bestaan van een user-rij; deze check dient
// alleen om overduidelijk ongeldige input met 400 af te wijzen (spec: "Ook 400
// bij ontbrekend/ongeldig e-mailformaat").
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Bouwt het contact-object zoals de client het verwacht, berekend t.o.v. de
// gebruiker `viewerId` die het ontvangt. `row` is een join van contacts met de
// ANDERE gebruiker (velden other_id/other_username/other_email al meegeselecteerd
// door de query hieronder).
//
// status-afleiding t.o.v. viewer:
//   accepted                → "accepted"
//   pending & viewer=requester → "pending_outgoing"
//   pending & viewer=addressee → "pending_incoming"
function toContactObject(row, viewerId) {
  let status;
  if (row.status === "accepted") {
    status = "accepted";
  } else if (row.requester_id === viewerId) {
    status = "pending_outgoing";
  } else {
    status = "pending_incoming";
  }

  const otherId = row.requester_id === viewerId ? row.addressee_id : row.requester_id;

  return {
    id: row.id,
    user_id: otherId,
    username: row.other_username,
    email: row.other_email,
    status,
    created_at: row.created_at,
  };
}

// Haalt één contact-rij op, samen met de gegevens van de ANDERE gebruiker t.o.v.
// `viewerId`. Retourneert de rij (met other_username/other_email) of undefined.
async function fetchContactRow(client, id, viewerId) {
  const { rows } = await client.query(
    `SELECT c.*,
            other.id       AS other_id,
            other.username AS other_username,
            other.email    AS other_email
       FROM contacts c
       JOIN users other
         ON other.id = CASE WHEN c.requester_id = $2 THEN c.addressee_id ELSE c.requester_id END
      WHERE c.id = $1
        AND (c.requester_id = $2 OR c.addressee_id = $2)`,
    [id, viewerId]
  );
  return rows[0];
}

// ========================
// GET ALL CONTACTS
// ========================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              other.id       AS other_id,
              other.username AS other_username,
              other.email    AS other_email
         FROM contacts c
         JOIN users other
           ON other.id = CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END
        WHERE c.requester_id = $1 OR c.addressee_id = $1
        ORDER BY c.created_at DESC`,
      [req.user.id]
    );

    res.json(rows.map((row) => toContactObject(row, req.user.id)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// INVITE (op e-mailadres)
// ========================
router.post("/", authMiddleware, async (req, res) => {
  const { email } = req.body;

  if (typeof email !== "string" || email.length > LIMITS.EMAIL_MAX || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }

  const emailNormalized = email.toLowerCase().trim();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Zoek de doelgebruiker (case-insensitief; e-mails worden bij register
    //    al lowercase opgeslagen, LOWER() maakt het robuust tegen oude data).
    const target = await client.query(
      `SELECT id, username, email FROM users WHERE LOWER(email) = $1`,
      [emailNormalized]
    );

    if (target.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "user_not_found" });
    }

    const other = target.rows[0];

    // 2. Zichzelf uitnodigen mag niet.
    if (other.id === req.user.id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "cannot_invite_self" });
    }

    // 3. Bestaat er al een relatie tussen dit paar (welke richting/status dan
    //    ook)? De unique index vangt de race, maar we checken expliciet voor de
    //    nette 409-melding.
    const existing = await client.query(
      `SELECT 1 FROM contacts
        WHERE least(requester_id, addressee_id) = least($1::uuid, $2::uuid)
          AND greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`,
      [req.user.id, other.id]
    );

    if (existing.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "already_exists" });
    }

    // 4. Maak de pending-rij aan.
    const inserted = await client.query(
      `INSERT INTO contacts (requester_id, addressee_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [req.user.id, other.id]
    );

    await client.query("COMMIT");

    const contact = inserted.rows[0];

    // Rij verrijkt met de gegevens van beide kanten, zodat we per perspectief
    // het juiste object kunnen bouwen.
    const requesterView = {
      ...contact,
      other_username: other.username,
      other_email: other.email,
    };

    // Voor het addressee-perspectief hebben we de gegevens van de afzender (ik)
    // nodig als "andere" persoon.
    const meRes = await pool.query(
      `SELECT username, email FROM users WHERE id = $1`,
      [req.user.id]
    );
    const me = meRes.rows[0];
    const addresseeView = {
      ...contact,
      other_username: me.username,
      other_email: me.email,
    };

    // Realtime: elk device krijgt het object zoals GET /contacts het voor díe
    // gebruiker zou teruggeven.
    broadcast(other.id, "contact_invited", [toContactObject(addresseeView, other.id)]);
    broadcast(req.user.id, "contact_invited", [toContactObject(requesterView, req.user.id)]);

    res.status(201).json(toContactObject(requesterView, req.user.id));
  } catch (err) {
    await client.query("ROLLBACK");
    // Race: unique-index-violation ondanks de check hierboven → already_exists.
    if (err.code === "23505") {
      return res.status(409).json({ error: "already_exists" });
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// ACCEPT (inkomend verzoek)
// ========================
router.post("/:id/accept", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "not_found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock de rij: alleen de addressee mag accepteren. Onbekend / niet van jou
    // (of jij bent de requester) → 404.
    const current = await client.query(
      `SELECT * FROM contacts
        WHERE id = $1 AND addressee_id = $2
        FOR UPDATE`,
      [id, req.user.id]
    );

    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }

    if (current.rows[0].status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "not_pending" });
    }

    await client.query(
      `UPDATE contacts SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await client.query("COMMIT");

    // Beide perspectieven ophalen voor de broadcast + response.
    const accepterRow = await fetchContactRow(pool, id, req.user.id);
    const requesterId = current.rows[0].requester_id;
    const requesterRow = await fetchContactRow(pool, id, requesterId);

    broadcast(req.user.id, "contact_accepted", [toContactObject(accepterRow, req.user.id)]);
    broadcast(requesterId, "contact_accepted", [toContactObject(requesterRow, requesterId)]);

    res.json(toContactObject(accepterRow, req.user.id));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ========================
// DELETE (afwijzen / annuleren / verwijderen)
// ========================
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "not_found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Hard delete; toegestaan als ik requester of addressee ben, elke status.
    const result = await client.query(
      `DELETE FROM contacts
        WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2)
        RETURNING requester_id, addressee_id`,
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }

    await client.query("COMMIT");

    const { requester_id, addressee_id } = result.rows[0];
    const otherId = requester_id === req.user.id ? addressee_id : requester_id;

    // Alleen het relatie-id volstaat; de client verwijdert de lokale rij daarmee.
    broadcast(otherId, "contact_rejected", [{ id }]);
    broadcast(req.user.id, "contact_rejected", [{ id }]);

    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
