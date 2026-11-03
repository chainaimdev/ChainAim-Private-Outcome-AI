/**
 * Phase 4c (owner 2026-11-03): payer codes compare case- and space-insensitively. The owner's deposit detail writes
 * "DENTAQUEST" and "AETNA " where the alias table says "DentaQuest" and "AETNA"; an EFT must still match its remittance, the
 * two spellings of one payer must form one remittance, and reports keep Curve's spelling. Every value below is made up.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PackRegistry, SourceRegistry } from "../src/core/registry.ts";
import { openDb } from "../src/db.ts";
import { BUILT_IN_PACKS } from "../src/domain-packs/index.ts";
import { payerKey, samePayer } from "../src/engines/deposit-match.ts";
import { reconcileFolder } from "../src/reconcile.ts";
import { BUILT_IN_SOURCES } from "../src/sources/index.ts";

const CONFIG_ROOT = fileURLToPath(new URL("../../../config", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "payer-")); after(() => rmSync(dir, { recursive: true, force: true }));
const put = (name: string, lines: string[]) => { const p = join(dir, name); writeFileSync(p, "﻿" + lines.join("\r\n") + "\r\n"); return { name, path: p }; };

test("payerKey / samePayer: case, surrounding and repeated spaces are ignored; different payers stay different", () => {
  assert.equal(payerKey(" DentaQuest "), "DENTAQUEST");
  assert.ok(samePayer("DENTAQUEST", "DentaQuest")); assert.ok(samePayer("AETNA ", "aetna")); assert.ok(samePayer("DELTA  DENTAL MA", "Delta Dental MA"));
  assert.ok(!samePayer("AET", "AETNA")); assert.ok(!samePayer("MH", null));
});

test("an EFT matches its remittance across spellings; 'AETNA ' and 'AETNA' rows form one remittance; Curve's spelling is reported", async () => {
  const dep = put("dep.csv", ["Date,ID,Payment Posted By,Payment Type,Ref. ID,Ext. ID,Payer,RP,Responsible Party,Provider,Posted At Clinic,Amount",
    "9/15/2024,900001,Office posted,Direct Deposit,,,DENTAQUEST,PT1,,PV1,S1,168",
    "9/9/2024,900002,Office posted,Direct Deposit,,,AETNA ,PT2,,PV1,S1,99",
    "9/9/2024,900003,Office posted,Direct Deposit,,,AETNA,PT3,,PV1,S1,1"]);
  const bank = put("bank.csv", ["Description,,Summary Amt.,", "Beginning balance as of 09/01/2024,,\"1,000.00\",", "Total credits,,268.00,", "Total debits,,0.00,",
    "Ending balance as of 09/30/2024,,\"1,268.00\",", ",,,", "Date,Description,Amount,Running Bal.", "9/1/2024,Beginning balance as of 09/01/2024,,\"1,000.00\"",
    "9/8/2024,AETNA DES:HCCLAIMPMT ID:X1 INDN:SAMPC CO ID:A1 CCD,100.00,\"1,100.00\"",
    "9/14/2024,DENTAQUEST DES:HCCLAIMPMT ID:X2 INDN:SAMPC CO ID:A2 CCD,168.00,\"1,268.00\""]);
  const sources = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) sources.register(a);
  const packs = new PackRegistry(); for (const p of BUILT_IN_PACKS) packs.register(p);
  const r = await reconcileFolder({ files: [dep, bank], sources, pack: packs.resolve("finance/rcm/dental"), configRoot: CONFIG_ROOT,
    sourceOptions: { patientNameFormat: "last_first" }, toleranceCents: null, open: openDb });
  const m = r.result.depositToBank.matched.map((x) => [x.payer, x.cents, x.paymentIds]).sort();
  assert.deepEqual(m, [["AETNA", 10000, ["900002", "900003"]], ["DENTAQUEST", 16800, ["900001"]]]);
  assert.deepEqual(r.result.depositToBank.unmatchedCurve, []); assert.deepEqual(r.result.depositToBank.unmatchedBank, []);
  assert.deepEqual(r.exceptions, []);
});
