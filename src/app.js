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
import { apiVersion, minApiVersion } from "./middleware/apiVersion.js";

const app = express();

// Achter de reverse proxy (Caddy op dezelfde machine): vertrouw precies één
// proxy-hop zodat express-rate-limit het echte client-IP uit X-Forwarded-For leest.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Request-log zonder query string: die kan tokens bevatten (/auth/verify-email, /ws).
app.use((req, _res, next) => {
  const path = req.originalUrl.split("?")[0];
  console.log(`[${new Date().toISOString()}] ${req.method} ${path}`);
  next();
});

// routes — één router, gemount per API-versie. De handlers gebruiken intern
// de nieuwe veldnamen (remote/stable/recent); apiVersion vertaalt voor v1
// van/naar de oude namen (ltm/stm).
const api = express.Router();
api.use("/auth", authRoutes);
api.use("/decks", deckRoutes);
api.use("/cards", cardRoutes);
api.use("/review", reviewRoutes);
api.use("/sync", syncRoutes);
api.use("/stats", statsRoutes);

app.get("/version", (req, res) => {
  const min = minApiVersion();
  const versions = [1, 2].filter((v) => v >= min).map((v) => `v${v}`);
  res.json({ versions, latest: "v2", min: `v${min}` });
});

app.get("/", (req, res) => {
  res.send("Goldfish API running 🐟");
});

app.use("/v1", apiVersion(1), api);
app.use("/v2", apiVersion(2), api);
// Ongeprefixte paden blijven werken voor al uitgerolde appversies (= v1).
app.use("/", apiVersion(1), api);

export default app;
