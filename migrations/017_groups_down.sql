-- Down-migratie voor 017_groups: verwijdert de groepstabellen en de FK op
-- deck_shares.group_id. Uitvoeren als postgres.
-- LET OP: deck_shares-rijen met kind='group' blijven staan maar verwijzen dan
-- nergens meer naar; draai zonodig eerst een revoke van die rijen.

BEGIN;

ALTER TABLE deck_shares DROP CONSTRAINT IF EXISTS deck_shares_group_fk;

DROP TABLE IF EXISTS group_decks;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;

DELETE FROM schema_migrations WHERE version = '017_groups';

COMMIT;
