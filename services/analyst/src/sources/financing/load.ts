/**
 * Loader shared by the financing adapters (Phase 4a.2): reads the file positionally (header = false, so HFD's repeated
 * "Bank Account Last 4" header cannot clash), builds a staging table with every parse diagnostic, keeps only the canonical
 * columns (names, phones, bank digits never reach the table), runs the file's own checks, drops the staging table.
 * A header-only file loads as an empty table and fails "rows present"; every file fails "rules verified" while any config
 * item is verified: false.
 */
import { readFile } from "node:fs/promises";
import type { LoadedSource, SourceCheck, SourceOptions } from "../../core/ports.ts";
import { type Db, ident, literal, rows } from "../../db.ts";
import { csvFields } from "../lines.ts";
import { type FinancingLayout, type ProviderConfig, amountNormExpr, centsFromNorm, columnIndex, dateListExpr, financingConfig, kindExpr, textExpr } from "./spec.ts";

const SCHEMA = `"row" INTEGER, "date" DATE, funding_date DATE, ref VARCHAR, patient_ref VARCHAR, gross_cents BIGINT, fee_cents BIGINT, bank_cents BIGINT, kind VARCHAR`;

export async function loadFinancing(adapterId: string, layout: FinancingLayout, db: Db, table: string, path: string, opt: SourceOptions): Promise<LoadedSource> {
  const { cfg, unverified } = financingConfig(opt.configs, layout);
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const headerAt = lines.findIndex((l) => l.replace(/,/g, "").trim() !== "");
  const width = headerAt === -1 ? layout.headers.length : csvFields(lines[headerAt]).length;
  const dataLines = headerAt === -1 ? 0 : lines.slice(headerAt + 1).filter((l) => l.replace(/,/g, "").trim() !== "").length;
  const t = ident(table), stage = ident(`${table}__stage`);
  await db.conn.run(`CREATE TABLE ${t} (${SCHEMA})`);
  const idx = (name: string | null) => (name === null ? null : columnIndex(layout, name, adapterId));
  const c = cfg.columns;
  // every amount column the config uses (gross, fee, bank, identity terms), parsed once
  const amountCols = [...new Set([c.gross, c.fee, c.bank, ...cfg.identities.rules.filter((r) => r.enabled).flatMap((r) => [r.left, ...r.plus, ...r.minus])]
    .filter((x): x is string => x !== null).map((n) => idx(n)!))];
  const a = (i: number | null) => (i === null ? "CAST(NULL AS BIGINT)" : `a${i}`);
  let s: Stats = { n: 0, noDate: 0, badDate: 0, ambDate: 0, outYear: 0, badFund: 0, ambFund: 0, badAmount: 0, noBank: 0, unmapped: 0, unmappedValues: null };
  const signBad: Record<string, number> = {}; const identityBad: Record<string, { off: number; missing: number }> = {};
  if (dataLines > 0) {
    const di = idx(c.date)!, fi = idx(c.funding_date);
    const cols = Array.from({ length: width }, (_, i) => `'column${i}': 'VARCHAR'`).join(", ");
    await db.conn.run(`CREATE TEMP TABLE ${stage} AS
      WITH raw AS (SELECT CAST(row_number() OVER () AS INTEGER) + ${headerAt + 1} AS "row", * FROM read_csv(${literal(path)}, header = false, skip = ${headerAt + 1},
        auto_detect = false, delim = ',', quote = '"', escape = '"', columns = {${cols}}, null_padding = true, all_varchar = true)),
      nonblank AS (SELECT * FROM raw WHERE NOT (${Array.from({ length: width }, (_, i) => `${textExpr(i)} IS NULL`).join(" AND ")})),
      parsed AS (SELECT "row", ${textExpr(di)} AS date_text, ${dateListExpr(di, cfg.dateFormats)} AS dates,
        ${fi === null ? "CAST(NULL AS VARCHAR) AS fund_text, CAST([] AS DATE[]) AS funds" : `${textExpr(fi)} AS fund_text, ${dateListExpr(fi, cfg.dateFormats)} AS funds`},
        ${c.ref === null ? "CAST(NULL AS VARCHAR)" : textExpr(idx(c.ref)!)} AS ref, ${c.patient_ref === null ? "CAST(NULL AS VARCHAR)" : textExpr(idx(c.patient_ref)!)} AS patient_ref,
        ${cfg.kind.column === null ? "CAST(NULL AS VARCHAR)" : textExpr(idx(cfg.kind.column)!)} AS type_text, ${kindExpr(cfg.kind, layout)} AS kind
        ${amountCols.map((i) => `, ${textExpr(i)} AS t${i}, ${amountNormExpr(i, cfg.amountFormat)} AS n${i}`).join("")}
        FROM nonblank)
      SELECT *, CASE WHEN len(dates) = 1 THEN dates[1] END AS "date", CASE WHEN len(funds) = 1 THEN funds[1] END AS funding_date
        ${amountCols.map((i) => `, ${centsFromNorm(`n${i}`)} AS a${i}`).join("")}
      FROM parsed`);
    await db.conn.run(`INSERT INTO ${t} SELECT "row", "date", funding_date, ref, patient_ref, ${a(idx(c.gross))}, ${a(idx(c.fee))}, ${a(idx(c.bank))}, kind FROM ${stage} ORDER BY "row"`);
    const badAmt = amountCols.map((i) => `(t${i} IS NOT NULL AND a${i} IS NULL)`).join(" OR ") || "false";
    const [st] = await rows<Stats>(db, `SELECT CAST(count(*) AS INTEGER) n,
      CAST(count(*) FILTER (WHERE date_text IS NULL) AS INTEGER) "noDate", CAST(count(*) FILTER (WHERE date_text IS NOT NULL AND len(dates) = 0) AS INTEGER) "badDate",
      CAST(count(*) FILTER (WHERE len(dates) > 1) AS INTEGER) "ambDate",
      CAST(count(*) FILTER (WHERE ("date" IS NOT NULL AND year("date") NOT BETWEEN ${cfg.dateYearRange[0]} AND ${cfg.dateYearRange[1]})
        OR (funding_date IS NOT NULL AND year(funding_date) NOT BETWEEN ${cfg.dateYearRange[0]} AND ${cfg.dateYearRange[1]})) AS INTEGER) "outYear",
      CAST(count(*) FILTER (WHERE fund_text IS NOT NULL AND len(funds) = 0) AS INTEGER) "badFund", CAST(count(*) FILTER (WHERE len(funds) > 1) AS INTEGER) "ambFund",
      CAST(count(*) FILTER (WHERE ${badAmt}) AS INTEGER) "badAmount", CAST(count(*) FILTER (WHERE ${a(idx(c.bank))} IS NULL) AS INTEGER) "noBank",
      CAST(count(*) FILTER (WHERE kind IS NULL) AS INTEGER) unmapped,
      (SELECT string_agg(v, ' | ' ORDER BY v) FROM (SELECT DISTINCT coalesce(type_text, '(empty)') v FROM ${stage} WHERE kind IS NULL LIMIT 10)) "unmappedValues"
      FROM ${stage}`);
    s = st;
    for (const [k, sign] of Object.entries(cfg.expectSign)) {
      const [r] = await rows<{ n: number }>(db, `SELECT CAST(count(*) AS INTEGER) n FROM ${t} WHERE kind = ${literal(k)} AND bank_cents IS NOT NULL AND ${sign === "positive" ? "bank_cents <= 0" : "bank_cents >= 0"}`);
      signBad[k] = r.n;
    }
    for (const rule of cfg.identities.rules.filter((r) => r.enabled)) {
      const v = (n: string) => (rule.emptyAsZero ? `coalesce(${a(idx(n))}, 0)` : a(idx(n)));
      const terms = [rule.left, ...rule.plus, ...rule.minus];
      const missing = terms.map((n) => `(${v(n)} IS NULL)`).join(" OR ");
      const rhs = [...rule.plus.map((n) => `+ ${v(n)}`), ...rule.minus.map((n) => `- ${v(n)}`)].join(" ");
      const [r] = await rows<{ off: number; missing: number }>(db, `SELECT CAST(count(*) FILTER (WHERE ${missing}) AS INTEGER) "missing",
        CAST(count(*) FILTER (WHERE NOT (${missing}) AND abs(${v(rule.left)} - (0 ${rhs})) > ${cfg.identities.toleranceCents}) AS INTEGER) "off" FROM ${stage}`);
      identityBad[rule.name] = r;
    }
    await db.conn.run(`DROP TABLE ${stage}`);
  }
  return { adapter: adapterId, table, rows: s.n, checks: checksOf(cfg, unverified, s, signBad, identityBad),
    meta: { provider: layout.provider, verified: unverified.length === 0, unverified, bankAmountColumn: c.bank, headerLine: headerAt + 1 } };
}

