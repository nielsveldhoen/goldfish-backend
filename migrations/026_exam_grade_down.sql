BEGIN;
ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_grade_len;
ALTER TABLE exams DROP COLUMN IF EXISTS grade;
DELETE FROM schema_migrations WHERE version = '026_exam_grade';
COMMIT;
