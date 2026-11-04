/**
 * Bank of America online-banking CSV export (layout read from the owner's sample BANK-ST-JUL-OCT-2026.csv; config/prms/
 * curve-bofa-835-schema.csv rows for bofa_statement). Layout: a summary block ("Description,,Summary Amt.", Beginning balance,
 * Total credits, Total debits, Ending balance), a blank line, then "Date,Description,Amount,Running Bal.,..." and one row per
 * transaction. The first detail row repeats the beginning balance with no amount and is skipped.
 * ACH descriptions are parsed into their fields: "<ORIGINATOR> DES:<type> ID:<id> INDN:<name> CO ID:<id> <SEC> [PMT INFO:TRN*1*<trace>*...]".
 * Checks: beginning + credits + debits = ending (summary), detail credits and debits equal the summary totals, and each
 * running balance equals the previous one plus the amount.
 */
import type { LoadedSource, SourceAdapter, SourceCheck } from "../../core/ports.ts";
import { type Db, dateExpr, ident, literal, rows } from "../../db.ts";
import { cents, csvFields, firstLines } from "../lines.ts";

const DETAIL = ["Date", "Description", "Amount", "Running Bal."];
const isDetailHeader = (l: string) => { const f = csvFields(l).map((x) => x.trim()); return DETAIL.every((h, i) => f[i] === h); };

export const BOFA_STATEMENT: SourceAdapter = {
  id: "bank/bofa",
  title: "Bank of America statement CSV (summary block + detail)",
  columns: ["row", "date", "cents", "description", "kind", "originator", "des", "ach_id", "indn", "co_id", "trace", "check_no", "running_cents"],
  detect: (lines) => /^Description,,Summary Amt\./.test(lines[0] ?? "") && lines.some(isDetailHeader),
  async load(db: Db, table: string, path: string): Promise<LoadedSource> {
    const head = await firstLines(path, 40);
    const at = head.findIndex(isDetailHeader);
    if (at === -1) throw new Error(`${path}: no "Date,Description,Amount,Running Bal." header in the first 40 lines`);
    const summary = new Map<string, number | null>();
    for (const l of head.slice(1, at)) {
      const f = csvFields(l); const label = (f[0] ?? "").trim(); if (!label) continue;
      const key = /^Beginning balance/i.test(label) ? "beginning" : /^Total credits/i.test(label) ? "credits" : /^Total debits/i.test(label) ? "debits" : /^Ending balance/i.test(label) ? "ending" : null;
      if (key) summary.set(key, cents(f[2] ?? ""));
    }
    const desc = `trim(column1)`;
    const rx = (re: string) => `nullif(trim(regexp_extract(${desc}, ${literal(re)}, 1)), '')`;
    await db.conn.run(`CREATE TABLE ${ident(table)} AS
      WITH raw AS (SELECT CAST(row_number() OVER () AS INTEGER) + ${at + 1} AS "row", * FROM read_csv(${literal(path)}, header = false, skip = ${at + 1}, all_varchar = true, null_padding = true))
      SELECT "row", ${dateExpr("column0", "%m/%d/%Y")} AS "date",
        CAST(round(TRY_CAST(replace(trim(column2), ',', '') AS DECIMAL(18, 2)) * 100) AS BIGINT) AS cents,
        ${desc} AS description,
        CASE WHEN ${desc} LIKE '% DES:%' THEN 'ach' WHEN regexp_matches(${desc}, '^Check \\d+') THEN 'check'
             WHEN regexp_matches(${desc}, '^BKOFAMERICA ATM .* DEPOSIT') THEN 'atm_deposit' WHEN ${desc} LIKE 'Counter Credit%' THEN 'counter_credit'
             WHEN regexp_matches(${desc}, ' PURCHASE .*DEBIT CARD') THEN 'card_purchase' ELSE 'other' END AS kind,
        ${rx("^(.*?) DES:")} AS originator, ${rx("DES:(.*?) ID:")} AS des, ${rx(" ID:(\\S+)")} AS ach_id,
        ${rx("INDN:(.*?) CO ID:")} AS indn, ${rx("CO ID:(\\S+)")} AS co_id, ${rx("TRN\\*1\\*([^*\\\\]+)")} AS trace,
        ${rx("^Check (\\d+)")} AS check_no,
        CAST(round(TRY_CAST(replace(trim(column3), ',', '') AS DECIMAL(18, 2)) * 100) AS BIGINT) AS running_cents
      FROM raw WHERE column0 IS NOT NULL AND trim(column0) <> '' AND NOT (${desc} ILIKE 'Beginning balance as of%' AND (column2 IS NULL OR trim(column2) = ''))`);
    const t = ident(table);
    const [tot] = await rows<{ n: number; cr: number | null; dr: number | null; bad: number }>(db, `SELECT CAST(count(*) AS INTEGER) n,
      CAST(sum(cents) FILTER (WHERE cents > 0) AS BIGINT) cr, CAST(sum(cents) FILTER (WHERE cents < 0) AS BIGINT) dr,
      CAST(count(*) FILTER (WHERE "date" IS NULL OR cents IS NULL) AS INTEGER) bad FROM ${t}`);
    const [run] = await rows<{ breaks: number; checked: number }>(db, `WITH o AS (SELECT running_cents, cents, lag(running_cents) OVER (ORDER BY "row") prev FROM ${t})
      SELECT CAST(count(*) FILTER (WHERE prev IS NOT NULL AND running_cents IS NOT NULL AND prev + cents <> running_cents) AS INTEGER) breaks,
             CAST(count(*) FILTER (WHERE prev IS NOT NULL AND running_cents IS NOT NULL) AS INTEGER) checked FROM o`);
    const [first] = await rows<{ running_cents: number | null; cents: number | null }>(db, `SELECT running_cents, cents FROM ${t} ORDER BY "row" LIMIT 1`);
    const b = summary.get("beginning"), c = summary.get("credits"), d = summary.get("debits"), e = summary.get("ending");
    const money = (x: number | null | undefined) => (x === null || x === undefined ? "missing" : (Number(x) / 100).toFixed(2));
    const checks: SourceCheck[] = [
      { name: "summary present", ok: [b, c, d, e].every((x) => typeof x === "number"), detail: `beginning ${money(b)}, credits ${money(c)}, debits ${money(d)}, ending ${money(e)}` },
      { name: "summary adds up", ok: b != null && c != null && d != null && e != null && b + c + d === e, detail: `${money(b)} + ${money(c)} + ${money(d)} vs ${money(e)}` },
      { name: "detail credits = summary credits", ok: c != null && Number(tot.cr ?? 0) === c, detail: `${money(Number(tot.cr ?? 0))} vs ${money(c)}` },
      { name: "detail debits = summary debits", ok: d != null && Number(tot.dr ?? 0) === d, detail: `${money(Number(tot.dr ?? 0))} vs ${money(d)}` },
      { name: "opening running balance", ok: b != null && first !== undefined && first.running_cents !== null && Number(first.running_cents) - Number(first.cents ?? 0) === b, detail: `first row ${money(first?.running_cents)} - ${money(first?.cents)} vs beginning ${money(b)}` },
      { name: "running balance continuous", ok: run.breaks === 0, detail: `${run.breaks} break(s) in ${run.checked} rows` },
      { name: "every row has a date and an amount", ok: tot.bad === 0, detail: `${tot.bad} row(s) without` },
    ];
    return { adapter: this.id, table, rows: tot.n, checks, meta: { headerLine: at + 1, summary: Object.fromEntries([...summary].map(([k, v]) => [k, v])) } };
  },
};
