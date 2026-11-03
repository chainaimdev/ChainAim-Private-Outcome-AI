/**
 * Curve Hero procedure report (Phase 4c; layout read from the owner's sample curveIptReport-sample-fin-csv.csv): one row per
 * completed procedure, with its fee ("Cost"). It is the production side of the practice: a procedure here with no invoice in
 * the ledger is revenue never billed (PROCEDURE_NOT_INVOICED).
 * The export carries no patient key, only "Full Name" ("LAST, FIRST"); it is turned into the same normalized name_key the
 * patient list builds (nameKeyExpr), which links a procedure to a patient key there. The raw name and "Provider Full Name"
 * are never stored; name_key stays inside the analyst (evidence and reports use patient keys only). Exports end in empty
 * columns. Created Date is "M/D/YYYY H:MM" (24-hour, as in the sample); the date part is used.
 */
import type { LoadedSource, SourceAdapter, SourceOptions } from "../../../core/ports.ts";
import { type Db, ident, literal, rows } from "../../../db.ts";
import { sameHeadersPadded } from "../../lines.ts";
import { nameKeyExpr } from "./patient-list.ts";

export const CURVE_PROCEDURE_HEADERS = ["Procedure Name", "Procedure Code", "Cost", "Created Date", "Associated Clinic", "Tooth", "Description",
  "Provider Full Name", "Full Name", "Prim. Carrier Name"];

export const CURVE_PROCEDURES: SourceAdapter = {
  id: "pms/curve-hero/procedures",
  title: "Curve Hero procedure report (completed procedures and their fees)",
  columns: ["row", "date", "procedure_code", "description", "tooth", "clinic", "carrier", "name_key", "cents"],
  detect: (lines) => sameHeadersPadded(lines, CURVE_PROCEDURE_HEADERS),
  async load(db: Db, table: string, path: string, opt: SourceOptions): Promise<LoadedSource> {
    const c = (h: string) => `nullif(trim(${ident(h)}), '')`;
    const cost = `replace(replace(replace(${c("Cost")}, '$', ''), ',', ''), ' ', '')`;
    const money = `CASE WHEN regexp_full_match(${cost}, '\\(([0-9.]+)\\)') THEN '-' || regexp_extract(${cost}, '\\(([0-9.]+)\\)', 1) ELSE ${cost} END`;
    await db.conn.run(`CREATE TABLE ${ident(table)} AS
      WITH raw AS (SELECT CAST(row_number() OVER () AS INTEGER) + 1 AS "row", * FROM read_csv(${literal(path)}, header = true, all_varchar = true, null_padding = true))
      SELECT "row", CAST(try_strptime(${c("Created Date")}, '%m/%d/%Y %H:%M') AS DATE) AS "date",
        upper(${c("Procedure Code")}) AS procedure_code, ${c("Description")} AS description, ${c("Tooth")} AS tooth,
        ${c("Associated Clinic")} AS clinic, ${c("Prim. Carrier Name")} AS carrier,
        CASE WHEN ${c("Full Name")} IS NULL THEN NULL ELSE ${nameKeyExpr("Full Name", opt.patientNameFormat)} END AS name_key,
        CASE WHEN regexp_full_match(${money}, '-?[0-9]+([.][0-9]{1,2})?') THEN CAST(round(CAST(${money} AS DECIMAL(18, 2)) * 100) AS BIGINT) END AS cents
      FROM raw WHERE ${c("Procedure Code")} IS NOT NULL OR ${c("Cost")} IS NOT NULL OR ${c("Created Date")} IS NOT NULL`);
    const [r] = await rows<{ n: number; nodate: number; nocost: number; badcode: number; noname: number }>(db, `SELECT CAST(count(*) AS INTEGER) n,
      CAST(count(*) FILTER (WHERE "date" IS NULL) AS INTEGER) nodate, CAST(count(*) FILTER (WHERE cents IS NULL) AS INTEGER) nocost,
      CAST(count(*) FILTER (WHERE procedure_code IS NULL OR NOT regexp_full_match(procedure_code, 'D[0-9]{4}')) AS INTEGER) badcode,
      CAST(count(*) FILTER (WHERE name_key IS NULL) AS INTEGER) noname FROM ${ident(table)}`);
    return { adapter: this.id, table, rows: r.n, meta: { nameFormat: opt.patientNameFormat }, checks: [
      { name: "procedures listed", ok: r.n > 0, detail: `${r.n} procedure(s)` },
      { name: "every Created Date parses (M/D/YYYY H:MM)", ok: r.nodate === 0, detail: `${r.nodate} row(s) without` },
      { name: "every Cost is an amount", ok: r.nocost === 0, detail: `${r.nocost} row(s) without` },
      { name: "every Procedure Code is a CDT code (Dnnnn)", ok: r.badcode === 0, detail: `${r.badcode} row(s) not` },
      { name: "every procedure names a patient (needed to link it to the patient list)", ok: r.noname === 0, detail: `${r.noname} row(s) without` },
    ] };
  },
};
