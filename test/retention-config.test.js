// Retentie/horizon-config: de invariant SYNC_RESYNC_HORIZON_DAYS <
// TOMBSTONE_RETENTION_DAYS. Getest als pure functie én als echte opstart
// (subprocess), zodat we afdekken dat de server weigert te starten bij een
// foute configuratie.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { assertRetentionInvariant } from "../src/config/retention.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(join(__dirname, "../src/config/retention.js")).href;

// Start het retention-config-module in een vers proces met de gegeven env en
// geef de exit-code terug. process.exit(1) bij geschonden invariant.
function startWith(env) {
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(modUrl)})`],
    { env: { ...process.env, ...env }, encoding: "utf8" }
  );
  return res.status;
}

describe("retentie/horizon-invariant", () => {
  test("pure check: gooit als horizon >= retentie", () => {
    assert.throws(() => assertRetentionInvariant(90, 90));
    assert.throws(() => assertRetentionInvariant(100, 90));
  });

  test("pure check: ok als horizon < retentie", () => {
    assert.doesNotThrow(() => assertRetentionInvariant(75, 90));
  });

  test("opstart faalt (exit 1) als horizon >= retentie", () => {
    const code = startWith({
      SYNC_RESYNC_HORIZON_DAYS: "100",
      TOMBSTONE_RETENTION_DAYS: "90",
    });
    assert.equal(code, 1, "proces moet met code 1 stoppen");
  });

  test("opstart slaagt (exit 0) als horizon < retentie", () => {
    const code = startWith({
      SYNC_RESYNC_HORIZON_DAYS: "50",
      TOMBSTONE_RETENTION_DAYS: "90",
    });
    assert.equal(code, 0, "geldige config → normale start");
  });
});
