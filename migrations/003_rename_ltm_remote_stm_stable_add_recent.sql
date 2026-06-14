-- Migration: LTM -> remote, STM -> stable, nieuwe 'recent'-kolom
-- Datum: 2026-06-12
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Strategie: nieuwe kolommen naast de oude, eenmalige backfill, en
-- BEFORE INSERT/UPDATE-triggers die oud <-> nieuw bidirectioneel synchroon
-- houden zodat oude appversies (die ltm_score/stm_score schrijven) blijven
-- werken. De nieuwe sync-kolommen krijgen bewust geen default zodat de
-- trigger bij INSERT kan zien welke kant aangeleverd is.
--
-- Verificatie na afloop (moet 0 zijn):
--   SELECT count(*) FROM user_card_progress
--   WHERE remote_score IS DISTINCT FROM ltm_score
--      OR stable_score IS DISTINCT FROM stm_score;

BEGIN;

-- ============================================================
-- 0. Versiebeheer: migratie-administratie
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON schema_migrations TO goldfish;

-- ============================================================
-- 1. user_card_progress: ltm_score -> remote_score,
--    stm_score -> stable_score, nieuw: recent_score
-- ============================================================
ALTER TABLE user_card_progress
  ADD COLUMN remote_score smallint,          -- bewust geen default: trigger detecteert "niet meegegeven"
  ADD COLUMN stable_score smallint,
  ADD COLUMN recent_score smallint NOT NULL DEFAULT 0;

UPDATE user_card_progress
SET remote_score = ltm_score,
    stable_score = stm_score;

CREATE OR REPLACE FUNCTION sync_progress_score_columns()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- nieuwe kolom aangeleverd? dan is die leidend; anders kopiëren vanuit de oude
    IF NEW.remote_score IS NULL THEN
      NEW.remote_score := NEW.ltm_score;
    ELSE
      NEW.ltm_score := NEW.remote_score;
    END IF;
    IF NEW.stable_score IS NULL THEN
      NEW.stable_score := NEW.stm_score;
    ELSE
      NEW.stm_score := NEW.stable_score;
    END IF;
  ELSE -- UPDATE: de kolom die daadwerkelijk wijzigt is leidend
    IF NEW.remote_score IS DISTINCT FROM OLD.remote_score THEN
      NEW.ltm_score := NEW.remote_score;
    ELSIF NEW.ltm_score IS DISTINCT FROM OLD.ltm_score THEN
      NEW.remote_score := NEW.ltm_score;
    END IF;
    IF NEW.stable_score IS DISTINCT FROM OLD.stable_score THEN
      NEW.stm_score := NEW.stable_score;
    ELSIF NEW.stm_score IS DISTINCT FROM OLD.stm_score THEN
      NEW.stable_score := NEW.stm_score;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER progress_sync_scores
  BEFORE INSERT OR UPDATE ON user_card_progress
  FOR EACH ROW EXECUTE FUNCTION sync_progress_score_columns();

-- na backfill + trigger zijn ze altijd gevuld; vanaf nu afdwingen
ALTER TABLE user_card_progress
  ALTER COLUMN remote_score SET NOT NULL,
  ALTER COLUMN stable_score SET NOT NULL;

-- ============================================================
-- 2. deck_stats: ltm_* -> remote_*, avg_stm -> avg_stable,
--    nieuw: avg_recent_score
-- ============================================================
ALTER TABLE deck_stats
  ADD COLUMN remote_cards_practiced   integer,
  ADD COLUMN remote_correct_first_try integer,
  ADD COLUMN avg_remote_score         numeric(5,2),
  ADD COLUMN avg_stable_score         numeric(5,2),
  ADD COLUMN avg_recent_score         numeric(5,2);

UPDATE deck_stats
SET remote_cards_practiced   = ltm_cards_practiced,
    remote_correct_first_try = ltm_correct_first_try,
    avg_remote_score         = avg_ltm_score,
    avg_stable_score         = avg_stm_score;

CREATE OR REPLACE FUNCTION sync_deck_stats_columns()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.remote_cards_practiced IS NULL THEN
      NEW.remote_cards_practiced := NEW.ltm_cards_practiced;
    ELSE
      NEW.ltm_cards_practiced := NEW.remote_cards_practiced;
    END IF;
    IF NEW.remote_correct_first_try IS NULL THEN
      NEW.remote_correct_first_try := NEW.ltm_correct_first_try;
    ELSE
      NEW.ltm_correct_first_try := NEW.remote_correct_first_try;
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
    IF NEW.remote_cards_practiced IS DISTINCT FROM OLD.remote_cards_practiced THEN
      NEW.ltm_cards_practiced := NEW.remote_cards_practiced;
    ELSIF NEW.ltm_cards_practiced IS DISTINCT FROM OLD.ltm_cards_practiced THEN
      NEW.remote_cards_practiced := NEW.ltm_cards_practiced;
    END IF;
    IF NEW.remote_correct_first_try IS DISTINCT FROM OLD.remote_correct_first_try THEN
      NEW.ltm_correct_first_try := NEW.remote_correct_first_try;
    ELSIF NEW.ltm_correct_first_try IS DISTINCT FROM OLD.ltm_correct_first_try THEN
      NEW.remote_correct_first_try := NEW.ltm_correct_first_try;
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

CREATE TRIGGER deck_stats_sync_scores
  BEFORE INSERT OR UPDATE ON deck_stats
  FOR EACH ROW EXECUTE FUNCTION sync_deck_stats_columns();

ALTER TABLE deck_stats
  ALTER COLUMN remote_cards_practiced   SET NOT NULL,
  ALTER COLUMN remote_correct_first_try SET NOT NULL;

-- ============================================================
-- 3. user_daily_snapshot: total_ltm_cards -> total_remote_cards,
--    avg_ltm/avg_stm -> avg_remote/avg_stable, nieuw: avg_recent_score
-- ============================================================
ALTER TABLE user_daily_snapshot
  ADD COLUMN total_remote_cards integer,
  ADD COLUMN avg_remote_score   numeric(5,2),
  ADD COLUMN avg_stable_score   numeric(5,2),
  ADD COLUMN avg_recent_score   numeric(5,2);

UPDATE user_daily_snapshot
SET total_remote_cards = total_ltm_cards,
    avg_remote_score   = avg_ltm_score,
    avg_stable_score   = avg_stm_score;

CREATE OR REPLACE FUNCTION sync_daily_snapshot_columns()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.total_remote_cards IS NULL THEN
      NEW.total_remote_cards := NEW.total_ltm_cards;
    ELSE
      NEW.total_ltm_cards := NEW.total_remote_cards;
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
    IF NEW.total_remote_cards IS DISTINCT FROM OLD.total_remote_cards THEN
      NEW.total_ltm_cards := NEW.total_remote_cards;
    ELSIF NEW.total_ltm_cards IS DISTINCT FROM OLD.total_ltm_cards THEN
      NEW.total_remote_cards := NEW.total_ltm_cards;
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

CREATE TRIGGER daily_snapshot_sync_scores
  BEFORE INSERT OR UPDATE ON user_daily_snapshot
  FOR EACH ROW EXECUTE FUNCTION sync_daily_snapshot_columns();

ALTER TABLE user_daily_snapshot
  ALTER COLUMN total_remote_cards SET NOT NULL;

-- ============================================================
-- 4. Migratie registreren
-- ============================================================
INSERT INTO schema_migrations (version)
VALUES ('003_rename_ltm_remote_stm_stable_add_recent');

COMMIT;
