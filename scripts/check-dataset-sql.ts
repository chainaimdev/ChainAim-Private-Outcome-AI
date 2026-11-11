/**
 * Runs every template's exact SQL of one dataset (config/datasets.json) against the running analyst's POST /sql, for
 * each set, and prints the tables. No model and no payment: a free check that the exact queries run and give the same
 * numbers on every set before they are used in tab 03.
 *
 *   node scripts/check-dataset-sql.ts [--dataset smb-erp-fin] [--sets orion,mercury-textiles,jupiter-knitting]
 *        [--templates all|1,3,LABEL] [--analyst http://127.0.0.1:8740] [--data-root /app/sample-data]
 *        [--datasets config/datasets.json] [--show-rows 20] [--json]
 *
 *   --dataset     a dataset id of --datasets whose templates have "sql"
 *   --sets        the dataset's sets (sub-folders) to run on (default: every set in setLabels, else none)
 *   --templates   all (default), or 1-based numbers / labels, comma-separated
 *   --analyst     the analyst's base address (default http://127.0.0.1:8740, the port up.ps1 publishes)
 *   --data-root   the samples root AS THE ANALYST SEES IT (default /app/sample-data, its mount in Docker)
 *   --show-rows   rows printed per table (default 20)
 *   --json        print one JSON line per run instead of tables (for diffing runs)
 *
 * Exit 0 = every query ran; 1 = at least one was refused or failed (its reason is printed); 2 = usage / analyst down.
 * Prints data values (synthetic sample data); it holds no key and calls no model.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

type Template = { label: string; q: string; sql?: string };
type Dataset = { id: string; label: string; folder: string; templates: Template[] | { from: string }; setLabels?: Record<string, string> };

const usage = (m: string): never => { process.stderr.write(`check-dataset-sql: ${m}\n`); process.exit(2); };
let o: Record<string, string | boolean | undefined>;
try {
  o = parseArgs({
    strict: true,
    options: {
      dataset: { type: "string", default: "smb-erp-fin" }, sets: { type: "string" }, templates: { type: "string", default: "all" },
      analyst: { type: "string", default: "http://127.0.0.1:8740" }, "data-root": { type: "string", default: "/app/sample-data" },
      datasets: { type: "string", default: "config/datasets.json" }, "show-rows": { type: "string", default: "20" }, json: { type: "boolean", default: false },
    },
  }).values;
} catch (e) { usage((e as Error).message); }

const showRows = Number(o!["show-rows"]);
if (!Number.isInteger(showRows) || showRows < 0) usage("--show-rows must be a whole number >= 0");
const analyst = String(o!.analyst).replace(/\/+$/, "");
if (!/^https?:\/\//.test(analyst) || !URL.canParse(analyst)) usage(`--analyst must be an http(s) URL, got ${o!.analyst}`);
let file: { datasets: Dataset[] };
try { file = JSON.parse(readFileSync(String(o!.datasets), "utf8").replace(/^﻿/, "")); }
catch (e) { usage(`${o!.datasets} could not be read: ${(e as Error).message}`); }
const ds = file!.datasets.find((d) => d.id === o!.dataset) ?? usage(`no dataset ${o!.dataset} in ${o!.datasets}`);
if (!Array.isArray(ds.templates)) usage(`dataset ${ds.id} takes its questions from a pack, not templates with sql`);
const all = (ds.templates as Template[]).map((t, i) => ({ ...t, n: i + 1 }));
const pick = String(o!.templates);
const chosen = pick === "all" ? all : pick.split(",").map((s) => s.trim()).filter(Boolean).map((s) =>
  (/^\d+$/.test(s) ? all[Number(s) - 1] : all.find((t) => t.label.toLowerCase() === s.toLowerCase())) ?? usage(`no template ${s} (1 to ${all.length})`));
const sets = o!.sets ? String(o!.sets).split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(ds.setLabels ?? {});
if (sets.length === 0) usage(`dataset ${ds.id} has no sets; pass --sets`);
const root = String(o!["data-root"]).replace(/\/+$/, "");

const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));
function table(columns: string[], rows: Record<string, unknown>[]): string {
  const shown = rows.slice(0, showRows);
  const w = columns.map((c) => Math.min(36, Math.max(c.length, ...shown.map((r) => cell(r[c]).length))));
  const line = (vals: string[]) => "    " + vals.map((v, i) => v.slice(0, 36).padEnd(w[i])).join("  ");
  return [line(columns), line(w.map((x) => "-".repeat(x))), ...shown.map((r) => line(columns.map((c) => cell(r[c]))))].join("\n");
}

let failed = 0;
for (const t of chosen) {
  if (!t.sql) { process.stdout.write(`\nSKIP   ${t.n}. ${t.label}: no exact sql (a model would write it)\n`); continue; }
  for (const s of sets) {
    const folder = `${root}/${ds.folder}/${s}`;
    let r: Response;
    try {
      r = await fetch(`${analyst}/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder, sql: t.sql }), signal: AbortSignal.timeout(60_000) });
    } catch (e) { usage(`the analyst is not answering at ${analyst} (${(e as Error).name}): start the desk first`); }
    const body = (await r!.json().catch(() => ({}))) as { columns?: string[]; rows?: Record<string, unknown>[]; truncated?: boolean; ms?: number; error?: unknown };
    if (o!.json) { process.stdout.write(JSON.stringify({ template: t.label, set: s, status: r!.status, ...body }) + "\n"); if (r!.status !== 200) failed++; continue; }
    if (r!.status !== 200 || !Array.isArray(body.columns)) {
      failed++;
      process.stdout.write(`\nFAIL   ${t.n}. ${t.label} · ${s}: HTTP ${r!.status} ${typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? "")}\n`);
      continue;
    }
    process.stdout.write(`\nOK     ${t.n}. ${t.label} · ${s} · ${body.rows!.length} row(s)${body.truncated ? " (truncated)" : ""} · ${body.ms} ms\n${table(body.columns, body.rows!)}\n`);
  }
}
process.stdout.write(`\n${failed === 0 ? "OK     every query ran" : `FAIL   ${failed} run(s) failed`}\n`);
process.exit(failed === 0 ? 0 : 1);
