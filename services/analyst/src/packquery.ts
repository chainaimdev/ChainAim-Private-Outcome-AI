/**
 * Domain-pack queries over a reconciliation run (DESIGN/xrplh-29): the query bank (queries.json: "sql" entries answered exactly,
 * "question" entries answered by a model from DuckDB fact sheets), the reconciliation tables those queries read, and the fact
 * sheets. Shared by scripts/dental.ts (CLI) and the analyst routes /pack-queries, /pack-run, /pack-verify (console). Moved from
 * scripts/dental.ts unchanged; no model calls and no keys here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Category, type ExceptionFact, type Fact, type FactSheet, renderSheet } from "./facts.ts";
import { type Db, ident, literal, rows } from "./db.ts";
import type { ReconcileReport } from "./reconcile.ts";

export type Entry = { id: string; title: string; topic?: string; pair?: string; sql?: string; question?: string; facts?: string[] };
export type Topic = { id: string; label: string };
/** topics / topic / pair are for the console (grouping, and one question with "Answer as: Table | Explained"); the CLI ignores them. */
export type Bank = { version: 1; topics?: Topic[]; queries: Entry[] };

export const SECTIONS = ["totals", "groups", "losses", "extra", "timing", "posting", "payers", "card", "branch", "eft", "all"];
export const CATEGORY_SQL = `CASE WHEN severity = 'watch' THEN 'timing' WHEN direction = 'negative' THEN 'loss' WHEN direction = 'positive' THEN 'extra' ELSE 'posting' END`;
export const RANK_SQL = `CASE category WHEN 'loss' THEN 0 WHEN 'extra' THEN 1 WHEN 'timing' THEN 2 ELSE 3 END`;
export const WHERE: Record<string, string> = { losses: "category = 'loss'", extra: "category = 'extra'", timing: "category = 'timing'", posting: "category = 'posting'",
  payers: "payer IS NOT NULL AND category IN ('loss', 'extra')", card: "grp = 'card_processor'", branch: "grp = 'branch_atm_deposit'", eft: "grp = 'insurance_eft'", all: "TRUE" };

/** Reads and checks a query bank; throws with the offending entry. */
export function loadBank(path: string): Bank {
  const t = readFileSync(path, "utf8");
  const bank = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t) as Bank;
  if (bank.version !== 1 || !Array.isArray(bank.queries)) throw new Error(`${path}: version must be 1 with a queries list`);
  const seen = new Set<string>();
  for (const q of bank.queries) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(q.id ?? "") || seen.has(q.id) || !q.title || (!q.sql === !q.question)) throw new Error(`${path}: entry ${q.id}: needs a unique lowercase id, a title, and exactly one of sql / question`);
    if (q.question && (!Array.isArray(q.facts) || !q.facts.length || q.facts.some((x) => !SECTIONS.includes(x)))) throw new Error(`${path}: entry ${q.id}: a question needs "facts", a list of ${SECTIONS.join(", ")}`);
    seen.add(q.id);
  }
  if (bank.topics !== undefined) {
    if (!Array.isArray(bank.topics) || bank.topics.some((t) => !/^[a-z0-9][a-z0-9-]*$/.test(t?.id ?? "") || !t.label)) throw new Error(`${path}: topics must be a list of { id, label }`);
    const known = new Set(bank.topics.map((t) => t.id));
    for (const q of bank.queries) if (!q.topic || !known.has(q.topic)) throw new Error(`${path}: entry ${q.id}: topic ${q.topic ?? "(none)"} is not in topics`);
  }
  const byId = new Map(bank.queries.map((q) => [q.id, q]));
  for (const q of bank.queries) {
    if (q.pair === undefined) continue;
    const o = byId.get(q.pair);
    if (!o || o.pair !== q.id || !q.sql === !o.sql || (q.topic ?? null) !== (o.topic ?? null))
      throw new Error(`${path}: entry ${q.id}: pair ${q.pair} must be an entry of the other kind, in the same topic, that pairs back`);
  }
  return bank;
}
/** The query bank of a domain pack: config/domain-packs/<pack>/queries.json. */
export const bankPathOf = (configRoot: string, pack: string): string => join(configRoot, "domain-packs", ...pack.split("/"), "queries.json");

