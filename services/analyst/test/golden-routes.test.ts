/** Golden master for the HTTP routes: every route's answer (normalized) equals test/golden/routes.golden.json. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("analyst routes golden master: answers identical to test/golden/routes.golden.json", () => {
  const script = fileURLToPath(new URL("../scripts/golden-routes.ts", import.meta.url));
  const r = spawnSync(process.execPath, [script, "--mode", "check"], { encoding: "utf8", timeout: 300000 });
  assert.equal(r.status, 0, `golden-routes check failed:\n${r.stdout}${r.stderr}`);
});
