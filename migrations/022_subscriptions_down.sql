-- Reverse van 022_subscriptions.sql: verwijdert de abonnementen-tabel.
-- Uitvoeren als: postgres. LET OP: gooit alle abonnementsdata weg.

BEGIN;

DROP TRIGGER IF EXISTS subscriptions_set_updated_at ON subscriptions;
DROP TABLE IF EXISTS subscriptions;

DELETE FROM schema_migrations WHERE version = '022_subscriptions';

COMMIT;
