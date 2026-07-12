// Alle rate limiters op één plek (SECURITY_PLAN.md fase 2 + 4.1).
//
// Ze stonden eerst verspreid over de route-bestanden. Centraal heeft twee
// voordelen: je ziet in één oogopslag wat er beschermd is en met welk budget,
// en elke limiet-hit loopt door dezelfde handler — die hem als security-event
// logt (4.1). Een limiter die stilletjes vuurt, vertelt je niets over wie er
// aan het rammen is.
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { securityEvent, clientIp } from "../utils/securityLog.js";

const WINDOW_MS = 15 * 60 * 1000;

// Gedeelde handler: log de hit en geef het standaardantwoord.
function limitHandler(name, message) {
  return (req, res) => {
    securityEvent("rate_limit_hit", {
      limiter: name,
      ip: clientIp(req),
      user_id: req.user?.id ?? null,
      method: req.method,
      // Alleen het pad, nooit de query string (die kan tokens bevatten).
      path: req.originalUrl.split("?")[0],
    });
    res.status(429).json({ error: message });
  };
}

function make(name, { max, message, perUser = false }) {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: limitHandler(name, message),
    // Per-user-limiters moeten ná authMiddleware gemount worden; zonder
    // req.user valt de sleutel terug op het IP.
    ...(perUser
      ? { keyGenerator: (req, res) => req.user?.id ?? ipKeyGenerator(req, res) }
      : {}),
  });
}

// Vangnet over de hele /v2-API. Ruim boven normaal sync-gedrag (een actieve
// client doet tientallen requests per kwartier, geen honderden), laag genoeg om
// scripted scraping af te remmen.
export const apiLimiter = make("api", {
  max: 600,
  message: "Too many requests, try again later",
});

// Auth-routes: register, login, resend-verification, forgot-password. Ook de
// browser-flows (reset-password, verify-email) draaien hierop.
export const authLimiter = make("auth", {
  max: 20,
  message: "Too many attempts, try again later",
});

// Groepsjoin verifieert een wachtwoord → zelfde brute-force-profiel als /auth.
export const joinLimiter = make("group_join", {
  max: 20,
  message: "Too many attempts, try again later",
});

// Publieke discovery is de duurste read (ILIKE over alle publieke decks).
export const publicSearchLimiter = make("public_search", {
  max: 120,
  message: "Too many attempts, try again later",
});

// Uitnodigen: POST /contacts (het e-mail-orakel, bevinding 1.5),
// POST /decks/:id/share en POST /groups/:id/invites. Sleutel = user-id: de
// aanvaller is hier per definitie ingelogd, en een IP-sleutel zou gebruikers
// achter dezelfde NAT-uitgang op één hoop gooien.
export const inviteLimiter = make("invite", {
  max: 30,
  message: "Too many invitations, try again later",
  perUser: true,
});
