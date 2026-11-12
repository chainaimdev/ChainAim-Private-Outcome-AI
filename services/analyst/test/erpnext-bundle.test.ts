/**
 * ERPNext JSON bundles read directly (src/erpnext-bundle.ts), without converting them to CSV.
 *
 *   1. Parity: a bundle folder gives the SAME typed tables (names, columns, column types, every value, row order) as
 *      the CSVs tools/erpnext-split writes from that bundle, and the 7 smb-erp-fin template queries give the same
 *      results on both. Synthetic bundle built here (sample-data is git-ignored).
 *   2. Exact numbers for one template on the synthetic bundle, computed by hand, so the check does not rest on parity alone.
 *   3. Security: drafts and DocTypes left out are not readable (the __erp_* working tables are dropped), read_json is
 *      refused in a question, file access is locked.
 *   4. Refusals: malformed bundles (400), two bundles or a bundle plus a clashing CSV in one folder (409).
 *   5. Options (--erpnext-*): off = the old one-table JSON load; all DocTypes; drafts; children off; flag checks.
 *   6. The owner's real bundles, when present (sample-data/smb-2-erp-fin/erpnext/_source and the CSV set folders):
 *      every table and all 7 templates, JSON-only folder vs the CSV folder. Skipped when the data is not on this PC.
 *
 *   npm test
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DataConfig } from "../src/config.ts";
import { type Db, lockFiles, openDb, rows } from "../src/db.ts";
import { type BundleOptions, DEFAULT_BUNDLE_OPTIONS, DEFAULT_ERPNEXT_DOCTYPES, bundleOptionsFrom } from "../src/erpnext-bundle.ts";
import { profileFolder } from "../src/profile.ts";
import { type TableSchema, loadAndRelate } from "../src/relate.ts";
import { SqlRefused, checkSelect, runSelect } from "../src/sqlrun.ts";
import { DEFAULT_DOCTYPES, splitDocuments, toCsv, type Doc } from "../../../packages/erpnext-split/src/index.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DATASETS = JSON.parse(readFileSync(join(REPO, "config", "datasets.json"), "utf8"));
const ERP = DATASETS.datasets.find((d: { id: string }) => d.id === "smb-erp-fin");
const TEMPLATES: { label: string; sql: string }[] = ERP.templates;

const root = mkdtempSync(join(tmpdir(), "analyst-erpnext-"));
after(() => rmSync(root, { recursive: true, force: true }));
const cfg: DataConfig = { allowedRoots: [root], exclude: [], hideFolders: [/^_.*$/], workDir: join(root, "_analyst") };
let seq = 0;
const folder = (files: Record<string, string>): string => {
  const dir = join(root, `f${++seq}`);
  mkdirSync(dir);
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
  return dir;
};

/** The console's path: typed tables, then file access locked. */
async function tablesOf(dir: string, o: BundleOptions = DEFAULT_BUNDLE_OPTIONS): Promise<{ db: Db; tables: TableSchema[] }> {
  const profs = await profileFolder(dir, cfg, 20, 500_000_000, openDb, o);
  const db = await openDb();
  try {
    const { tables } = await loadAndRelate(db, profs);
    await lockFiles(db);
    return { db, tables };
  } catch (e) { db.close(); throw e; }
}
async function dump(db: Db, tables: TableSchema[]): Promise<Record<string, { columns: [string, string][]; rows: unknown[] }>> {
  const out: Record<string, { columns: [string, string][]; rows: unknown[] }> = {};
  for (const t of [...tables].sort((a, b) => a.table.localeCompare(b.table))) {
    out[t.table] = { columns: t.columns.map((c) => [c.name, c.type]), rows: await rows(db, `SELECT * FROM "${t.table}" ORDER BY __row`) };
  }
  return out;
}
async function templateResults(db: Db): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of TEMPLATES) {
    const r = await runSelect(db, t.sql, { maxRows: 500, timeoutMs: 30000 });
    out[t.label] = { columns: r.columns, rows: r.rows };
  }
  return out;
}

