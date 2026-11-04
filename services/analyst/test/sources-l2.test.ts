/**
 * L2 (DESIGN/xrplh-24 §8): the source adapters on small inline files built from the quirks seen in the owner's samples
 * (Phase 4c layouts: sample-data/prms/dent-prms-c-sample/sample-prms-fin). No data folder needed; every value below is made up.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceAdapter } from "../src/core/ports.ts";
import { SourceRegistry } from "../src/core/registry.ts";
import { openDb, rows } from "../src/db.ts";
import { firstLines } from "../src/sources/lines.ts";
import { BUILT_IN_SOURCES } from "../src/sources/index.ts";
import { BOFA_STATEMENT } from "../src/sources/bank/bofa.ts";
import { CURVE_DEPOSIT_DETAIL } from "../src/sources/prms/curve-hero/deposit-detail.ts";
import { CURVE_LEDGER } from "../src/sources/prms/curve-hero/ledger.ts";
import { CURVE_PATIENT_LIST } from "../src/sources/prms/curve-hero/patient-list.ts";
import { CURVE_PROCEDURES, CURVE_PROCEDURE_HEADERS } from "../src/sources/prms/curve-hero/procedures.ts";
import { existsSync } from "node:fs";
import { SAMPLES } from "./data-root.ts";

const dir = mkdtempSync(join(tmpdir(), "l2-")); after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, lines: string[], eol = "\r\n", bom = false) => { const p = join(dir, name); writeFileSync(p, (bom ? "﻿" : "") + lines.join(eol) + eol); return p; };
async function load(a: SourceAdapter, path: string, nameFormat: "last_first" | "first_last" = "last_first") {
  const db = await openDb();
  try { const l = await a.load(db, "t", path, { patientNameFormat: nameFormat }); return { l, data: await rows<Record<string, unknown>>(db, `SELECT * FROM t ORDER BY "row"`) }; }
  finally { db.close(); }
}
const BANK = [
  "Description,,Summary Amt.,,,,", 'Beginning balance as of 09/01/2024,,"1,000.00","1,000.00",,,', 'Total credits,,"1,594.20","1,594.20",,,',
  "Total debits,,-200.00,-200.00,,,", 'Ending balance as of 09/30/2024,,"2,394.20","2,394.20",,,', ",,,,,,", "Date,Description,Amount,Running Bal.,RBalAdj,,Running Bal.",
  '9/1/2024,Beginning balance as of 09/01/2024,,"1,000.00","1,000.00",,',
  '9/2/2024,GLOBAL PAYMENTS DES:GLOBAL DEP ID:8700000000001 INDN:MAPLE GROVE DENTAL CO ID:N400000000 CCD,"1,069.50","2,069.50","2,069.50",,',
  '9/3/2024,COMM OF MASS DES:HCCLAIMPMT ID:1234567890 INDN:MGD PC CO ID:1999999999 CCD PMT INFO:TRN*1*123456789012345*1999999999\\,510.10,"2,579.60","2,579.60",,',
  '9/4/2024,Check 3001,-200.00,"2,379.60","2,379.60",,',
  '9/5/2024,BKOFAMERICA ATM 09/05 #000001941 DEPOSIT MAIN ST ANYTOWN CT CKCD 4135770000004410,14.6,"2,394.20","2,394.20",,',
];

test("BofA: summary block skipped, header on line 7, beginning-balance pseudo-row dropped, \"1,069.50\" read, ACH fields and TRN extracted", async () => {
  const { l, data } = await load(BOFA_STATEMENT, file("bank.csv", BANK));
  assert.equal(l.rows, 4); assert.deepEqual(l.checks.filter((c) => !c.ok), []);
  assert.deepEqual(data.map((r) => [r.row, String(r.date), Number(r.cents), r.kind]), [[9, "2024-09-02", 106950, "ach"], [10, "2024-09-03", 51010, "ach"], [11, "2024-09-04", -20000, "check"], [12, "2024-09-05", 1460, "atm_deposit"]]);
  assert.deepEqual([data[0].originator, data[0].des, data[0].indn], ["GLOBAL PAYMENTS", "GLOBAL DEP", "MAPLE GROVE DENTAL"]);
  assert.deepEqual([data[1].originator, data[1].trace, data[1].co_id], ["COMM OF MASS", "123456789012345", "1999999999"]);
  assert.equal(data[2].check_no, "3001");
});
test("BofA: the same file with LF line endings loads identically (the owner's SET-1 copy is LF, the generator writes CRLF)", async () => {
  const crlf = await load(BOFA_STATEMENT, file("bank-crlf.csv", BANK, "\r\n")), lf = await load(BOFA_STATEMENT, file("bank-lf.csv", BANK, "\n"));
  assert.deepEqual(lf.data, crlf.data); assert.deepEqual(lf.l.checks, crlf.l.checks);
});
test("BofA: a summary that does not add up, or a broken running balance, fails the file's own checks", async () => {
  const bad = [...BANK]; bad[2] = 'Total credits,,"1,594.21","1,594.21",,,'; bad[11] = '9/4/2024,Check 3001,-200.00,"2,379.00","2,379.60",,';
  const failed = (await load(BOFA_STATEMENT, file("bank-bad.csv", bad))).l.checks.filter((c) => !c.ok).map((c) => c.name);
  for (const n of ["summary adds up", "detail credits = summary credits", "running balance continuous"]) assert.ok(failed.includes(n), `${n} should fail: ${failed}`);
});

const LEDGER_H = "Date,Details,Patient,Patient-LM,Patient-FM,Default dentist,Provider of service,Clinic,Posted at clinic,Amount";
test("Curve ledger: every Details form (Invoice, Payment, Deposit, Adjustment with ID, check reference after ' - ')", async () => {
  const { l, data } = await load(CURVE_LEDGER, file("ledger.csv", [LEDGER_H,
    '9/9/2024,Invoice #226619,PT1,ACEVEDO,CARMEN,PV1,PV1,S1,S1,0', '9/9/2024,"Payment #226521, Direct Deposit",PT4,Ackley,Sharon,PV1,PV1,S1,S1,-99',
    '9/1/2024,"Deposit #225463, Visa",PT32,Cabrera,Ann,PV1,PV1,S1,S1,439.1', '9/1/2024,"Payment #225433, Account Credit",PT32,,,PV1,PV1,S1,S1,-439.1',
    '9/3/2024,"Adjustment #225790, PPO Write-off",PT3,,,PV1,PV1,S1,S1,-25', '9/1/2024,"Payment #225388, Insurance Check - 22311492",PT9,,,PV3,PV3,M1,S1,-489'], "\r\n", true));
  assert.deepEqual(l.checks.filter((c) => !c.ok), []);
  assert.deepEqual(data.map((r) => [r.entry, r.entry_id, r.method, r.ref, Number(r.cents)]), [["invoice", "226619", null, null, 0], ["payment", "226521", "Direct Deposit", null, -9900],
    ["deposit", "225463", "Visa", null, 43910], ["payment", "225433", "Account Credit", null, -43910], ["adjustment", "225790", "PPO Write-off", null, -2500], ["payment", "225388", "Insurance Check", "22311492", -48900]]);
  assert.deepEqual(data.map((r) => r.pt_pseudonym), ["PT1", "PT4", "PT32", "PT32", "PT3", "PT9"]);
  const all = JSON.stringify(data);
  for (const name of ["ACEVEDO", "CARMEN", "Ackley", "Sharon", "Cabrera"]) assert.ok(!all.includes(name), `${name}: patient name columns are never loaded`);
});
test("Curve ledger: an unknown Details form fails the file's check instead of being guessed", async () => {
  const { l } = await load(CURVE_LEDGER, file("ledger-bad.csv", [LEDGER_H, '9/9/2024,"Refund #1, Visa",PT1,,,PV1,PV1,S1,S1,10'], "\r\n", true));
  assert.deepEqual(l.checks.filter((c) => !c.ok).map((c) => c.detail), ["1 row(s) not Payment/Deposit/Invoice/Adjustment"]);
});

const DEP_H = "Date,ID,Payment Posted By,Payment Type,Ref. ID,Ext. ID,Payer,RP,Responsible Party,Provider,Posted At Clinic,Amount";
test("Curve deposit detail: one ID repeated per provider is fine; the same ID and provider twice fails; names are not loaded", async () => {
  const ok = await load(CURVE_DEPOSIT_DETAIL, file("dep.csv", [DEP_H, "9/12/2024,227347,Office posted,Direct Deposit,,,MH,PT7,Ann Lee,PV1,S1,0.00", "9/12/2024,227347,Office posted,Direct Deposit,,,MH,PT7,Ann Lee,PV2,S1,43.00"], "\r\n", true));
  assert.deepEqual(ok.l.checks.filter((c) => !c.ok), []); assert.deepEqual(ok.data.map((r) => [r.payment_id, r.provider, Number(r.cents)]), [["227347", "PV1", 0], ["227347", "PV2", 4300]]);
  assert.deepEqual(ok.data.map((r) => r.rp_pseudonym), ["PT7", "PT7"]); assert.ok(!JSON.stringify(ok.data).includes("Ann Lee"), "Responsible Party is never loaded");
  const dup = await load(CURVE_DEPOSIT_DETAIL, file("dep-dup.csv", [DEP_H, "9/12/2024,1,Office posted,Cash,,,X,PT1,A B,PV1,S1,1.00", "9/12/2024,1,Office posted,Cash,,,X,PT1,A B,PV1,S1,2.00"], "\r\n", true));
  assert.deepEqual(dup.l.checks.filter((c) => !c.ok).map((c) => c.name), ["ID + Provider is unique"]);
});
test("Curve patient list: blank rows skipped; patient key kept; 'LAST, FIRST' and --patient-name-format first_last give the same name key; one key per plan row is fine, a shared name is flagged", async () => {
  const H = "Patient,Full Name,Status,Preferred Clinic,Default Doctor,Prim. Insurance Plan,Sec. Insurance Plan";
  const a = await load(CURVE_PATIENT_LIST, file("p1.csv", [H, ",,,,,,", 'PT9,"Lowe, Elizabeth",Active,S1,PV1,MassHealth Dental,', ",,,,,,"], "\r\n", true));
  const b = await load(CURVE_PATIENT_LIST, file("p2.csv", [H, "PT9,Elizabeth Lowe,Active,S1,PV1,MassHealth Dental,"], "\r\n", true), "first_last");
  assert.equal(a.l.rows, 1); assert.equal(a.data[0].patient_key, "PT9"); assert.equal(a.data[0].name_key, "LOWE ELIZABETH"); assert.equal(b.data[0].name_key, "LOWE ELIZABETH");
  assert.deepEqual(a.l.checks.filter((c) => !c.ok), []);
  // the owner's sample: PT1 has two rows (two plans, one name) -> fine; PT36 carries PT38's name -> "names are unique across keys" fails
  const c = await load(CURVE_PATIENT_LIST, file("p3.csv", [H, '"PT1","A, B",Active,S1,PV1,Plan X,', '"PT1","A, B",Active,S1,PV1,Plan Y,', '"PT36","C, D",Active,S1,PV3,Plan Z,', '"PT38","C, D",Active,S1,PV1,Plan Z,'], "\r\n", true));
  assert.deepEqual(c.l.checks.filter((x) => !x.ok).map((x) => [x.name, x.detail]), [["names are unique across keys (a shared name makes name lookups ambiguous)", "1 name(s) on more than one key"]]);
});
test("Curve procedure report: date, CDT code, cost in cents, name key equal to the patient list's; raw names never stored; bad rows fail checks", async () => {
  const H = CURVE_PROCEDURE_HEADERS.join(",") + ",,,,,,";
  const ok = await load(CURVE_PROCEDURES, file("proc.csv", [H,
    'D6010 - Implant,D6010,"$1,052.00 ",2/2/2025 15:57,ACME Dental,26,Implant body,"PV9_FM, PV9_LM","Lowe, Elizabeth",CARRIER X,,,,,,',
    'D2740 - Crown,d2740,($100.00),2/3/2025 9:05,ACME Dental,8,Crown,"PV9_FM, PV9_LM","LOWE,ELIZABETH",,,,,,,'], "\r\n", true));
  assert.deepEqual(ok.l.checks.filter((c) => !c.ok), []);
  assert.deepEqual(ok.data.map((r) => [r.date, r.procedure_code, Number(r.cents), r.name_key, r.tooth]), [["2025-02-02", "D6010", 105200, "LOWE ELIZABETH", "26"], ["2025-02-03", "D2740", -10000, "LOWE ELIZABETH", "8"]]);
  const all = JSON.stringify(ok.data);
  for (const s of ["PV9_FM", "PV9_LM", "Lowe, Elizabeth"]) assert.ok(!all.includes(s), `${s}: names are never stored`);
  const bad = await load(CURVE_PROCEDURES, file("proc-bad.csv", [H, 'X - Other,X99,abc,2025-02-02,ACME Dental,,,,,,,,,,,']));
  assert.deepEqual(bad.l.checks.filter((c) => !c.ok).map((c) => c.name), ["every Created Date parses (M/D/YYYY H:MM)", "every Cost is an amount",
    "every Procedure Code is a CDT code (Dnnnn)", "every procedure names a patient (needed to link it to the patient list)"]);
});
test("the owner's samples (when present): procedure report and patient list load cleanly and every procedure's name key links to a patient key", { skip: !existsSync(join(SAMPLES, "curveIptReport-sample-fin-csv.csv")) }, async () => {
  const db = await openDb();
  try {
    const opt = { patientNameFormat: "last_first" as const };
    const p = await CURVE_PROCEDURES.load(db, "p", join(SAMPLES, "curveIptReport-sample-fin-csv.csv"), opt);
    const pl = await CURVE_PATIENT_LIST.load(db, "pl", join(SAMPLES, "LOCS-patientlist-sample-3-fin-csv.csv"), opt);
    assert.deepEqual(p.checks.filter((c) => !c.ok), []); assert.equal(p.rows, 7);
    const [x] = await rows<{ linked: number }>(db, `SELECT CAST(count(*) FILTER (WHERE k IS NOT NULL) AS INTEGER) linked FROM p LEFT JOIN (SELECT DISTINCT name_key nk, patient_key k FROM pl) ON p.name_key = nk`);
    assert.equal(x.linked, 7, "each of the 7 procedures links to a patient key");
    assert.ok(pl.rows > 0);
  } finally { db.close(); }
});
test("layout detection: each sample header picks exactly one adapter; an unrelated file picks none", async () => {
  const r = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) r.register(a);
  const ids = async (p: string) => r.detect(await firstLines(p)).map((a) => a.id);
  assert.deepEqual(await ids(file("d1.csv", BANK)), ["bank/bofa"]);
  assert.deepEqual(await ids(file("d2.csv", [LEDGER_H], "\r\n", true)), ["prms/curve-hero/ledger"]);
  assert.deepEqual(await ids(file("d3.csv", [DEP_H], "\r\n", true)), ["prms/curve-hero/deposit-detail"]);
  assert.deepEqual(await ids(file("d5.csv", [CURVE_PROCEDURE_HEADERS.join(",") + ",,,,"], "\r\n", true)), ["prms/curve-hero/procedures"]);
  // Phase 4a.2: the CareCredit header used here before is now a real layout (financing/carecredit); an unrelated header instead
  assert.deepEqual(await ids(file("d4.csv", ["Merchant ID,Date,Name,Amount,Promo Code,Status"])), []);
});
