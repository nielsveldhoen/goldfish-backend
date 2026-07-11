# Database-migraties

SQL-migraties die als `postgres`-superuser gedraaid moeten worden (de
app-user `goldfish` heeft geen DDL-rechten). Op de lokale dev-database zijn
beide al uitgevoerd op 2026-06-12; op de remote server nog draaien.

```bash
sudo -u postgres psql -d goldfish -f 001_progress_deleted_at.sql
sudo -u postgres psql -d goldfish -f 002_hash_verification_tokens.sql   # éénmalig!
sudo -u postgres psql -d goldfish -f 003_rename_ltm_remote_stm_stable_add_recent.sql
sudo -u postgres psql -d goldfish -f 004_rename_remote_core_type_columns.sql
sudo -u postgres psql -d goldfish -f 005_drop_legacy_ltm_stm.sql
sudo -u postgres psql -d goldfish -f 006_app_config_min_client_build.sql
sudo -u postgres psql -d goldfish -f 007_add_core_avg_scores.sql
sudo -u postgres psql -d goldfish -f 008_cleanup_orphan_progress.sql
sudo -u postgres psql -d goldfish -f 009_stats_updated_at_watermark.sql
sudo -u postgres psql -d goldfish -f 010_tombstone_purge_indexes.sql
sudo -u postgres psql -d goldfish -f 011_decks_inactive.sql
sudo -u postgres psql -d goldfish -f 012_deck_stats_totals.sql
sudo -u postgres psql -d goldfish -f 013_password_reset_and_token_revocation.sql
sudo -u postgres psql -d goldfish -f 014_decks_core_only.sql
sudo -u postgres psql -d goldfish -f 015_contacts.sql
sudo -u postgres psql -d goldfish -f 016_deck_sharing.sql
sudo -u postgres psql -d goldfish -f 017_groups.sql
sudo -u postgres psql -d goldfish -f 018_share_accept.sql
sudo -u postgres psql -d goldfish -f 019_deck_share_edit.sql
```

