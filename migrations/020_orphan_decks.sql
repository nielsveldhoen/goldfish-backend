-- Migratie 020 (2026-07-12): eigenaarloze decks + account-verwijdering
-- (ACCOUNT_DELETION_PLAN.md §4). Datum: 2026-07-12
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Besluit: gedeelde decks blijven bij account- of deck-verwijdering
-- eigenaarloos (user_id = NULL) bestaan zolang er actieve subscribers zijn.
-- Daarvoor moeten drie eigenaar-kolommen NULL kunnen zijn:
--   decks.user_id       — het geörphande deck zelf
--   deck_shares.owner_id — de share-rijen die de toegang dragen moeten de
--                          verdwenen eigenaar overleven (FK NO ACTION zou een
--                          DELETE FROM users anders blokkeren)
--   groups.owner_id     — gerevokete group-shares verwijzen naar group_id;
--                          de (soft-deleted) groepsrij blijft als FK-anker
--                          staan tot de purge hem opruimt
-- users.deletion_requested_at draagt de 14-daagse bedenktijd van
-- DELETE /v2/auth/me; de purge-job wist accounts die erover heen zijn.
--
-- De FK's zelf blijven ongewijzigd: een NULL-eigenaar wordt door geen enkele
-- FK geraakt, en voor niet-geörphande rijen blijft de bestaande cascade werken.
--
-- Idempotent: DROP NOT NULL is idempotent, ADD COLUMN IF NOT EXISTS,
-- INSERT ... ON CONFLICT DO NOTHING.

BEGIN;

ALTER TABLE decks       ALTER COLUMN user_id  DROP NOT NULL;
ALTER TABLE deck_shares ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE groups      ALTER COLUMN owner_id DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;

INSERT INTO schema_migrations (version)
VALUES ('020_orphan_decks')
ON CONFLICT (version) DO NOTHING;

COMMIT;
