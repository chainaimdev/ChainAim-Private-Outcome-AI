/**
 * config/row-filters.json (2026-11-06): the smb-fin-1 bank statement (SECTION,DATE,DESCRIPTION,AMOUNT,BALANCE) has HEADER and
 * SUMMARY rows that are not transactions; a cash-flow-by-month query counted them as NULL months. A rule that matches the header
 * line drops them before a model sees the table, and the schema says so. Files with any other header are untouched.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DataConfig } from "../src/config.ts";
import { lockFiles, openDb } from "../src/db.ts";
import { profileFolder } from "../src/profile.ts";
import { loadAndRelate, readRowFilters, RELATE_DEFAULTS, schemaText } from "../src/relate.ts";
import { runSelect } from "../src/sqlrun.ts";

const SHIPPED = fileURLToPath(new URL("../../../config/row-filters.json", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "analyst-rowf-"));
after(() => rmSync(root, { recursive: true, force: true }));
const cfg: DataConfig = { allowedRoots: [root], exclude: [], hideFolders: [/^_.*$/], workDir: join(root, "_analyst") };
// the shape of sample_bofa_full_statement.csv (values synthetic)
const BANK = ["SECTION,DATE,DESCRIPTION,AMOUNT,BALANCE", 'HEADER,,"BANK OF AMERICA, N.A.",,', 'HEADER,,"Statement Period: Oct 01, 2026 to Oct 15, 2026",,',
  'SUMMARY,,"Beginning Balance on October 01, 2026",,2450.50', "SUMMARY,,Deposits and other additions,1500.00,", "SUMMARY,,ATM and debit card subtractions,-172.35,",
  "DEPOSITS,10/04/2026,DIRECT DEPOSIT - ACME CORP DES:EDI PYMNT,1500.00,3950.50", "DEBITS_ATM,10/02/2026,STORE #10492,-5.75,2444.75",
  "DEBITS_OTHER,10/10/2026,ELECTRIC UTILITY PAYMENT ONLINE,-85.40,3817.25", "FEES,10/15/2026,NO SERVICE FEE CHARGED THIS PERIOD,0.00,3192.75"].join("\n") + "\n";

async function tablesOf(folder: string, withRules: boolean) {
  const db = await openDb();
  const r = await loadAndRelate(db, await profileFolder(folder, cfg, 20, 500_000_000, openDb), { ...RELATE_DEFAULTS, ...(withRules ? { rowFilters: readRowFilters(SHIPPED) } : {}) });
  await lockFiles(db);
  return { db, ...r };
}
const MONTHLY = `SELECT date_trunc('month', "DATE") AS m, sum(CASE WHEN "AMOUNT" > 0 THEN "AMOUNT" ELSE 0 END) AS cash_in, sum(CASE WHEN "AMOUNT" < 0 THEN -"AMOUNT" ELSE 0 END) AS cash_out FROM bank GROUP BY 1 ORDER BY 1`;

test("the shipped rule drops HEADER and SUMMARY rows; cash flow by month has one month and no NULL month; the schema says why", async () => {
  const dir = join(root, "smb"); mkdirSync(dir); writeFileSync(join(dir, "bank.csv"), BANK);
  const { db, tables, relations } = await tablesOf(dir, true);
  try {
    assert.equal(tables[0].rows, 4);
    assert.deepEqual(tables[0].left, { rows: 5, values: ["HEADER", "SUMMARY"], rule: "bofa-sectioned-statement" });
    assert.match(schemaText(tables, relations), /\(file bank\.csv, 4 rows; 5 HEADER\/SUMMARY row\(s\) of the file left out, they are not data\)/);
    const r = await runSelect(db, MONTHLY, { maxRows: 50, timeoutMs: 15000 });
    assert.equal(r.rows.length, 1, JSON.stringify(r.rows));
    assert.equal(Number(r.rows[0].cash_in), 1500); assert.equal(Math.round(Number(r.rows[0].cash_out) * 100), 9115);
  } finally { db.close(); }
});

test("without the rules every row stays (the 2026-11-06 behaviour: a NULL month); another header line is never touched", async () => {
  const dir = join(root, "smb2"); mkdirSync(dir); writeFileSync(join(dir, "bank.csv"), BANK);
  writeFileSync(join(dir, "other.csv"), "SECTION,DATE,AMOUNT\nHEADER,10/01/2026,1.00\nX,10/02/2026,2.00\n");
  const off = await tablesOf(dir, false);
  try { assert.ok((await runSelect(off.db, MONTHLY, { maxRows: 50, timeoutMs: 15000 })).rows.some((x) => x.m === null), "a NULL month without the rule"); } finally { off.db.close(); }
  const on = await tablesOf(dir, true);
  try {
    const other = on.tables.find((t) => t.file === "other.csv")!;
    assert.equal(other.rows, 2); assert.equal(other.left, undefined, "a different header line keeps its HEADER row");
  } finally { on.db.close(); }
});

test("readRowFilters refuses a rule without its column in the header line, an empty drop list or no basis", () => {
  const bad = (rule: unknown) => { const p = join(root, `${Math.random()}.json`); writeFileSync(p, JSON.stringify({ version: 1, rules: [rule] })); return p; };
  assert.throws(() => readRowFilters(bad({ id: "a", columns: ["X"], column: "Y", drop: ["H"], basis: "b" })), /needs id, columns/);
  assert.throws(() => readRowFilters(bad({ id: "a", columns: ["X"], column: "X", drop: [], basis: "b" })), /non-empty drop/);
  assert.throws(() => readRowFilters(bad({ id: "a", columns: ["X"], column: "X", drop: ["H"] })), /basis/);
  assert.equal(readRowFilters(SHIPPED).length, 1);
});
