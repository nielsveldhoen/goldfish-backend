-- Reverse van migratie 020. LET OP: SET NOT NULL faalt zolang er
-- eigenaarloze rijen bestaan — ruim die eerst op (of draai de sweep +
-- tombstone-purge volledig af) voordat je dit uitvoert.

BEGIN;

ALTER TABLE decks       ALTER COLUMN user_id  SET NOT NULL;
ALTER TABLE deck_shares ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE groups      ALTER COLUMN owner_id SET NOT NULL;

ALTER TABLE users DROP COLUMN IF EXISTS deletion_requested_at;

DELETE FROM schema_migrations WHERE version = '020_orphan_decks';

COMMIT;
