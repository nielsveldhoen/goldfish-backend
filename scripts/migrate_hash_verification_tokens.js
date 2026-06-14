import "../src/config/env.js";
import crypto from "crypto";
import { pool } from "../src/db.js";

// Bestaande tokens staan in plaintext in de DB; vervang ze door hun
// sha256-hash zodat lopende verificatielinks blijven werken. Gehashte tokens
// zijn 64 hex-tekens — net als de ruwe tokens (32 random bytes → hex), dus we
// markeren gemigreerde rijen niet, maar draaien dit script precies één keer.
// Dubbel draaien is onschadelijk voor de veiligheid maar maakt lopende
// verificatielinks ongeldig (gebruikers kunnen een nieuwe mail aanvragen).

const result = await pool.query(`SELECT id, token FROM email_verification_tokens`);

for (const row of result.rows) {
  const hash = crypto.createHash("sha256").update(row.token).digest("hex");
  await pool.query(
    `UPDATE email_verification_tokens SET token = $1 WHERE id = $2`,
    [hash, row.id]
  );
}

console.log(`Migration complete: ${result.rowCount} verification token(s) hashed.`);
await pool.end();
