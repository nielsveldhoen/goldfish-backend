import "./config/env.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import authRoutes from "./routes/auth.js";
import deckRoutes from "./routes/decks.js";
import cardRoutes from "./routes/cards.js";
import reviewRoutes from "./routes/review.js";
import syncRoutes from "./routes/sync.js";
import statsRoutes from "./routes/stats.js";
import { requireClientVersion, minClientBuild } from "./middleware/clientVersion.js";

const app = express();

// Achter de reverse proxy (Caddy op dezelfde machine): vertrouw precies één
// proxy-hop zodat express-rate-limit het echte client-IP uit X-Forwarded-For leest.
app.set("trust proxy", 1);

app.use(helmet());

// CORS — alleen relevant voor de browser (Flutter web). De native apps
// (Android/iOS/Windows) doen geen preflight en worden hier niet geraakt.
//
// We reflecteren de toegestane origin terug i.p.v. "*", zodat het ook klopt
// als er ooit credentials (cookies) bijkomen. JWT zit nu in de Authorization-
// header — dat is géén "credentialed" request, dus Allow-Credentials is niet
// nodig.
//
// Toegestaan: elke localhost/127.0.0.1-origin (de Flutter web-dev-server kiest
// elke run een willekeurige poort), plus de expliciete productie-origins uit
// CORS_ORIGINS (komma-gescheiden). Requests zonder Origin-header (native apps,
// curl, server-to-server) worden altijd doorgelaten.
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true); // native app / curl: geen Origin
    if (LOCALHOST_ORIGIN.test(origin)) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false); // niet toegestaan: geen CORS-headers, browser blokkeert
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Client-Build"],
};

app.use(cors(corsOptions));
// Preflight (OPTIONS) voor álle routes expliciet afhandelen.
app.options(/.*/, cors(corsOptions));

app.use(express.json({ limit: "1mb" }));

// Request-log zonder query string: die kan tokens bevatten (/auth/verify-email, /ws).
app.use((req, _res, next) => {
  const path = req.originalUrl.split("?")[0];
  console.log(`[${new Date().toISOString()}] ${req.method} ${path}`);
  next();
});

// routes — één router met één naamset (remote/core/stable/recent).
const api = express.Router();
api.use("/auth", authRoutes);
api.use("/decks", deckRoutes);
api.use("/cards", cardRoutes);
api.use("/review", reviewRoutes);
api.use("/sync", syncRoutes);
api.use("/stats", statsRoutes);

// Open discovery-endpoint: nooit achter de client-versiegate, zodat een te oude
// client hier kan zien dat hij moet updaten (min_client_build = vereiste
// Flutter buildNumber).
app.get("/version", async (req, res) => {
  let minBuild = 0;
  try {
    minBuild = await minClientBuild();
  } catch (err) {
    console.error("/version: config-lookup mislukt", err);
  }
  res.json({ versions: ["v2"], latest: "v2", min: "v2", min_client_build: minBuild });
});

app.get("/", (req, res) => {
  res.send("Goldfish API running 🐟");
});

// Alle API-routes zitten onder een expliciet versie-prefix en achter de
// client-versiegate. Nu alleen /v2; een toekomstige versie krijgt een eigen
// mount (bijv. app.use("/v3", apiV3)).
app.use("/v2", requireClientVersion, api);

export default app;
