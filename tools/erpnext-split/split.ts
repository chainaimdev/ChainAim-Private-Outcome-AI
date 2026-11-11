/**
 * ERPNext bundle -> one CSV per record type, for tab 03 (config/datasets.json "smb-erp-fin").
 *
 * Input: <borrower>.erpnext-data.json files (CreditSeal ERPNext v16 seed bundles: {companySettings, documents: [...]}).
 * Output: <out>/<borrower>/<doctype>.csv, one row per document; every child table (items, references, taxes,
 * credit_limits) becomes its own CSV with ERPNext's child-row link columns parent, parenttype, parentfield and idx,
 * the same columns a live ERPNext REST answer carries. Only fields present in the documents are written: ERPNext's
 * computed fields (grand_total, outstanding_amount, status) are not in the seed bundle and are not invented here.
 * Node built-ins only. Nothing is written outside --out, and existing CSVs are kept unless --force.
 *
 *   node tools/erpnext-split/split.ts --in sample-data/smb-2-erp-fin/erpnext/_source --out sample-data/smb-2-erp-fin/erpnext
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const BUNDLE_SUFFIX = ".erpnext-data.json";

/** Record types written by default: the books (masters a question needs plus every submitted transaction). */
export const DEFAULT_DOCTYPES = [
  "Customer", "Supplier", "Item",
  "Sales Order", "Sales Invoice", "Purchase Invoice", "Payment Entry", "Bank Transaction",
];

export type Doc = Record<string, unknown> & { doctype: string };
export type SplitOptions = { doctypes: string[]; children: boolean; submittedOnly: boolean };
export type Table = { file: string; columns: string[]; rows: Record<string, unknown>[] };

/** "Sales Invoice Item" -> "sales-invoice-item.csv" */
export const fileFor = (doctype: string): string => doctype.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".csv";

const isScalar = (v: unknown): boolean => v === null || ["string", "number", "boolean"].includes(typeof v);

/** One CSV field: quoted when it holds a comma, quote, line break or leading/trailing space; null and undefined are empty. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(t: Table): string {
  const lines = [t.columns.map(csvField).join(",")];
  for (const r of t.rows) lines.push(t.columns.map((c) => csvField(r[c])).join(","));
  return lines.join("\n") + "\n";
}

/** Splits one bundle's documents into tables. Column order: name first, then fields in the order first seen. */
export function splitDocuments(docs: Doc[], opts: SplitOptions): Table[] {
  const want = new Set(opts.doctypes);
  const tables = new Map<string, Table>();
  const add = (doctype: string, row: Record<string, unknown>, lead: string[]): void => {
    const file = fileFor(doctype);
    let t = tables.get(file);
    if (!t) { t = { file, columns: [...lead], rows: [] }; tables.set(file, t); }
    for (const k of Object.keys(row)) if (!t.columns.includes(k)) t.columns.push(k);
    t.rows.push(row);
  };
  for (const d of docs) {
    if (typeof d?.doctype !== "string") throw new Error(`a document has no doctype: ${JSON.stringify(d).slice(0, 120)}`);
    if (!want.has(d.doctype)) continue;
    if (opts.submittedOnly && "docstatus" in d && d.docstatus !== 1) continue;
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) {
      if (k === "doctype") continue;
      if (Array.isArray(v)) {
        if (!opts.children) continue;
        v.forEach((c, i) => {
          if (!c || typeof c !== "object") throw new Error(`${d.doctype} ${String(d.name ?? "")}: ${k}[${i}] is not a child row`);
          const child = c as Record<string, unknown>;
          const childType = typeof child.doctype === "string" ? child.doctype : `${d.doctype} ${k}`;
          const crow: Record<string, unknown> = { parent: d.name ?? null, parenttype: d.doctype, parentfield: k, idx: i + 1 };
          for (const [ck, cv] of Object.entries(child)) {
            if (ck === "doctype") continue;
            if (!isScalar(cv)) throw new Error(`${d.doctype} ${String(d.name ?? "")}: ${k}[${i}].${ck} is nested; only one level of child rows is supported`);
            crow[ck] = cv;
          }
          add(childType, crow, ["parent", "parenttype", "parentfield", "idx"]);
        });
      } else if (isScalar(v)) row[k] = v;
      else throw new Error(`${d.doctype} ${String(d.name ?? "")}: field ${k} is an object; not an ERPNext document field`);
    }
    add(d.doctype, row, "name" in d ? ["name"] : []);
  }
  for (const dt of want) if (![...tables.values()].some((t) => t.file === fileFor(dt))) throw new Error(`no ${dt} documents in the bundle (check --doctypes)`);
  return [...tables.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function readBundle(path: string): Doc[] {
  const text = readFileSync(path, "utf8");
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!raw || !Array.isArray(raw.documents)) throw new Error(`${path}: not an ERPNext bundle (no "documents" list)`);
  return raw.documents as Doc[];
}

