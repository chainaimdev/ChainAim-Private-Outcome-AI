/**
 * Curve Hero patient list (layout read from the owner's sample LOCS-patientlist-sample-3-fin-csv.csv, Phase 4c): a reference
 * file (no amounts). Patient is the patient key (PT1, ...) the ledger and deposit detail use; one key can have several rows (one
 * per plan, e.g. PT1 in the sample). Blank rows are skipped. Of the name only a normalized key is kept ("LAST FIRST", upper case) for later rule checks; the order of a
 * name without a comma is set by --patient-name-format (the sample does not show it; tools/dental-synth README).
 */
import type { LoadedSource, SourceAdapter, SourceOptions } from "../../../core/ports.ts";
import { type Db, ident, literal, rows } from "../../../db.ts";
import { sameHeaders } from "../../lines.ts";

export const CURVE_PATIENT_HEADERS = ["Patient", "Full Name", "Status", "Preferred Clinic", "Default Doctor", "Prim. Insurance Plan", "Sec. Insurance Plan"];

/**
 * SQL: a person-name column -> the normalized key "LAST FIRST" (upper case, single spaces). "LAST, FIRST" (any spacing around
 * the comma) is read as written; a name without a comma is read by --patient-name-format. Shared by every Curve export that
 * carries a patient name (patient list, procedure report) so the keys agree; the raw name itself is never stored.
 */
export function nameKeyExpr(column: string, format: SourceOptions["patientNameFormat"]): string {
  const n = `upper(regexp_replace(trim(${ident(column)}), '\\s+', ' ', 'g'))`;
  return `CASE WHEN ${n} LIKE '%,%' THEN trim(split_part(${n}, ',', 1)) || ' ' || trim(split_part(${n}, ',', 2))
      ${format === "first_last" ? `ELSE regexp_extract(${n}, '(\\S+)$', 1) || ' ' || trim(regexp_replace(${n}, '\\s*\\S+$', ''))` : `ELSE ${n}`} END`;
}

export const CURVE_PATIENT_LIST: SourceAdapter = {
  id: "prms/curve-hero/patient-list",
  title: "Curve Hero patient list (reference: status, clinic, doctor, plans)",
  columns: ["row", "patient_key", "name_key", "status", "clinic", "doctor", "primary_plan", "secondary_plan"],
  detect: (lines) => sameHeaders(lines, CURVE_PATIENT_HEADERS),
  async load(db: Db, table: string, path: string, opt: SourceOptions): Promise<LoadedSource> {
    const key = nameKeyExpr("Full Name", opt.patientNameFormat);
    await db.conn.run(`CREATE TABLE ${ident(table)} AS
      WITH raw AS (SELECT CAST(row_number() OVER () AS INTEGER) + 1 AS "row", * FROM read_csv(${literal(path)}, header = true, all_varchar = true))
      SELECT "row", nullif(trim("Patient"), '') AS patient_key, ${key} AS name_key, nullif(trim("Status"), '') AS status, nullif(trim("Preferred Clinic"), '') AS clinic,
        nullif(trim("Default Doctor"), '') AS doctor, nullif(trim("Prim. Insurance Plan"), '') AS primary_plan, nullif(trim("Sec. Insurance Plan"), '') AS secondary_plan
      FROM raw WHERE nullif(trim("Full Name"), '') IS NOT NULL`);
    const [r] = await rows<{ n: number; keys: number; nokey: number; dup: number; multi: number }>(db, `SELECT CAST(count(*) AS INTEGER) n,
      CAST(count(DISTINCT patient_key) AS INTEGER) keys, CAST(count(*) FILTER (WHERE patient_key IS NULL) AS INTEGER) nokey,
      CAST((SELECT count(*) FROM (SELECT name_key FROM ${ident(table)} GROUP BY 1 HAVING count(DISTINCT patient_key) > 1)) AS INTEGER) dup,
      CAST((SELECT count(*) FROM (SELECT patient_key FROM ${ident(table)} GROUP BY 1 HAVING count(DISTINCT name_key) > 1)) AS INTEGER) multi
      FROM ${ident(table)}`);
    return { adapter: this.id, table, rows: r.n, meta: { nameFormat: opt.patientNameFormat, patients: r.keys }, checks: [
      { name: "patients listed", ok: r.n > 0, detail: `${r.keys} patient key(s) in ${r.n} row(s)` },
      { name: "every row has a patient key", ok: r.nokey === 0, detail: `${r.nokey} row(s) without` },
      { name: "one name per patient key", ok: r.multi === 0, detail: `${r.multi} key(s) with more than one name` },
      { name: "names are unique across keys (a shared name makes name lookups ambiguous)", ok: r.dup === 0, detail: `${r.dup} name(s) on more than one key` },
    ] };
  },
};
