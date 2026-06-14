import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";

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

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      socket.close(CLOSE_UNAUTHORIZED, "Unauthorized");
      return;
    }

    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.userId;
      // exp in seconden; nodig om de verbinding te sluiten zodra het token
      // tijdens de sessie verloopt.
      socket.tokenExpiresAt = decoded.exp ? decoded.exp * 1000 : null;
    } catch {
      socket.close(CLOSE_UNAUTHORIZED, "Unauthorized");
      return;
    }

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

export function broadcast(userId, type, payload, exclude = null) {
  const sockets = connections.get(userId);
  if (!sockets) return;

  const message = JSON.stringify({
    type,
    payload,
    server_time: new Date().toISOString(),
  });

  for (const socket of sockets) {
    if (socket === exclude) continue;
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}
