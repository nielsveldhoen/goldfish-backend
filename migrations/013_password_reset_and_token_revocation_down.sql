-- Reverse van 013_password_reset_and_token_revocation.sql.
-- Uitvoeren als: postgres.
--
-- LET OP: draai dit alleen als de backend-code van vóór migratie 013 draait —
-- de auth-middleware van 013+ leest users.tokens_valid_after op elke request.

BEGIN;

DROP TABLE IF EXISTS password_reset_tokens;

ALTER TABLE users
  DROP COLUMN IF EXISTS tokens_valid_after;

DELETE FROM schema_migrations
WHERE version = '013_password_reset_and_token_revocation';

COMMIT;
