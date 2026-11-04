/**
 * Phase 4a smoke tests on the owner's synthetic set (<DENTAL_DATA_ROOT>/SET-2/POS, Phase 4c layouts, git-ignored, made by
 * tools/dental-synth). Skipped, with the reason, when the set is not on this machine. The full dental suite (L2-L8, NEG
 * scenarios, a TypeScript generator so no data folder is needed) is Phase 4b.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceRegistry } from "../src/core/registry.ts";
import { openDb } from "../src/db.ts";
import { firstLines } from "../src/sources/lines.ts";
import { BUILT_IN_SOURCES } from "../src/sources/index.ts";
import { SET as setDir } from "./data-root.ts";

const SET = setDir("SET-2", "POS");
const skip = existsSync(SET) ? false : `synthetic set not found at ${SET} (run tools/dental-synth/gen_dental_set.py --out <that folder>)`;
const registry = () => { const r = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) r.register(a); return r; };

test("each SET-2 file is recognised by exactly one adapter: deposit detail, ledger, bank statement, patient list", { skip }, async () => {
  const r = registry();
  const got = Object.fromEntries(await Promise.all(readdirSync(SET).filter((n) => n.endsWith(".csv")).map(async (n) => [n, r.detect(await firstLines(join(SET, n))).map((a) => a.id)])));
  assert.deepEqual(got, { "BANK-ST-SET1-POS.csv": ["bank/bofa"], "BankDep-Det-SET1-POS.csv": ["prms/curve-hero/deposit-detail"],
    "Per-Sum-SET1-POS.csv": ["prms/curve-hero/ledger"], "SPR-patientlist-SET1-POS.csv": ["prms/curve-hero/patient-list"] });
});

test("every adapter loads its SET-2 file and all of the file's own checks pass (bank totals, running balance, keys)", { skip }, async () => {
  const r = registry();
  for (const [file, id] of [["BANK-ST-SET1-POS.csv", "bank/bofa"], ["BankDep-Det-SET1-POS.csv", "prms/curve-hero/deposit-detail"], ["Per-Sum-SET1-POS.csv", "prms/curve-hero/ledger"]] as const) {
    const db = await openDb();
    try {
      const loaded = await r.get(id).load(db, "t", join(SET, file), { patientNameFormat: "last_first" });
      assert.ok(loaded.rows > 0, `${file}: no rows`);
      assert.deepEqual(loaded.checks.filter((c) => !c.ok), [], `${file}: failed checks`);
    } finally { db.close(); }
  }
});

test("scripts/reconcile-check.ts reproduces SET-2/POS's answer key: 45 bank credits, exact payment IDs, no exceptions", { skip }, () => {
  const script = fileURLToPath(new URL("../scripts/reconcile-check.ts", import.meta.url));
  const out = spawnSync(process.execPath, [script, "--folder", SET, "--json"], { encoding: "utf8", timeout: 120000 });
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  const s = JSON.parse(out.stdout);
  assert.equal(s.matched, 45); assert.deepEqual(s.missing, []); assert.deepEqual(s.extra, []); assert.equal(s.exceptions, 0);
  assert.deepEqual(s.ledgerToDeposit, { checkedIds: 159, matched: 159 });
});