type Stats = { n: number; noDate: number; badDate: number; ambDate: number; outYear: number; badFund: number; ambFund: number; badAmount: number; noBank: number; unmapped: number; unmappedValues: string | null };

function checksOf(cfg: ProviderConfig, unverified: string[], s: Stats, signBad: Record<string, number>, identityBad: Record<string, { off: number; missing: number }>): SourceCheck[] {
  const out: SourceCheck[] = [
    { name: "rows present", ok: s.n > 0, detail: `${s.n} row(s)` },
    { name: "rules verified against real-format rows", ok: unverified.length === 0, detail: unverified.length ? `UNVERIFIED: ${unverified.join(", ")}` : "all verified" },
    { name: "every row has one date in the accepted formats", ok: s.noDate + s.badDate + s.ambDate === 0,
      detail: `${s.noDate} missing, ${s.badDate} unparseable, ${s.ambDate} ambiguous (formats ${cfg.dateFormats.join(", ")})` },
    { name: "dates within the accepted years", ok: s.outYear === 0, detail: `${s.outYear} row(s) outside ${cfg.dateYearRange[0]}-${cfg.dateYearRange[1]}` },
    { name: "amounts parse", ok: s.badAmount === 0 && s.noBank === 0, detail: `${s.badAmount} row(s) with an unparseable amount, ${s.noBank} without a bank amount (${cfg.columns.bank})` },
  ];
  if (cfg.columns.funding_date !== null) out.push({ name: "funding dates parse", ok: s.badFund + s.ambFund === 0, detail: `${s.badFund} unparseable, ${s.ambFund} ambiguous` });
  if (cfg.kind.column !== null) out.push({ name: `every ${cfg.kind.column} is mapped to a kind`, ok: s.unmapped === 0,
    detail: s.unmapped ? `${s.unmapped} row(s) unmapped; values: ${s.unmappedValues ?? ""}` : `${Object.keys(cfg.kind.map).length} value(s) mapped` });
  for (const [k, n] of Object.entries(signBad)) out.push({ name: `${k} amounts are ${cfg.expectSign[k as "sale"]}`, ok: n === 0, detail: `${n} row(s) with the other sign or zero` });
  for (const [name, r] of Object.entries(identityBad)) out.push({ name: `identity: ${name}`, ok: r.off === 0 && r.missing === 0, detail: `${r.off} row(s) off by more than ${cfg.identities.toleranceCents} cent(s), ${r.missing} row(s) with a missing term` });
  return out;
}
