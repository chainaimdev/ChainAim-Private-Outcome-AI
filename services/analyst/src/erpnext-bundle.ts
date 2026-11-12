/**
 * ERPNext JSON bundles read directly, without converting them to CSV first (tools/erpnext-split stays optional).
 *
 * A file named <borrower>.erpnext-data.json (the CreditSeal ERPNext v16 seed bundle: one JSON object with a
 * "documents" list of Frappe doc dicts) in a data folder becomes one table per DocType, the same tables
 * tools/erpnext-split/split.ts writes as CSVs, with the same rules, so the smb-erp-fin templates
 * (config/datasets.json) run unchanged:
 *   - only the DocTypes in --erpnext-doctypes (default: the splitter's DEFAULT_DOCTYPES; "all" = every DocType);
 *   - only submitted documents (docstatus 1, where the document has a docstatus) unless --erpnext-include-drafts;
 *   - every child list (items, references, taxes, credit_limits ...) becomes its own table, named after each child
 *     row's own doctype (or "<Parent DocType> <field>" when it has none), with ERPNext's child-row link columns
 *     parent, parenttype, parentfield and idx first;
 *   - a table is named after the DocType like the splitter's file ("Sales Invoice Item" -> sales-invoice-item ->
 *     table sales_invoice_item); columns are the document fields in the order first seen, name first;
 *   - every value is text, as a CSV load is: booleans become 1 and 0, a whole number written as 5000.0 becomes 5000;
 *     relate.ts then types the columns exactly as for the CSVs (amountExpr, dateExpr);
 *   - a field holding an object, or a child row holding a list or an object, is refused with the document named,
 *     as the splitter refuses it. Nothing is guessed.
 *
 * The parsing is DuckDB's own (read_json_objects and the json functions), run only while the folder is loaded,
 * before lockFiles; the SQL a question runs cannot call read_json* (sqlrun.ts) and file access is locked by then.
 * The working tables (__erp_*) are dropped once the folder's tables are built, so a question cannot see drafts or
 * other DocTypes left out by the options.
 */
import { DEFAULT_DOCTYPES } from "../../../packages/erpnext-split/src/index.ts";
import { HttpError } from "./config.ts";
import { type Db, ident, literal, loadText, rows } from "./db.ts";

/** The splitter's default record types, from the one shared definition (packages/erpnext-split DEFAULT_DOCTYPES). */
export const DEFAULT_ERPNEXT_DOCTYPES: string[] = [...DEFAULT_DOCTYPES];

export type BundleOptions = {
  /** --erpnext-bundles on|off: off = a bundle is loaded like any other JSON file (one table). */
  enabled: boolean;
  /** --erpnext-suffix: the file name ending that marks a bundle (case-insensitive). */
  suffix: string;
  /** --erpnext-doctypes: parent DocTypes kept; null = all. */
  doctypes: string[] | null;
  /** --erpnext-include-drafts: also documents whose docstatus is not 1. */
  includeDrafts: boolean;
  /** --erpnext-children on|off: child lists become tables. */
  children: boolean;
  /** --erpnext-max-tables: most tables one bundle may give. */
  maxTables: number;
};

export const DEFAULT_BUNDLE_OPTIONS: BundleOptions = {
  enabled: true, suffix: ".erpnext-data.json", doctypes: DEFAULT_ERPNEXT_DOCTYPES, includeDrafts: false, children: true, maxTables: 40,
};

/** The --erpnext-* flag values as BundleOptions; throws naming the bad flag. */
export function bundleOptionsFrom(v: { bundles: string; suffix: string; doctypes: string; includeDrafts: boolean; children: string; maxTables: string }): BundleOptions {
  const onOff = (name: string, s: string): boolean => {
    if (s !== "on" && s !== "off") throw new Error(`--${name} must be on or off, got ${s}`);
    return s === "on";
  };
  const suffix = v.suffix.trim();
  if (!/^\.[A-Za-z0-9._-]*\.json$/i.test(suffix)) throw new Error(`--erpnext-suffix must be a file name ending such as .erpnext-data.json, got ${v.suffix}`);
  const d = v.doctypes.trim();
  const doctypes = d.toLowerCase() === "all" ? null : d.split(",").map((s) => s.trim()).filter(Boolean);
  if (doctypes !== null && !doctypes.length) throw new Error("--erpnext-doctypes must list DocTypes (comma-separated) or be all");
  const maxTables = Number(v.maxTables);
  if (!Number.isInteger(maxTables) || maxTables < 1 || maxTables > 500) throw new Error(`--erpnext-max-tables must be a whole number from 1 to 500, got ${v.maxTables}`);
  return { enabled: onOff("erpnext-bundles", v.bundles), suffix, doctypes, includeDrafts: v.includeDrafts, children: onOff("erpnext-children", v.children), maxTables };
}

