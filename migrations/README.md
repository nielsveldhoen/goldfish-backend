# Database-migraties

SQL-migraties die als `postgres`-superuser gedraaid moeten worden (de
app-user `goldfish` heeft geen DDL-rechten). Op de lokale dev-database zijn
beide al uitgevoerd op 2026-06-12; op de remote server nog draaien.

```bash
sudo -u postgres psql -d goldfish -f 001_progress_deleted_at.sql
sudo -u postgres psql -d goldfish -f 002_hash_verification_tokens.sql   # éénmalig!
sudo -u postgres psql -d goldfish -f 003_rename_ltm_remote_stm_stable_add_recent.sql
```

| Bestand | Wat | Herhaalbaar? |
|---|---|---|
| `001_progress_deleted_at.sql` | `deleted_at`-kolom op `user_card_progress` (progress reset + sync) | ja, idempotent |
| `002_hash_verification_tokens.sql` | bestaande verificatietokens sha256-hashen | **nee — precies één keer** |
| `003_rename_ltm_remote_stm_stable_add_recent.sql` | LTM→remote, STM→stable, nieuwe `recent`-kolom; sync-triggers voor oude clients + `schema_migrations`-tabel | **nee — precies één keer** (rerun faalt veilig op `ADD COLUMN`) |

Volgorde aanhouden; nieuwe migraties krijgen het volgende nummer.
