-- Migratie 009 (2026-06-25): server-side updated_at-watermark voor de stats-delta-sync.
-- Datum: 2026-06-25
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: GET /v2/stats/changes levert deck_stats + user_daily_snapshot
-- incrementeel uit op basis van updated_at > since, net als GET /v2/review/core
-- en GET /v2/sync/changes. Daarvoor moet updated_at server-side bijgewerkt
-- worden bij ELKE UPDATE — de client-klok mag nooit de bron van het watermerk
-- zijn. POST /v2/stats/update zette updated_at tot nu toe handmatig in de query;
-- de trigger maakt dat onafhankelijk van de schrijfweg en sluit aan op de
-- bestaande set_updated_at()-helper die decks/cards/user_card_progress al
-- gebruiken.
--
-- Doet:
--   1. updated_at-kolom garanderen (bestond al op dev; guard voor remote).
--   2. set_updated_at()-helper (her)definiëren — idempotent, identiek aan de
--      bestaande versie.
--   3. BEFORE UPDATE-trigger op beide tabellen.
--   4. Index (user_id, updated_at) op beide tabellen, in de stijl van
--      idx_progress_updated_at / idx_decks_updated_at.
--
-- GEEN deleted_at en GEEN cascade: het endpoint geeft alleen levende rijen
-- terug; de client ruimt lokale orphans zelf op op basis van de deck-deletes.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER, CREATE INDEX IF NOT EXISTS.
-- Reverse: 009_stats_updated_at_watermark_down.sql.

BEGIN;

-- ============================================================
-- 1. updated_at garanderen (bestond al op dev)
-- ============================================================
ALTER TABLE deck_stats
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE user_daily_snapshot
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- ============================================================
-- 2. Gedeelde helper (bestaat al voor decks/cards/progress)
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. Triggers: bij ELKE UPDATE updated_at = now() (server-side)
-- ============================================================
DROP TRIGGER IF EXISTS deck_stats_updated_at ON deck_stats;
CREATE TRIGGER deck_stats_updated_at
  BEFORE UPDATE ON deck_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS user_daily_snapshot_updated_at ON user_daily_snapshot;
CREATE TRIGGER user_daily_snapshot_updated_at
  BEFORE UPDATE ON user_daily_snapshot
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 4. Indexen (user_id, updated_at) — stijl van idx_progress_updated_at
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_deck_stats_updated_at
  ON deck_stats (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_user_daily_snapshot_updated_at
  ON user_daily_snapshot (user_id, updated_at);

-- ============================================================
-- 5. Migratie registreren
-- ============================================================
INSERT INTO schema_migrations (version)
VALUES ('009_stats_updated_at_watermark')
ON CONFLICT (version) DO NOTHING;

COMMIT;