export const isBundleFile = (name: string, o: BundleOptions): boolean => o.enabled && name.toLowerCase().endsWith(o.suffix.toLowerCase());

/** One table of a bundle: name is what the folder lists (and the table is named after); doctype as written in the bundle. */
export type BundlePart = { name: string; doctype: string; bundle: string; options: BundleOptions };

const LEAD_CHILD = ["parent", "parenttype", "parentfield", "idx"];
/** "Sales Invoice Item" -> "sales-invoice-item": the splitter's file name without .csv (fileFor), so the table name is the same. */
const SLUG_SQL = (x: string): string => `trim(regexp_replace(lower(trim(${x})), '[^a-z0-9]+', '-', 'g'), '-')`;
/** A JSON scalar as the text a CSV cell would hold (null -> NULL, true/false -> 1/0, 5000.0 -> 5000). */
const VALUE_SQL = (v: string, t: string): string => `CASE ${t} WHEN 'NULL' THEN NULL
  WHEN 'BOOLEAN' THEN CASE WHEN json_extract_string(${v}, '$') = 'true' THEN '1' ELSE '0' END
  WHEN 'DOUBLE' THEN regexp_replace(json_extract_string(${v}, '$'), '\\.0+$', '')
  ELSE json_extract_string(${v}, '$') END`;
const KEY_PATH = (k: string): string => `'$."' || ${k} || '"'`;

type Loaded = { n: number; parts: { slug: string; doctype: string }[] };
const cache = new WeakMap<Db, Map<string, Loaded>>();
let counter = 0;

const fail = (status: number, file: string, m: string): never => { throw new HttpError(status, `${file}: ${m}`); };

