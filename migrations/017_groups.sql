-- Migratie 017 (2026-07-10): groepen — besloten clubs met join-code+wachtwoord
-- en een deck-catalogus (zie SHARING_PLAN.md, Release B).
-- Datum: 2026-07-10
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
-- Vereist: migratie 016 (deck_shares heeft al een group_id-kolom; hier komt de FK).
--
-- Model:
--   groups        — join_code is de deelbare identificatie (niet geheim), het
--                   join-wachtwoord (argon2-hash, zelfde patroon als users) is
--                   het geheim. Owner kan het wachtwoord wisselen (na een kick).
--   group_members — role owner/member; status 'invited' (aanvraag via contact,
--                   wacht op acceptatie) of 'active'. can_add_decks = mag eigen
--                   decks aan de catalogus toevoegen.
--   group_decks   — de catalogus: welke decks met de groep gedeeld zijn.
--                   Lidmaatschap geeft GEEN deck-toegang; pas het "toevoegen"
--                   van een catalogus-deck maakt een deck_shares-rij
--                   (kind='group') aan.
--
-- groups krijgt een SOFT delete (deleted_at): gerevokete deck_shares-rijen
-- blijven via group_id naar de groep verwijzen (nodig voor removed_deck_ids in
-- /sync/changes), dus hard delete zou de FK breken of het sync-signaal kosten.
-- group_members en group_decks zijn hard-delete zoals contacts (online-only,
-- geen sync-delta).
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS +
-- CREATE TRIGGER, FK via drop-and-add, GRANT is idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS groups (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  description        text,
  join_code          text        NOT NULL UNIQUE,
  join_password_hash text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TABLE IF NOT EXISTS group_members (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text        NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active')),
  can_add_decks boolean     NOT NULL DEFAULT true,
  invited_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id);

CREATE TABLE IF NOT EXISTS group_decks (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  deck_id    uuid        NOT NULL REFERENCES decks(id),
  added_by   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, deck_id)
);

CREATE INDEX IF NOT EXISTS group_decks_deck_idx ON group_decks (deck_id);

-- FK van deck_shares.group_id naar groups (kolom bestaat sinds 016). Groepen
-- worden soft-deleted, dus deze FK wordt in de praktijk nooit geschonden;
-- RESTRICT (default) is een vangnet tegen per ongeluk hard verwijderen zolang
-- er nog share-rijen (ook gerevokete) naar verwijzen.
ALTER TABLE deck_shares DROP CONSTRAINT IF EXISTS deck_shares_group_fk;
ALTER TABLE deck_shares
  ADD CONSTRAINT deck_shares_group_fk
  FOREIGN KEY (group_id) REFERENCES groups(id);

-- updated_at via de gedeelde set_updated_at()-helper (migratie 009).
DROP TRIGGER IF EXISTS groups_updated_at ON groups;
CREATE TRIGGER groups_updated_at
  BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS group_members_updated_at ON group_members;
CREATE TRIGGER group_members_updated_at
  BEFORE UPDATE ON group_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- App-rol krijgt DML (geen sequences: ids zijn gen_random_uuid()).
GRANT SELECT, INSERT, UPDATE, DELETE ON groups, group_members, group_decks TO goldfish;

INSERT INTO schema_migrations (version)
VALUES ('017_groups')
ON CONFLICT (version) DO NOTHING;

COMMIT;
