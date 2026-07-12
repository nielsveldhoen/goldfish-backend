import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { pool } from "./db.js";
import { isRevoked } from "./middleware/auth.js";
import { securityEvent } from "./utils/securityLog.js";

const JWT_SECRET = process.env.JWT_SECRET;

// Close code waarmee de client stopt met reconnecten (auth definitief mislukt).
const CLOSE_UNAUTHORIZED = 4001;
// Verbindingslimiet overschreden: de oudste socket gaat dicht. Bewust géén
// 4001 — die socket is niet ongeautoriseerd en de client mag reconnecten.
const CLOSE_TOO_MANY = 4002;

// Server-side heartbeat: elke HEARTBEAT_INTERVAL_MS een ping-frame; wie dan
// nog niet op de vorige ping heeft gepongd (≈ 2 intervallen ≈ 60s) gaat dicht.
const HEARTBEAT_INTERVAL_MS = Number(process.env.WS_HEARTBEAT_INTERVAL_MS) || 30_000;

// Grootste bericht dat een client mag sturen. Clients sturen alleen pings en
// (nieuw) het auth-bericht; de ws-default van 100 MiB is een gratis
// geheugen-DoS. Groter bericht → ws sluit de socket met 1009.
const MAX_PAYLOAD_BYTES = 64 * 1024;

// Max gelijktijdige sockets per gebruiker. Ruim boven "telefoon + tablet +
// laptop, allemaal met een herstelde verbinding", laag genoeg dat één account
// de server niet kan volpompen met open verbindingen.
const MAX_SOCKETS_PER_USER = 10;

// Tijd die een client krijgt om zijn token te sturen als het niet in de URL
// staat (zie authenticatie hieronder).
const AUTH_TIMEOUT_MS = Number(process.env.WS_AUTH_TIMEOUT_MS) || 5_000;

// userId → Set<WebSocket>
const connections = new Map();

// Token uit het auth-bericht ({"type":"auth","token":"..."}), of null.
function authTokenFrom(data) {
  try {
    const msg = JSON.parse(data.toString());
    if (msg?.type === "auth" && typeof msg.token === "string") return msg.token;
  } catch {
    // Geen JSON: geen auth-bericht.
  }
  return null;
}

export function createWsServer(server) {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  // Authenticatie kan op twee manieren:
  //   (a) token als eerste WS-bericht — voorkeur: de query string van een
  //       WS-upgrade belandt in de accesslogs van de proxy, het bericht niet;
  //   (b) token in de query string (?token=...) — het oude pad, blijft werken
  //       zolang er clients zijn die het zo sturen (zie SECURITY_PLAN 2.7).
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    const queryToken = url.searchParams.get("token");

    // De WS-upgrade komt via nginx binnen; het echte client-IP staat dus in
    // X-Forwarded-For. Alleen voor de logging — nooit voor autorisatie.
    socket.clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";

    if (queryToken) {
      authenticate(socket, queryToken);
      return;
    }

    // Geen token in de URL: wachten op het auth-bericht. Wie binnen de timeout
    // niets bruikbaars stuurt, gaat dicht — anders houdt een anonieme client
    // gratis een socket open.
    const timer = setTimeout(() => {
      securityEvent("ws_auth_failed", { ip: socket.clientIp, reason: "auth_timeout" });
      socket.close(CLOSE_UNAUTHORIZED, "Unauthorized");
    }, AUTH_TIMEOUT_MS);

    const onAuthMessage = (data) => {
      const token = authTokenFrom(data);
      if (!token) return; // ander bericht vóór auth: negeren, timeout loopt door
      clearTimeout(timer);
      socket.off("message", onAuthMessage);
      authenticate(socket, token);
    };

    socket.on("message", onAuthMessage);
    socket.on("close", () => clearTimeout(timer));
    // Vóór authenticatie is er nog geen error-handler; zonder deze gooit een
    // socket-error een uncaught exception op.
    socket.on("error", () => {});
  });

  async function authenticate(socket, token) {
    let userId;
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.userId;
      // exp in seconden; nodig om de verbinding te sluiten zodra het token
      // tijdens de sessie verloopt.
      socket.tokenExpiresAt = decoded.exp ? decoded.exp * 1000 : null;
    } catch (err) {
      securityEvent("ws_auth_failed", {
        ip: socket.clientIp,
        reason: err.name === "TokenExpiredError" ? "expired" : "invalid_signature",
      });
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
        securityEvent("ws_auth_failed", {
          ip: socket.clientIp,
          reason: rows.length === 0 ? "unknown_user" : "revoked",
        });
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

    register(socket, userId);
  }

  function register(socket, userId) {
    socket.isAlive = true;
    socket.userId = userId; // markeert de socket als geauthenticeerd (heartbeat)

    if (!connections.has(userId)) connections.set(userId, new Set());
    const sockets = connections.get(userId);

    // Verbindingslimiet: de oudste sockets wijken voor de nieuwe. Een Set houdt
    // insertion order aan, dus values().next() is de oudste. Nieuwe verbindingen
    // weigeren zou een gebruiker met tien dode sockets buitensluiten; de oudste
    // opruimen is bijna altijd precies de bedoeling.
    while (sockets.size >= MAX_SOCKETS_PER_USER) {
      const oldest = sockets.values().next().value;
      sockets.delete(oldest);
      oldest.close(CLOSE_TOO_MANY, "Too many connections");
    }

    sockets.add(socket);

    // Op ping-frames antwoordt ws zelf al met pong (autoPong). Pongs van onze
    // eigen heartbeat-pings markeren de verbinding als levend.
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    // Clients sturen soms tekstberichten (oudere clients: de string "ping",
    // nieuwe clients een tweede auth-bericht na een reconnect). Die zijn geen
    // onderdeel van het protocol: negeren, nooit crashen.
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
  }

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      // Nog niet geauthenticeerd: die socket wordt door de auth-timeout
      // bewaakt, niet door de heartbeat (anders termineert de heartbeat hem
      // met 1006 vóór hij zijn token heeft kunnen sturen).
      if (!socket.userId) continue;

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

