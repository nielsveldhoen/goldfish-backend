// Examens (EXAM_PLAN.md): benoemde deadline met een set decks, persoonlijk
// (owner) of per groep. De client-side scheduler past hierop het
// vervalalgoritme aan; de backend slaat alleen op en synct.
//
// Hive-first via snapshot: /sync/changes levert áltijd de volledige set
// toegankelijke examens (laag-cardinaal), de client vervangt zijn Hive-box
// integraal. Daarom hard delete (geen tombstones) en geen updated_at-delta.
// deck_ids zit embedded in het examen-object; muteren is set-replace via PUT.
//
// Rechten: lezen = eigen examens + examens van groepen waar ik actief lid
// van ben (gratis — een free groepslid moet examens zien en ermee trainen).
// Schrijven = owner (persoonlijk) of actief lid met role 'owner'/can_add_decks
// (groep), én entitlement EXAM_PLANNING — behalve DELETE: opruimen blijft
// vrij, een verlopen pro mag een examen dat de scheduling opjaagt altijd weg.
import express from "express";
import { pool } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireEntitlement } from "../middleware/entitlements.js";
import { ENTITLEMENTS } from "../config/products.js";
import { broadcast, broadcastGroup } from "../ws.js";
import { LIMITS, invalidString, invalidDate, firstError } from "../utils/validate.js";
import { canReadDeckSql } from "../utils/deckAccess.js";

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maximaal aantal decks per examen.
const MAX_EXAM_DECKS = 50;

// Leestoegang tot examen `alias`: persoonlijk van mij, of van een groep waar
// ik actief lid ben (soft-deleted groepen verbergen hun examens).
// LET OP: userParam komt meermaals terug; aanroeper gebruikt dezelfde index.
function canReadExamSql(alias, userParam) {
  return `((${alias}.owner_id = ${userParam} AND ${alias}.group_id IS NULL)
    OR EXISTS (
      SELECT 1 FROM group_members _gm
      JOIN groups _g ON _g.id = _gm.group_id AND _g.deleted_at IS NULL
      WHERE _gm.group_id = ${alias}.group_id
        AND _gm.user_id = ${userParam}
        AND _gm.status = 'active'))`;
}

// Schrijfrecht: persoonlijk = owner; groepsexamen = actief lid met role
// 'owner' of can_add_decks (zelfde recht als catalogus-decks toevoegen).
function canWriteExamSql(alias, userParam) {
  return `((${alias}.owner_id = ${userParam} AND ${alias}.group_id IS NULL)
    OR EXISTS (
      SELECT 1 FROM group_members _gm
      JOIN groups _g ON _g.id = _gm.group_id AND _g.deleted_at IS NULL
      WHERE _gm.group_id = ${alias}.group_id
        AND _gm.user_id = ${userParam}
        AND _gm.status = 'active'
        AND (_gm.role = 'owner' OR _gm.can_add_decks)))`;
}

// Canonieke examen-objecten met embedded deck_ids. De deck_ids worden per
// lezer gefilterd: persoonlijk examen → decks die ík mag lezen; groepsexamen
// → decks die nog in de groepscatalogus staan (de catalogus is voor elk lid
// zichtbaar, ook vóór dashboard-add). Soft-deleted decks vallen er altijd
// uit — een examen "krimpt" dus vanzelf mee, zonder updated_at-bump (de
// snapshot-sync levert toch elke keer de actuele stand).
// Wordt óók door sync.js gebruikt (exports onderaan).
export async function fetchExamObjects(db, userId, { examId = null } = {}) {
  const params = [userId];
  let where = canReadExamSql("e", "$1");
  if (examId) {
    params.push(examId);
    where = `e.id = $2 AND ${where}`;
  }

  const { rows } = await db.query(
    `SELECT e.id, e.owner_id, e.group_id, e.name, e.exam_date,
            e.created_at, e.updated_at,
            COALESCE(ed.deck_ids, '{}') AS deck_ids
     FROM exams e
     LEFT JOIN LATERAL (
       SELECT array_agg(x.deck_id ORDER BY x.created_at, x.deck_id) AS deck_ids
       FROM exam_decks x
       JOIN decks d ON d.id = x.deck_id AND d.deleted_at IS NULL
       WHERE x.exam_id = e.id
         AND CASE WHEN e.group_id IS NULL
              THEN ${canReadDeckSql("d", "$1")}
              ELSE EXISTS (SELECT 1 FROM group_decks _gd
                           WHERE _gd.group_id = e.group_id
                             AND _gd.deck_id = d.id)
             END
     ) ed ON true
     WHERE ${where}
     ORDER BY e.exam_date ASC, e.created_at ASC`,
    params
  );
  return rows;
}

