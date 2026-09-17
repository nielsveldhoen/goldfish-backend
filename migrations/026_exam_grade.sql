-- Cijfer bij een examen (HOURLY_SRS_V4_PLAN.md / EXAM_PLAN.md, besluit Niels
-- 2026-09-16). Vrije tekst en niet numeriek: een cijfer is in Nederland een
-- getal met een komma ("7,5"), elders een letter (A–F) of een woord
-- ("voldoende"). De app toont het ongewijzigd; er wordt niet mee gerekend.
--
-- Nullable zonder default: metadata-only, geen table rewrite.
BEGIN;

ALTER TABLE exams ADD COLUMN IF NOT EXISTS grade text;

-- Even kort als de UI toelaat; de backend kapt af op deze lengte.
ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_grade_len;
ALTER TABLE exams ADD CONSTRAINT exams_grade_len
  CHECK (grade IS NULL OR char_length(grade) <= 16);

INSERT INTO schema_migrations (version)
VALUES ('026_exam_grade')
ON CONFLICT (version) DO NOTHING;

COMMIT;
