-- Down-migratie voor 016_deck_sharing: verwijdert de sharing-tabel en de
-- publieke-discovery-index. Uitvoeren als postgres.
-- LET OP: gooit alle share-relaties weg (geen soft-verwijdering mogelijk).

BEGIN;

DROP TABLE IF EXISTS deck_shares;
DROP INDEX IF EXISTS idx_decks_public;

DELETE FROM schema_migrations WHERE version = '016_deck_sharing';

COMMIT;
