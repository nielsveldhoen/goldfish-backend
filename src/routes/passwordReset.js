import express from "express";
import argon2 from "argon2";
import crypto from "crypto";
import { pool } from "../db.js";
import { authLimiter as resetLimiter } from "../middleware/limiters.js";
import { LIMITS } from "../utils/validate.js";
import { isCommonPassword, COMMON_PASSWORD_ERROR } from "../utils/commonPasswords.js";

// Browser-flow voor de wachtwoord-reset. De link uit de mail
// (APP_URL/auth/reset-password?token=...) opent in een browser, dus deze
// routes leven buiten het /v2-prefix en buiten de client-versiegate: een
// browser stuurt geen X-Client-Build mee. Gemount in app.js op
// /auth/reset-password.
//
// GET  ?token=...  → HTML-formulier (of foutpagina bij ongeldig/verlopen token)
// POST             → voert de reset uit; accepteert het browserformulier
//                    (urlencoded) én JSON (voor een toekomstige in-app-flow)
//
// Een geslaagde reset:
//   - zet het nieuwe password_hash
//   - zet email_verified = true (de reset bewijst bezit van de mailbox)
//   - zet tokens_valid_after = NOW() → alle bestaande JWT's zijn ingetrokken
//   - verwijdert alle reset-tokens van de gebruiker (single-use)

const router = express.Router();

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// Geen inline JS (helmet-CSP blokkeert dat); puur een form-POST.
// Inline <style> valt binnen helmet's default style-src 'unsafe-inline'.
const page = (title, body) => `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Goldfish</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f6f7f9; color: #1c1c1e;
           display: flex; justify-content: center; padding: 48px 16px; }
    .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 420px;
            width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    h1 { font-size: 20px; margin: 0 0 16px; }
    label { display: block; font-size: 14px; margin: 12px 0 4px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 10px;
            border: 1px solid #ccc; border-radius: 8px; font-size: 16px; }
    button { margin-top: 20px; width: 100%; padding: 12px; border: 0;
             border-radius: 8px; background: #e8863a; color: #fff;
             font-size: 16px; cursor: pointer; }
    p { font-size: 14px; line-height: 1.5; }
    .error { color: #b00020; }
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;

const formPage = (token, errorMsg = "") =>
  page(
    "Nieuw wachtwoord",
    `<h1>🐟 Nieuw wachtwoord instellen</h1>
     ${errorMsg ? `<p class="error">${escapeHtml(errorMsg)}</p>` : ""}
     <form method="POST" action="">
       <input type="hidden" name="token" value="${escapeHtml(token)}">
       <label for="password">Nieuw wachtwoord (minimaal 8 tekens)</label>
       <input type="password" id="password" name="password" minlength="8" required autofocus>
       <label for="confirm">Herhaal wachtwoord</label>
       <input type="password" id="confirm" name="confirm" minlength="8" required>
       <button type="submit">Wachtwoord opslaan</button>
     </form>`
  );

const invalidPage = () =>
  page(
    "Link ongeldig",
    `<h1>🐟 Link ongeldig of verlopen</h1>
     <p>Deze reset-link is niet (meer) geldig. Vraag in de app via
     "Wachtwoord vergeten" een nieuwe link aan — die is 1 uur geldig.</p>`
  );

const successPage = () =>
  page(
    "Wachtwoord gewijzigd",
    `<h1>🐟 Wachtwoord gewijzigd</h1>
     <p>Je wachtwoord is aangepast en je bent op alle apparaten uitgelogd.
     Log in de app opnieuw in met je nieuwe wachtwoord.</p>`
  );

// Levend token-record of null; verlopen exemplaren tellen als afwezig.
async function findValidToken(rawToken) {
  const { rows } = await pool.query(
    `SELECT user_id, expires_at FROM password_reset_tokens WHERE token = $1`,
    [hashToken(rawToken)]
  );
  const record = rows[0];
  if (!record || new Date(record.expires_at) < new Date()) return null;
  return record;
}

router.get("/", resetLimiter, async (req, res) => {
  const { token } = req.query;

  if (!token || typeof token !== "string") {
    return res.status(400).send(invalidPage());
  }

  try {
    const record = await findValidToken(token);
    if (!record) return res.status(400).send(invalidPage());
    res.send(formPage(token));
  } catch (err) {
    console.error(err);
    res.status(500).send(page("Fout", "<h1>Er ging iets mis</h1><p>Probeer het later opnieuw.</p>"));
  }
});

router.post("/", resetLimiter, async (req, res) => {
  const wantsJson = req.is("application/json");
  const { token, password, confirm } = req.body ?? {};

  const fail = (status, htmlBody, jsonError) =>
    wantsJson
      ? res.status(status).json({ error: jsonError })
      : res.status(status).send(htmlBody);

  if (!token || typeof token !== "string") {
    return fail(400, invalidPage(), "Missing token");
  }

  if (typeof password !== "string" || password.length < 8) {
    return fail(400, formPage(token, "Wachtwoord moet minimaal 8 tekens zijn."), "Password must be at least 8 characters");
  }

  // Zelfde bovengrens als bij registratie: argon2 over enorme input is
  // onnodig traag.
  if (password.length > LIMITS.PASSWORD_MAX) {
    return fail(400, formPage(token, `Wachtwoord mag maximaal ${LIMITS.PASSWORD_MAX} tekens zijn.`), `Password too long (max ${LIMITS.PASSWORD_MAX} characters)`);
  }

  // Zelfde blocklist als bij registratie — een reset is geen achterdeur om
  // alsnog "password123" in te stellen.
  if (isCommonPassword(password)) {
    return fail(400, formPage(token, "Dit wachtwoord is te vaak gelekt. Kies een minder voorspelbaar wachtwoord."), COMMON_PASSWORD_ERROR);
  }

  // `confirm` komt alleen van het browserformulier; JSON-callers laten hem weg.
  if (confirm !== undefined && confirm !== password) {
    return fail(400, formPage(token, "De wachtwoorden komen niet overeen."), "Passwords do not match");
  }

  try {
    const record = await findValidToken(token);
    if (!record) return fail(400, invalidPage(), "Invalid or expired token");

    const hash = await argon2.hash(password);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE users
         SET password_hash = $1,
             email_verified = true,
             tokens_valid_after = NOW()
         WHERE id = $2`,
        [hash, record.user_id]
      );
      await client.query(
        `DELETE FROM password_reset_tokens WHERE user_id = $1`,
        [record.user_id]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return wantsJson
      ? res.json({ message: "Password updated; all sessions revoked" })
      : res.send(successPage());

  } catch (err) {
    console.error(err);
    return fail(500, page("Fout", "<h1>Er ging iets mis</h1><p>Probeer het later opnieuw.</p>"), "Server error");
  }
});

export default router;
