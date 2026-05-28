import "../src/config/env.js";
import { pool } from "../src/db.js";

await pool.query(`
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_token
    ON email_verification_tokens(token);
`);

console.log("Migration complete: email_verification_tokens table created.");
await pool.end();
