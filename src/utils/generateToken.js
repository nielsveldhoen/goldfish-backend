import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

// iat_ms is hetzelfde uitgiftemoment als de standaard iat, maar in
// milliseconden. iat heeft namelijk maar secondeprecisie, terwijl het
// revocatie-watermerk (users.tokens_valid_after) exacter is: een token dat in
// dezelfde seconde als een intrekking wordt uitgegeven leest daardoor als ouder
// dan het is en wordt meteen geweigerd. Dat overkomt geen aanvaller maar de
// gebruiker zelf, die na een wachtwoordreset of verwijderaanvraag direct weer
// inlogt. Zie isRevoked() in middleware/auth.js.
export function generateToken(userId) {
  return jwt.sign(
    { userId, iat_ms: Date.now() },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}