/** The bundles under --in (a folder, or one file), as borrower name -> path. */
export function findBundles(input: string): Map<string, string> {
  const files = statSync(input).isDirectory() ? readdirSync(input).filter((f) => f.endsWith(BUNDLE_SUFFIX)).map((f) => join(input, f)) : [input];
  const out = new Map<string, string>();
  for (const f of files) {
    const name = basename(f);
    if (!name.endsWith(BUNDLE_SUFFIX)) throw new Error(`${f}: expected a file named <borrower>${BUNDLE_SUFFIX}`);
    out.set(name.slice(0, -BUNDLE_SUFFIX.length), f);
  }
  if (!out.size) throw new Error(`no *${BUNDLE_SUFFIX} files in ${input}`);
  return out;
}

function main(argv: string[]): void {
  const { values: f } = parseArgs({
    args: argv,
    strict: true,
    options: {
      in: { type: "string" },
      out: { type: "string" },
      doctypes: { type: "string", default: DEFAULT_DOCTYPES.join(",") },
      borrowers: { type: "string" },
      children: { type: "boolean", default: true },
      "no-children": { type: "boolean", default: false },
      "include-drafts": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (f.help || !f.in || !f.out) {
    console.log(`usage: node tools/erpnext-split/split.ts --in <folder|file> --out <folder> [options]
  --doctypes "A,B"     record types to write (default: ${DEFAULT_DOCTYPES.join(", ")})
  --borrowers "a,b"    only these borrowers (default: every <borrower>${BUNDLE_SUFFIX} under --in)
  --no-children        skip child tables (items, references, taxes, credit limits)
  --include-drafts     also write documents with docstatus other than 1 (default: submitted only)
  --force              overwrite existing CSVs in <out>/<borrower>
  --dry-run            print what would be written, write nothing`);
    process.exit(f.help ? 0 : 2);
  }
  const opts: SplitOptions = {
    doctypes: f.doctypes!.split(",").map((s) => s.trim()).filter(Boolean),
    children: f.children! && !f["no-children"],
    submittedOnly: !f["include-drafts"],
  };
  if (!opts.doctypes.length) throw new Error("--doctypes is empty");
  let bundles = findBundles(resolve(f.in));
  if (f.borrowers) {
    const keep = f.borrowers.split(",").map((s) => s.trim()).filter(Boolean);
    for (const b of keep) if (!bundles.has(b)) throw new Error(`borrower ${b} not found under ${f.in}`);
    bundles = new Map([...bundles].filter(([b]) => keep.includes(b)));
  }
  for (const [borrower, path] of bundles) {
    const dir = join(resolve(f.out), borrower);
    const tables = splitDocuments(readBundle(path), opts);
    const clash = tables.filter((t) => existsSync(join(dir, t.file)));
    if (clash.length && !f.force && !f["dry-run"]) throw new Error(`${dir} already has ${clash.map((t) => t.file).join(", ")}; use --force to overwrite`);
    if (!f["dry-run"]) mkdirSync(dir, { recursive: true });
    for (const t of tables) {
      if (!f["dry-run"]) writeFileSync(join(dir, t.file), toCsv(t), "utf8");
      console.log(`${f["dry-run"] ? "would write" : "wrote"} ${join(dir, t.file)}  ${t.rows.length} rows, ${t.columns.length} columns`);
    }
  }
}

const samePath = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`erpnext-split: ${(e as Error).message}`); process.exit(1); }
}