/** Parses the bundle once per database into __erp_row<n> (one row per table row) and __erp_kv<n> (its values). */
async function ensureBundle(db: Db, path: string, file: string, bytes: number, o: BundleOptions): Promise<Loaded> {
  const key = `${path}\u0000${JSON.stringify(o)}`;
  let m = cache.get(db);
  if (!m) { m = new Map(); cache.set(db, m); }
  const hit = m.get(key);
  if (hit) return hit;
  const n = ++counter;
  const T = (s: string) => ident(`__erp_${s}${n}`);
  const src = `read_json_objects(${literal(path)}, format = 'auto', maximum_object_size = ${Math.max(1_048_576, Math.ceil(bytes) + 1024)})`;
  const [shape] = await rows<{ objects: number; lists: number }>(db, `SELECT CAST(count(*) AS INTEGER) objects, CAST(count(*) FILTER (WHERE json_type(json, '$.documents') = 'ARRAY') AS INTEGER) lists FROM ${src}`);
  if (shape.objects !== 1 || shape.lists !== 1) fail(400, file, `not an ERPNext bundle (one JSON object with a "documents" list), or rename it so it does not end with ${o.suffix}`);
  await db.conn.run(`CREATE TEMP TABLE ${T("doc")} AS SELECT CAST(generate_subscripts(arr, 1) AS INTEGER) AS i, unnest(arr) AS doc FROM (SELECT CAST(json_extract(json, '$.documents') AS JSON[]) AS arr FROM ${src})`);
  const [bad] = await rows<{ i: number | null }>(db, `SELECT min(i) AS i FROM ${T("doc")} WHERE json_type(doc) <> 'OBJECT' OR json_type(doc, '$.doctype') IS DISTINCT FROM 'VARCHAR'`);
  if (bad.i !== null) fail(400, file, `document ${bad.i} has no doctype`);

  const keep = o.doctypes === null ? "" : ` AND json_extract_string(doc, '$.doctype') IN (${o.doctypes.map(literal).join(", ")})`;
  const submitted = o.includeDrafts ? "" : ` AND (json_type(doc, '$.docstatus') IS NULL OR (json_type(doc, '$.docstatus') IN ('UBIGINT', 'BIGINT', 'DOUBLE') AND CAST(json_extract_string(doc, '$.docstatus') AS DOUBLE) = 1))`;
  await db.conn.run(`CREATE TEMP TABLE ${T("par")} AS SELECT i, doc, json_extract_string(doc, '$.doctype') AS dt FROM ${T("doc")} WHERE true${keep}${submitted}`);
  // Every field of every kept document, with its position (for the column order) and JSON type.
  await db.conn.run(`CREATE TEMP TABLE ${T("pk")} AS SELECT p.i, p.dt, json_extract_string(p.doc, '$.name') AS pname, k.key, CAST(k.kp AS INTEGER) AS kp,
      json_type(p.doc, ${KEY_PATH("k.key")}) AS t, json_extract(p.doc, ${KEY_PATH("k.key")}) AS v
    FROM ${T("par")} p, LATERAL (SELECT unnest(json_keys(p.doc)) AS key, generate_subscripts(json_keys(p.doc), 1) AS kp) k WHERE k.key <> 'doctype'`);
  const [qk] = await rows<{ dt: string; key: string }>(db, `SELECT dt, key FROM ${T("pk")} WHERE regexp_matches(key, '["\\\\]') LIMIT 1`);
  if (qk) fail(400, file, `${qk.dt}: field name ${JSON.stringify(qk.key)} holds a quote or backslash; not an ERPNext field name`);
  const [obj] = await rows<{ dt: string; pname: string | null; key: string }>(db, `SELECT dt, pname, key FROM ${T("pk")} WHERE t = 'OBJECT' ORDER BY i, kp LIMIT 1`);
  if (obj) fail(400, file, `${obj.dt} ${obj.pname ?? ""}: field ${obj.key} is an object; not an ERPNext document field`);

  await db.conn.run(`CREATE TEMP TABLE ${T("row")} (tbl VARCHAR, dt VARCHAR, i INTEGER, fp INTEGER, idx INTEGER, child BOOLEAN)`);
  await db.conn.run(`CREATE TEMP TABLE ${T("kv")} (tbl VARCHAR, i INTEGER, fp INTEGER, idx INTEGER, key VARCHAR, ko INTEGER, val VARCHAR)`);
  await db.conn.run(`INSERT INTO ${T("row")} SELECT ${SLUG_SQL("dt")}, dt, i, 0, 0, false FROM ${T("par")}`);
  await db.conn.run(`INSERT INTO ${T("kv")} SELECT ${SLUG_SQL("dt")}, i, 0, 0, key, kp, ${VALUE_SQL("v", "t")} FROM ${T("pk")} WHERE t NOT IN ('ARRAY', 'OBJECT')`);

  if (o.children) {
    await db.conn.run(`CREATE TEMP TABLE ${T("ch")} AS SELECT x.*, CASE WHEN json_type(x.c, '$.doctype') = 'VARCHAR' THEN json_extract_string(x.c, '$.doctype') ELSE x.pdt || ' ' || x.field END AS ct
      FROM (SELECT pk.i, pk.dt AS pdt, pk.pname, pk.key AS field, pk.kp AS fp, CAST(u.idx AS INTEGER) AS idx, u.c
        FROM ${T("pk")} pk, LATERAL (SELECT unnest(CAST(pk.v AS JSON[])) AS c, generate_subscripts(CAST(pk.v AS JSON[]), 1) AS idx) u WHERE pk.t = 'ARRAY') x`);
    const [notRow] = await rows<{ pdt: string; pname: string | null; field: string; idx: number }>(db, `SELECT pdt, pname, field, idx FROM ${T("ch")} WHERE json_type(c) <> 'OBJECT' ORDER BY i, fp, idx LIMIT 1`);
    if (notRow) fail(400, file, `${notRow.pdt} ${notRow.pname ?? ""}: ${notRow.field}[${notRow.idx - 1}] is not a child row`);
    await db.conn.run(`CREATE TEMP TABLE ${T("ck")} AS SELECT ch.ct, ch.i, ch.fp, ch.idx, ch.pdt, ch.pname, ch.field, k.key, CAST(k.kp AS INTEGER) AS kp,
        json_type(ch.c, ${KEY_PATH("k.key")}) AS t, json_extract(ch.c, ${KEY_PATH("k.key")}) AS v
      FROM ${T("ch")} ch, LATERAL (SELECT unnest(json_keys(ch.c)) AS key, generate_subscripts(json_keys(ch.c), 1) AS kp) k WHERE k.key <> 'doctype'`);
    const [cq] = await rows<{ ct: string; key: string }>(db, `SELECT ct, key FROM ${T("ck")} WHERE regexp_matches(key, '["\\\\]') LIMIT 1`);
    if (cq) fail(400, file, `${cq.ct}: field name ${JSON.stringify(cq.key)} holds a quote or backslash; not an ERPNext field name`);
    const [nest] = await rows<{ pdt: string; pname: string | null; field: string; idx: number; key: string }>(db, `SELECT pdt, pname, field, idx, key FROM ${T("ck")} WHERE t IN ('ARRAY', 'OBJECT') ORDER BY i, fp, idx, kp LIMIT 1`);
    if (nest) fail(400, file, `${nest.pdt} ${nest.pname ?? ""}: ${nest.field}[${nest.idx - 1}].${nest.key} is nested; only one level of child rows is supported`);
    await db.conn.run(`INSERT INTO ${T("row")} SELECT ${SLUG_SQL("ct")}, ct, i, fp, idx, true FROM ${T("ch")}`);
    // The link columns, unless the child row carries a field of the same name (then its own value is kept, as the splitter does).
    const leads: [string, string][] = [["parent", "pname"], ["parenttype", "pdt"], ["parentfield", "field"], ["idx", "CAST(idx AS VARCHAR)"]];
    for (const [k, [col, expr]] of leads.entries()) {
      await db.conn.run(`INSERT INTO ${T("kv")} SELECT ${SLUG_SQL("ct")}, i, fp, idx, ${literal(col)}, ${k - leads.length}, ${expr} FROM ${T("ch")} WHERE NOT list_contains(json_keys(c), ${literal(col)})`);
    }
    await db.conn.run(`INSERT INTO ${T("kv")} SELECT ${SLUG_SQL("ct")}, i, fp, idx, key, kp, ${VALUE_SQL("v", "t")} FROM ${T("ck")}`);
  }
  const parts = await rows<{ slug: string; doctype: string }>(db, `SELECT tbl AS slug, arg_min(dt, [i, fp, idx]) AS doctype FROM ${T("row")} GROUP BY tbl ORDER BY tbl`);
  if (parts.length > o.maxTables) fail(413, file, `${parts.length} tables (DocTypes and child lists); the limit is --erpnext-max-tables ${o.maxTables}`);
  const empty = parts.find((p) => !p.slug);
  if (empty) fail(400, file, `DocType ${JSON.stringify(empty.doctype)} gives no table name`);
  const loaded = { n, parts };
  m.set(key, loaded);
  return loaded;
}

