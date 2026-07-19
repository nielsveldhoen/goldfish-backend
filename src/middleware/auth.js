import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { securityEvent, clientIp } from "../utils/securityLog.js";

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

// 401's zijn de ruggengraat van de detectie: een piek erin betekent een
// gestolen/verlopen token dat blijft kloppen, of iemand die tokens raadt. Het
// pad gaat mee (zonder query string), het token nooit.
function reject(req, res, reason) {
  securityEvent("token_rejected", {
    ip: clientIp(req),
    reason,
    method: req.method,
    path: req.originalUrl.split("?")[0],
  });
  return res.status(401).json({ error: reason === "missing" ? "Unauthorized" : "Invalid token" });
}

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return reject(req, res, "missing");
  }

  const token = header.split(" ")[1];

  let decoded;
  try {
    // Algoritme gepind: wij tekenen alleen HS256 (generateToken.js). Zonder
    // pin accepteert jsonwebtoken elk HMAC-algoritme dat bij het secret past.
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch (err) {
    // Onderscheid maken tussen "verlopen" en "ongeldig" helpt bij het lezen van
    // het log: het eerste is normaal gebruik, het tweede is verdacht.
    return reject(req, res, err.name === "TokenExpiredError" ? "expired" : "invalid_signature");
  }

  // Revocatie-check tegen de DB: één PK-lookup per request (zelfde patroon en
  // schaal als de min_client_build-gate). Bewust géén fail-open — een
  // ingetrokken token mag bij een DB-storing niet alsnog werken.
  try {
    const { rows } = await pool.query(
      `SELECT tokens_valid_after FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (rows.length === 0) {
      return reject(req, res, "unknown_user");
    }
    if (isRevoked(decoded, rows[0].tokens_valid_after)) {
      return reject(req, res, "revoked");
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