/** The report as tables (amounts in cents and as dollars), and the loaded sources under short names. */
export async function buildTables(db: Db, tables: Readonly<Record<string, string>>, rep: ReconcileReport, dirs: Record<string, string>): Promise<void> {
  const make = async (name: string, cols: [string, string][], data: unknown[][]) => {
    await db.conn.run(`CREATE TABLE ${ident(name)} (${cols.map(([c, t]) => `${ident(c)} ${t}`).join(", ")})`);
    // an empty value is NULL in a typed column (e.g. an exception with no date, such as an ID found only in the ledger)
    const v = (x: unknown, t: string) => x === null || x === undefined || (x === "" && t !== "VARCHAR") ? "NULL" : typeof x === "number" || typeof x === "boolean" ? String(x) : literal(String(x));
    for (let i = 0; i < data.length; i += 200) await db.conn.run(`INSERT INTO ${ident(name)} VALUES ${data.slice(i, i + 200).map((r) => `(${r.map((x, j) => v(x, cols[j][1])).join(", ")})`).join(", ")}`);
  };
  const usd = (c: number) => (c / 100).toFixed(2);
  const d = rep.result.depositToBank;
  await make("exceptions", [["n", "INTEGER"], ["code", "VARCHAR"], ["severity", "VARCHAR"], ["direction", "VARCHAR"], ["grp", "VARCHAR"], ["payer", "VARCHAR"], ["date", "DATE"], ["cents", "BIGINT"], ["amount", "DECIMAL(18,2)"], ["payment_ids", "VARCHAR"], ["bank_rows", "VARCHAR"], ["detail", "VARCHAR"]],
    rep.exceptions.map((e, i) => [i + 1, e.code, e.severity, dirs[e.code] ?? null, e.group, e.payer, e.date, e.cents, usd(e.cents), e.paymentIds.join(";"), e.bankRows.join(";"), e.detail]));
  await make("matches", [["bank_row", "INTEGER"], ["bank_date", "DATE"], ["grp", "VARCHAR"], ["payer", "VARCHAR"], ["curve_date", "DATE"], ["lag_days", "INTEGER"], ["cents", "BIGINT"], ["amount", "DECIMAL(18,2)"], ["n_payments", "INTEGER"], ["payment_ids", "VARCHAR"]],
    d.matched.map((m) => [m.bankRow, m.bankDate, m.group, m.payer, m.curveDate, m.lagDays, m.cents, usd(m.cents), m.paymentIds.length, m.paymentIds.join(";")]));
  await make("unmatched_curve", [["grp", "VARCHAR"], ["payer", "VARCHAR"], ["date", "DATE"], ["cents", "BIGINT"], ["amount", "DECIMAL(18,2)"], ["n_payments", "INTEGER"], ["payment_ids", "VARCHAR"]],
    d.unmatchedCurve.map((u) => [u.group, u.payer, u.date, u.cents, usd(u.cents), u.ids.length, u.ids.join(";")]));
  await make("unmatched_bank", [["bank_row", "INTEGER"], ["date", "DATE"], ["grp", "VARCHAR"], ["payer", "VARCHAR"], ["kind", "VARCHAR"], ["originator", "VARCHAR"], ["cents", "BIGINT"], ["amount", "DECIMAL(18,2)"]],
    d.unmatchedBank.map((b) => [b.row, b.date, b.group, b.payer, b.kind, b.originator, b.cents, usd(b.cents)]));
  await make("group_totals", [["grp", "VARCHAR"], ["curve_amount", "DECIMAL(18,2)"], ["matched_amount", "DECIMAL(18,2)"], ["unmatched_amount", "DECIMAL(18,2)"]],
    Object.entries(rep.result.totals).map(([g, t]) => [g, usd(t.curveCents), usd(t.matchedCents), usd(t.curveCents - t.matchedCents)]));
  await make("file_checks", [["file", "VARCHAR"], ["adapter", "VARCHAR"], ["rows", "INTEGER"], ["check_name", "VARCHAR"], ["ok", "BOOLEAN"], ["detail", "VARCHAR"]],
    rep.files.flatMap((f) => f.checks.length ? f.checks.map((c) => [f.name, f.adapter, f.rows, c.name, c.ok, c.detail]) : [[f.name, f.adapter, f.rows, "(no layout recognised)", f.adapter !== null, ""]]));
  const short: Record<string, string> = { "bank/bofa": "bank", "prms/curve-hero/deposit-detail": "deposit", "prms/curve-hero/ledger": "ledger", "prms/curve-hero/patient-list": "patients",
    "prms/curve-hero/procedures": "procedures", "financing/carecredit": "carecredit", "financing/cherry": "cherry", "financing/hfd": "hfd" };
  for (const [id, t] of Object.entries(tables)) if (short[id]) await db.conn.run(`CREATE VIEW ${ident(short[id])} AS SELECT * FROM ${ident(t)}`);
}

