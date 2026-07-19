-- Reverse van 024_exams.sql. Alleen draaien nadat de backend is teruggezet
-- naar een versie vóór de examens-feature (de nieuwe code verwacht de
-- tabellen en kolom).

BEGIN;

DROP TABLE IF EXISTS exam_decks;
DROP TABLE IF EXISTS exams;

ALTER TABLE user_card_progress
  DROP COLUMN IF EXISTS longest_in_streak_hours;

DELETE FROM schema_migrations WHERE version = '024_exams';

COMMIT;
