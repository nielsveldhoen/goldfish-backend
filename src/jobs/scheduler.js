import { purgeTombstones } from "./purgeTombstones.js";
import { purgeDeletedAccounts } from "./purgeDeletedAccounts.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// In-process dagelijkse scheduler voor de opruimjobs: eerst de account-purge
// (die maakt nieuwe tombstones en orphans aan), daarna de tombstone-purge
// (incl. orphan-sweep) die ze verder afhandelt. Bewust simpel: één run kort
// na opstart, daarna elke 24 u. Fouten worden gelogd maar laten het proces
// nooit crashen. Gestart vanuit index.js (niet app.js), zodat de tests — die
// alleen app.js importeren — de jobs niet triggeren.
//
// Draait de jobs in dit Node-proces; bij meerdere instances zou je dit naar
// pg_cron of een externe scheduler verplaatsen. Beide jobs zijn idempotent,
// dus dubbel draaien is onschadelijk.
export function startTombstonePurgeScheduler() {
  const run = async () => {
    try {
      await purgeDeletedAccounts();
    } catch (err) {
      console.error("[scheduler] purgeDeletedAccounts run failed:", err);
    }
    try {
      await purgeTombstones();
    } catch (err) {
      console.error("[scheduler] purgeTombstones run failed:", err);
    }
  };

  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref?.(); // houd het proces niet open puur voor deze timer
  return timer;
}