/** The tables one bundle gives, in name order. */
export async function bundleParts(db: Db, path: string, file: string, bytes: number, o: BundleOptions): Promise<BundlePart[]> {
  return (await ensureBundle(db, path, file, bytes, o)).parts.map((p) => ({ name: p.slug, doctype: p.doctype, bundle: file, options: o }));
}

/** Creates `table` with __row and one text column per field of the part, like loadText does for a CSV. */
export async function loadBundlePart(db: Db, table: string, path: string, bytes: number, part: BundlePart): Promise<void> {
  const { n } = await ensureBundle(db, path, part.bundle, bytes, part.options);
  const R = ident(`__erp_row${n}`), KV = ident(`__erp_kv${n}`);
  const tbl = literal(part.name);
  const [kind] = await rows<{ child: boolean; parent: boolean }>(db, `SELECT bool_or(child) AS child, bool_or(NOT child) AS parent FROM ${R} WHERE tbl = ${tbl}`);
  if (kind?.child === null || kind?.child === undefined) fail(404, part.bundle, `no ${part.doctype} rows`);
  const seen = (await rows<{ key: string }>(db, `SELECT key FROM ${KV} WHERE tbl = ${tbl} GROUP BY key ORDER BY min([i, fp, idx, ko])`)).map((r) => r.key);
  const lead = kind.parent ? ["name"] : LEAD_CHILD;
  const cols = [...lead.filter((c) => seen.includes(c)), ...seen.filter((c) => !lead.includes(c))];
  const pick = cols.map((c) => `max(kv.val) FILTER (WHERE kv.key = ${literal(c)}) AS ${ident(c)}`);
  await db.conn.run(`CREATE TABLE ${ident(table)} AS SELECT * FROM (
      SELECT CAST(row_number() OVER (ORDER BY r.i, r.fp, r.idx) AS INTEGER) AS __row${pick.length ? ", " + pick.join(", ") : ""}
      FROM ${R} r LEFT JOIN ${KV} kv ON kv.tbl = r.tbl AND kv.i = r.i AND kv.fp = r.fp AND kv.idx = r.idx
      WHERE r.tbl = ${tbl} GROUP BY r.i, r.fp, r.idx) ORDER BY __row`);
}

/** Drops every __erp_* working table, so a question sees only the tables built from them. Call before lockFiles. */
export async function dropBundleWork(db: Db): Promise<void> {
  for (const t of await rows<{ name: string }>(db, "SELECT table_name AS name FROM duckdb_tables() WHERE starts_with(table_name, '__erp_')")) await db.conn.run(`DROP TABLE ${ident(t.name)}`);
  cache.delete(db);
}

/** A profiled file or bundle part, loaded as text into `table`. */
export async function loadSource(db: Db, table: string, p: { path: string; bytes: number; part?: BundlePart }): Promise<void> {
  return p.part ? loadBundlePart(db, table, p.path, p.bytes, p.part) : loadText(db, table, p.path);
}
