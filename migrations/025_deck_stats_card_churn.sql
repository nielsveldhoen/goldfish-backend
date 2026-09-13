-- Migratie 025 (2026-09-12): tellers voor kaartmutaties per (deck, datum) in deck_stats.
-- Datum: 2026-09-12
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: de grafiek moet een scoredaling kunnen verklaren. Een verse
-- kaart telt in elk gemiddelde als 0 (StatsLocal.computeDeckAverages), dus 48
-- kaarten toevoegen verdunt de score zichtbaar. Om dat te kunnen annoteren
-- ("48 toegevoegd") is het aantal mutaties per dag nodig, niet alleen de
-- deckgrootte: een dag met 50 toevoegingen en 2 verwijderingen moet als 50
-- gelezen worden, niet als een netto verschil van 48.
--
-- Voegt toe aan deck_stats:
--   cards_added   INTEGER NOT NULL DEFAULT 0  -- kaarten die deze dag in het deck kwamen
--   cards_removed INTEGER NOT NULL DEFAULT 0  -- kaarten die deze dag uit het deck gingen
--
-- Optelbare tellers, net als cards_practiced — geen absolute totalen zoals
-- total_cards. Dat maakt ze veilig over meerdere devices en over offline
-- flushes heen: POST /stats/update telt op in plaats van te overschrijven.
--
-- Een gereset kaart telt als beide: zijn voortgang verdwijnt, dus hij verlaat
-- de geoefende verzameling (removed) en komt als nieuwe kaart terug (added).
-- Dat is precies de mutatie die de score verdunt zoals een toevoeging dat doet.
--
-- NOT NULL DEFAULT 0: bestaande rijen claimen "geen mutaties". Dat is voor de
-- historie vóór deze migratie niet waar maar wel onschadelijk — een rij zonder
-- mutaties krijgt in de grafiek geen markering, precies wat een nul betekent.
-- Het scheelt de client de null-behandeling die total_cards nog wel nodig heeft.
--
-- Ze syncen mee via GET /stats/changes, GET /stats/decks, GET /stats/deck/:id
-- en de response van POST /stats/update (allemaal SELECT * / RETURNING *).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE deck_stats
  ADD COLUMN IF NOT EXISTS cards_added   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cards_removed INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (version)
VALUES ('025_deck_stats_card_churn')
ON CONFLICT (version) DO NOTHING;

COMMIT;
