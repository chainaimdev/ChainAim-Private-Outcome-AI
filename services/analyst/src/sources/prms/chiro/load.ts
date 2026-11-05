/**
 * Loader shared by the chiro layouts (layouts.ts). Reads the file with its header, builds a staging table that keeps the raw
 * text of every typed column next to its parsed value (so each parse failure is counted), keeps only the canonical columns
 * (person names never reach a table: forbidden headers are read only into name_key), runs the file's checks, drops the stage.
 * Every file reports "layout verified against a real export"; it fails while any column is verified: false.
 */
import type { LoadedSource, SourceAdapter, SourceCheck } from "../../../core/ports.ts";
import { type Db, ident, literal, rows } from "../../../db.ts";
import { type ChiroLayout, type ColSpec, chiroColumns, detectChiro, specProblems, unverifiedOf } from "./layouts.ts";

const DATE_FORMAT = "%m/%d/%Y";
const txt = (h: string) => `nullif(trim(${ident(h)}), '')`;

/** SQL for one canonical column, from the raw row (all VARCHAR). */
export function colExpr(col: ColSpec): string {
  const from = typeof col.from === "string" ? col.from : col.from[0];
  switch (col.type) {
    case "text":
      return col.onlyWhen ? `CASE WHEN ${txt(col.onlyWhen.column)} IN (${col.onlyWhen.in.map(literal).join(", ")}) THEN ${txt(from)} END` : txt(from);
    case "date": return `CAST(try_strptime(${txt(from)}, ${literal(DATE_FORMAT)}) AS DATE)`;
    case "cents": {
      const v = `replace(${txt(from)}, ',', '')`;
      return `CASE WHEN regexp_full_match(${v}, '-?[0-9]+([.][0-9]{1,2})?') THEN CAST(round(CAST(${v} AS DECIMAL(18, 2)) * 100) AS BIGINT) END`;
    }
    case "int": return `TRY_CAST(${txt(from)} AS INTEGER)`;
    case "name_key": {
      const [last, first] = col.from as readonly [string, string];
      return `nullif(upper(regexp_replace(trim(coalesce(${txt(last)}, '') || ' ' || coalesce(${txt(first)}, '')), '\\s+', ' ', 'g')), '')`;
    }
    case "map": return `CASE ${Object.entries(col.map!).map(([k, v]) => `WHEN ${txt(from)} = ${literal(k)} THEN ${literal(v)}`).join(" ")} ELSE NULL END`;
  }
}

/** Raw text kept in the stage for a column whose parse can fail (never for names or plain text). */
const rawOf = (col: ColSpec): string | null => (["date", "cents", "int", "map"].includes(col.type) ? txt(col.from as string) : null);

export async function loadChiro(adapterId: string, l: ChiroLayout, db: Db, table: string, path: string): Promise<LoadedSource> {
  const stage = ident(`${table}__stage`);
  const raws = l.columns.flatMap((col) => { const r = rawOf(col); return r ? [`${r} AS ${ident(`__raw_${col.name}`)}`] : []; });
  await db.conn.run(`CREATE TEMP TABLE ${stage} AS
    WITH raw AS (SELECT CAST(row_number() OVER () AS INTEGER) + 1 AS "row", * FROM read_csv(${literal(path)}, header = true, all_varchar = true))
    SELECT "row", ${l.columns.map((col) => `${colExpr(col)} AS ${ident(col.name)}`).join(", ")}${raws.length ? `, ${raws.join(", ")}` : ""} FROM raw`);
  await db.conn.run(`CREATE TABLE ${ident(table)} AS SELECT ${chiroColumns(l).map(ident).join(", ")} FROM ${stage} ORDER BY "row"`);

  const count = async (where: string) => Number((await rows<{ n: number }>(db, `SELECT CAST(count(*) AS INTEGER) n FROM ${stage} WHERE ${where}`))[0].n);
  const n = await count("true");
  const missing: string[] = [], unparsed: string[] = [], checks: SourceCheck[] = [{ name: "rows present", ok: n > 0, detail: `${n} row(s)` }];
  for (const col of l.columns) {
    const raw = rawOf(col) ? ident(`__raw_${col.name}`) : null;
    if (col.required) { const k = await count(raw ? `${raw} IS NULL` : `${ident(col.name)} IS NULL`); if (k) missing.push(`${col.name} ${k}`); }
    if (raw && col.type !== "map") { const k = await count(`${raw} IS NOT NULL AND ${ident(col.name)} IS NULL`); if (k) unparsed.push(`${col.name} ${k}`); }
  }
  checks.push({ name: "required columns present on every row", ok: !missing.length, detail: missing.length ? `rows without: ${missing.join(", ")}` : "all present" });
  checks.push({ name: `dates (${DATE_FORMAT}), amounts and counts parse`, ok: !unparsed.length, detail: unparsed.length ? `unparseable: ${unparsed.join(", ")}` : "all parse" });
  for (const col of l.columns.filter((x) => x.type === "map")) {
    const raw = ident(`__raw_${col.name}`);
    const [u] = await rows<{ n: number; v: string | null }>(db, `SELECT CAST(count(*) AS INTEGER) n, (SELECT string_agg(v, ' | ' ORDER BY v) FROM
      (SELECT DISTINCT ${raw} v FROM ${stage} WHERE ${raw} IS NOT NULL AND ${ident(col.name)} IS NULL LIMIT 10)) v FROM ${stage} WHERE ${raw} IS NOT NULL AND ${ident(col.name)} IS NULL`);
    checks.push({ name: `every ${typeof col.from === "string" ? col.from : col.name} value is known`, ok: u.n === 0,
      detail: u.n ? `${u.n} row(s) with ${u.v}` : `${Object.keys(col.map!).join(", ")}` });
  }
  if (l.key?.length) {
    const k = l.key.map(ident).join(", ");
    const [r] = await rows<{ n: number }>(db, `SELECT CAST(count(*) AS INTEGER) n FROM (SELECT ${k} FROM ${stage} GROUP BY ${k} HAVING count(*) > 1)`);
    checks.push({ name: `${l.key.join(" + ")} is unique`, ok: r.n === 0, detail: `${r.n} repeated key(s)` });
  }
  for (const id of l.identities ?? []) {
    const k = await count(`coalesce(${id.failsWhen}, true)`);
    checks.push({ name: `identity: ${id.name}`, ok: k === 0, detail: `${k} row(s) break it or miss a term` });
  }
  const unverified = unverifiedOf(l);
  checks.push({ name: "layout verified against a real export", ok: unverified.length === 0,
    detail: unverified.length ? `UNVERIFIED: ${unverified.join(", ")} (${l.header.basis})` : "all verified" });
  await db.conn.run(`DROP TABLE ${stage}`);
  return { adapter: adapterId, table, rows: n, checks, meta: { layout: l.id, prefix: l.prefix, verified: unverified.length === 0, unverified } };
}

/** A SourceAdapter for a chiro layout; a broken spec throws when the adapter is built (at startup), never at load time. */
export function chiroAdapter(l: ChiroLayout): SourceAdapter {
  const bad = specProblems(l);
  if (bad.length) throw new Error(`chiro layout spec: ${bad.join("; ")}`);
  return {
    id: l.id, title: l.title, columns: chiroColumns(l),
    detect: (lines) => detectChiro(l, lines),
    load(db, table, path) { return loadChiro(l.id, l, db, table, path); },
  };
}
