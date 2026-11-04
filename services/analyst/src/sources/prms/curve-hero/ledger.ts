/**
 * Curve Hero ledger / period summary export (layout read from the owner's sample Per-Sum-Sample-7-anon-fin-csv.csv, Phase 4c; config/prms
 * header-crosswalk.csv). "Details" carries the entry: "Payment #<id>, <method>" (amount negative), "Deposit #<id>, <method>"
 * (amount positive), "Adjustment #<id>, <type>" (PPO Write-off, Credit Adjustment, Write Off), "Invoice #<id>"; a reference
 * may follow " - ". (Phase 4a first read the Adjustment form without its ID; the ledger's own check caught it on SET-1.) The patient name columns
 * (Patient-LM, Patient-FM) are never loaded; matching uses the patient key in Patient (PT1, ...).
 */
import type { LoadedSource, SourceAdapter } from "../../../core/ports.ts";
import { type Db, dateExpr, ident, literal, rows } from "../../../db.ts";
import { sameHeaders } from "../../lines.ts";

export const CURVE_LEDGER_HEADERS = ["Date", "Details", "Patient", "Patient-LM", "Patient-FM", "Default dentist", "Provider of service", "Clinic", "Posted at clinic", "Amount"];

export const CURVE_LEDGER: SourceAdapter = {
  id: "prms/curve-hero/ledger",
  title: "Curve Hero ledger / period summary (invoices, payments, deposits, adjustments)",
  columns: ["row", "date", "entry", "entry_id", "method", "ref", "pt_pseudonym", "provider", "clinic", "cents"],
  detect: (lines) => sameHeaders(lines, CURVE_LEDGER_HEADERS),
  async load(db: Db, table: string, path: string): Promise<LoadedSource> {
    const d = `trim("Details")`;
    const tail = `trim(regexp_extract(${d}, '^[^,]*,\\s*(.*)$', 1))`;
    await db.conn.run(`CREATE TABLE ${ident(table)} AS
      WITH raw AS (SELECT CAST(row_number() OVER () AS INTEGER) + 1 AS "row", * FROM read_csv(${literal(path)}, header = true, all_varchar = true))
      SELECT "row", ${dateExpr("Date", "%m/%d/%Y")} AS "date",
        CASE WHEN regexp_matches(${d}, '^Payment #\\d+') THEN 'payment' WHEN regexp_matches(${d}, '^Deposit #\\d+') THEN 'deposit'
             WHEN regexp_matches(${d}, '^Invoice #\\d+') THEN 'invoice' WHEN regexp_matches(${d}, '^Adjustment(?: #\\d+)?\\s*,') THEN 'adjustment' ELSE 'other' END AS entry,
        nullif(regexp_extract(${d}, '^(?:Payment|Deposit|Invoice|Adjustment) #(\\d+)', 1), '') AS entry_id,
        nullif(trim(regexp_extract(${tail}, '^(.*?)(?: - .*)?$', 1)), '') AS method,
        nullif(trim(regexp_extract(${tail}, ' - (.*)$', 1)), '') AS ref,
        nullif(trim("Patient"), '') AS pt_pseudonym, nullif(trim("Provider of service"), '') AS provider,
        nullif(trim("Posted at clinic"), '') AS clinic,
        CAST(round(TRY_CAST(replace(trim("Amount"), ',', '') AS DECIMAL(18, 2)) * 100) AS BIGINT) AS cents
      FROM raw`);
    const [r] = await rows<{ n: number; bad: number; other: number }>(db, `SELECT CAST(count(*) AS INTEGER) n,
      CAST(count(*) FILTER (WHERE "date" IS NULL OR cents IS NULL) AS INTEGER) bad, CAST(count(*) FILTER (WHERE entry = 'other') AS INTEGER) other FROM ${ident(table)}`);
    return { adapter: this.id, table, rows: r.n, meta: {}, checks: [
      { name: "every row has a date and an amount", ok: r.bad === 0, detail: `${r.bad} row(s) without` },
      { name: "every Details value is a known entry", ok: r.other === 0, detail: `${r.other} row(s) not Payment/Deposit/Invoice/Adjustment` },
    ] };
  },
};
