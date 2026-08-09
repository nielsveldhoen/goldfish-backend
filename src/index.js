import "./config/env.js";
import http from "http";
import app from "./app.js";
import { createWsServer } from "./ws.js";
import { startTombstonePurgeScheduler } from "./jobs/scheduler.js";

const server = http.createServer(app);
createWsServer(server);

// Dagelijkse tombstone-purge (hard-delete van oude soft-deletes).
// DISABLE_BACKGROUND_JOBS=1 zet hem uit; bedoeld voor een dev-instance die tegen
// de PRODUCTIE-database praat (scripts/dev.sh --db remote). Twee processen die
// dezelfde rijen hard-deleten is onnodig, en het hoort niet vanaf een laptop.
// In productie staat de vlag niet, dus daar draait hij gewoon.
if (process.env.DISABLE_BACKGROUND_JOBS === "1") {
  console.log("achtergrondjobs uitgeschakeld (DISABLE_BACKGROUND_JOBS=1)");
} else {
  startTombstonePurgeScheduler();
}

const PORT = process.env.PORT || 3000;
// In productie (achter de reverse proxy) HOST=127.0.0.1 zetten zodat de app
// niet rechtstreeks vanaf het netwerk bereikbaar is.
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
});
