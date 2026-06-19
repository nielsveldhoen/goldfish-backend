-- Migration 007: voeg per-type gemiddelde scores voor core-kaarten toe.
-- Datum: 2026-06-19
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: deck_stats en user_daily_snapshot hadden al avg_remote_score,
-- avg_stable_score en avg_recent_score — gemiddelden over álle kaarten. De
-- statistiekenschermen tonen ook een aparte uitsplitsing voor alleen de
-- core-kaarten (is_core = true), dus we hebben een tweede set gemiddelden
-- nodig die alleen over die kaarten berekend is.
--
-- Voegt toe (nullable numeric(5,2), zoals de bestaande avg_*-kolommen):
--   deck_stats / user_daily_snapshot:
--     avg_core_remote_score
--     avg_core_stable_score
--     avg_core_recent_score
--
-- Idempotent: alle ADD COLUMN met IF NOT EXISTS, dus een rerun doet niets.

BEGIN;

-- ============================================================
-- 1. deck_stats
-- ============================================================
ALTER TABLE deck_stats
  ADD COLUMN IF NOT EXISTS avg_core_remote_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS avg_core_stable_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS avg_core_recent_score numeric(5,2);

-- ============================================================
-- 2. user_daily_snapshot
-- ============================================================
ALTER TABLE user_daily_snapshot
  ADD COLUMN IF NOT EXISTS avg_core_remote_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS avg_core_stable_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS avg_core_recent_score numeric(5,2);

-- ============================================================
-- 3. Migratie registreren
-- ============================================================
INSERT INTO schema_migrations (version)
VALUES ('007_add_core_avg_scores')
ON CONFLICT (version) DO NOTHING;

COMMIT;
