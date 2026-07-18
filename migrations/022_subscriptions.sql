-- Migratie 022 (2026-07-18): abonnementen per account (PRO_FEATURES_PLAN.md).
-- Datum: 2026-07-18
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Achtergrond: een account kan meerdere abonnementen tegelijk hebben (in
-- eerste instantie drie pro-producten, uitbreidbaar naar meer). Eén rij =
-- één abonnementsperiode op één product. Welke features een product
-- ontgrendelt staat NIET in de database maar in src/config/products.js
-- (product_key → entitlements): een nieuw product toevoegen is dan een
-- code-wijziging zonder DDL, en de waarheid over features leeft op één plek.
--
-- "Actief" is een berekend gegeven, geen status-kolom:
--   started_at <= now() AND (expires_at IS NULL OR expires_at > now())
-- canceled_at is puur informatief ("verlengt niet meer"): wie opzegt houdt
-- toegang tot expires_at, zoals bij de app-stores gebruikelijk. Historie
-- blijft staan (meerdere rijen per user+product over de tijd); verlengen =
-- expires_at opschuiven of een nieuwe rij.
--
-- source/external_ref zijn voorbereid op betaalproviders (Stripe/app-stores):
-- de webhook-handler vindt de rij terug op external_ref. Zolang er geen
-- provider is, worden rijen handmatig (DML) of via een admin-pad aangemaakt.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS +
-- CREATE, GRANT is idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriptions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_key  text        NOT NULL,  -- sleutel in src/config/products.js; bewust géén CHECK: nieuw product = geen DDL
  started_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,           -- NULL = doorlopend
  canceled_at  timestamptz,           -- opgezegd (informatief; toegang loopt door tot expires_at)
  source       text        NOT NULL DEFAULT 'manual'
               CHECK (source IN ('manual', 'stripe', 'app_store', 'play_store')),
  external_ref text,                  -- id bij de betaalprovider (webhook-lookup)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_period_valid CHECK (expires_at IS NULL OR expires_at > started_at)
);

-- Elke entitlement-check zoekt op user_id (+ actieve-periode-filter in code).
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);

-- Webhook-lookups van een betaalprovider (uniek per bron zodra gevuld).
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_external_ref_uniq
  ON subscriptions (source, external_ref) WHERE external_ref IS NOT NULL;

-- updated_at bijhouden via de gedeelde set_updated_at()-helper (migratie 009).
DROP TRIGGER IF EXISTS subscriptions_set_updated_at ON subscriptions;
CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- App-rol krijgt DML (geen sequence: id is gen_random_uuid()).
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions TO goldfish;

INSERT INTO schema_migrations (version)
VALUES ('022_subscriptions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