// ---- a small bundle shaped like the CreditSeal ones (flat documents, child lists carrying their own doctype) ----------
function bundle(): { $about: string; companySettings: Record<string, unknown>; documents: Doc[] } {
  const d: Doc[] = [
    { doctype: "Company", name: "Orion", abbr: "ORN" }, // not a default DocType: left out
    { doctype: "Customer", name: "C001", customer_name: "Atlas Build Supply", customer_group: "Commercial", credit_limits: [{ doctype: "Customer Credit Limit", company: "Orion", credit_limit: 20000.0 }] },
    { doctype: "Customer", name: "C002", customer_name: "Birch & Co, \"Ltd\"", customer_group: "Commercial", credit_limits: [{ doctype: "Customer Credit Limit", company: "Orion", credit_limit: 1000.0 }] },
    { doctype: "Customer", name: "C003", customer_name: "Cobalt Retail", customer_group: null },
    { doctype: "Supplier", name: "S001", supplier_name: "Redclay Minerals", supplier_group: "Raw Material" },
    { doctype: "Supplier", name: "S002", supplier_name: "Glazeworks", supplier_group: "Raw Material" },
    { doctype: "Item", name: "TILE-A", item_code: "TILE-A", is_stock_item: true, reorder_levels: [{ doctype: "Item Reorder", warehouse: "Stores - ORN", warehouse_reorder_level: 50 }] },
    { doctype: "Sales Order", docstatus: 1, name: "SO-1", customer: "C001", transaction_date: "2026-08-01", items: [{ doctype: "Sales Order Item", name: "SO-1-1", item_code: "TILE-A", qty: 10, rate: 100.0 }] },
    { doctype: "Sales Order", docstatus: 1, name: "SO-2", customer: "C002", transaction_date: "2026-09-20", items: [{ doctype: "Sales Order Item", name: "SO-2-1", item_code: "TILE-A", qty: 5, rate: 300.0 }] },
    { doctype: "Sales Order", docstatus: 0, name: "SO-3", customer: "C003", transaction_date: "2026-09-21", items: [{ doctype: "Sales Order Item", name: "SO-3-1", item_code: "TILE-A", qty: 99, rate: 1.0 }] },
    { doctype: "Sales Invoice", docstatus: 1, name: "INV-1", customer: "C001", posting_date: "2026-08-05", due_date: "2026-09-04", is_return: false, discount_amount: 0.0,
      items: [{ doctype: "Sales Invoice Item", name: "INV-1-1", item_code: "TILE-A", qty: 10, rate: 100.0, sales_order: "SO-1", so_detail: "SO-1-1" }],
      taxes: [{ doctype: "Sales Taxes and Charges", charge_type: "Actual", account_head: "Freight and Forwarding Charges - ORN", tax_amount: 50.0 }] },
    { doctype: "Sales Invoice", docstatus: 1, name: "INV-2", customer: "C003", posting_date: "2026-09-10", due_date: "2026-09-25", is_return: false, discount_amount: 25.5,
      items: [{ doctype: "Sales Invoice Item", name: "INV-2-1", item_code: "TILE-A", qty: 3, rate: 250.0, sales_order: "" }] },
    { doctype: "Sales Invoice", docstatus: 0, name: "INV-3", customer: "C001", posting_date: "2026-09-11", due_date: "2026-09-30", is_return: false, discount_amount: 0.0,
      items: [{ doctype: "Sales Invoice Item", name: "INV-3-1", item_code: "TILE-A", qty: 1000, rate: 1000.0 }] },
    { doctype: "Purchase Invoice", docstatus: 1, name: "BILL-1", supplier: "S001", posting_date: "2026-08-10", due_date: "2026-10-15", is_return: false,
      items: [{ doctype: "Purchase Invoice Item", item_code: "TILE-A", qty: 100, rate: 20.0 }, { item_code: "TILE-A", qty: 1, rate: 5.0, note: "a child row without doctype" }] },
    { doctype: "Purchase Invoice", docstatus: 1, name: "BILL-2", supplier: "S002", posting_date: "2026-09-01", due_date: "2026-09-15", is_return: false,
      items: [{ doctype: "Purchase Invoice Item", item_code: "TILE-A", qty: 10, rate: 48.25 }] },
    { doctype: "Payment Entry", docstatus: 1, name: "RCT-1", payment_type: "Receive", party_type: "Customer", party: "C001", posting_date: "2026-09-14", paid_amount: 600.0,
      references: [{ doctype: "Payment Entry Reference", reference_doctype: "Sales Invoice", reference_name: "INV-1", allocated_amount: 600.0 }] },
    { doctype: "Payment Entry", docstatus: 1, name: "PAY-1", payment_type: "Pay", party_type: "Supplier", party: "S002", posting_date: "2026-09-15", paid_amount: 482.5,
      references: [{ doctype: "Payment Entry Reference", reference_doctype: "Purchase Invoice", reference_name: "BILL-2", allocated_amount: 482.5 }] },
    { doctype: "Bank Transaction", docstatus: 1, date: "2026-08-03", description: "Opening deposit", reference_number: "DEP-1", deposit: 25000.0, withdrawal: 0.0 },
    { doctype: "Bank Transaction", docstatus: 1, date: "2026-09-14", description: "Customer payment Atlas Build Supply (demo)", reference_number: "RCT-1", deposit: 600.0, withdrawal: 0.0 },
    { doctype: "Bank Transaction", docstatus: 1, date: "2026-09-15", description: "Supplier payment Glazeworks (demo)", reference_number: "BILL-2", deposit: 0.0, withdrawal: 482.5 },
    { doctype: "Bank Transaction", docstatus: 1, date: "2026-09-30", description: "Payroll, September", reference_number: "PR-9", deposit: 0.0, withdrawal: 21000.0 },
    { doctype: "Bank Transaction", docstatus: 0, date: "2026-09-30", description: "DRAFT never booked", reference_number: "X", deposit: 0.0, withdrawal: 999999.0 },
  ];
  return { $about: "test bundle", companySettings: { company: "Orion", abbr: "ORN" }, documents: d };
}
const BUNDLE_TEXT = JSON.stringify(bundle(), null, 1);
const csvFolderFrom = (docs: Doc[]): Record<string, string> =>
  Object.fromEntries(splitDocuments(docs, { doctypes: DEFAULT_DOCTYPES, children: true, submittedOnly: true }).map((t) => [t.file, toCsv(t)]));

