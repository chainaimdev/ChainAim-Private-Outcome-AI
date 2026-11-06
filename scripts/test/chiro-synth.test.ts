/**
 * tools/chiro-synth (2026-11-06): truth.json carries query_answers, the answers of the chiro query bank computed from the
 * generator's model; the verifier recomputes them from the written files and catches a tampered figure. Runs the real Python
 * scripts in a temporary folder (no sample-data needed); skipped when no Python 3 is on PATH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GEN = fileURLToPath(new URL("../../tools/chiro-synth/gen_chiro_set.py", import.meta.url));
const VERIFY = fileURLToPath(new URL("../../tools/chiro-synth/verify_chiro_set.py", import.meta.url));
const PY = ["python", "python3"].find((p) => spawnSync(p, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"]).status === 0);
const run = (script: string, args: string[]) => spawnSync(PY!, [script, ...args], { encoding: "utf8" });
const truthOf = (dir: string) => JSON.parse(readFileSync(join(dir, "_answer-key", "truth.json"), "utf8"));

test("POS: query_answers for both PRMS (seed 1 figures), the same in both, and the verifier recomputes them from the files", { skip: !PY && "no Python 3 on PATH" }, () => {
  const root = mkdtempSync(join(tmpdir(), "chiro-synth-"));
  try {
    for (const p of ["chirotouch", "jane"]) { const g = run(GEN, ["--prms", p, "--out", join(root, p)]); assert.equal(g.status, 0, g.stderr + g.stdout); }
    const ct = truthOf(join(root, "chirotouch")).query_answers, jane = truthOf(join(root, "jane")).query_answers;
    assert.deepEqual(ct.cash, { in: "53076.86", out: "31305.87", net: "21770.99" });
    assert.deepEqual(jane.cash, { in: "55198.07", out: "30808.45", net: "24389.62" });
    assert.deepEqual(ct.pi_open, { "CT/MedPay": { open_cases: 15, billed: "9130.00", carrier_paid: "6800.00", open_balance: "2330.00" },
      "MA/PIP": { open_cases: 13, billed: "7100.00", carrier_paid: "4780.00", open_balance: "2320.00" } });
    assert.deepEqual(ct.payer_paid["AETNA (SYN)"], { payments: 3, claims_paid: 124, paid: "10022.50" });
    assert.equal(Object.keys(ct.contracted).length, 44);
    assert.deepEqual(ct.contracted["AETNA (SYN)/97012"], { allowed: "22.50", charges: 31, avg_charge: "30.00" });
    assert.deepEqual(ct.payer_paid, jane.payer_paid, "the same seed gives the same 835 in both PRMS");
    assert.deepEqual(ct.contracted, jane.contracted); assert.deepEqual(ct.pi_open, jane.pi_open);
    const v = run(VERIFY, ["--dir", join(root, "chirotouch"), "--tag", "SET1-POS", "--compare", join(root, "jane")]);
    assert.equal(v.status, 0, v.stdout + v.stderr); assert.match(v.stdout, /ALL CHECKS PASS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("NEG-EFT-MISSING: payer_paid follows the 835 (not the bank EFTs) and still verifies", { skip: !PY && "no Python 3 on PATH" }, () => {
  const root = mkdtempSync(join(tmpdir(), "chiro-synth-"));
  try {
    const g = run(GEN, ["--prms", "jane", "--scenario", "neg-eft-missing", "--out", root]); assert.equal(g.status, 0, g.stderr + g.stdout);
    const t = truthOf(root);
    const paid = Object.values(t.query_answers.payer_paid as Record<string, { paid: string }>).reduce((n, x) => n + Math.round(Number(x.paid) * 100), 0);
    assert.equal(paid, 2357210, "the 835 still pays 23572.10");
    assert.ok(Math.round(Number(t.bank_credits_by_group.insurance_eft) * 100) < paid, "the bank received less (the planted missing EFT)");
    const v = run(VERIFY, ["--dir", root, "--tag", "SET1-NEG-EFT-MISSING"]); assert.equal(v.status, 0, v.stdout + v.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the verifier catches a tampered query_answers figure and a key without query_answers, naming them", { skip: !PY && "no Python 3 on PATH" }, () => {
  const root = mkdtempSync(join(tmpdir(), "chiro-synth-"));
  try {
    assert.equal(run(GEN, ["--prms", "chirotouch", "--out", root]).status, 0);
    const path = join(root, "_answer-key", "truth.json"); const good = readFileSync(path, "utf8");
    const edit = (f: (t: any) => void) => { const t = JSON.parse(good); f(t); writeFileSync(path, JSON.stringify(t, null, 2)); return run(VERIFY, ["--dir", root, "--tag", "SET1-POS"]); };
    let v = edit((t) => { t.query_answers.cash.in = "53076.87"; }); assert.equal(v.status, 1); assert.match(v.stdout, /query_answers\.cash/);
    v = edit((t) => { t.query_answers.pi_open["MA/PIP"].open_balance = "2320.01"; }); assert.equal(v.status, 1); assert.match(v.stdout, /query_answers\.pi_open/);
    v = edit((t) => { t.query_answers.payer_paid["AETNA (SYN)"].claims_paid = 125; }); assert.equal(v.status, 1); assert.match(v.stdout, /query_answers\.payer_paid/);
    v = edit((t) => { t.query_answers.contracted["AETNA (SYN)/97012"].avg_charge = "30.01"; }); assert.equal(v.status, 1); assert.match(v.stdout, /query_answers\.contracted.*AETNA \(SYN\)\/97012/);
    v = edit((t) => { delete t.query_answers; }); assert.equal(v.status, 1); assert.match(v.stdout, /no query_answers \(regenerate/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
