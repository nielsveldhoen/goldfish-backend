import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { pool } from "./db.js";
import { isRevoked } from "./middleware/auth.js";

const JWT_SECRET = process.env.JWT_SECRET;

// Close code waarmee de client stopt met reconnecten (auth definitief mislukt).
const CLOSE_UNAUTHORIZED = 4001;

// Server-side heartbeat: elke HEARTBEAT_INTERVAL_MS een ping-frame; wie dan
// nog niet op de vorige ping heeft gepongd (≈ 2 intervallen ≈ 60s) gaat dicht.
const HEARTBEAT_INTERVAL_MS = Number(process.env.WS_HEARTBEAT_INTERVAL_MS) || 30_000;

// userId → Set<WebSocket>
const connections = new Map();

export function createWsServer(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      socket.close(CLOSE_UNAUTHORIZED, "Unauthorized");
      return;
    }

    let userId;
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.userId;
      // exp in seconden; nodig om de verbinding te sluiten zodra het token
      // tijdens de sessie verloopt.
      socket.tokenExpiresAt = decoded.exp ? decoded.exp * 1000 : null;
    } catch {
      socket.close(CLOSE_UNAUTHORIZED, "Unauthorized");
      return;
    }

    // Revocatie-check, zelfde regels als het REST-middleware. Alleen bij de
    // handshake: wordt het token daarná ingetrokken, dan krijgt de client op
    // zijn eerstvolgende REST-call een 401 en verbreekt hij zelf de WS.
    try {
      const { rows } = await pool.query(
        `SELECT tokens_valid_after FROM users WHERE id = $1`,
        [userId]
      );
      if (rows.length === 0 || isRevoked(decoded, rows[0].tokens_valid_after)) {
        socket.close(CLOSE_UNAUTHORIZED, "Unauthorized");
        return;
      }
    } catch (err) {
      console.error("[ws] revocation lookup failed:", err);
      socket.close(1011, "Server error");
      return;
    }

    // De lookup is async: is de socket intussen al dichtgegaan, registreer
    // hem dan niet meer (anders blijft hij als wees in `connections` hangen).
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.isAlive = true;

    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId).add(socket);

    // Op ping-frames antwoordt ws zelf al met pong (autoPong). Pongs van onze
    // eigen heartbeat-pings markeren de verbinding als levend.
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    // Clients sturen soms tekstberichten (oudere clients: de string "ping").
    // Die zijn geen onderdeel van het protocol: negeren, nooit crashen.
    socket.on("message", (data) => {
      try {
        JSON.parse(data.toString());
      } catch {
        if (process.env.WS_DEBUG) {
          console.log(`[ws] ignored unparseable message from user ${userId}`);
        }
      }
    });

    socket.on("error", (err) => {
      if (process.env.WS_DEBUG) {
        console.log(`[ws] socket error for user ${userId}: ${err.message}`);
      }
    });

    socket.on("close", () => {
      connections.get(userId)?.delete(socket);
      if (connections.get(userId)?.size === 0) connections.delete(userId);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.tokenExpiresAt && socket.tokenExpiresAt <= Date.now()) {
        socket.close(CLOSE_UNAUTHORIZED, "Token expired");
        continue;
      }

      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }

      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}

// Protocolcontract: payload is op de draad áltijd een array van objecten,
// ook bij één item. Call sites mogen een los object of een array aanleveren;
// een lege array wordt niet verstuurd.
export function broadcast(userId, type, payload, exclude = null) {
  const items = Array.isArray(payload) ? payload : [payload];
  if (items.length === 0) return;

  const sockets = connections.get(userId);
  if (!sockets) return;

  const message = JSON.stringify({
    type,
    payload: items,
    server_time: new Date().toISOString(),
  });

  for (const socket of sockets) {
    if (socket === exclude) continue;
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}
