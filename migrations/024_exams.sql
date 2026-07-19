-- Migratie 024 (2026-07-19): examens (EXAM_PLAN.md) — benoemde deadline met
-- een set decks, persoonlijk (owner) of per groep, waarop de client-side
-- scheduler het vervalalgoritme aanpast.
-- Datum: 2026-07-19
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
-- Vereist: migratie 017 (groups), 020 (orphan-patroon owner_id NULL).
--
-- Model:
--   exams      — group_id NULL = persoonlijk examen van owner_id; group_id
--                gezet = groepsexamen (zichtbaar voor actieve leden; owner_id
--                is de maker en mag NULL worden bij account-verwijdering,
--                orphan-patroon migratie 020). HARD delete: de sync levert
--                examens als volledige snapshot (laag-cardinaal), dus
--                verwijderen/toegangsverlies heeft geen tombstone nodig.
--   exam_decks — koppeltabel; hetzelfde deck mag in meerdere examens.
--                deck_id cascadet mee met de tombstone-purge van decks
--                (purgeTombstones.js doet hard deletes).
--
-- user_card_progress krijgt longest_in_streak_hours: de langste verdiende gap
-- (uren) binnen de huidige goed-streak, aangeleverd door de client (de
-- v3-scheduler berekent hem al). NULL = nog nooit aangeleverd. Voedt de
-- examen-readiness ("dekt de bewezen retentie de tijd tot het examen?").
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER, GRANT is idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS exams (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid        REFERENCES users(id) ON DELETE CASCADE,
  group_id   uuid        REFERENCES groups(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  exam_date  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exams_scope CHECK (group_id IS NOT NULL OR owner_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS exams_owner_idx ON exams (owner_id);
CREATE INDEX IF NOT EXISTS exams_group_idx ON exams (group_id);

CREATE TABLE IF NOT EXISTS exam_decks (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id    uuid        NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  deck_id    uuid        NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, deck_id)
);

CREATE INDEX IF NOT EXISTS exam_decks_deck_idx ON exam_decks (deck_id);

-- updated_at via de gedeelde set_updated_at()-helper (migratie 009).
DROP TRIGGER IF EXISTS exams_updated_at ON exams;
CREATE TRIGGER exams_updated_at
  BEFORE UPDATE ON exams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Nullable zonder default: metadata-only, geen table rewrite.
ALTER TABLE user_card_progress
  ADD COLUMN IF NOT EXISTS longest_in_streak_hours integer;

-- App-rol krijgt DML (geen sequences: ids zijn gen_random_uuid()).
GRANT SELECT, INSERT, UPDATE, DELETE ON exams, exam_decks TO goldfish;

INSERT INTO schema_migrations (version)
VALUES ('024_exams')
ON CONFLICT (version) DO NOTHING;

COMMIT;