describe("an ERPNext bundle read directly gives the splitter's tables", () => {
  it("uses the splitter's default DocTypes", () => {
    assert.deepEqual(DEFAULT_ERPNEXT_DOCTYPES, DEFAULT_DOCTYPES);
  });
  it("one table per DocType and child list, named like the CSV files; the same columns, types, values and order", async () => {
    const J = await tablesOf(folder({ "orion.erpnext-data.json": BUNDLE_TEXT }));
    const C = await tablesOf(folder(csvFolderFrom(bundle().documents)));
    try {
      assert.deepEqual(J.tables.map((t) => t.table).sort(), [
        "bank_transaction", "customer", "customer_credit_limit", "item", "item_reorder", "payment_entry", "payment_entry_reference",
        "purchase_invoice", "purchase_invoice_item", "purchase_invoice_items", "sales_invoice", "sales_invoice_item", "sales_order",
        "sales_order_item", "sales_taxes_and_charges", "supplier",
      ]);
      assert.deepEqual(await dump(J.db, J.tables), await dump(C.db, C.tables));
      const item = J.tables.find((t) => t.table === "sales_invoice_item")!;
      assert.deepEqual(item.columns.slice(0, 4).map((c) => c.name), ["parent", "parenttype", "parentfield", "idx"]);
      assert.equal(J.tables.find((t) => t.table === "sales_invoice")!.columns[0].name, "name");
    } finally { J.db.close(); C.db.close(); }
  });
  it("all 7 smb-erp-fin templates give the same results on the bundle as on the CSVs, and none fails", async () => {
    assert.equal(TEMPLATES.length, 7);
    const J = await tablesOf(folder({ "orion.erpnext-data.json": BUNDLE_TEXT }));
    const C = await tablesOf(folder(csvFolderFrom(bundle().documents)));
    try {
      const j = await templateResults(J.db);
      assert.deepEqual(j, await templateResults(C.db));
      for (const t of TEMPLATES) assert.ok((j[t.label] as { rows: unknown[] }).rows.length > 0, `${t.label} returned rows`);
    } finally { J.db.close(); C.db.close(); }
  });
  it("exact numbers, by hand: biggest payments out, open receivables, credit limit exposure", async () => {
    const J = await tablesOf(folder({ "orion.erpnext-data.json": BUNDLE_TEXT }));
    const sql = (label: string) => TEMPLATES.find((t) => t.label === label)!.sql;
    try {
      const out = await runSelect(J.db, sql("Biggest payments out"), { maxRows: 10, timeoutMs: 10000 });
      assert.deepEqual(out.rows.map((r) => [r.reference_number, Number(r.amount_out)]), [["PR-9", 21000], ["BILL-2", 482.5]], "the 999999 draft is not there");
      const ar = await runSelect(J.db, sql("Open receivables by age"), { maxRows: 10, timeoutMs: 10000 });
      // INV-1: 10 x 100 + 50 tax - 600 paid = 450, due 2026-09-04, as of 2026-09-30: 26 days. INV-2: 3 x 250 - 25.50 = 724.50, due 09-25: 5 days.
      assert.deepEqual(ar.rows.map((r) => [r.customer, Number(r.days_1_30), Number(r.total_unpaid)]), [["Cobalt Retail", 724.5, 724.5], ["Atlas Build Supply", 450, 450]]);
      const cl = await runSelect(J.db, sql("Credit limit exposure"), { maxRows: 10, timeoutMs: 10000 });
      const birch = cl.rows.find((r) => String(r.customer).startsWith("Birch"))!;
      // SO-2 (5 x 300) is not invoiced: exposure 1500 over a 1000 limit. The SO-3 draft is left out.
      assert.equal(birch.customer, 'Birch & Co, "Ltd"');
      assert.deepEqual([Number(birch.uninvoiced_orders), Number(birch.headroom), birch.over_limit], [1500, -500, true]);
    } finally { J.db.close(); }
  });
});

