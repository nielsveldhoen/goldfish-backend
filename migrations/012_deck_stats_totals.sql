-- Migratie 012 (2026-07-05): historische deckgroottes per (deck, datum) in deck_stats.
-- Datum: 2026-07-05
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: de frontend gaat de "all decks"-statistieken voortaan berekenen
-- door per-deck deck_stats-rijen te aggregeren (gewogen op deckgrootte per datum)
-- in plaats van user_daily_snapshot te lezen. Daarvoor moet de deckgrootte
-- historisch per (deck, datum) bewaard worden. user_daily_snapshot had deze
-- totalen al (user-breed); deck_stats krijgt nu de deck-lokale variant.
--
-- Voegt toe aan deck_stats:
--   total_cards      INTEGER NULL  -- absoluut aantal kaarten in het deck op die datum
--   total_core_cards INTEGER NULL  -- absoluut aantal core-kaarten in het deck op die datum
--
-- Beide zijn NULL voor bestaande rijen (backfill is niet mogelijk — het
-- historische aantal is niet reconstrueerbaar). De client valt voor NULL-rijen
-- terug op de huidige aantallen.
--
-- Ze synce mee via GET /stats/changes, GET /stats/decks, GET /stats/deck/:id en
-- de response van POST /stats/update (allemaal SELECT * / RETURNING *). POST
-- /stats/update accepteert ze als absolute waarden in deck_delta (overschrijven,
-- weglaten = onveranderd) en bumpt daarbij updated_at.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE deck_stats
  ADD COLUMN IF NOT EXISTS total_cards      INTEGER,
  ADD COLUMN IF NOT EXISTS total_core_cards INTEGER;

INSERT INTO schema_migrations (version)
VALUES ('012_deck_stats_totals')
ON CONFLICT (version) DO NOTHING;

COMMIT;
