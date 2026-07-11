-- Down-migratie voor 018: accepteer-stap voor directe deck-shares.
-- LET OP: pending uitnodigingen worden hiermee onherroepelijk "geaccepteerd"
-- (de kolom met de pending-status verdwijnt) — de oude code kent geen
-- accepteer-stap, dus die rijen gedragen zich daarna als actieve shares.

BEGIN;

ALTER TABLE deck_shares DROP COLUMN IF EXISTS accepted_at;

DELETE FROM schema_migrations WHERE version = '018_share_accept';

COMMIT;
