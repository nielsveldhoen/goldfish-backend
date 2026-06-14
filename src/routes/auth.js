import express from "express";
import argon2 from "argon2";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { generateToken } from "../utils/generateToken.js";
import { sendVerificationEmail } from "../utils/sendVerificationEmail.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

// Verificatietokens worden gehasht opgeslagen; alleen de hash staat in de DB,
// de gebruiker krijgt het ruwe token per mail.
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts, try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

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

  const emailNormalized = email.toLowerCase().trim();
  const usernameNormalized = (username || email.split("@")[0]).toLowerCase().trim();

  try {
    const hash = await argon2.hash(password);

    const result = await pool.query(
      `INSERT INTO users (email, username, password_hash, email_verified)
       VALUES ($1, $2, $3, false)
       RETURNING id, email, username`,
      [emailNormalized, usernameNormalized, hash]
    );

    const user = result.rows[0];

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, hashToken(token), expiresAt]
    );

    await sendVerificationEmail(emailNormalized, token);

    res.status(200).json({ message: "Registration successful. Check your email to verify your account." });

  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        error: "Email or username already exists"
      });
    }

    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
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

  const isEmail = identifier.includes("@");

  try {
    const result = await pool.query(
      isEmail
        ? "SELECT * FROM users WHERE email = $1"
        : "SELECT * FROM users WHERE username = $1",
      [identifier.toLowerCase().trim()]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await argon2.verify(user.password_hash, password);

    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.email_verified) {
      return res.status(403).json({ error: "Email not verified" });
    }

    const token = generateToken(user.id);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username
      },
      token
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// ========================
// VERIFY EMAIL
// ========================
router.get("/verify-email", async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: "Missing token" });
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
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    await pool.query(
      `UPDATE users SET email_verified = true WHERE id = $1`,
      [record.user_id]
    );

    res.json({ message: "Email verified successfully" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


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
// ME
// ========================
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, username FROM users WHERE id = $1",
      [req.user.id]
    );

    const user = result.rows[0];

    res.json(user);

  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
