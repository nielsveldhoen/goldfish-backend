import express from "express";
import argon2 from "argon2";
import crypto from "crypto";
import { pool } from "../db.js";
import { generateToken } from "../utils/generateToken.js";
import { sendVerificationEmail, mailer } from "../utils/sendVerificationEmail.js";
import { authMiddleware } from "../middleware/auth.js";
import { authLimiter } from "../middleware/limiters.js";
import { securityEvent, clientIp } from "../utils/securityLog.js";
import { LIMITS } from "../utils/validate.js";
import { isCommonPassword, COMMON_PASSWORD_ERROR } from "../utils/commonPasswords.js";
import { ACCOUNT_DELETION_GRACE_DAYS } from "../config/retention.js";

const router = express.Router();

// Verificatietokens worden gehasht opgeslagen; alleen de hash staat in de DB,
// de gebruiker krijgt het ruwe token per mail.
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

// Dummy-hash voor het onbekende-user-pad bij login. Zonder deze verify is het
// antwoord op een niet-bestaand account meetbaar sneller dan op een bestaand
// account met fout wachtwoord — dan is de anti-enumeration van register/forgot
// alsnog te omzeilen via de klok. Eén keer berekend bij het opstarten, over een
// random string zodat de hash zelf niets prijsgeeft.
const dummyHash = argon2.hash(crypto.randomBytes(32).toString("hex"));

// Wanneer de purge-job een aangevraagde verwijdering definitief maakt.
const deletionEffectiveAt = (requestedAt) =>
  new Date(new Date(requestedAt).getTime() + ACCOUNT_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);

// HEALTH CHECK
router.get("/ping", (req, res) => {
  console.log("PING HIT");
  res.send("pong");
});