// server_time moet uit dezelfde klokbron komen als de REST-sync (Postgres
// NOW()), want de frontend schrijft beide naar dezelfde lastSync-cursor.
// We nemen daarom de jongste updated_at/deleted_at uit de payload (dat zijn
// DB-rijen) — minus 1 ms, omdat NOW() transactie-vast is: rijen die in
// dezelfde transactie zijn mee-gewijzigd (bijv. cascade-soft-deletes) delen
// exact deze timestamp en zouden bij een strikte `> since`-delta anders
// buiten het venster vallen. Alleen als geen enkel item een timestamp
// draagt valt dit terug op de Node-klok.
function serverTimeFor(items) {
  const times = items
    .map((item) => item?.updated_at ?? item?.deleted_at)
    .filter(Boolean)
    .map((t) => new Date(t).getTime())
    .filter((ms) => !Number.isNaN(ms));

  if (times.length === 0) return new Date().toISOString();
  return new Date(Math.max(...times) - 1).toISOString();
}

// Protocolcontract: payload is op de draad áltijd een array van objecten,
// ook bij één item. Call sites mogen een los object of een array aanleveren;
// een lege array wordt niet verstuurd.
export function broadcast(userId, type, payload, exclude = null) {
  broadcastMany([userId], type, payload, exclude);
}

// Fan-out naar owner + alle actieve recipients van een deck (deck_updated,
// deck_deleted, card_*). `excludeUserId` voor bulk-paden die de owner al
// apart (met de volledige batch) bedienen. Async — call sites die de
// response niet willen ophouden mogen fire-and-forget met .catch().
export async function broadcastDeck(deckId, type, payload, { excludeUserId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT user_id AS id FROM decks WHERE id = $1
     UNION
     SELECT recipient_id AS id FROM deck_shares
     WHERE deck_id = $1 AND revoked_at IS NULL AND accepted_at IS NOT NULL`,
    [deckId]
  );
  const userIds = rows.map((r) => r.id).filter((id) => id !== excludeUserId);
  broadcastMany(userIds, type, payload);
}

// Fan-out naar alle leden van een groep (actief én uitgenodigd — een invitee
// moet zijn aanvraag zien verdwijnen als de groep wijzigt/verdwijnt).
export async function broadcastGroup(groupId, type, payload, { excludeUserId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT user_id FROM group_members WHERE group_id = $1`,
    [groupId]
  );
  const userIds = rows.map((r) => r.user_id).filter((id) => id !== excludeUserId);
  broadcastMany(userIds, type, payload);
}

function broadcastMany(userIds, type, payload, exclude = null) {
  const items = Array.isArray(payload) ? payload : [payload];
  if (items.length === 0) return;

  let message = null; // lazy: niet serialiseren als niemand verbonden is

  for (const userId of userIds) {
    const sockets = connections.get(userId);
    if (!sockets) continue;

    message ??= JSON.stringify({
      type,
      payload: items,
      server_time: serverTimeFor(items),
    });

    for (const socket of sockets) {
      if (socket === exclude) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }
}
