-- Migratie 1 (2026-06-12): soft-delete-kolom voor progress reset.
-- Nodig voor DELETE /review/progress/:card_id en de sync daarvan.
-- Idempotent — mag vaker gedraaid worden.
--
-- Uitvoeren als superuser:
--   sudo -u postgres psql -d goldfish -f 001_progress_deleted_at.sql

ALTER TABLE user_card_progress ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