// ========================
// REGISTER
// ========================
router.post("/register", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const username = req.body.username;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing fields" });
  }

  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  // Bovengrens: argon2 over megabytes aan input is onnodig traag (DoS-vector
  // binnen de 1MB body-limit).
  if (password.length > LIMITS.PASSWORD_MAX) {
    return res.status(400).json({ error: `Password too long (max ${LIMITS.PASSWORD_MAX} characters)` });
  }

  if (typeof email !== "string" || email.length > LIMITS.EMAIL_MAX) {
    return res.status(400).json({ error: "Invalid email" });
  }

  if (username !== undefined && username !== null
      && (typeof username !== "string" || username.length > LIMITS.USERNAME_MAX)) {
    return res.status(400).json({ error: `Username too long (max ${LIMITS.USERNAME_MAX} characters)` });
  }

  // Geen complexity-regels (die leveren vooral "Passw0rd!"), wél een blocklist:
  // de wachtwoorden die in elke credential-stuffing-lijst bovenaan staan.
  if (isCommonPassword(password)) {
    return res.status(400).json({ error: COMMON_PASSWORD_ERROR });
  }

  const emailNormalized = email.toLowerCase().trim();
  const usernameNormalized = (username || email.split("@")[0]).toLowerCase().trim();

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Hashen vóór pool.connect(): argon2 is bewust traag en hoeft geen
  // DB-connectie bezet te houden.
  let hash;
  try {
    hash = await argon2.hash(password);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }

  // User- en token-insert in één transactie: faalt de tweede insert, dan
  // blijft er geen account zonder verificatietoken achter.
  const client = await pool.connect();
  let duplicate = false;
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO users (email, username, password_hash, email_verified)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [emailNormalized, usernameNormalized, hash]
    );

    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [result.rows[0].id, hashToken(token), expiresAt]
    );

    await client.query("COMMIT");

  } catch (err) {
    await client.query("ROLLBACK");

    if (err.code === "23505") {
      duplicate = true;
    } else {
      console.error(err);
      return res.status(500).json({ error: "Server error" });
    }
  } finally {
    client.release();
  }

  // Anti-enumeration: of een e-mailadres al een account heeft mag niet uit de
  // API-response af te leiden zijn. Bestaat het e-mailadres al, antwoord dan
  // exact zoals bij een geslaagde registratie en mail de échte eigenaar (die
  // kan via "wachtwoord vergeten" weer bij zijn account). Alleen een bezette
  // username bij een vrij e-mailadres geeft een 400 — dat is onmisbare UX en
  // usernames zijn geen geheim.
  if (duplicate) {
    try {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM users WHERE email = $1`,
        [emailNormalized]
      );
      if (rowCount === 0) {
        return res.status(400).json({ error: "Username already taken" });
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Server error" });
    }

    try {
      await mailer.sendAccountExistsEmail(emailNormalized);
    } catch (err) {
      console.error("account-exists email failed:", err);
      return res.status(200).json({
        message: "Registration successful, but the verification email could not be sent. Request a new one via resend.",
        email_sent: false
      });
    }
    return res.status(200).json({
      message: "Registration successful. Check your email to verify your account.",
      email_sent: true
    });
  }

  // De mail valt buiten de transactie: het account bestaat op dit punt al,
  // dus een mail-fout is geen registratiefout. De gebruiker kan via
  // /auth/resend-verification een nieuwe mail aanvragen.
  try {
    await sendVerificationEmail(emailNormalized, token);
  } catch (err) {
    console.error("verification email failed:", err);
    return res.status(200).json({
      message: "Registration successful, but the verification email could not be sent. Request a new one via resend.",
      email_sent: false
    });
  }

  res.status(200).json({
    message: "Registration successful. Check your email to verify your account.",
    email_sent: true
  });
});


// ========================
// LOGIN (email OR username)
// ========================
router.post("/login", authLimiter, async (req, res) => {
  const identifier = req.body.identifier || req.body.email;
  const { password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Ruimer dan PASSWORD_MAX zodat wachtwoorden van vóór die limiet blijven
  // werken; alles daarboven kan nooit geldig zijn en hoeft argon2 niet in.
  if (typeof password !== "string" || password.length > LIMITS.PASSWORD_LOGIN_MAX
      || typeof identifier !== "string" || identifier.length > LIMITS.EMAIL_MAX) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const isEmail = identifier.includes("@");

  try {
    const result = await pool.query(
      isEmail
        ? "SELECT * FROM users WHERE email = $1"
        : "SELECT * FROM users WHERE username = $1",
      [identifier.toLowerCase().trim()]
    );

    const user = result.rows[0];

    // Ook zonder user één argon2.verify draaien (tegen de dummy-hash): beide
    // paden kosten dan even veel tijd, zodat "bestaat dit account?" niet uit de
    // responstijd valt af te lezen.
    const valid = await argon2
      .verify(user ? user.password_hash : await dummyHash, password)
      .catch(() => false); // corrupt/legacy hash telt als ongeldig, niet als 500

    if (!user || !valid) {
      // Géén identifier in het log (zie utils/securityLog.js): de reden-code
      // volstaat om een aanval te herkennen, en zo lekt het log zelf geen
      // e-mailadressen.
      securityEvent("login_failed", {
        ip: clientIp(req),
        reason: user ? "bad_password" : "unknown_account",
      });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.email_verified) {
      securityEvent("login_blocked", {
        ip: clientIp(req),
        user_id: user.id,
        reason: "email_unverified",
      });
      return res.status(403).json({ error: "Email not verified" });
    }

    const token = generateToken(user.id);

    // Staat er een verwijderaanvraag open, dan mag de eigenaar gewoon
    // inloggen (bedenktijd): de client toont de deadline en de
    // annuleerknop (POST /auth/me/restore).
    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username
      },
      token,
      ...(user.deletion_requested_at && {
        deletion_pending_until: deletionEffectiveAt(user.deletion_requested_at),
      }),
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// VERIFY EMAIL
// ========================
// De GET /auth/verify-email-route is een browser-flow en leeft buiten het
// /v2-prefix (geen X-Client-Build in een browser), zie src/routes/verifyEmail.js.

// ========================
// RESEND VERIFICATION EMAIL
// ========================
router.post("/resend-verification", authLimiter, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  try {
    const result = await pool.query(
      `SELECT id, email, email_verified FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    const user = result.rows[0];

    // Geef altijd dezelfde response terug om user enumeration te voorkomen
    if (!user || user.email_verified) {
      return res.json({ message: "If your email exists and is unverified, a new verification email has been sent." });
    }

    await pool.query(
      `DELETE FROM email_verification_tokens WHERE user_id = $1`,
      [user.id]
    );

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, hashToken(token), expiresAt]
    );

    await sendVerificationEmail(user.email, token);

    res.json({ message: "If your email exists and is unverified, a new verification email has been sent." });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// FORGOT PASSWORD
