// Retentie-/sync-horizon-config voor de tombstone-purge en de full-resync-guard.
//
// Twee knoppen, uit env met defaults:
//   TOMBSTONE_RETENTION_DAYS  (default 90) — soft-deletes ouder dan dit worden
//     door purgeTombstones() hard verwijderd. Tot die leeftijd blijven ze als
//     tombstone staan zodat /sync/changes ze nog aan clients kan leveren.
//   SYNC_RESYNC_HORIZON_DAYS  (default 75) — is de `since` van een client ouder
//     dan dit, dan geeft /sync/changes geen delta maar een full-resync-signaal.
//
// INVARIANT: SYNC_RESYNC_HORIZON_DAYS < TOMBSTONE_RETENTION_DAYS. Zou de horizon
// >= retentie zijn, dan kan een client een delta vragen over een venster waarin
// tombstones al gepurged zijn → hij mist die deletes en raakt stil inconsistent.
// De marge (default 15 d) is de tijd die een purge-run en clock-skew mogen
// nemen zonder de garantie te breken. We falen daarom hard bij opstart.
import "./env.js";

function positiveIntFromEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Invalid ${name}: must be a positive integer (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

export const TOMBSTONE_RETENTION_DAYS = positiveIntFromEnv("TOMBSTONE_RETENTION_DAYS", 90);
export const SYNC_RESYNC_HORIZON_DAYS = positiveIntFromEnv("SYNC_RESYNC_HORIZON_DAYS", 75);

// Bedenktijd tussen DELETE /v2/auth/me en de definitieve account-wis door de
// purge-job (ACCOUNT_DELETION_PLAN.md §6). Binnen dit venster kan de
// gebruiker via inloggen + POST /v2/auth/me/restore terug.
export const ACCOUNT_DELETION_GRACE_DAYS = positiveIntFromEnv("ACCOUNT_DELETION_GRACE_DAYS", 14);

// Overlap-venster voor de delta-sync-watermerken (/sync/changes, /stats/changes,
// /review/core). Het teruggegeven server_time (= volgende `since` van de client)
// wordt dit aantal seconden vóór het query-moment gezet. Zo vallen writes die
// rond het snapshot committen — of transacties die vóór het watermerk startten
// maar erna committen — bij de volgende delta alsnog binnen het venster.
// Dubbel geleverde rijen zijn onschadelijk: de client upsert idempotent.
export const SYNC_WATERMARK_OVERLAP_SECONDS = positiveIntFromEnv("SYNC_WATERMARK_OVERLAP_SECONDS", 5);

// Pure, testbare invariant-check. Gooit als de horizon niet strikt kleiner is
// dan de retentie.
export function assertRetentionInvariant(horizonDays, retentionDays) {
  if (!(horizonDays < retentionDays)) {
    throw new Error(
      `SYNC_RESYNC_HORIZON_DAYS (${horizonDays}) must be < ` +
        `TOMBSTONE_RETENTION_DAYS (${retentionDays})`
    );
  }
}

// Bij opstart afdwingen (module-load = startup, via app.js → config).
try {
  assertRetentionInvariant(SYNC_RESYNC_HORIZON_DAYS, TOMBSTONE_RETENTION_DAYS);
} catch (err) {
  console.error(`Config invariant violated: ${err.message}`);
  process.exit(1);
}
