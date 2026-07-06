-- Migratie 013 (2026-07-05): wachtwoord-reset + JWT-revocatie.
-- Datum: 2026-07-05
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond:
--   1. password_reset_tokens — zelfde model als email_verification_tokens:
--      alleen de sha256-hash van het token staat in de DB, het ruwe token
--      gaat per mail naar de gebruiker. Single-use, 1 uur geldig
--      (afgedwongen in de route, expires_at hier alleen opgeslagen).
--   2. users.tokens_valid_after — revocatie-watermerk voor JWT's: het
--      auth-middleware weigert tokens met iat < tokens_valid_after. Wordt
--      gezet door POST /auth/logout-all en door een geslaagde
--      wachtwoord-reset (alle bestaande sessies vervallen dan).
--      Default epoch = geen enkel bestaand token geraakt.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, GRANT is idempotent van zichzelf.
-- Reverse: 013_password_reset_and_token_revocation_down.sql.

BEGIN;

-- ============================================================
-- 1. JWT-revocatie-watermerk
-- ============================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tokens_valid_after timestamptz NOT NULL DEFAULT to_timestamp(0);

-- ============================================================
-- 2. Wachtwoord-reset-tokens (hash-only, zoals email_verification_tokens)
-- ============================================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,            -- sha256-hex van het ruwe token
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON password_reset_tokens (user_id);

-- App-rol doet alleen DML op de nieuwe tabel
GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO goldfish;

-- ============================================================
-- 3. Migratie registreren
-- ============================================================
INSERT INTO schema_migrations (version)
VALUES ('013_password_reset_and_token_revocation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
