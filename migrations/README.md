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

**Minimale clientversie bijstellen** (geen migratie — gewoon DML):
```sql
UPDATE app_config SET value = '42', updated_at = now() WHERE key = 'min_client_build';
```

Volgorde aanhouden; nieuwe migraties krijgen het volgende nummer.
