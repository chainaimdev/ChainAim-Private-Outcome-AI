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
import { BUNDLE_SUFFIX, DEFAULT_DOCTYPES, type Doc, type SplitOptions, splitDocuments, toCsv } from "../../packages/erpnext-split/src/index.ts";

// The splitting rules live in packages/erpnext-split (shared with services/analyst); re-exported so existing imports keep working.
export { BUNDLE_SUFFIX, DEFAULT_DOCTYPES, csvField, fileFor, splitDocuments, toCsv } from "../../packages/erpnext-split/src/index.ts";
export type { Doc, SplitOptions, Table } from "../../packages/erpnext-split/src/index.ts";

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
