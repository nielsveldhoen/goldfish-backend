-- Migratie 023 (2026-07-18): goedkeuring van nieuwe groepsleden
-- (zie GROUP_APPROVAL_PLAN.md).
-- Datum: 2026-07-18
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
-- Vereist: migratie 017 (groups + group_members).
--
-- groups.require_approval — toggle van de owner: staat hij aan, dan wordt
-- iedereen die via code+wachtwoord joint eerst status 'pending' en moet de
-- owner goedkeuren (→ 'active') of afwijzen (rij weg via de kick-route).
-- Invites blijven buiten de goedkeuring (een invite is al een expliciete
-- uitnodiging door een actief lid).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; de CHECK wordt via drop-and-add
-- vervangen (DROP IF EXISTS + ADD).

BEGIN;

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS require_approval boolean NOT NULL DEFAULT false;

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_status_check;
ALTER TABLE group_members
  ADD CONSTRAINT group_members_status_check
  CHECK (status IN ('invited', 'active', 'pending'));

INSERT INTO schema_migrations (version)
VALUES ('023_group_join_approval')
ON CONFLICT (version) DO NOTHING;

COMMIT;
