import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET;

// Weigert tokens die vóór het revocatie-watermerk van de gebruiker zijn
// uitgegeven (users.tokens_valid_after, gezet door POST /auth/logout-all en
// door een geslaagde wachtwoord-reset). iat is in seconden; een token uit
// exact dezelfde seconde als het watermerk telt als ingetrokken.
export function isRevoked(decoded, tokensValidAfter) {
  if (!tokensValidAfter) return false;
  if (!decoded.iat) return true; // tokens zonder iat zijn niet te beoordelen
  return decoded.iat * 1000 < tokensValidAfter.getTime();
}

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = header.split(" ")[1];

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }

  // Revocatie-check tegen de DB: één PK-lookup per request (zelfde patroon en
  // schaal als de min_client_build-gate). Bewust géén fail-open — een
  // ingetrokken token mag bij een DB-storing niet alsnog werken.
  try {
    const { rows } = await pool.query(
      `SELECT tokens_valid_after FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (rows.length === 0 || isRevoked(decoded, rows[0].tokens_valid_after)) {
      return res.status(401).json({ error: "Invalid token" });
    }
  } catch (err) {
    console.error("auth middleware: revocation lookup failed", err);
    return res.status(500).json({ error: "Server error" });
  }

  req.user = {
    id: decoded.userId
  };

  next();
}
