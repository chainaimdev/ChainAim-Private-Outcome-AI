/**
 * privateAI-design-30 §6.1-6.2, §8: finance/rcm gains coverage, remittance and ar_aging; finance/rcm/chiro extends it with the
 * owner's file prefixes. Dental proposals must not change (regression on the SET-2 file names).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PackRegistry } from "../src/core/registry.ts";
import { BUILT_IN_PACKS } from "../src/domain-packs/index.ts";
import { type FileProfile, proposeRecipe } from "../src/profile.ts";

const packs = () => { const r = new PackRegistry(); for (const p of BUILT_IN_PACKS) r.register(p); return r; };
const profile = (name: string): FileProfile =>
  ({ name, path: `/x/${name}`, bytes: 1, modified: "", rows: 3, dateRange: null, tooBig: false,
     columns: [{ name: "Date", type: "date", filled: 3, samples: [] }, { name: "Amount", type: "number", filled: 3, samples: [] }] });
const kinds = (pack: string, names: string[]) => Object.fromEntries(Object.entries(proposeRecipe("/x", names.map(profile), packs().resolve(pack)).files).map(([n, f]) => [n, [f.kind, f.measure]]));

test("finance/rcm/chiro: chain of 3, its own kinds and flow, no reconcile config until the layouts are verified", () => {
  const c = packs().resolve("finance/rcm/chiro");
  assert.deepEqual(c.chain, ["finance/rcm/chiro", "finance/rcm", "finance-generic"]);
  assert.deepEqual(c.kinds, ["ledger", "remittance", "deposit_detail", "processor", "bank", "patient_list", "coverage", "ar_aging", "pi_case", "prepay_plan", "adjustments", "other"]);
  assert.deepEqual(c.flowOrder, ["ledger", "remittance", "deposit_detail", "processor", "bank"]);
  for (const k of c.kinds) assert.ok(k in c.defaultMeasure, `measure for ${k}`);
  assert.equal(c.reconcile, undefined); assert.equal(c.sourceConfigs, undefined);
  assert.equal(c.from.nameHints, "finance-generic"); assert.equal(c.from.kindHints, "finance/rcm/chiro");
});

test("finance/rcm adds coverage, remittance and ar_aging; dental inherits them and keeps its reconcile config", () => {
  const r = packs().resolve("finance/rcm"), d = packs().resolve("finance/rcm/dental");
  for (const k of ["coverage", "remittance", "ar_aging"]) { assert.ok(r.kinds.includes(k)); assert.ok(k in r.defaultMeasure); }
  assert.deepEqual(r.flowOrder, ["ledger", "remittance", "deposit_detail", "bank"]);
  assert.equal(d.from.kinds, "finance/rcm"); assert.equal(d.reconcile, "domain-packs/finance/rcm/dental/reconcile.json");
});

test("dental file names are classified exactly as before (regression)", () => {
  assert.deepEqual(kinds("finance/rcm/dental", ["BANK-ST-SET1-POS.csv", "BankDep-Det-SET1-POS.csv", "Per-Sum-SET1-POS.csv", "SPR-patientlist-SET1-POS.csv"]), {
    "BANK-ST-SET1-POS.csv": ["bank", "inflows"], "BankDep-Det-SET1-POS.csv": ["deposit_detail", "inflows"],
    "Per-Sum-SET1-POS.csv": ["ledger", "net"], "SPR-patientlist-SET1-POS.csv": ["patient_list", "net"] });
});

test("chiro file prefixes (design-30 §8.3) propose the right kind for both PRMS", () => {
  assert.deepEqual(kinds("finance/rcm/chiro", ["ERA-SET1-POS.835", "BANK-ST-SET1-POS.csv", "CTPAY-SET1-POS.csv", "JANEPAY-PAYOUTS-SET1-POS.csv",
    "CASHPRAC-POSTED-SET1-POS.csv", "PI-CASES-SET1-POS.csv", "CAREPLANS-SET1-POS.csv", "CT-PATIENTS-SET1-POS.csv", "JANE-PAYMENTS-REFUNDS-FEES-SET1-POS.csv",
    "CT-DAYSHEET-SET1-POS.csv", "JANE-TRANSACTIONS-SET1-POS.csv", "CT-AR-AGING-SET1-POS.csv", "CT-INSURERS-POLICIES-SET1-POS.csv"]), {
    "ERA-SET1-POS.835": ["remittance", "abs"], "BANK-ST-SET1-POS.csv": ["bank", "inflows"], "CTPAY-SET1-POS.csv": ["processor", "inflows"],
    "JANEPAY-PAYOUTS-SET1-POS.csv": ["processor", "inflows"], "CASHPRAC-POSTED-SET1-POS.csv": ["processor", "inflows"], "PI-CASES-SET1-POS.csv": ["pi_case", "abs"],
    "CAREPLANS-SET1-POS.csv": ["prepay_plan", "abs"], "CT-PATIENTS-SET1-POS.csv": ["patient_list", "net"],
    "JANE-PAYMENTS-REFUNDS-FEES-SET1-POS.csv": ["deposit_detail", "inflows"], "CT-DAYSHEET-SET1-POS.csv": ["ledger", "net"],
    "JANE-TRANSACTIONS-SET1-POS.csv": ["ledger", "net"], "CT-AR-AGING-SET1-POS.csv": ["ar_aging", "net"], "CT-INSURERS-POLICIES-SET1-POS.csv": ["coverage", "net"] });
});
