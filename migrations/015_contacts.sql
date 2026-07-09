-- Migratie 015 (2026-07-09): contacten-feature (vrienden op e-mailadres).
-- Datum: 2026-07-09
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: gebruikers voegen elkaar toe op e-mailadres. Eén relatie-rij per
-- paar met een vaste richting (wie nodigde wie uit). Status 'pending' tot de
-- ontvanger accepteert; afwijzen/annuleren/verwijderen = HARD delete.
--
-- Contacten staan LOS van de sync-delta: dit is een online-only feature. Geen
-- deleted_at/soft-delete, geen sync-watermerk. De client leest de lijst via
-- GET /v2/contacts en verwerkt mutaties via de WS-events contact_invited /
-- contact_accepted / contact_rejected.
--
-- gen_random_uuid() is in Postgres 13+ ingebouwd (pgcrypto niet nodig); decks/
-- users gebruiken hetzelfde patroon.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS contacts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- wie de uitnodiging stuurde
  addressee_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- wie werd uitgenodigd
  status        text        NOT NULL CHECK (status IN ('pending', 'accepted')) DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_no_self CHECK (requester_id <> addressee_id)
);

-- Uniek per paar, ongeacht richting: voorkomt dubbele én kruisende uitnodigingen
-- (A→B en B→A tegelijk).
CREATE UNIQUE INDEX IF NOT EXISTS contacts_pair_uniq
  ON contacts (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

-- GET /v2/contacts zoekt op beide richtingen; index op addressee_id maakt de
-- OR-tak los indexeerbaar (requester_id zit al in contacts_pair_uniq's eerste
-- expressie-argument niet direct bruikbaar, dus een eigen index).
CREATE INDEX IF NOT EXISTS contacts_requester_idx ON contacts (requester_id);
CREATE INDEX IF NOT EXISTS contacts_addressee_idx ON contacts (addressee_id);

INSERT INTO schema_migrations (version)
VALUES ('015_contacts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
