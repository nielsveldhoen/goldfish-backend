-- Migratie 014 (2026-07-09): voeg `core_only` toe aan decks.
-- Datum: 2026-07-09
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: de client krijgt drie deck-toestanden i.p.v. twee:
--   * actief            — alle kaarten tellen mee (ongewijzigd)
--   * alleen kernkaarten (`core_only = true`) — alleen is_core-kaarten tellen mee
--   * inactief          — het deck telt volledig niet meer mee (óók core niet)
--
-- `core_only` spiegelt `inactive` volledig qua opslag/lezen/schrijven/sync/WS,
-- maar heeft GEEN effect op de core-aggregaten of welke aggregatie dan ook — de
-- "alleen kernkaarten"-filtering past de client zelf toe. De nieuwe uitsluitende
-- betekenis van `inactive` (kernkaarten van inactieve decks tellen niet meer mee
-- in /review/core*) zit in de backend-code, niet in de DDL.
--
-- De kolom synct mee via /sync/changes (decks SELECT *), GET /decks(/:id), de
-- 409-`current`, en het WebSocket deck_created/deck_updated-event.
--
-- NOT NULL DEFAULT false: bestaande decks worden niet "alleen kernkaarten";
-- oudere clients die het veld niet kennen negeren het (backwards-compatibel).
--
-- Geen datamigratie: bestaande `inactive = true` decks blijven `inactive` en
-- krijgen de nieuwe uitsluitende betekenis.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS core_only BOOLEAN NOT NULL DEFAULT false;

INSERT INTO schema_migrations (version)
VALUES ('014_decks_core_only')
ON CONFLICT (version) DO NOTHING;

COMMIT;