| Bestand | Wat | Herhaalbaar? |
|---|---|---|
| `001_progress_deleted_at.sql` | `deleted_at`-kolom op `user_card_progress` (progress reset + sync) | ja, idempotent |
| `002_hash_verification_tokens.sql` | bestaande verificatietokens sha256-hashen | **nee — precies één keer** |
| `003_rename_ltm_remote_stm_stable_add_recent.sql` | LTM→remote, STM→stable, nieuwe `recent`-kolom; sync-triggers voor oude clients + `schema_migrations`-tabel | **nee — precies één keer** (rerun faalt veilig op `ADD COLUMN`) |
| `004_rename_remote_core_type_columns.sql` | corrigeert de type-tellingen die in 003 abusievelijk `remote_*` heetten naar `core_*` (`core_cards_practiced`, `core_correct_first_try`, `total_core_cards`); werkt sync-triggers bij | ja, idempotent (RENAMEs met `IF EXISTS`-guards) |
| `005_drop_legacy_ltm_stm.sql` | verwijdert de oude `ltm_*`/`stm_*`-kolommen + sync-triggers/functies; nog maar één naamset. **Pas draaien als geen enkele client meer op de oude namen draait** | ja, idempotent (`DROP … IF EXISTS`) |
| `006_app_config_min_client_build.sql` | `app_config` key-value-tabel + seed `min_client_build = 0` (minimaal vereist Flutter buildNumber; server weigert te oude clients met 426) | ja, idempotent |
| `007_add_core_avg_scores.sql` | voegt `avg_core_remote_score`/`avg_core_stable_score`/`avg_core_recent_score` toe aan `deck_stats` en `user_daily_snapshot` (gemiddelden over alleen core-kaarten) | ja, idempotent (`ADD COLUMN IF NOT EXISTS`) |
| `008_cleanup_orphan_progress.sql` | softdeletet bestaande wees-`user_card_progress`-records waarvan de card of het deck al soft-deleted is (maakt core-telling consistent; cascade-fix in de DELETE-handlers voorkomt nieuwe) | ja, idempotent (al gesoftdelete records vallen buiten de `WHERE`) |
| `009_stats_updated_at_watermark.sql` | server-side `updated_at`-watermark voor `GET /stats/changes`: `set_updated_at()`-trigger op `deck_stats` + `user_daily_snapshot` (bumpt `updated_at` bij elke UPDATE) + index `(user_id, updated_at)` op beide. Reverse: `009_stats_updated_at_watermark_down.sql` | ja, idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP … IF EXISTS` + `CREATE`) |
| `010_tombstone_purge_indexes.sql` | partial indexen `(deleted_at) WHERE deleted_at IS NOT NULL` op `user_card_progress`, `cards`, `decks` voor de dagelijkse tombstone-purge (`src/jobs/purgeTombstones.js`, hard-delete van soft-deletes ouder dan `TOMBSTONE_RETENTION_DAYS`) | ja, idempotent (`CREATE INDEX IF NOT EXISTS`) |
| `011_decks_inactive.sql` | `inactive`-kolom (`BOOLEAN NOT NULL DEFAULT false`) op `decks` (archiveerbaar; client verbergt inactieve decks, core-kaarten blijven trainen) | ja, idempotent (`ADD COLUMN IF NOT EXISTS`) |
| `012_deck_stats_totals.sql` | `total_cards`/`total_core_cards` (`INTEGER NULL`) op `deck_stats` — historische deckgrootte per `(deck, datum)`, zodat de client de "all decks"-stats uit `deck_stats` kan aggregeren i.p.v. `user_daily_snapshot`. Bestaande rijen blijven `null` (geen backfill) | ja, idempotent (`ADD COLUMN IF NOT EXISTS`) |
| `013_password_reset_and_token_revocation.sql` | `password_reset_tokens`-tabel (sha256-gehasht, single-use, 1 u geldig) voor de wachtwoord-reset-flow + `users.tokens_valid_after` (JWT-revocatie-watermerk voor `POST /auth/logout-all` en de reset). **Vereist vóór deploy van de juli-2026-backend**: het auth-middleware leest de kolom op elke request. Reverse: `013_..._down.sql` | ja, idempotent (`IF NOT EXISTS` overal) |
| `014_decks_core_only.sql` | `core_only`-kolom (`BOOLEAN NOT NULL DEFAULT false`) op `decks` ("alleen kernkaarten"-toestand; spiegelt `inactive` qua opslag/sync/WS maar zonder effect op aggregaten — client filtert zelf). Vanaf deze backend sluit `inactive = true` óók de core-kaarten van dat deck uit `/review/core*` (code, geen DDL). Reverse: `014_..._down.sql` | ja, idempotent (`ADD COLUMN IF NOT EXISTS`) |
| `015_contacts.sql` | `contacts`-tabel (vrienden op e-mailadres, `pending`/`accepted`, uniek per paar ongeacht richting) + GRANT DML aan app-rol `goldfish`. Online-only (geen sync-delta). Reverse: `015_..._down.sql` | ja, idempotent |
| `016_deck_sharing.sql` | `deck_shares`-tabel: één toegangswaarheid voor live gedeelde decks (`invited`/`subscribed`/`group`; `revoked_at` voedt `removed_deck_ids` in de sync; `inactive` = archiefvlag van de óntvanger) + partial unique indexes, sync-indexen, publieke-discovery-index op `decks`, `set_updated_at`-trigger, GRANT. **Vereist vóór deploy van de sharing-backend** (sync/decks-queries joinen op de tabel). Reverse: `016_..._down.sql` | ja, idempotent |
| `017_groups.sql` | groepen: `groups` (join-code + argon2-join-wachtwoord, soft-delete), `group_members` (owner/member, invited/active, `can_add_decks`), `group_decks` (catalogus) + FK `deck_shares.group_id → groups`, triggers, GRANT. Vereist 016. Reverse: `017_..._down.sql` | ja, idempotent |
| `018_share_accept.sql` | `accepted_at`-kolom op `deck_shares`: een directe share is voortaan een uitnodiging (`NULL` = pending, géén toegang); bestaande rijen worden gebackfilled naar geaccepteerd. Vereist 016. Reverse: `018_..._down.sql` | ja, idempotent |
| `019_deck_share_edit.sql` | `can_edit`-kolom (`BOOLEAN NOT NULL DEFAULT false`) op `deck_shares`: edit-recht (volledig kaartbeheer) dat de deck-owner per persoon uitdeelt (EDIT_RIGHTS_PLAN.md). Vereist 016/018. Reverse: `019_..._down.sql` | ja, idempotent |

**Minimale clientversie bijstellen** (geen migratie — gewoon DML):
```sql
UPDATE app_config SET value = '42', updated_at = now() WHERE key = 'min_client_build';
```

Volgorde aanhouden; nieuwe migraties krijgen het volgende nummer.
