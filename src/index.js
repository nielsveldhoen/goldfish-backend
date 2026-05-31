import "./config/env.js";
import http from "http";
import express from "express";
import cors from "cors";
import { createWsServer } from "./ws.js";

import authRoutes from "./routes/auth.js";
import deckRoutes from "./routes/decks.js";
import cardRoutes from "./routes/cards.js";
import reviewRoutes from "./routes/review.js";
import syncRoutes from "./routes/sync.js";
import statsRoutes from "./routes/stats.js";


const app = express();

app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// routes
app.use("/auth", authRoutes);
app.use("/decks", deckRoutes);
app.use("/cards", cardRoutes);
app.use("/review", reviewRoutes);
app.use("/sync", syncRoutes);
app.use("/stats", statsRoutes);

app.get("/", (req, res) => {
  res.send("Goldfish API running 🐟");
});

const server = http.createServer(app);
createWsServer(server);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});