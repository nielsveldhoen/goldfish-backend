-- Migration 004: corrigeer de 'core'-type kolommen die in 003 abusievelijk
-- 'remote' werden genoemd.
-- Datum: 2026-06-19
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: 'ltm' was twee dingen tegelijk — een score én een kaarttype.
-- In 003 is alles naar 'remote' hernoemd, maar alleen de *score* hoort
-- 'remote' te heten. De *type*-aanduiding (LTM-kaart / is_core) en de daarvan
-- afgeleide tellingen horen 'core' te heten, consistent met de al bestaande
-- kolommen core_practiced_today / core_correct_first_try_today.
--
-- Hernoemt (type-tellingen, GEEN scores):
--   deck_stats.remote_cards_practiced      -> core_cards_practiced
--   deck_stats.remote_correct_first_try    -> core_correct_first_try
--   user_daily_snapshot.total_remote_cards -> total_core_cards
--
-- Ongemoeid (echte scores): remote_score, avg_remote_score, stable/recent.
-- De bidirectionele sync met de oude ltm_*-kolommen blijft werken; alleen de
-- triggerfuncties worden bijgewerkt naar de nieuwe kolomnamen.
--
-- Idempotent: de RENAMEs zijn met IF EXISTS-guards beschermd, dus een rerun
-- doet niets schadelijks.

BEGIN;

-- ============================================================
-- 1. deck_stats: remote_cards_practiced / remote_correct_first_try -> core_*
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'deck_stats' AND column_name = 'remote_cards_practiced') THEN
    ALTER TABLE deck_stats RENAME COLUMN remote_cards_practiced TO core_cards_practiced;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'deck_stats' AND column_name = 'remote_correct_first_try') THEN
    ALTER TABLE deck_stats RENAME COLUMN remote_correct_first_try TO core_correct_first_try;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_deck_stats_columns()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.core_cards_practiced IS NULL THEN
      NEW.core_cards_practiced := NEW.ltm_cards_practiced;
    ELSE
      NEW.ltm_cards_practiced := NEW.core_cards_practiced;
    END IF;
    IF NEW.core_correct_first_try IS NULL THEN
      NEW.core_correct_first_try := NEW.ltm_correct_first_try;
    ELSE
      NEW.ltm_correct_first_try := NEW.core_correct_first_try;
    END IF;
    -- avg-kolommen zijn nullable; gevulde kant is leidend
    IF NEW.avg_remote_score IS NOT NULL THEN
      NEW.avg_ltm_score := NEW.avg_remote_score;
    ELSIF NEW.avg_ltm_score IS NOT NULL THEN
      NEW.avg_remote_score := NEW.avg_ltm_score;
    END IF;
    IF NEW.avg_stable_score IS NOT NULL THEN
      NEW.avg_stm_score := NEW.avg_stable_score;
    ELSIF NEW.avg_stm_score IS NOT NULL THEN
      NEW.avg_stable_score := NEW.avg_stm_score;
    END IF;
  ELSE
    IF NEW.core_cards_practiced IS DISTINCT FROM OLD.core_cards_practiced THEN
      NEW.ltm_cards_practiced := NEW.core_cards_practiced;
    ELSIF NEW.ltm_cards_practiced IS DISTINCT FROM OLD.ltm_cards_practiced THEN
      NEW.core_cards_practiced := NEW.ltm_cards_practiced;
    END IF;
    IF NEW.core_correct_first_try IS DISTINCT FROM OLD.core_correct_first_try THEN
      NEW.ltm_correct_first_try := NEW.core_correct_first_try;
    ELSIF NEW.ltm_correct_first_try IS DISTINCT FROM OLD.ltm_correct_first_try THEN
      NEW.core_correct_first_try := NEW.ltm_correct_first_try;
    END IF;
    IF NEW.avg_remote_score IS DISTINCT FROM OLD.avg_remote_score THEN
      NEW.avg_ltm_score := NEW.avg_remote_score;
    ELSIF NEW.avg_ltm_score IS DISTINCT FROM OLD.avg_ltm_score THEN
      NEW.avg_remote_score := NEW.avg_ltm_score;
    END IF;
    IF NEW.avg_stable_score IS DISTINCT FROM OLD.avg_stable_score THEN
      NEW.avg_stm_score := NEW.avg_stable_score;
    ELSIF NEW.avg_stm_score IS DISTINCT FROM OLD.avg_stm_score THEN
      NEW.avg_stable_score := NEW.avg_stm_score;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 2. user_daily_snapshot: total_remote_cards -> total_core_cards
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'user_daily_snapshot' AND column_name = 'total_remote_cards') THEN
    ALTER TABLE user_daily_snapshot RENAME COLUMN total_remote_cards TO total_core_cards;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_daily_snapshot_columns()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.total_core_cards IS NULL THEN
      NEW.total_core_cards := NEW.total_ltm_cards;
    ELSE
      NEW.total_ltm_cards := NEW.total_core_cards;
    END IF;
    IF NEW.avg_remote_score IS NOT NULL THEN
      NEW.avg_ltm_score := NEW.avg_remote_score;
    ELSIF NEW.avg_ltm_score IS NOT NULL THEN
      NEW.avg_remote_score := NEW.avg_ltm_score;
    END IF;
    IF NEW.avg_stable_score IS NOT NULL THEN
      NEW.avg_stm_score := NEW.avg_stable_score;
    ELSIF NEW.avg_stm_score IS NOT NULL THEN
      NEW.avg_stable_score := NEW.avg_stm_score;
    END IF;
  ELSE
    IF NEW.total_core_cards IS DISTINCT FROM OLD.total_core_cards THEN
      NEW.total_ltm_cards := NEW.total_core_cards;
    ELSIF NEW.total_ltm_cards IS DISTINCT FROM OLD.total_ltm_cards THEN
      NEW.total_core_cards := NEW.total_ltm_cards;
    END IF;
    IF NEW.avg_remote_score IS DISTINCT FROM OLD.avg_remote_score THEN
      NEW.avg_ltm_score := NEW.avg_remote_score;
    ELSIF NEW.avg_ltm_score IS DISTINCT FROM OLD.avg_ltm_score THEN
      NEW.avg_remote_score := NEW.avg_ltm_score;
    END IF;
    IF NEW.avg_stable_score IS DISTINCT FROM OLD.avg_stable_score THEN
      NEW.avg_stm_score := NEW.avg_stable_score;
    ELSIF NEW.avg_stm_score IS DISTINCT FROM OLD.avg_stm_score THEN
      NEW.avg_stable_score := NEW.avg_stm_score;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. Migratie registreren
-- ============================================================
INSERT INTO schema_migrations (version)
VALUES ('004_rename_remote_core_type_columns')
ON CONFLICT (version) DO NOTHING;

COMMIT;
