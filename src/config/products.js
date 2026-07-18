// Productcatalogus: welke abonnementen bestaan er en welke features
// (entitlements) ontgrendelt elk product. Eén plek, in code — een nieuw
// product of een bundel toevoegen is een regel hier, geen migratie
// (subscriptions.product_key is vrije tekst, zie migratie 022).
//
// Product ≠ feature: routes checken altijd op een ENTITLEMENT (via
// requireEntitlement), nooit op een product_key. Zo kan later een bundel
// ("pro_all") of een actie-product dezelfde features ontgrendelen zonder dat
// er één route-check hoeft te veranderen.

export const ENTITLEMENTS = Object.freeze({
  SPEECH_RECOGNITION: "speech_recognition", // spraakherkenning in alle talen
  AI_ANSWER_CHECK: "ai_answer_check",       // AI-gestuurde antwoordcontrole
  EXAM_PLANNING: "exam_planning",           // examens inplannen + examentraining
});

export const PRODUCTS = Object.freeze({
  pro_speech: { entitlements: [ENTITLEMENTS.SPEECH_RECOGNITION] },
  pro_ai_check: { entitlements: [ENTITLEMENTS.AI_ANSWER_CHECK] },
  pro_exams: { entitlements: [ENTITLEMENTS.EXAM_PLANNING] },
  // Voorbeeld voor later — bundel die alles ontgrendelt:
  // pro_all: { entitlements: Object.values(ENTITLEMENTS) },
});

// Entitlements die een lijst product_keys samen ontgrendelen. Onbekende keys
// (product uit de catalogus gehaald, of typefout in een handmatige DML-insert)
// tellen niet mee maar breken niets — de rij blijft gewoon staan.
export function entitlementsFor(productKeys) {
  const out = new Set();
  for (const key of productKeys) {
    const product = PRODUCTS[key];
    if (!product) {
      console.warn(`products: onbekende product_key genegeerd: ${key}`);
      continue;
    }
    for (const ent of product.entitlements) out.add(ent);
  }
  return out;
}
