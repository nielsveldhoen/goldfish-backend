// Abonnementen — read-only voor de client. Rijen ontstaan (voorlopig)
// handmatig via DML of later via betaalprovider-webhooks; er is bewust geen
// POST/DELETE: een client die zijn eigen abonnementen kan schrijven is een
// gratis-pro-generator.
import express from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getSubscriptions } from "../utils/entitlements.js";
import { entitlementsFor } from "../config/products.js";

const router = express.Router();

// ========================
// GET /subscriptions 🔒
// ========================
// Alle abonnementsrijen (incl. verlopen — de client kan "verlopen op ..."
// tonen) + de daaruit volgende actieve entitlements in één response.
router.get("/", authMiddleware, async (req, res) => {
  try {
    const subscriptions = await getSubscriptions(req.user.id);
    const entitlements = entitlementsFor(
      subscriptions.filter((s) => s.active).map((s) => s.product_key)
    );
    res.json({
      subscriptions,
      entitlements: [...entitlements].sort(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