/** One question's facts, computed by DuckDB from the reconciliation tables: classified, signed, totalled, ranked, with actions. */
export async function factSheet(db: Db, sections: string[], actions: Record<string, string>): Promise<FactSheet> {
  
  const base = `(SELECT n, code, ${CATEGORY_SQL} AS category, CAST(date AS VARCHAR) AS d, cents, payer, grp, payment_ids, bank_rows FROM exceptions)`;
  const facts: Fact[] = []; const seen = new Set<number>(); let t = 0, g = 0, f = 0;
  const signedCents = (cat: string, c: number) => (cat === "loss" || cat === "timing" ? -Math.abs(c) : Math.abs(c));
  for (const sec of sections) {
    if (sec === "totals") {
      for (const r of await rows<{ category: Category; items: number; cents: number }>(db, `SELECT category, CAST(count(*) AS INTEGER) AS items, CAST(sum(cents) AS BIGINT) AS cents FROM ${base} GROUP BY category ORDER BY ${RANK_SQL.replaceAll("category", "category")}`))
        facts.push({ tag: `T${++t}`, kind: "T", category: r.category, items: Number(r.items), cents: signedCents(r.category, Number(r.cents)) });
    } else if (sec === "groups") {
      for (const r of await rows<{ grp: string; c: number; m: number }>(db, `SELECT grp, CAST(round(curve_amount * 100) AS BIGINT) AS c, CAST(round(matched_amount * 100) AS BIGINT) AS m FROM group_totals ORDER BY curve_amount DESC`))
        facts.push({ tag: `G${++g}`, kind: "G", group: r.grp, curveCents: Number(r.c), matchedCents: Number(r.m), unmatchedCents: Number(r.c) - Number(r.m) });
    } else {
      const order = sec === "payers" ? "payer, abs(cents) DESC, d, n" : `${RANK_SQL}, abs(cents) DESC, d, n`;
      for (const r of await rows<{ n: number; code: string; category: Category; d: string | null; cents: number; payer: string | null; grp: string | null; payment_ids: string; bank_rows: string }>(db,
        `SELECT * FROM ${base} WHERE ${WHERE[sec]} ORDER BY ${order}`)) {
        if (seen.has(Number(r.n))) continue; seen.add(Number(r.n));
        const fact: ExceptionFact = { tag: `F${++f}`, kind: "F", category: r.category, code: r.code, date: r.d, cents: signedCents(r.category, Number(r.cents)), payer: r.payer, group: r.grp,
          paymentIds: r.payment_ids ? r.payment_ids.split(";").filter(Boolean) : [], bankRows: r.bank_rows ? r.bank_rows.split(";").filter(Boolean).map(Number) : [],
          action: actions[r.code] ?? "check this item" };
        facts.push(fact);
      }
    }
  }
  const nF = facts.filter((x) => x.kind === "F").length;
  return renderSheet(facts, `Scope: ${sections.join(", ")}. ${nF ? `${nF} exception fact(s), already ranked.` : "There are no exceptions of these kinds."}`);
}
