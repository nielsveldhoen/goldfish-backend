-- Migratie 011 (2026-06-28): voeg `inactive` toe aan decks (archiveerbaar).
-- Datum: 2026-06-28
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: een deck kan op inactief worden gezet ("archiveren"). De client
-- verbergt inactieve decks en sluit hun gewone kaarten uit van de due/new-
-- weergave. De core-kaarten van inactieve decks blijven echter wél meetellen en
-- trainen — de core-endpoints filteren bewust NIET op `inactive`.
--
-- De kolom synct mee via /sync/changes (decks SELECT *), /review/decks/summary,
-- GET /decks/:id, en het WebSocket deck_updated-event.
--
-- NOT NULL DEFAULT false: bestaande decks worden actief; oudere clients die het
-- veld niet kennen negeren het (backwards-compatibel).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS inactive BOOLEAN NOT NULL DEFAULT false;

INSERT INTO schema_migrations (version)
VALUES ('011_decks_inactive')
ON CONFLICT (version) DO NOTHING;

COMMIT;
