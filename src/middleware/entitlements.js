// requireEntitlement("...") — poortwachter voor pro-features. Altijd ná
// authMiddleware mounten (leest req.user.id).
//
// 403 met code "entitlement_required" + de ontbrekende entitlement, zodat de
// client het onderscheid ziet met een gewone 403 en een gerichte
// upgrade-prompt kan tonen. Bewust géén fail-open: bij een DB-storing krijgt
// niemand gratis pro-toegang (zelfde afweging als de revocatie-check in
// middleware/auth.js).
import { getEntitlements } from "../utils/entitlements.js";

export function requireEntitlement(entitlement) {
  return async (req, res, next) => {
    try {
      const entitlements = await getEntitlements(req.user.id);
      if (!entitlements.has(entitlement)) {
        return res.status(403).json({
          error: "Subscription required",
          code: "entitlement_required",
          entitlement,
        });
      }
      next();
    } catch (err) {
      console.error("entitlement middleware: lookup failed", err);
      res.status(500).json({ error: "Server error" });
    }
  };
}
