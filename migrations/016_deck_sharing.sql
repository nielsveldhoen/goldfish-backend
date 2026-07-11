-- Migratie 016 (2026-07-10): deck-sharing — live gedeelde decks.
-- Datum: 2026-07-10
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond (zie SHARING_PLAN.md): één toegangswaarheid voor alle vormen van
-- delen. Een niet-gerevokete rij in deck_shares = leestoegang voor recipient_id
-- tot het deck (en eigen progress erop). Bronnen:
--   kind='invited'    — door de eigenaar met een contact gedeeld
--   kind='subscribed' — zelf gevolgd (publiek deck)
--   kind='group'      — zelf toegevoegd uit een groepscatalogus (group_id gezet;
--                       de FK naar groups volgt in migratie 017)
--
-- revoked_at i.p.v. hard delete: /sync/changes levert "toegang verloren" als
-- removed_deck_ids uit `revoked_at > since` — een hard delete zou dat signaal
-- kwijtraken. Her-delen/her-toevoegen = upsert (revoked_at = NULL).
--
-- inactive is de archiefvlag van de ONTVANGER; de deck-kolom `inactive` blijft
-- van de eigenaar.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS +
-- CREATE TRIGGER, GRANT is idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS deck_shares (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id      uuid        NOT NULL REFERENCES decks(id),
  owner_id     uuid        NOT NULL REFERENCES users(id),
  recipient_id uuid        NOT NULL REFERENCES users(id),
  kind         text        NOT NULL DEFAULT 'invited'
                           CHECK (kind IN ('invited', 'subscribed', 'group')),
  group_id     uuid,       -- FK naar groups komt in migratie 017
  inactive     boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CONSTRAINT deck_shares_no_self  CHECK (owner_id <> recipient_id),
  CONSTRAINT deck_shares_group_id CHECK ((kind = 'group') = (group_id IS NOT NULL))
);

-- Uniek per bron: één directe/publieke share per (deck, ontvanger) en één
-- groepsshare per (deck, ontvanger, groep). Zo kan hetzelfde deck iemand via
-- een contact-share ÉN via een groep bereiken zonder dat een groeps-revoke de
-- directe share sloopt. Partiële unique indexes zodat ON CONFLICT ze kan
-- targeten (ON CONFLICT (...) WHERE group_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS deck_shares_direct_uniq
  ON deck_shares (deck_id, recipient_id) WHERE group_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS deck_shares_group_uniq
  ON deck_shares (deck_id, recipient_id, group_id) WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deck_shares_recipient
  ON deck_shares (recipient_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deck_shares_deck
  ON deck_shares (deck_id) WHERE revoked_at IS NULL;
-- Sync-watermarks: nieuwe shares (updated_at) én revokes (revoked_at) moeten
-- in de delta van /sync/changes vallen.
CREATE INDEX IF NOT EXISTS idx_deck_shares_recipient_updated
  ON deck_shares (recipient_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_deck_shares_recipient_revoked
  ON deck_shares (recipient_id, revoked_at) WHERE revoked_at IS NOT NULL;

-- Publieke discovery (GET /decks/public).
CREATE INDEX IF NOT EXISTS idx_decks_public
  ON decks (created_at DESC) WHERE is_public = true AND deleted_at IS NULL;

-- updated_at bijhouden via de gedeelde set_updated_at()-helper (migratie 009).
DROP TRIGGER IF EXISTS deck_shares_updated_at ON deck_shares;
CREATE TRIGGER deck_shares_updated_at
  BEFORE UPDATE ON deck_shares
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- App-rol krijgt DML (geen sequence: id is gen_random_uuid()); zonder deze
-- GRANT faalt elke share-query met 42501 (zelfde les als migratie 015).
GRANT SELECT, INSERT, UPDATE, DELETE ON deck_shares TO goldfish;

INSERT INTO schema_migrations (version)
VALUES ('016_deck_sharing')
ON CONFLICT (version) DO NOTHING;

COMMIT;
