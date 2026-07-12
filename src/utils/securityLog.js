// Security-logging (SECURITY_PLAN.md 4.1).
//
// Eén regel JSON per gebeurtenis, naar stdout — pm2/journald bewaren dat en
// logrotate ruimt het op. Geen aparte log-dependency: de behoefte is klein en
// de dependency-lijst blijft bewust kort.
//
// HARDE REGEL: hier komen nooit wachtwoorden, tokens, JWT's of e-mailadressen
// in. Een securitylog dat zelf gevoelige data lekt, is een nieuw lek. Wat er
// wél in mag: IP, route, user-id (een UUID zonder DB is nietszeggend) en een
// reden-code. Bij een mislukte login loggen we dus géén identifier — anders
// staat het e-mailadres van elke typefout in de logs, en een aanvaller die het
// log leest krijgt gratis een lijst geldige adressen.
//
// Zoeken: `pm2 logs goldfish-backend | grep '"tag":"security"'`

const TAG = "security";

export function securityEvent(event, fields = {}) {
  // console.warn → stderr, zodat security-events in pm2 in het aparte
  // error-logbestand belanden en niet ondersneeuwen in het request-log.
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      tag: TAG,
      event,
      ...fields,
    })
  );
}

// Client-IP zoals de rate limiter het ook ziet (respecteert TRUST_PROXY).
export function clientIp(req) {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
