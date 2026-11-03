/**
 * Curve Hero "bank deposit detail" export (layout read from the owner's sample BankDep-Det-Sim-Sample-5-fin-csv.csv, Phase 4c;
 * config/pms/curve-bofa-835-schema.csv): one row per posted payment. Row key = ID + Provider (one ID can repeat once per
 * provider). Payer stays (a carrier code, or the self-pay name used for EFT aliasing); Responsible Party (a name) is never
 * loaded — matching uses the patient key in RP (PT1, ...).
 */
import type { LoadedSource, SourceAdapter } from "../../../core/ports.ts";
import { type Db, dateExpr, ident, literal, rows } from "../../../db.ts";
import { sameHeaders } from "../../lines.ts";

export const CURVE_DEPOSIT_HEADERS = ["Date", "ID", "Payment Posted By", "Payment Type", "Ref. ID", "Ext. ID", "Payer", "RP", "Responsible Party", "Provider", "Posted At Clinic", "Amount"];

export const CURVE_DEPOSIT_DETAIL: SourceAdapter = {
  id: "pms/curve-hero/deposit-detail",
  title: "Curve Hero bank deposit detail (one row per posted payment)",
  columns: ["row", "date", "payment_id", "method", "ref_id", "ext_id", "payer", "rp_pseudonym", "provider", "clinic", "cents"],
  detect: (lines) => sameHeaders(lines, CURVE_DEPOSIT_HEADERS),
  async load(db: Db, table: string, path: string): Promise<LoadedSource> {
    const c = (h: string) => `nullif(trim(${ident(h)}), '')`;
    await db.conn.run(`CREATE TABLE ${ident(table)} AS
      WITH raw AS (SELECT CAST(row_number() OVER () AS INTEGER) + 1 AS "row", * FROM read_csv(${literal(path)}, header = true, all_varchar = true))
      SELECT "row", ${dateExpr("Date", "%m/%d/%Y")} AS "date", ${c("ID")} AS payment_id, ${c("Payment Type")} AS method,
        ${c("Ref. ID")} AS ref_id, ${c("Ext. ID")} AS ext_id, ${c("Payer")} AS payer, ${c("RP")} AS rp_pseudonym,
        ${c("Provider")} AS provider, ${c("Posted At Clinic")} AS clinic,
        CAST(round(TRY_CAST(replace(trim("Amount"), ',', '') AS DECIMAL(18, 2)) * 100) AS BIGINT) AS cents
      FROM raw`);
    const [r] = await rows<{ n: number; bad: number; dup: number }>(db, `SELECT CAST(count(*) AS INTEGER) n,
      CAST(count(*) FILTER (WHERE "date" IS NULL OR cents IS NULL OR payment_id IS NULL OR method IS NULL) AS INTEGER) bad,
      CAST((SELECT count(*) FROM (SELECT payment_id, provider FROM ${ident(table)} GROUP BY 1, 2 HAVING count(*) > 1)) AS INTEGER) dup FROM ${ident(table)}`);
    return { adapter: this.id, table, rows: r.n, meta: {}, checks: [
      { name: "every row has a date, an ID, a payment type and an amount", ok: r.bad === 0, detail: `${r.bad} row(s) without` },
      { name: "ID + Provider is unique", ok: r.dup === 0, detail: `${r.dup} repeated key(s)` },
    ] };
  },
};