// ========================
// Maakt een reset-token (1 uur geldig, hash-only opgeslagen, single-use) en
// mailt de link. Response is altijd hetzelfde — bestaand of onbekend
// e-mailadres — tegen user enumeration; de mail gaat fire-and-forget zodat
// ook de responstijd niets verraadt. De reset zelf is een browser-flow:
// GET/POST /auth/reset-password, buiten /v2 (src/routes/passwordReset.js).
router.post("/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  const generic = {
    message: "If your email exists, a password reset email has been sent.",
  };

  try {
    const { rows } = await pool.query(
      `SELECT id, email FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    const user = rows[0];
    if (!user) {
      return res.json(generic);
    }

    // Eén actieve reset-link per account: een nieuwe aanvraag vervangt de oude.
    await pool.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [
      user.id,
    ]);

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, hashToken(token), expiresAt]
    );

    mailer.sendPasswordResetEmail(user.email, token).catch((err) =>
      console.error("password reset email failed:", err)
    );

    res.json(generic);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// LOGOUT ALL (revoke alle JWT's)
// ========================
// Zet het revocatie-watermerk (users.tokens_valid_after): elk token dat vóór
// dit moment is uitgegeven — ook dat van deze request zelf — is per direct
// ongeldig op alle apparaten. Een geslaagde wachtwoord-reset doet hetzelfde.
router.post("/logout-all", authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET tokens_valid_after = NOW() WHERE id = $1`,
      [req.user.id]
    );
    res.json({ message: "All sessions revoked" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// ME
// ========================
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, username, deletion_requested_at FROM users WHERE id = $1",
      [req.user.id]
    );

    const { deletion_requested_at, ...user } = result.rows[0];

    res.json({
      ...user,
      ...(deletion_requested_at && {
        deletion_pending_until: deletionEffectiveAt(deletion_requested_at),
      }),
    });

  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// DELETE ME — account-verwijdering aanvragen (ACCOUNT_DELETION_PLAN.md §6)
// ========================
// Wachtwoord in de body als herbevestiging: een gestolen JWT mag geen account
// kunnen wissen. Zet de bedenktijd-klok en trekt alle JWT's in; de purge-job
// wist het account definitief na ACCOUNT_DELETION_GRACE_DAYS. Nogmaals
// aanvragen reset de klok (idempotent genoeg, en onschadelijk).
router.delete("/me", authMiddleware, authLimiter, async (req, res) => {
  const { password } = req.body ?? {};

  if (typeof password !== "string" || password.length === 0
      || password.length > LIMITS.PASSWORD_LOGIN_MAX) {
    return res.status(400).json({ error: "password is required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT email, password_hash FROM users WHERE id = $1`,
      [req.user.id]
    );

    const valid = await argon2
      .verify(rows[0].password_hash, password)
      .catch(() => false);

    if (!valid) {
      securityEvent("account_deletion_denied", {
        ip: clientIp(req),
        user_id: req.user.id,
        reason: "bad_password",
      });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const result = await pool.query(
      `UPDATE users
       SET deletion_requested_at = NOW(), tokens_valid_after = NOW()
       WHERE id = $1
       RETURNING deletion_requested_at`,
      [req.user.id]
    );

    securityEvent("account_deletion_requested", {
      ip: clientIp(req),
      user_id: req.user.id,
    });

    const effectiveAt = deletionEffectiveAt(result.rows[0].deletion_requested_at);

    // Fire-and-forget: het account is op dit punt al gemarkeerd, een
    // mail-fout mag de aanvraag niet terugdraaien.
    mailer.sendAccountDeletionEmail(rows[0].email, effectiveAt).catch((err) =>
      console.error("account deletion email failed:", err)
    );

    res.json({
      message: "Account deletion scheduled",
      deletion_pending_until: effectiveAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// RESTORE ME — openstaande verwijderaanvraag annuleren
// ========================
// Vereist een geldige (nieuwe) login — de aanvraag zelf trok alle tokens in,
// dus wie hier komt heeft het wachtwoord opnieuw bewezen.
router.post("/me/restore", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users SET deletion_requested_at = NULL
       WHERE id = $1 AND deletion_requested_at IS NOT NULL
       RETURNING id`,
      [req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: "no_pending_deletion" });
    }

    securityEvent("account_deletion_cancelled", {
      ip: clientIp(req),
      user_id: req.user.id,
    });

    res.json({ message: "Account deletion cancelled" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
