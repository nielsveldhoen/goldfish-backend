-- Migratie 019 (2026-07-11): edit-rechten op gedeelde decks (EDIT_RIGHTS_PLAN.md).
-- Datum: 2026-07-11
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Het schrijfrecht leeft op de share-rij zelf: can_edit = true geeft de
-- recipient volledig kaartbeheer (create/update/delete) op het deck.
-- Deck-writes (PUT/DELETE /decks) blijven owner-only. Effectief recht =
-- bool_or over iemands actieve, geaccepteerde rijen; de toggle-route zet de
-- vlag daarom op ál iemands rijen tegelijk (zelfde patroon als inactive).
-- Default false: niemand krijgt met deze migratie rechten erbij, en het
-- recht verdwijnt automatisch mee met een revoke (rij-gebonden).
--
-- Geen nieuwe index: de schrijfcheck is een EXISTS op (deck_id, recipient_id)
-- en wordt gedekt door deck_shares_direct_uniq / idx_deck_shares_deck.
-- GRANT is tabel-breed al geregeld (migratie 016).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING.

BEGIN;

ALTER TABLE deck_shares
  ADD COLUMN IF NOT EXISTS can_edit boolean NOT NULL DEFAULT false;

INSERT INTO schema_migrations (version)
VALUES ('019_deck_share_edit')
ON CONFLICT (version) DO NOTHING;

COMMIT;
