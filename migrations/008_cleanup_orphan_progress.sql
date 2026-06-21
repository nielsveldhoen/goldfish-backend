-- Migratie 008 (2026-06-21): éénmalige cleanup van wees-voortgangsrecords.
-- Datum: 2026-06-21
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten; de DML
--   hieronder mag goldfish wél, maar we houden migraties consistent op postgres)
--
-- Achtergrond: tot nu toe werd user_card_progress niet mee-gesoftdelete als de
-- bijbehorende card of het deck soft-deleted werd. Daardoor bleven er
-- voortgangsrecords met is_core = true rondzweven die nog wel in /review/core/summary
-- meetelden (telt op ucp.deleted_at IS NULL, zonder join op cards/decks), terwijl
-- /review/core en /review/core/scores ze al wegfilterden (joinen op
-- cards.deleted_at / decks.deleted_at). Dat gaf een inconsistente core-telling.
--
-- De cascade-fix in de DELETE-handlers (cards.js / decks.js) voorkomt nieuwe
-- wees-records; deze migratie ruimt de bestaande op.
--
-- Idempotent: re-run softdeletet niets nieuws (al gesoftdelete records vallen
-- buiten de WHERE).

BEGIN;

-- Softdelete alle nog-actieve progress-records waarvan de card of het deck
-- al soft-deleted is.
UPDATE user_card_progress ucp
SET deleted_at = NOW()
FROM cards c
JOIN decks d ON d.id = c.deck_id
WHERE ucp.card_id = c.id
  AND ucp.deleted_at IS NULL
  AND (c.deleted_at IS NOT NULL OR d.deleted_at IS NOT NULL);

INSERT INTO schema_migrations (version)
VALUES ('008_cleanup_orphan_progress')
ON CONFLICT (version) DO NOTHING;

COMMIT;
