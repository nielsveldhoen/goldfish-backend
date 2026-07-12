// Gedeelde rate limiters (SECURITY_PLAN.md, fase 2).
//
// De limiters op /auth, password-reset, verify-email, /groups/join en
// GET /decks/public staan bewust in hun eigen route-bestand: die horen bij één
// endpoint. Hier staan de limiters die over meerdere routers heen gelden.
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const WINDOW_MS = 15 * 60 * 1000;

// Vangnet over de hele /v2-API (per IP). Ruim boven normaal sync-gedrag — een
// actieve client doet tientallen requests per kwartier, geen honderden — maar
// laag genoeg om scripted scraping af te remmen. De strengere limiters op de
// gevoelige routes blijven er los naast staan.
export const apiLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 600,
  message: { error: "Too many requests, try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Uitnodigings- en contactroutes: POST /contacts (e-mail-orakel, zie bevinding
// 1.5 in SECURITY_PLAN.md), POST /groups/:id/invites en POST /decks/:id/share.
//
// Sleutel = user-id, niet IP: de aanvaller is hier per definitie ingelogd, en
// een IP-sleutel zou meerdere gebruikers achter dezelfde NAT-uitgang op één
// hoop gooien. Moet dus ná authMiddleware gemount worden; zonder req.user valt
// hij terug op het IP.
export const inviteLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 30,
  message: { error: "Too many invitations, try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id ?? ipKeyGenerator(req, res),
});