async function fetchExamObject(db, userId, examId) {
  const [exam] = await fetchExamObjects(db, userId, { examId });
  return exam ?? null;
}

// WS-fan-out: persoonlijk → eigen devices; groepsexamen → alle leden
// (zelfde bereik als group_updated). Fire-and-forget.
function pushExamEvent(exam, type, payload) {
  const send = exam.group_id
    ? broadcastGroup(exam.group_id, type, [payload])
    : Promise.resolve(broadcast(exam.owner_id, type, [payload]));
  Promise.resolve(send)
    .catch((err) => console.error(`[exams] ${type} broadcast failed:`, err));
}

function invalidDeckIds(deck_ids) {
  if (deck_ids === undefined || deck_ids === null) return null;
  if (!Array.isArray(deck_ids)) return "deck_ids must be an array of deck ids";
  if (deck_ids.length > MAX_EXAM_DECKS) {
    return `Too many decks (max ${MAX_EXAM_DECKS})`;
  }
  for (const id of deck_ids) {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return "deck_ids must be an array of deck ids";
    }
  }
  return null;
}

// Valideert dat álle deck_ids binnen de scope van het examen vallen.
// Persoonlijk: leesbaar voor de user; groep: in de groepscatalogus.
// Geeft een 400-melding of null.
async function invalidDeckScope(db, deckIds, { userId, groupId }) {
  if (deckIds.length === 0) return null;
  const check = groupId
    ? await db.query(
        `SELECT COUNT(*)::int AS n FROM group_decks gd
         JOIN decks d ON d.id = gd.deck_id AND d.deleted_at IS NULL
         WHERE gd.group_id = $1 AND gd.deck_id = ANY($2::uuid[])`,
        [groupId, deckIds]
      )
    : await db.query(
        `SELECT COUNT(*)::int AS n FROM decks d
         WHERE d.id = ANY($2::uuid[]) AND d.deleted_at IS NULL
           AND ${canReadDeckSql("d", "$1")}`,
        [userId, deckIds]
      );
  if (check.rows[0].n !== deckIds.length) {
    return groupId ? "deck_not_in_group" : "deck_not_accessible";
  }
  return null;
}

