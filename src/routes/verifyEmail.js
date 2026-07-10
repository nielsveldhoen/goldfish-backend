import express from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";

// Browser-flow voor e-mailverificatie. De link uit de verificatiemail
// (APP_URL/auth/verify-email?token=...) opent in een browser, dus deze route
// leeft — net als de wachtwoord-reset — buiten het /v2-prefix en buiten de
// client-versiegate: een browser stuurt geen X-Client-Build mee. Gemount in
// app.js op /auth/verify-email.
//
// GET  ?token=...  → HTML-bevestigingspagina (of foutpagina bij ongeldig/verlopen token)
//
// Single-use: het token wordt bij het opvragen direct verwijderd, zodat een
// tweede klik op dezelfde link altijd als "ongeldig of verlopen" toont.

const router = express.Router();

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts, try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Geen inline JS (helmet-CSP blokkeert dat). Inline <style> valt binnen
// helmet's default style-src 'unsafe-inline'.
const page = (title, body) => `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Goldfish</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f6f7f9; color: #1c1c1e;
           display: flex; justify-content: center; padding: 48px 16px; }
    .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 420px;
            width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    h1 { font-size: 20px; margin: 0 0 16px; }
    p { font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;

const successPage = () =>
  page(
    "E-mail bevestigd",
    `<h1>🐟 E-mailadres bevestigd</h1>
     <p>Je e-mailadres is bevestigd. Je kunt nu in de Goldfish-app inloggen.</p>`
  );

const invalidPage = () =>
  page(
    "Link ongeldig",
    `<h1>🐟 Link ongeldig of verlopen</h1>
     <p>Deze verificatielink is niet (meer) geldig. Vraag in de app een nieuwe
     verificatiemail aan — die is 24 uur geldig.</p>`
  );

router.get("/", verifyLimiter, async (req, res) => {
  const { token } = req.query;

  if (!token || typeof token !== "string") {
    return res.status(400).send(invalidPage());
  }

  try {
    // Single-use: verwijder het token direct bij het opvragen, zodat een
    // tweede poging met hetzelfde token altijd faalt.
    const result = await pool.query(
      `DELETE FROM email_verification_tokens WHERE token = $1 RETURNING *`,
      [hashToken(token)]
    );

    const record = result.rows[0];

    if (!record || new Date(record.expires_at) < new Date()) {
      return res.status(400).send(invalidPage());
    }

    await pool.query(
      `UPDATE users SET email_verified = true WHERE id = $1`,
      [record.user_id]
    );

    res.send(successPage());
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .send(page("Fout", "<h1>Er ging iets mis</h1><p>Probeer het later opnieuw.</p>"));
  }
});

export default router;
