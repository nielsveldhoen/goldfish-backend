import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

// userId → Set<WebSocket>
const connections = new Map();

export function createWsServer(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      socket.close(4001, "Unauthorized");
      return;
    }

    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.userId;
    } catch {
      socket.close(4001, "Unauthorized");
      return;
    }

    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId).add(socket);

    socket.on("ping", () => socket.pong());

    socket.on("close", () => {
      connections.get(userId)?.delete(socket);
      if (connections.get(userId)?.size === 0) connections.delete(userId);
    });
  });
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
