/** tools/erpnext-split: bundle -> one CSV per record type, child tables linked by parent/parenttype/parentfield/idx. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { csvField, fileFor, findBundles, splitDocuments, toCsv, type Doc } from "../split.ts";

const SPLIT = fileURLToPath(new URL("../split.ts", import.meta.url));

// Documents in the shape of the CreditSeal ERPNext v16 bundles (orion.erpnext-data.json).
const DOCS: Doc[] = [
  { doctype: "Payment Terms Template", template_name: "Net 30", terms: [{ doctype: "Payment Terms Template Detail", credit_days: 30 }] },
  { doctype: "Customer", name: "C001", customer_name: "Atlas Build Supply (demo)", credit_limits: [{ doctype: "Customer Credit Limit", company: "Orion", credit_limit: 124800 }] },
  { doctype: "Sales Invoice", name: "INV-60006", docstatus: 1, customer: "C001", posting_date: "2025-09-13", due_date: "2025-10-13", discount_amount: 2.5,
    items: [{ doctype: "Sales Invoice Item", name: "INV-60006-1", item_code: "OC-TILE", qty: 133, rate: 24, sales_order: "SO-50006" }],
    taxes: [{ doctype: "Sales Taxes and Charges", charge_type: "Actual", description: "Adjustment, rounding", tax_amount: 4.41 }] },
  { doctype: "Sales Invoice", name: "INV-60007", docstatus: 2, customer: "C001", posting_date: "2025-09-14", due_date: "2025-10-14", items: [] },
  { doctype: "Payment Entry", name: "RCT-70001", docstatus: 1, payment_type: "Receive", party: "C001", posting_date: "2025-10-13",
    references: [{ doctype: "Payment Entry Reference", reference_doctype: "Sales Invoice", reference_name: "INV-60006", allocated_amount: 3193.91 }] },
  { doctype: "Bank Transaction", docstatus: 1, date: "2025-10-13", description: "Customer payment Atlas Build Supply (demo)", deposit: 3193.91, withdrawal: 0 },
];
const OPTS = { doctypes: ["Customer", "Sales Invoice", "Payment Entry", "Bank Transaction"], children: true, submittedOnly: true };

test("file names follow the ERPNext doctype", () => {
  assert.equal(fileFor("Sales Invoice Item"), "sales-invoice-item.csv");
  assert.equal(fileFor("Sales Taxes and Charges"), "sales-taxes-and-charges.csv");
});

test("one table per record type and per child table; only the asked doctypes; drafts and cancelled left out", () => {
  const t = splitDocuments(DOCS, OPTS);
  assert.deepEqual(t.map((x) => x.file), ["bank-transaction.csv", "customer-credit-limit.csv", "customer.csv", "payment-entry-reference.csv", "payment-entry.csv", "sales-invoice-item.csv", "sales-invoice.csv", "sales-taxes-and-charges.csv"]);
  const inv = t.find((x) => x.file === "sales-invoice.csv")!;
  assert.deepEqual(inv.rows.map((r) => r.name), ["INV-60006"]);
  assert.equal(inv.columns[0], "name");
  assert.ok(!inv.columns.includes("items") && !inv.columns.includes("doctype"));
});

test("child rows carry ERPNext's parent link columns", () => {
  const ref = splitDocuments(DOCS, OPTS).find((x) => x.file === "payment-entry-reference.csv")!;
  assert.deepEqual(ref.columns.slice(0, 4), ["parent", "parenttype", "parentfield", "idx"]);
  assert.deepEqual(ref.rows[0], { parent: "RCT-70001", parenttype: "Payment Entry", parentfield: "references", idx: 1, reference_doctype: "Sales Invoice", reference_name: "INV-60006", allocated_amount: 3193.91 });
});

test("--include-drafts keeps documents whose docstatus is not 1", () => {
  const inv = splitDocuments(DOCS, { ...OPTS, submittedOnly: false }).find((x) => x.file === "sales-invoice.csv")!;
  assert.deepEqual(inv.rows.map((r) => r.name), ["INV-60006", "INV-60007"]);
});

test("--no-children writes only the parent tables", () => {
  assert.deepEqual(splitDocuments(DOCS, { ...OPTS, children: false }).map((x) => x.file), ["bank-transaction.csv", "customer.csv", "payment-entry.csv", "sales-invoice.csv"]);
});

test("a doctype asked for but absent is an error, not an empty file", () => {
  assert.throws(() => splitDocuments(DOCS, { ...OPTS, doctypes: ["Purchase Invoice"] }), /no Purchase Invoice documents/);
});

test("CSV quoting: commas, quotes and edge spaces quoted; null empty", () => {
  assert.equal(csvField("Adjustment, rounding"), '"Adjustment, rounding"');
  assert.equal(csvField('a "b"'), '"a ""b"""');
  assert.equal(csvField(" x"), '" x"');
  assert.equal(csvField(null), "");
  assert.equal(csvField(4.41), "4.41");
  const tax = splitDocuments(DOCS, OPTS).find((x) => x.file === "sales-taxes-and-charges.csv")!;
  assert.equal(toCsv(tax), 'parent,parenttype,parentfield,idx,charge_type,description,tax_amount\nINV-60006,Sales Invoice,taxes,1,Actual,"Adjustment, rounding",4.41\n');
});

test("CLI: one folder per borrower, refuses to overwrite without --force, --dry-run writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "erpnext-split-"));
  const src = join(dir, "src"); const out = join(dir, "out");
  mkdirSync(src);
  writeFileSync(join(src, "orion.erpnext-data.json"), JSON.stringify({ documents: DOCS }));
  assert.deepEqual([...findBundles(src).keys()], ["orion"]);
  const run = (...a: string[]) => spawnSync(process.execPath, [SPLIT, "--in", src, "--out", out, "--doctypes", OPTS.doctypes.join(","), ...a], { encoding: "utf8" });
  const dry = run("--dry-run");
  assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /would write/);
  assert.throws(() => readdirSync(join(out, "orion")));
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readdirSync(join(out, "orion")).length, 8);
  assert.match(readFileSync(join(out, "orion", "sales-invoice.csv"), "utf8"), /^name,docstatus,customer,posting_date,due_date,discount_amount\nINV-60006,1,C001,/);
  const again = run();
  assert.equal(again.status, 1); assert.match(again.stderr, /use --force/);
  assert.equal(run("--force").status, 0);
});
