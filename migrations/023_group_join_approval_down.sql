-- Down-migratie voor 023_group_join_approval. Uitvoeren als postgres.
-- Verwijdert eerst de pending-rijen (die passen niet meer in de oude CHECK).

BEGIN;

DELETE FROM group_members WHERE status = 'pending';

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_status_check;
ALTER TABLE group_members
  ADD CONSTRAINT group_members_status_check
  CHECK (status IN ('invited', 'active'));

ALTER TABLE groups DROP COLUMN IF EXISTS require_approval;

DELETE FROM schema_migrations WHERE version = '023_group_join_approval';

COMMIT;
