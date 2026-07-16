-- Down-migratie 021: due_date terug van TIMESTAMPTZ naar DATE.
-- LET OP: verliest de uurcomponent (truncatie naar de UTC-kalenderdag).
-- Alleen gebruiken bij een rollback naar een pre-v3 app; kaarten worden dan
-- weer per dag due.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_card_progress'
      AND column_name = 'due_date'
      AND data_type = 'timestamp with time zone'
  ) THEN
    ALTER TABLE user_card_progress
      ALTER COLUMN due_date TYPE date
      USING (due_date AT TIME ZONE 'UTC')::date;
  END IF;
END $$;

DELETE FROM schema_migrations WHERE version = '021_due_date_timestamptz';

COMMIT;
