-- Reverse van 014_decks_core_only.sql.
-- Uitvoeren als: postgres.
--
-- LET OP: draai dit alleen als de backend-code van vóór migratie 014 draait —
-- POST/PUT /decks van 014+ schrijven de kolom `core_only`.

BEGIN;

ALTER TABLE decks
  DROP COLUMN IF EXISTS core_only;

DELETE FROM schema_migrations
WHERE version = '014_decks_core_only';

COMMIT;
