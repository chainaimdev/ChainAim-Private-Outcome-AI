/** Golden masters: every pure export of @chainaim/crossask gives byte-identical output to the recorded files. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const tool = at("../../../tools/golden/golden.ts");
const check = (module: string, name: string, skip = "") => {
  const r = spawnSync(process.execPath, [tool, "--mode", "check", "--module", at(module), "--cases", at(`golden/${name}.cases.json`), "--golden", at(`golden/${name}.golden.json`), "--skip", skip], { encoding: "utf8" });
  assert.equal(r.status, 0, `golden check failed:\n${r.stdout}${r.stderr}`);
};

// parseAttestHeaders takes a header getter (a function), which a JSON case cannot hold; ARCH-411 tests cover it.
// figuresVerdict (tab 03 figures line, 2026-11-07) is new, not a moved function: verify-small.test.ts covers every case of it.
test("crossask golden master: extractSql, resultText, fanOutJoins and the two prompts unchanged", () => check("../src/index.ts", "crossask", "crossAsk,analystClient,gatewayChat,explainReconcile,parseAttestHeaders,figuresVerdict"));
test("verifyAnswer golden master: the number check unchanged", () => check("../src/verify.ts", "verify", "verifyMoney"));
