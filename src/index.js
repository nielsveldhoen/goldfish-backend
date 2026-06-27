import "./config/env.js";
import http from "http";
import app from "./app.js";
import { createWsServer } from "./ws.js";
import { startTombstonePurgeScheduler } from "./jobs/scheduler.js";

const server = http.createServer(app);
createWsServer(server);

// Dagelijkse tombstone-purge (hard-delete van oude soft-deletes).
startTombstonePurgeScheduler();

const PORT = process.env.PORT || 3000;
// In productie (achter de reverse proxy) HOST=127.0.0.1 zetten zodat de app
// niet rechtstreeks vanaf het netwerk bereikbaar is.
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
});
