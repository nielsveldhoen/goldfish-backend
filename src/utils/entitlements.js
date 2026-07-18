// Entitlement-laag boven de subscriptions-tabel (migratie 022): welke
// features heeft deze gebruiker nú? Aparte util zodat routes, middleware en
// /auth/me dezelfde definitie van "actief abonnement" delen.
import { pool } from "../db.js";
import { entitlementsFor } from "../config/products.js";

// SQL-definitie van "actief": periode loopt. canceled_at telt bewust NIET
// mee — opzeggen stopt verlenging, de betaalde periode loopt door tot
// expires_at (app-store-semantiek, zie migratie 022).
export const ACTIVE_SUBSCRIPTION_SQL =
  `started_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())`;

// Alle abonnementsrijen van een user (historie incl. verlopen), met een
// berekende `active`-kolom. Voedt GET /subscriptions.
export async function getSubscriptions(userId) {
  const { rows } = await pool.query(
    `SELECT id, product_key, started_at, expires_at, canceled_at, source,
            (${ACTIVE_SUBSCRIPTION_SQL}) AS active
     FROM subscriptions
     WHERE user_id = $1
     ORDER BY started_at DESC`,
    [userId]
  );
  return rows;
}

// Set van entitlement-keys die de actieve abonnementen samen ontgrendelen.
// Eén PK-achtige lookup per aanroep (zelfde patroon en schaal als de
// revocatie-check in het auth-middleware).
export async function getEntitlements(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT product_key FROM subscriptions
     WHERE user_id = $1 AND ${ACTIVE_SUBSCRIPTION_SQL}`,
    [userId]
  );
  return entitlementsFor(rows.map((r) => r.product_key));
}
