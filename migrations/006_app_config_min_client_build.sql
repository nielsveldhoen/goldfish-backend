-- Migration 006: app_config-tabel met de minimaal vereiste client-buildnummer.
-- Datum: 2026-06-19
-- Uitvoeren als: postgres (app-user goldfish heeft geen DDL-rechten)
--
-- Een simpele key-value config-tabel. De enige sleutel nu is
-- 'min_client_build': het laagste Flutter buildNumber dat de server nog
-- accepteert. De client haalt dit op via GET /version en weigert te draaien als
-- zijn eigen buildNumber lager is; de server weigert daarnaast elke API-call van
-- een te oude client met HTTP 426 (zie src/middleware/clientVersion.js).
--
-- Bijwerken (als postgres of als goldfish):
--   UPDATE app_config SET value = '42', updated_at = now()
--   WHERE key = 'min_client_build';
--
-- Seed-waarde 0 = poort open: niets wordt geblokkeerd totdat je 'm ophoogt.
-- Hoog 'm pas op nadat een client-build die het X-Client-Build-header meestuurt
-- is uitgerold.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS app_config (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- App-user leest (gate + /version) en mag de waarde bijwerken.
GRANT SELECT, UPDATE ON app_config TO goldfish;

INSERT INTO app_config (key, value)
VALUES ('min_client_build', '0')
ON CONFLICT (key) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('006_app_config_min_client_build')
ON CONFLICT (version) DO NOTHING;

COMMIT;
