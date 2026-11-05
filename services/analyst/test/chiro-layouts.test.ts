/**
 * privateAI-design-30 §11 (CHIRO-1b-2 stage 2): the chiro layout spec, without DuckDB (runs anywhere). Loading the files is
 * tested in chiro-sets.test.ts (DuckDB, owner PC). Generated sets: CHIRO_DATA_ROOT, default <repo>/sample-data/prms.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { csvFields, firstLines } from "../src/sources/lines.ts";
import { CHIRO_LAYOUTS, chiroColumns, detectChiro, specProblems, unverifiedOf } from "../src/sources/prms/chiro/layouts.ts";
import { CARECREDIT_LAYOUT, CHERRY_LAYOUT, HFD_LAYOUT } from "../src/sources/financing/layouts.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const env = process.env.CHIRO_DATA_ROOT?.trim();
const ROOT = env ? (isAbsolute(env) ? env : resolve(REPO, env)) : join(REPO, "sample-data", "prms");
const line = (hs: readonly string[]) => hs.map((h) => (/[",]/.test(h) ? `"${h.replace(/"/g, '""')}"` : h)).join(",");

test("every chiro layout spec is sound: a basis on every column and header, forbidden headers only in name_key, each header used once", () => {
  assert.deepEqual(CHIRO_LAYOUTS.flatMap(specProblems), []);
  assert.equal(new Set(CHIRO_LAYOUTS.map((l) => l.id)).size, CHIRO_LAYOUTS.length, "layout ids are unique");
});

test("each layout's header line is detected by exactly that layout; financing headers and blank lines by none", () => {
  for (const l of CHIRO_LAYOUTS) assert.deepEqual(CHIRO_LAYOUTS.filter((x) => detectChiro(x, ["", line(l.headers)])).map((x) => x.id), [l.id]);
  for (const f of [CARECREDIT_LAYOUT, CHERRY_LAYOUT, HFD_LAYOUT]) assert.deepEqual(CHIRO_LAYOUTS.filter((x) => detectChiro(x, [line(f.headers)])).map((x) => x.id), []);
  assert.deepEqual(CHIRO_LAYOUTS.filter((x) => detectChiro(x, ["", ","])).map((x) => x.id), []);
  // a header with one extra or one renamed column is not the layout (no fuzzy matching)
  const dep = CHIRO_LAYOUTS.find((l) => l.id === "prms/chirotouch/deposits")!;
  assert.equal(detectChiro(dep, [line([...dep.headers, "Note"])]), false);
  assert.equal(detectChiro(dep, [line(dep.headers.map((h) => (h === "Payment ID" ? "Payment Id" : h)))]), false);
});

test("person names never become a column: forbidden headers feed only name_key, and Jane's Payor name only insurance rows", () => {
  for (const l of CHIRO_LAYOUTS) {
    for (const c of l.columns) {
      const froms = typeof c.from === "string" ? [c.from] : [...c.from];
      if (froms.some((h) => l.forbidden.includes(h))) assert.equal(c.type, "name_key", `${l.id}.${c.name}`);
    }
    assert.ok(!chiroColumns(l).some((c) => /name$/i.test(c) && c !== "name_key"), `${l.id}: no *name column`);
  }
  const prf = CHIRO_LAYOUTS.find((l) => l.id === "prms/jane/payments-refunds-fees")!;
  const payer = prf.columns.find((c) => c.name === "payer")!;
  assert.deepEqual(payer.onlyWhen, { column: "Payment method", in: ["EFT", "Manual EOB", "Insurance Check"] });
});

test("no layout claims to be verified: no real ChiroTouch or Jane export has been seen (design-30 §11)", () => {
  for (const l of CHIRO_LAYOUTS) assert.ok(unverifiedOf(l).includes("header"), `${l.id} header`);
});

const SETS = [["chiro-1-chirotouch", "SET-1"], ["chiro-2-jane", "SET-1"]] as const;
const EXPECT: Record<string, string> = {
  "CT-PATIENTS-": "prms/chirotouch/patients", "CT-DAYSHEET-": "prms/chirotouch/daysheet", "CT-DEPOSITS-": "prms/chirotouch/deposits",
  "CTPAY-": "processor/ct-payments", "CASHPRAC-": "processor/cash-practice", "JANE-PATIENTS-": "prms/jane/patients",
  "JANE-TRANSACTIONS-": "prms/jane/transactions", "JANE-PAYMENTS-REFUNDS-FEES-": "prms/jane/payments-refunds-fees",
  "JANEPAY-PAYOUTS-": "processor/jane-payments-payouts", "FEESCHED-": "owner/fee-schedule", "PI-CASES-": "owner/pi-cases", "CAREPLANS-": "owner/care-plans",
};
for (const [prms, set] of SETS) {
  const dir = join(ROOT, prms, set);
  const skip = existsSync(dir) ? false : `chiro sets not found at ${dir} (tools/chiro-synth/gen_chiro_set.py)`;
  test(`${prms}/${set}: every PRMS, processor and owner file of every scenario is detected by its own layout; bank and ERA by none`, { skip }, async () => {
    let files = 0;
    for (const sc of readdirSync(dir)) {
      for (const f of readdirSync(join(dir, sc)).filter((x) => x.endsWith(".csv"))) {
        const got = await firstLines(join(dir, sc, f));
        const ids = CHIRO_LAYOUTS.filter((l) => detectChiro(l, got)).map((l) => l.id);
        const prefix = Object.keys(EXPECT).filter((p) => f.startsWith(p)).sort((a, b) => b.length - a.length)[0];
        assert.deepEqual(ids, prefix ? [EXPECT[prefix]] : [], `${sc}/${f}`);
        files++;
      }
    }
    assert.ok(files > 0);
  });
}

test("csvFields keeps the header names the layouts expect (no quoting surprises)", () => {
  for (const l of CHIRO_LAYOUTS) assert.deepEqual(csvFields(line(l.headers)), [...l.headers]);
});
