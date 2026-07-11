-- Migratie 018 (2026-07-11): accepteer-stap voor directe deck-shares.
-- Datum: 2026-07-11
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Een directe share (kind='invited') verscheen tot nu toe meteen op het
-- dashboard van de ontvanger. Voortaan is zo'n share een uitnodiging die de
-- ontvanger eerst accepteert of afwijst (zoals groeps- en contactinvites).
--
-- accepted_at IS NULL  = uitnodiging in afwachting: géén leestoegang, deck
--                        reist niet mee in /sync/changes.
-- accepted_at gezet    = actieve share (het oude gedrag).
--
-- DEFAULT now(): bestaande rijen worden bij ADD COLUMN gebackfilled naar
-- "geaccepteerd" (niemand verliest een deck), en follow- en groepsrijen —
-- acties van de ontvanger zélf — blijven zonder codewijziging direct actief.
-- Alleen POST /decks/:id/share zet de kolom expliciet op NULL.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING.

BEGIN;

ALTER TABLE deck_shares
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz DEFAULT now();

INSERT INTO schema_migrations (version)
VALUES ('018_share_accept')
ON CONFLICT (version) DO NOTHING;

COMMIT;
