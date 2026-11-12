/**
 * ERPNext bundle splitting rules, shared by tools/erpnext-split (writes one CSV per record type) and services/analyst
 * (reads the bundle directly into the same tables, src/erpnext-bundle.ts; its tests compare the two). Pure: no file or
 * network access, Node built-ins not needed. Moved unchanged from tools/erpnext-split/split.ts so both sides use one
 * definition (config/deps/rules.json: a service may not import a tool; shared code belongs in packages/).
 *
 * A bundle (<borrower>.erpnext-data.json) is one JSON object with a "documents" list of Frappe doc dicts. Each record
 * type becomes one table; every child list (items, references, taxes, credit_limits) becomes its own table with
 * ERPNext's child-row link columns parent, parenttype, parentfield and idx.
 */

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
