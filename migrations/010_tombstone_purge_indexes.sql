-- Migratie 010 (2026-06-27): partial indexen voor de tombstone-purge.
-- Datum: 2026-06-27
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: purgeTombstones() (src/jobs/purgeTombstones.js) draait dagelijks
-- en hard-delete soft-deletes ouder dan TOMBSTONE_RETENTION_DAYS:
--
--   DELETE FROM <tabel>
--    WHERE deleted_at IS NOT NULL
--      AND deleted_at < now() - ($1 || ' days')::interval;
--
-- De meeste rijen hebben deleted_at IS NULL (levende data). Een partial index
-- op alleen de tombstones houdt de index klein en laat de dagelijkse purge de
-- te verwijderen rijen vinden zonder full table scan.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_user_card_progress_deleted_at
  ON user_card_progress (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cards_deleted_at
  ON cards (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_decks_deleted_at
  ON decks (deleted_at) WHERE deleted_at IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('010_tombstone_purge_indexes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
