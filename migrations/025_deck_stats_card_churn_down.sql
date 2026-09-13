-- Reverse van 025_deck_stats_card_churn.sql.
-- Uitvoeren als: postgres.
--
-- LET OP: draai dit alleen als de backend-code van vóór migratie 025 draait —
-- POST /stats/update van 025+ schrijft cards_added en cards_removed.

BEGIN;

ALTER TABLE deck_stats
  DROP COLUMN IF EXISTS cards_added,
  DROP COLUMN IF EXISTS cards_removed;

DELETE FROM schema_migrations
WHERE version = '025_deck_stats_card_churn';

COMMIT;
