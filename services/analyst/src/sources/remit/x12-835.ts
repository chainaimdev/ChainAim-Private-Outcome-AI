/**
 * Source adapter for ERA files: ASC X12N 835 5010 (parser and basis in x12-835-parse.ts). Detects an interchange whose first
 * transaction set is 835 (ISA at the start, ST*835 in the first lines, any delimiters). One file can hold many payments
 * (one ST per payment/EFT/check), so loading creates the claim table under the name it is given plus four side tables,
 * named in meta.tables: <table>__payments, <table>__lines, <table>__adjustments, <table>__plb. Names from NM1 are never loaded.
 */
import { readFile } from "node:fs/promises";
import type { LoadedSource, SourceAdapter } from "../../core/ports.ts";
import { type Db, ident, literal } from "../../db.ts";
import { ERA_TABLES, type EraTable, isEra835, parse835, tableRows } from "./x12-835-parse.ts";

const TYPES: Record<string, string> = {
  paid_cents: "BIGINT", charge_cents: "BIGINT", patient_resp_cents: "BIGINT", allowed_cents: "BIGINT", cents: "BIGINT",
  claim_seq: "INTEGER", line_seq: "INTEGER", payment_date: "DATE", production_date: "DATE", period_start: "DATE", period_end: "DATE",
  service_date: "DATE", fiscal_date: "DATE",
};
const sqlValue = (v: string | number | null): string => (v === null ? "NULL" : typeof v === "number" ? String(v) : literal(v));

/** Creates one table and inserts its rows in batches of `batch`. */
export async function createEraTable(db: Db, name: string, t: EraTable, data: (string | number | null)[][], batch = 500): Promise<void> {
  const cols = ERA_TABLES[t];
  await db.conn.run(`CREATE TABLE ${ident(name)} (${cols.map((c) => `${ident(c)} ${TYPES[c] ?? "VARCHAR"}`).join(", ")})`);
  for (let i = 0; i < data.length; i += batch)
    await db.conn.run(`INSERT INTO ${ident(name)} VALUES ${data.slice(i, i + batch).map((r) => `(${r.map(sqlValue).join(", ")})`).join(", ")}`);
}

export const X12_835: SourceAdapter = {
  id: "remit/x12-835",
  title: "ERA: ASC X12N 835 5010 health care claim payment/advice (payments, claims, service lines, CAS adjustments, PLB)",
  columns: [...ERA_TABLES.claims],
  detect: (lines) => isEra835(lines),
  async load(db: Db, table: string, path: string): Promise<LoadedSource> {
    const r = parse835(await readFile(path, "utf8"));
    const names: Record<EraTable, string> = { claims: table, payments: `${table}__payments`, lines: `${table}__lines`, adjustments: `${table}__adjustments`, plb: `${table}__plb` };
    for (const t of Object.keys(ERA_TABLES) as EraTable[]) await createEraTable(db, names[t], t, tableRows(r, t));
    return { adapter: this.id, table, rows: r.claims.length, checks: [{ name: "claims listed", ok: r.claims.length > 0, detail: `${r.claims.length} claim(s) in ${r.payments.length} payment(s)` }, ...r.checks],
      meta: { tables: names, version: r.version, isaControl: r.isaControl, payments: r.payments.length, lines: r.lines.length, adjustments: r.adjustments.length, plb: r.plb.length } };
  },
};
