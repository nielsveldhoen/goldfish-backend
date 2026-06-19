// Client-versiegate. De minimaal vereiste Flutter buildNumber staat in
// app_config (key 'min_client_build', zie migrations/006). De client stuurt
// zijn eigen buildNumber mee in de header `X-Client-Build`. Is die lager dan
// het minimum, dan weigert de server de call met HTTP 426 Upgrade Required.
//
// Een ontbrekend/onparseerbaar header telt als build 0: zolang het minimum 0
// is (de seed-waarde) wordt dus niets geblokkeerd. Hoog het minimum pas op
// nadat een client die de header meestuurt is uitgerold.
import { pool } from "../db.js";

const HEADER = "x-client-build";

// Per request vers uit de DB gelezen — één geïndexeerde PK-lookup, te
// verwaarlozen op deze schaal, en zo werkt een UPDATE direct door.
export async function minClientBuild() {
  const { rows } = await pool.query(
    `SELECT value FROM app_config WHERE key = 'min_client_build'`
  );
  return rows.length ? Number(rows[0].value) || 0 : 0;
}

export async function requireClientVersion(req, res, next) {
  let min;
  try {
    min = await minClientBuild();
  } catch (err) {
    // Fail-open: de gate mag zelf geen single point of failure zijn. Lukt de
    // config-lookup niet, laat de request door (de handler faalt dan alsnog
    // netjes als de DB echt plat ligt).
    console.error("client-version gate: config-lookup mislukt", err);
    return next();
  }

  const build = Number(req.get(HEADER)) || 0;
  if (build < min) {
    return res.status(426).json({
      error: "client_version_unsupported",
      min_client_build: min,
    });
  }
  next();
}