// ========================
// GET /exams — alle toegankelijke examens (géén entitlement: lezen is vrij)
// ========================
router.get("/", authMiddleware, async (req, res) => {
  try {
    res.json(await fetchExamObjects(pool, req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// POST /exams 💰 — examen aanmaken (persoonlijk of groep)
// ========================
router.post("/", authMiddleware, requireEntitlement(ENTITLEMENTS.EXAM_PLANNING),
  async (req, res) => {
    const { name, exam_date, group_id } = req.body;
    // Dedupliceren: dubbele ids zouden anders op de UNIQUE stranden.
    const deckIds = [...new Set(req.body.deck_ids ?? [])];

    if (group_id !== undefined && group_id !== null
        && (typeof group_id !== "string" || !UUID_RE.test(group_id))) {
      return res.status(400).json({ error: "group_id must be a valid group id" });
    }
    const invalid = firstError(
      invalidString(name, "name", LIMITS.TITLE_MAX, { required: true }),
      invalidDate(exam_date, "exam_date", { required: true }),
      invalidDeckIds(req.body.deck_ids),
    );
    if (invalid) {
      return res.status(400).json({ error: invalid });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (group_id) {
        // Actief lid van een levende groep; schrijven vereist role 'owner'
        // of can_add_decks (zelfde ladder als POST /groups/:id/decks).
        const membership = await client.query(
          `SELECT gm.role, gm.can_add_decks FROM group_members gm
           JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
           WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.status = 'active'`,
          [group_id, req.user.id]
        );
        if (membership.rowCount === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Group not found" });
        }
        const m = membership.rows[0];
        if (m.role !== "owner" && !m.can_add_decks) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "not_allowed_to_manage_exams" });
        }
      }

      const scopeError = await invalidDeckScope(client, deckIds, {
        userId: req.user.id,
        groupId: group_id ?? null,
      });
      if (scopeError) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: scopeError });
      }

      const inserted = await client.query(
        `INSERT INTO exams (owner_id, group_id, name, exam_date)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [req.user.id, group_id ?? null, name, exam_date]
      );
      if (deckIds.length > 0) {
        await client.query(
          `INSERT INTO exam_decks (exam_id, deck_id)
           SELECT $1, unnest($2::uuid[])`,
          [inserted.rows[0].id, deckIds]
        );
      }

      await client.query("COMMIT");

      const exam = await fetchExamObject(pool, req.user.id, inserted.rows[0].id);
      pushExamEvent(exam, "exam_updated", exam);
      res.status(201).json(exam);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(500).json({ error: "Server error" });
    } finally {
      client.release();
    }
  });

// ========================
// PUT /exams/:id 💰 — naam/datum/deck_ids (set-replace) bijwerken
// ========================
// Scope (group_id) is immutabel na aanmaak. Zelfde stale-write-patroon als
// PUT /decks/:id: transactie + rij-lock, 409 met `current` bij een oudere
// client_updated_at.
router.put("/:id", authMiddleware, requireEntitlement(ENTITLEMENTS.EXAM_PLANNING),
  async (req, res) => {
    const { id } = req.params;
    const { name, exam_date, deck_ids, client_updated_at } = req.body;

    if (!UUID_RE.test(id)) {
      return res.status(404).json({ error: "Exam not found" });
    }
    const invalid = firstError(
      invalidString(name, "name", LIMITS.TITLE_MAX),
      invalidDate(exam_date, "exam_date"),
      invalidDeckIds(deck_ids),
      invalidDate(client_updated_at, "client_updated_at"),
    );
    if (invalid) {
      return res.status(400).json({ error: invalid });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const current = await client.query(
        `SELECT e.* FROM exams e
         WHERE e.id = $1 AND ${canWriteExamSql("e", "$2")}
         FOR UPDATE OF e`,
        [id, req.user.id]
      );
      if (current.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Exam not found" });
      }
      const exam = current.rows[0];

      if (client_updated_at && exam.updated_at > new Date(client_updated_at)) {
        await client.query("ROLLBACK");
        const currentObject = await fetchExamObject(pool, req.user.id, id);
        return res.status(409).json({ error: "stale_write", current: currentObject });
      }

      if (deck_ids !== undefined) {
        const deckIds = [...new Set(deck_ids ?? [])];
        const scopeError = await invalidDeckScope(client, deckIds, {
          userId: req.user.id,
          groupId: exam.group_id,
        });
        if (scopeError) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: scopeError });
        }
        await client.query(`DELETE FROM exam_decks WHERE exam_id = $1`, [id]);
        if (deckIds.length > 0) {
          await client.query(
            `INSERT INTO exam_decks (exam_id, deck_id)
             SELECT $1, unnest($2::uuid[])`,
            [id, deckIds]
          );
        }
      }

      // Altijd uitvoeren, ook bij een pure deck_ids-wijziging: de
      // updated_at-trigger bumpt dan mee (nodig voor stale-write en WS).
      await client.query(
        `UPDATE exams SET name = COALESCE($1, name),
                          exam_date = COALESCE($2, exam_date)
         WHERE id = $3`,
        [name ?? null, exam_date ?? null, id]
      );

      await client.query("COMMIT");

      const examObject = await fetchExamObject(pool, req.user.id, id);
      pushExamEvent(examObject, "exam_updated", examObject);
      res.json(examObject);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(500).json({ error: "Server error" });
    } finally {
      client.release();
    }
  });

// ========================
// DELETE /exams/:id — hard delete (bewust zónder entitlement: opruimen is vrij)
// ========================
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: "Exam not found" });
  }

  try {
    const deleted = await pool.query(
      `DELETE FROM exams e
       WHERE e.id = $1 AND ${canWriteExamSql("e", "$2")}
       RETURNING e.owner_id, e.group_id`,
      [id, req.user.id]
    );
    if (deleted.rowCount === 0) {
      return res.status(404).json({ error: "Exam not found" });
    }

    pushExamEvent(deleted.rows[0], "exam_removed", { id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
