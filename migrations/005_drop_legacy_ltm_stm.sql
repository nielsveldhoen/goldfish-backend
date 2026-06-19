-- Migration 005: verwijder de legacy ltm/stm-kolommen en de sync-triggers.
-- Datum: 2026-06-19
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- 003 hield de oude ltm/stm-kolommen naast de nieuwe (remote/core/stable) in
-- stand met bidirectionele triggers, zodat oude appversies bleven werken. Alle
-- clients draaien nu op de nieuwe namen, dus de oude kolommen + triggers kunnen
-- weg. Hierna kent de database nog maar één naamset.
--
-- VOORWAARDE: geen enkele client schrijft of leest nog ltm_*/stm_*. Pas
-- uitvoeren nadat alle apps geüpdatet zijn.
--
-- Idempotent: alles met IF EXISTS, dus een rerun doet niets schadelijks.

BEGIN;

-- ============================================================
-- 1. Sync-triggers + functies weg (referenties naar oude kolommen)
-- ============================================================
DROP TRIGGER IF EXISTS progress_sync_scores ON user_card_progress;
DROP TRIGGER IF EXISTS deck_stats_sync_scores ON deck_stats;
DROP TRIGGER IF EXISTS daily_snapshot_sync_scores ON user_daily_snapshot;

DROP FUNCTION IF EXISTS sync_progress_score_columns();
DROP FUNCTION IF EXISTS sync_deck_stats_columns();
DROP FUNCTION IF EXISTS sync_daily_snapshot_columns();

-- ============================================================
-- 2. Legacy-kolommen weg
-- ============================================================
ALTER TABLE user_card_progress
  DROP COLUMN IF EXISTS ltm_score,
  DROP COLUMN IF EXISTS stm_score;

ALTER TABLE deck_stats
  DROP COLUMN IF EXISTS ltm_cards_practiced,
  DROP COLUMN IF EXISTS ltm_correct_first_try,
  DROP COLUMN IF EXISTS avg_ltm_score,
  DROP COLUMN IF EXISTS avg_stm_score;

ALTER TABLE user_daily_snapshot
  DROP COLUMN IF EXISTS total_ltm_cards,
  DROP COLUMN IF EXISTS avg_ltm_score,
  DROP COLUMN IF EXISTS avg_stm_score;

-- ============================================================
-- 3. Migratie registreren
-- ============================================================
INSERT INTO schema_migrations (version)
VALUES ('005_drop_legacy_ltm_stm')
ON CONFLICT (version) DO NOTHING;

COMMIT;