describe("security is unchanged", () => {
  it("left-out documents cannot be read: the __erp_* working tables are gone; read_json is refused; file access is locked", async () => {
    const dir = folder({ "orion.erpnext-data.json": BUNDLE_TEXT });
    const J = await tablesOf(dir);
    try {
      assert.deepEqual(await rows(J.db, "SELECT table_name FROM duckdb_tables() WHERE starts_with(table_name, '__erp_')"), []);
      await assert.rejects(runSelect(J.db, "SELECT * FROM __erp_doc1", { maxRows: 5, timeoutMs: 5000 }), SqlRefused);
      assert.throws(() => checkSelect(`SELECT * FROM read_json_objects('${join(dir, "orion.erpnext-data.json")}')`), SqlRefused);
      await assert.rejects(runSelect(J.db, `SELECT * FROM '${join(dir, "orion.erpnext-data.json").replace(/'/g, "''")}'`, { maxRows: 5, timeoutMs: 5000 }), SqlRefused);
      const [{ n }] = await rows<{ n: number }>(J.db, "SELECT CAST(count(*) AS INTEGER) n FROM sales_invoice");
      assert.equal(n, 2, "the draft INV-3 is not a row");
      assert.equal(J.tables.some((t) => t.table === "company"), false);
    } finally { J.db.close(); }
  });
});

describe("refusals", () => {
  const status = async (p: Promise<unknown>, code: number, re: RegExp) => assert.rejects(p, (e: Error & { status?: number }) => e.status === code && re.test(e.message));
  it("a file named like a bundle that is not one: 400", async () => {
    await status(profileFolder(folder({ "x.erpnext-data.json": "[1,2,3]" }), cfg, 20, 1e9, openDb), 400, /not an ERPNext bundle/);
    await status(profileFolder(folder({ "x.erpnext-data.json": JSON.stringify({ documents: [{ name: "no doctype" }] }) }), cfg, 20, 1e9, openDb), 400, /document 1 has no doctype/);
  });
  it("a field holding an object, or a child row holding a list: 400, naming the document, as the splitter refuses it", async () => {
    const obj = { documents: [{ doctype: "Customer", name: "C9", address: { city: "X" } }] };
    await status(profileFolder(folder({ "x.erpnext-data.json": JSON.stringify(obj) }), cfg, 20, 1e9, openDb), 400, /Customer C9: field address is an object/);
    const nested = { documents: [{ doctype: "Sales Invoice", docstatus: 1, name: "I9", items: [{ doctype: "Sales Invoice Item", serials: ["a"] }] }] };
    await status(profileFolder(folder({ "x.erpnext-data.json": JSON.stringify(nested) }), cfg, 20, 1e9, openDb), 400, /Sales Invoice I9: items\[0\]\.serials is nested/);
    const notRow = { documents: [{ doctype: "Sales Invoice", docstatus: 1, name: "I8", items: [5] }] };
    await status(profileFolder(folder({ "x.erpnext-data.json": JSON.stringify(notRow) }), cfg, 20, 1e9, openDb), 400, /items\[0\] is not a child row/);
  });
  it("two bundles in one folder, or a bundle and a CSV that would be the same table: 409; an unrelated CSV is fine", async () => {
    await status(profileFolder(folder({ "a.erpnext-data.json": BUNDLE_TEXT, "b.erpnext-data.json": BUNDLE_TEXT }), cfg, 20, 1e9, openDb), 409, /one ERPNext bundle per folder/);
    await status(profileFolder(folder({ "a.erpnext-data.json": BUNDLE_TEXT, "customer.csv": "name,customer_name\nC1,X\n" }), cfg, 20, 1e9, openDb), 409, /would both be table customer/);
    const ok = await profileFolder(folder({ "a.erpnext-data.json": BUNDLE_TEXT, "rates.csv": "Currency,Rate\nUSD,1\n" }), cfg, 20, 1e9, openDb);
    assert.ok(ok.some((p) => p.name === "rates.csv") && ok.some((p) => p.name === "customer"));
  });
  it("more tables than --erpnext-max-tables: 413", async () => {
    await status(profileFolder(folder({ "a.erpnext-data.json": BUNDLE_TEXT }), cfg, 20, 1e9, openDb, { ...DEFAULT_BUNDLE_OPTIONS, maxTables: 3 }), 413, /16 tables .* --erpnext-max-tables 3/);
  });
});

