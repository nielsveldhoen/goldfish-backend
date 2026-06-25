-- Reverse van migratie 009 (server-side updated_at-watermark voor stats-delta).
-- Datum: 2026-06-25
-- Uitvoeren als: postgres
--
-- Verwijdert alleen wat 009 toevoegde: de twee triggers en de twee indexen.
--
-- BEWUST NIET verwijderd:
--   * set_updated_at()  — gedeelde helper, ook in gebruik door decks/cards/
--     user_card_progress; droppen zou die triggers breken.
--   * updated_at-kolommen — bestonden al vóór 009 en worden door
--     POST /v2/stats/update gebruikt; droppen is dataverlies.
--
-- Idempotent: DROP ... IF EXISTS.

BEGIN;

DROP TRIGGER IF EXISTS deck_stats_updated_at ON deck_stats;
DROP TRIGGER IF EXISTS user_daily_snapshot_updated_at ON user_daily_snapshot;

DROP INDEX IF EXISTS idx_deck_stats_updated_at;
DROP INDEX IF EXISTS idx_user_daily_snapshot_updated_at;

DELETE FROM schema_migrations WHERE version = '009_stats_updated_at_watermark';

COMMIT;
