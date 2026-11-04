/**
 * L3 (POS: no false alarms) and L4 (NEG: each planted leak found with its cause, amount, date and payment IDs) on every
 * generated scenario folder under <DENTAL_DATA_ROOT>/SET-2/ (Phase 4c layouts; default sample-data/prms/dent-prms-c-sample/SET-2/) that has an answer key (git-ignored; made by
 * tools/dental-synth/gen_dental_set.py --scenario pos|neg-all|neg-<leak>). Skipped with the reason when none exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SET } from "./data-root.ts";

const ROOT = SET("SET-2");
const sets = existsSync(ROOT) ? readdirSync(ROOT).filter((n) => existsSync(join(ROOT, n, "_answer-key", "truth.json"))).sort() : [];
const script = fileURLToPath(new URL("../scripts/reconcile-check.ts", import.meta.url));

if (!sets.length) test("dental scenarios", { skip: `no generated sets under ${ROOT}` }, () => {});
for (const name of sets) {
  test(`${name}: reconcile-check reproduces the answer key (matches and diagnosed exceptions)`, () => {
    const out = spawnSync(process.execPath, [script, "--folder", join(ROOT, name), "--json"], { encoding: "utf8", timeout: 120000 });
    assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
    const s = JSON.parse(out.stdout);
    assert.deepEqual([s.missing, s.extra, s.missingExceptions, s.extraExceptions, s.failedChecks], [[], [], [], [], []]);
  });
}
