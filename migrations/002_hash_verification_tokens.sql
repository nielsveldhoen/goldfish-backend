-- Migratie 2 (2026-06-12): bestaande e-mailverificatietokens hashen (sha256).
-- De backend slaat tokens sindsdien gehasht op; deze migratie zet de nog
-- openstaande plaintext-tokens om zodat lopende verificatielinks blijven werken.
--
-- ⚠️  PRECIES ÉÉN KEER draaien. Een tweede keer hasht de hashes opnieuw en
--     maakt alle lopende verificatielinks ongeldig.
--
-- Alternatief als er geen belangrijke openstaande verificaties zijn
-- (gebruikers kunnen altijd een nieuwe mail aanvragen):
--   DELETE FROM email_verification_tokens;
--
-- Uitvoeren als superuser:
--   sudo -u postgres psql -d goldfish -f 002_hash_verification_tokens.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE email_verification_tokens SET token = encode(digest(token, 'sha256'), 'hex');
