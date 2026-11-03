/** Golden master: every pure export of @chainaim/actus gives byte-identical output to the recorded file. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

test("actus golden master: outputs identical to test/golden/actus.golden.json", () => {
  const r = spawnSync(process.execPath, [at("../../../tools/golden/golden.ts"), "--mode", "check", "--module", at("../src/index.ts"),
    "--cases", at("golden/cases.json"), "--golden", at("golden/actus.golden.json"), "--skip", "runDirect,mentorBuild,mentorRun"], { encoding: "utf8" });
  assert.equal(r.status, 0, `golden check failed:\n${r.stdout}${r.stderr}`);
});
