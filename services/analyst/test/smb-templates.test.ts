/**
 * smb-fin-1 exact template queries (config/datasets.json, owner 2026-11-07): each template's sql runs on the TYPED tables the
 * console's /crossask runs on (profileFolder -> loadAndRelate with the shipped row filters -> lockFiles -> runSelect), not on
 * the all-text raw load. The 2026-11-07 owner run failed every paid job because the first template sql called trim() on the
 * DATE and AMOUNT columns, which relate.ts types as DATE and DOUBLE. The files below are copies of the synthetic sample set
 * (tools/smb-synth/gen_ar_ap.py seed 1 and the sample statement), so this runs without the git-ignored sample-data.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DataConfig } from "../src/config.ts";
import { lockFiles, openDb } from "../src/db.ts";
import { profileFolder } from "../src/profile.ts";
import { loadAndRelate, readRowFilters, RELATE_DEFAULTS } from "../src/relate.ts";
import { runSelect } from "../src/sqlrun.ts";

const SHIPPED_FILTERS = fileURLToPath(new URL("../../../config/row-filters.json", import.meta.url));
const DATASETS = JSON.parse(readFileSync(new URL("../../../config/datasets.json", import.meta.url), "utf8"));
const smb = DATASETS.datasets.find((d: { id: string }) => d.id === "smb-fin-1");
const sqlOf = (label: string): string => {
  const t = smb.templates.find((x: { label: string }) => x.label === label);
  assert.ok(t && typeof t.sql === "string", `template ${label} has sql`);
  return t.sql;
};

const root = mkdtempSync(join(tmpdir(), "analyst-smb-tpl-"));
after(() => rmSync(root, { recursive: true, force: true }));
const cfg: DataConfig = { allowedRoots: [root], exclude: [], hideFolders: [/^_.*$/], workDir: join(root, "_analyst") };

const BANK = `SECTION,DATE,DESCRIPTION,AMOUNT,BALANCE
HEADER,,"BANK OF AMERICA, N.A.",,
HEADER,,Account Type: Advantage Plus Banking,,
HEADER,,Account Number: *******1234,,
HEADER,,"Statement Period: Oct 01, 2026 to Oct 15, 2026",,
SUMMARY,,"Beginning Balance on October 01, 2026",,2450.50
SUMMARY,,Deposits and other additions,1500.00,
SUMMARY,,ATM and debit card subtractions,-172.35,
SUMMARY,,Other subtractions / Electronic transfers,-585.40,
SUMMARY,,Service fees,-0.00,
SUMMARY,,"Ending Balance on October 15, 2026",,3192.75
DEPOSITS,10/04/2026,DIRECT DEPOSIT - ACME CORP DES:EDI PYMNT,1500.00,3950.50
DEBITS_ATM,10/02/2026,STARBUCKS STORE #10492 NEWINGTON CT,-5.75,2444.75
DEBITS_ATM,10/06/2026,TARGET T-0192 NEWINGTON CT,-42.10,3902.65
DEBITS_ATM,10/15/2026,GROCERY STORE MARKET NEWINGTON CT,-124.50,3192.75
DEBITS_OTHER,10/10/2026,ELECTRIC UTILITY PAYMENT ONLINE,-85.40,3817.25
DEBITS_OTHER,10/12/2026,ONLINE TRANSFER TO SAVINGS XXXXXX5678,-500.00,3317.25
FEES,10/15/2026,NO SERVICE FEE CHARGED THIS PERIOD,0.00,3192.75
`;
const AR = `Invoice No,Customer,Invoice Date,Due Date,Terms,Amount,Paid,Open Balance,Days Past Due,Aging Bucket
INV-1001,ACME CORP,09/20/2026,11/04/2026,Net 45,2080.86,1500.00,580.86,0,Current
INV-1002,BLUE HARBOR CAFE (SYN),08/16/2026,09/30/2026,Net 45,1587.29,634.91,952.38,15,1-30
INV-1003,CEDAR LANE CLINIC (SYN),10/03/2026,11/02/2026,Net 30,2240.27,0.00,2240.27,0,Current
INV-1004,SUMMIT BUILDERS (SYN),08/27/2026,09/26/2026,Net 30,398.62,0.00,398.62,19,1-30
INV-1005,RIVERSIDE SCHOOL DISTRICT (SYN),10/15/2026,11/29/2026,Net 45,3434.72,0.00,3434.72,0,Current
INV-1006,HILLTOP EVENTS (SYN),09/16/2026,10/31/2026,Net 45,2585.11,0.00,2585.11,0,Current
INV-1007,GREENFIELD FARMS (SYN),10/12/2026,10/27/2026,Net 15,785.96,0.00,785.96,0,Current
INV-1008,HARBORVIEW HOTEL (SYN),10/14/2026,11/13/2026,Net 30,383.40,0.00,383.40,0,Current
`;
const AP = `Bill No,Vendor,Bill Date,Due Date,Terms,Amount,Paid,Open Balance,Days Past Due,Aging Bucket
BILL-2001,OFFICE SUPPLY DEPOT (SYN),08/22/2026,10/06/2026,Net 45,3849.15,0.00,3849.15,9,1-30
BILL-2002,METRO ELECTRIC UTILITY (SYN),08/20/2026,09/19/2026,Net 30,402.25,0.00,402.25,26,1-30
BILL-2003,CITYWIDE INSURANCE (SYN),09/16/2026,10/31/2026,Net 45,3148.57,0.00,3148.57,0,Current
BILL-2004,PRIME PAPER CO (SYN),09/08/2026,09/23/2026,Net 15,1397.04,0.00,1397.04,22,1-30
BILL-2005,LOGISTICS EXPRESS (SYN),08/05/2026,09/19/2026,Net 45,2431.98,0.00,2431.98,26,1-30
BILL-2006,TECH SERVICES LLC (SYN),09/30/2026,11/14/2026,Net 45,774.28,387.14,387.14,0,Current
BILL-2007,LANDLORD PROPERTIES (SYN),08/12/2026,09/11/2026,Net 30,1994.28,0.00,1994.28,34,31-60
`;

/** The console's path for one folder: typed tables, the shipped row filters, file access locked. */
async function smbTables() {
  const dir = join(root, `smb-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "sample_bofa_full_statement.csv"), BANK);
  writeFileSync(join(dir, "AR-OPEN-INVOICES.csv"), AR);
  writeFileSync(join(dir, "AP-OPEN-BILLS.csv"), AP);
  const db = await openDb();
  const r = await loadAndRelate(db, await profileFolder(dir, cfg, 20, 500_000_000, openDb), { ...RELATE_DEFAULTS, rowFilters: readRowFilters(SHIPPED_FILTERS) });
  await lockFiles(db);
  return { db, ...r };
}
const cents = (v: unknown): number => Math.round(Number(v) * 100);

test("the tables the templates name exist with those columns, typed as relate.ts types them (DATE, number)", async () => {
  const { db, tables } = await smbTables();
  try {
    const by = (t: string) => tables.find((x) => x.table === t);
    assert.deepEqual(tables.map((t) => t.table).sort(), ["ap_open_bills", "ar_open_invoices", "sample_bofa_full_statement"]);
    const col = (t: string, c: string) => by(t)!.columns.find((x) => x.name === c)?.type;
    assert.equal(col("sample_bofa_full_statement", "DATE"), "date");
    assert.equal(col("sample_bofa_full_statement", "AMOUNT"), "number");
    assert.equal(col("ar_open_invoices", "Open Balance"), "number");
    assert.equal(col("ap_open_bills", "Open Balance"), "number");
  } finally { db.close(); }
});

test("Cash flow vs installment: the exact sql runs on the typed tables; one month, 1500.00 in, 757.75 out, 742.25 net", async () => {
  const { db } = await smbTables();
  try {
    const r = await runSelect(db, sqlOf("Cash flow vs installment"), { maxRows: 50, timeoutMs: 15000 });
    assert.deepEqual(r.columns, ["month", "transactions", "cash_in", "cash_out", "net_cash_flow", "installment", "left_after_installment"]);
    assert.equal(r.rows.length, 1, JSON.stringify(r.rows));
    const m = r.rows[0];
    assert.equal(m.month, "2026-10");
    assert.equal(Number(m.transactions), 6, "the 0.00 fee row is not a transaction");
    assert.equal(cents(m.cash_in), 150000);
    assert.equal(cents(m.cash_out), 75775, "5.75 + 42.10 + 124.50 + 85.40 + 500.00");
    assert.equal(cents(m.net_cash_flow), 74225);
    assert.equal(cents(m.installment), 2036800);
    assert.equal(cents(m.left_after_installment), -1962575);
  } finally { db.close(); }
});

test("Receivables vs payables: the exact sql runs on the typed tables; 8 invoices 11361.32, 7 bills 13610.41, net -2249.09", async () => {
  const { db } = await smbTables();
  try {
    const r = await runSelect(db, sqlOf("Receivables vs payables: need a loan?"), { maxRows: 50, timeoutMs: 15000 });
    assert.deepEqual(r.columns, ["invoices_open", "receivables_open", "bills_open", "payables_open", "net_position"]);
    assert.equal(r.rows.length, 1);
    const x = r.rows[0];
    assert.equal(Number(x.invoices_open), 8); assert.equal(Number(x.bills_open), 7);
    assert.equal(cents(x.receivables_open), 1136132);
    assert.equal(cents(x.payables_open), 1361041);
    assert.equal(cents(x.net_position), -224909);
  } finally { db.close(); }
});
