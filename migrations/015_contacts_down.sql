-- Reverse van 015_contacts.sql.
-- Uitvoeren als: postgres.
--
-- LET OP: draai dit alleen als de contacten-routes niet meer gemount zijn
-- (app.js zonder /v2/contacts) — anders faalt elke contact-call op een
-- ontbrekende tabel.

BEGIN;

DROP TABLE IF EXISTS contacts;

DELETE FROM schema_migrations
WHERE version = '015_contacts';

COMMIT;
