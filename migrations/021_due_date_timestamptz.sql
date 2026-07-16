-- Migratie 021 (2026-07-16): due_date van DATE naar TIMESTAMPTZ (SRS v3).
-- Datum: 2026-07-16
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: SRS v3 plant kaarten per uur i.p.v. per dag (zie
-- HOURLY_SRS_V3_PLAN.md). De client stuurt due_date voortaan als volledige
-- ISO-8601 UTC-timestamp op een heel uur; de queries vergelijken met NOW()
-- i.p.v. CURRENT_DATE, zodat kaarten op uurgrenzen due worden.
--
-- Bestaande DATE-waarden worden 00:00 UTC van die dag — consistent met de
-- &00-logmigratie in de app. Oude clients die nog "YYYY-MM-DD" schrijven
-- blijven werken: timestamptz accepteert die string (→ 00:00 UTC).
--
-- Idempotent: de ALTER draait alleen als de kolom nog geen timestamptz is.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_card_progress'
      AND column_name = 'due_date'
      AND data_type = 'date'
  ) THEN
    ALTER TABLE user_card_progress
      ALTER COLUMN due_date TYPE timestamptz
      USING due_date::timestamptz;
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('021_due_date_timestamptz')
ON CONFLICT (version) DO NOTHING;

COMMIT;
