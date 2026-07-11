-- Down-migratie voor 019: edit-rechten op gedeelde decks.
-- LET OP: uitgedeelde edit-rechten gaan hiermee onherroepelijk verloren
-- (de kolom verdwijnt); de oude code behandelt iedere recipient weer als
-- read-only, wat ook precies het oude gedrag is.

BEGIN;

ALTER TABLE deck_shares DROP COLUMN IF EXISTS can_edit;

DELETE FROM schema_migrations WHERE version = '019_deck_share_edit';

COMMIT;
