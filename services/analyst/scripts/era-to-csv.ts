/**
 * ERA (ASC X12N 835 5010) to CSV (privateAI-design-30 §6.3). Pure Node, no DuckDB: runs on any machine.
 *
 *   node scripts/era-to-csv.ts --in <file.835> [--out <dir>] [--prefix <name>] [--tables payments,claims,lines,adjustments,plb]
 *        [--allow-unbalanced] [--json]
 *
 * Writes <out>/<prefix>-<table>.csv for each table (default out = the input's folder, prefix = the input's base name), amounts
 * in integer cents, dates YYYY-MM-DD, lists joined with "+". Prints the file's checks (balancing, SE counts, parse problems).
 * Exit 0 = written and every check ok (or --allow-unbalanced), 1 = a check failed (files still written), 2 = usage or not an 835.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ERA_TABLES, type EraTable, X12Error, parse835, tableRows } from "../src/sources/remit/x12-835-parse.ts";

const { values: o } = parseArgs({ options: {
  in: { type: "string" }, out: { type: "string" }, prefix: { type: "string" }, tables: { type: "string", default: Object.keys(ERA_TABLES).join(",") },
  "allow-unbalanced": { type: "boolean", default: false }, json: { type: "boolean", default: false },
} });
const usage = (m: string): never => { process.stderr.write(`era-to-csv: ${m}\n`); process.exit(2); };
if (!o.in) usage("--in <file.835> is required");
const input = resolve(o.in!);
const tables = o.tables!.split(",").map((t) => t.trim()).filter(Boolean);
for (const t of tables) if (!(t in ERA_TABLES)) usage(`unknown table ${t} (known: ${Object.keys(ERA_TABLES).join(", ")})`);
const outDir = resolve(o.out ?? dirname(input));
const prefix = o.prefix ?? basename(input, extname(input));

/** RFC 4180: quote a cell holding a comma, quote or line break; double inner quotes. */
const csvCell = (v: string | number | null): string => {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

let text = "";
try { text = readFileSync(input, "utf8"); } catch (e) { usage(`cannot read ${input}: ${(e as Error).message}`); }
let era;
try { era = parse835(text); } catch (e) { if (e instanceof X12Error) usage(`${input}: ${e.message}`); throw e; }
mkdirSync(outDir, { recursive: true });
const written: Record<string, { path: string; rows: number }> = {};
for (const t of tables as EraTable[]) {
  const rowsOut = tableRows(era, t);
  const path = join(outDir, `${prefix}-${t}.csv`);
  writeFileSync(path, [ERA_TABLES[t].join(","), ...rowsOut.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n");
  written[t] = { path, rows: rowsOut.length };
}
const failed = era.checks.filter((c) => !c.ok);
if (o.json) process.stdout.write(JSON.stringify({ input, version: era.version, written, checks: era.checks, failed: failed.length }, null, 2) + "\n");
else {
  for (const [t, w] of Object.entries(written)) process.stdout.write(`${t.padEnd(12)} ${String(w.rows).padStart(6)} row(s)  ${w.path}\n`);
  for (const c of era.checks) process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}\n`);
}
process.exit(failed.length && !o["allow-unbalanced"] ? 1 : 0);