describe("options (--erpnext-*)", () => {
  it("--erpnext-bundles off: the file loads as before, one table named after the file", async () => {
    const J = await tablesOf(folder({ "orion.erpnext-data.json": BUNDLE_TEXT }), { ...DEFAULT_BUNDLE_OPTIONS, enabled: false });
    try { assert.deepEqual(J.tables.map((t) => t.table), ["orion_erpnext_data"]); } finally { J.db.close(); }
  });
  it("--erpnext-doctypes all, --erpnext-include-drafts, --erpnext-children off", async () => {
    const dir = folder({ "orion.erpnext-data.json": BUNDLE_TEXT });
    const all = await tablesOf(dir, { ...DEFAULT_BUNDLE_OPTIONS, doctypes: null });
    const drafts = await tablesOf(dir, { ...DEFAULT_BUNDLE_OPTIONS, includeDrafts: true });
    const flat = await tablesOf(dir, { ...DEFAULT_BUNDLE_OPTIONS, children: false });
    try {
      assert.ok(all.tables.some((t) => t.table === "company"));
      const [{ n }] = await rows<{ n: number }>(drafts.db, "SELECT CAST(count(*) AS INTEGER) n FROM bank_transaction");
      assert.equal(n, 5);
      assert.deepEqual(flat.tables.map((t) => t.table).sort(), ["bank_transaction", "customer", "item", "payment_entry", "purchase_invoice", "sales_invoice", "sales_order", "supplier"]);
    } finally { all.db.close(); drafts.db.close(); flat.db.close(); }
  });
  it("flag values are checked", () => {
    const base = { bundles: "on", suffix: ".erpnext-data.json", doctypes: DEFAULT_DOCTYPES.join(","), includeDrafts: false, children: "on", maxTables: "40" };
    assert.deepEqual(bundleOptionsFrom(base), DEFAULT_BUNDLE_OPTIONS);
    assert.equal(bundleOptionsFrom({ ...base, doctypes: "ALL" }).doctypes, null);
    assert.throws(() => bundleOptionsFrom({ ...base, bundles: "yes" }), /--erpnext-bundles must be on or off/);
    assert.throws(() => bundleOptionsFrom({ ...base, suffix: ".csv" }), /--erpnext-suffix/);
    assert.throws(() => bundleOptionsFrom({ ...base, doctypes: " , " }), /--erpnext-doctypes/);
    assert.throws(() => bundleOptionsFrom({ ...base, maxTables: "0" }), /--erpnext-max-tables/);
  });
});

// ---- the owner's real data, when it is on this PC ------------------------------------------------------------------
const REAL = join(REPO, "sample-data", "smb-2-erp-fin", "erpnext");
const SETS = Object.keys(ERP.setLabels ?? {}).filter((s) => existsSync(join(REAL, "_source", `${s}.erpnext-data.json`)) && existsSync(join(REAL, s)));
describe("the real bundles (sample-data/smb-2-erp-fin/erpnext): JSON-only folder vs the CSV folder", { skip: SETS.length === 0 ? "no ERPNext sample data on this PC" : false }, () => {
  for (const set of SETS) {
    it(`${set}: every table and all 7 templates are the same`, async () => {
      const dir = join(root, `real-${set}`);
      mkdirSync(dir);
      copyFileSync(join(REAL, "_source", `${set}.erpnext-data.json`), join(dir, `${set}.erpnext-data.json`));
      const realCfg: DataConfig = { ...cfg, allowedRoots: [root, REAL] };
      const load = async (d: string) => {
        const db = await openDb();
        const { tables } = await loadAndRelate(db, await profileFolder(d, realCfg, 40, 500_000_000, openDb));
        await lockFiles(db);
        return { db, tables };
      };
      const J = await load(dir), C = await load(join(REAL, set));
      try {
        assert.deepEqual(J.tables.map((t) => t.table).sort(), C.tables.map((t) => t.table).sort(), "the same tables");
        assert.deepEqual(await dump(J.db, J.tables), await dump(C.db, C.tables));
        const j = await templateResults(J.db);
        assert.deepEqual(j, await templateResults(C.db));
        for (const t of TEMPLATES) assert.ok((j[t.label] as { rows: unknown[] }).rows.length > 0, `${set}: ${t.label} returned rows`);
      } finally { J.db.close(); C.db.close(); }
    });
  }
});
