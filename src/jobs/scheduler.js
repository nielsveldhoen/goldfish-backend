import { purgeTombstones } from "./purgeTombstones.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// In-process dagelijkse scheduler voor de tombstone-purge. Bewust simpel: één
// run kort na opstart, daarna elke 24 u. Fouten worden gelogd maar laten het
// proces nooit crashen. Gestart vanuit index.js (niet app.js), zodat de tests
// — die alleen app.js importeren — de job niet triggeren.
//
// Draait de job in dit Node-proces; bij meerdere instances zou je dit naar
// pg_cron of een externe scheduler verplaatsen. De purge is idempotent, dus
// dubbel draaien is onschadelijk.
export function startTombstonePurgeScheduler() {
  const run = () =>
    purgeTombstones().catch((err) =>
      console.error("[scheduler] purgeTombstones run failed:", err)
    );

  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref?.(); // houd het proces niet open puur voor deze timer
  return timer;
}
