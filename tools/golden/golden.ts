/**
 * Golden master for any module's pure exports: runs each export on fixed inputs and records or checks the outputs as
 * canonical JSON. Proves a move or refactor changes nothing. Shared by packages (actus, crossask, ...).
 *
 *   node tools/golden/golden.ts --mode check  --module <m.ts> --cases <cases.json> --golden <out.json> [--skip a,b]
 *   node tools/golden/golden.ts --mode record --module <m.ts> --cases <cases.json> --golden <out.json> [--skip a,b] [--force]
 *
 * Flags (paths relative to the current directory):
 *   --mode record|check      record writes the golden file; check compares and exits 1 on any difference (2 = usage)
 *   --module <path>          the module under test (required)
 *   --cases <path>           the input cases (required)
 *   --golden <path>          the recorded outputs (required)
 *   --skip <a,b,...>         exported functions not run, e.g. ones that need the network (default: none)
 *   --force                  let record overwrite an existing golden file
 *
 * Case format: {"id", "fn", "args": [...]}. In args, {"$call": {"fn", "args"}} is replaced by that call's result and
 * {"$undefined": true} by undefined. A thrown error is recorded as {"error": {"name", "message"}}. Every exported function
 * needs a case or a --skip entry; every non-function export is recorded as a constant.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

type Case = { id: string; fn: string; args: unknown[] };
type Outcome = { value: unknown } | { error: { name: string; message: string } };

const { values: o } = parseArgs({
  options: {
    mode: { type: "string" },
    module: { type: "string" },
    cases: { type: "string" },
    golden: { type: "string" },
    skip: { type: "string", default: "" },
    force: { type: "boolean", default: false },
  },
});
const fail = (msg: string, code = 2): never => { process.stderr.write(`golden: ${msg}\n`); process.exit(code); };
if (o.mode !== "record" && o.mode !== "check") fail("--mode must be record or check");
for (const k of ["module", "cases", "golden"] as const) if (!o[k]) fail(`--${k} is required`);

const mod = (await import(pathToFileURL(resolve(o.module!)).href)) as Record<string, unknown>;
const cases = JSON.parse(readFileSync(resolve(o.cases!), "utf8")) as Case[];
const skip = new Set(o.skip!.split(",").map((s) => s.trim()).filter(Boolean));

// Every export must be covered: functions by at least one case (unless skipped), everything else recorded as a constant.
const ids = new Set<string>();
for (const c of cases) {
  if (ids.has(c.id)) fail(`duplicate case id ${c.id}`);
  ids.add(c.id);
  if (typeof mod[c.fn] !== "function") fail(`case ${c.id}: ${c.fn} is not an exported function of ${o.module}`);
}
const fns = Object.keys(mod).filter((k) => typeof mod[k] === "function").sort();
const uncovered = fns.filter((f) => !skip.has(f) && !cases.some((c) => c.fn === f));
if (uncovered.length) fail(`exports with no case: ${uncovered.join(", ")} (add a case or list them in --skip)`);

function resolveArg(a: unknown): unknown {
  if (Array.isArray(a)) return a.map(resolveArg);
  if (a && typeof a === "object") {
    const r = a as Record<string, any>;
    if (r.$undefined === true) return undefined;
    if (r.$call) return (mod[r.$call.fn] as (...x: unknown[]) => unknown)(...(r.$call.args ?? []).map(resolveArg));
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, resolveArg(v)]));
  }
  return a;
}
function run(c: Case): Outcome {
  try { return { value: (mod[c.fn] as (...x: unknown[]) => unknown)(...c.args.map(resolveArg)) }; }
  catch (e) { const err = e as Error; return { error: { name: err.name, message: err.message } }; }
}
/** Sorted keys, two-space indent, LF, trailing newline: the same bytes on every machine. */
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(sort(v), null, 2) + "\n";
}

const constants = Object.fromEntries(Object.keys(mod).filter((k) => typeof mod[k] !== "function").sort().map((k) => [k, mod[k]]));
const out = canonical({ version: 1, functions: fns, skipped: [...skip].sort(), constants, cases: Object.fromEntries(cases.map((c) => [c.id, run(c)])) });
const golden = resolve(o.golden!);

if (o.mode === "record") {
  if (existsSync(golden) && !o.force) fail(`${golden} exists; pass --force to overwrite`);
  writeFileSync(golden, out);
  process.stdout.write(`golden: recorded ${cases.length} cases, ${Object.keys(constants).length} constants -> ${golden}\n`);
} else {
  if (!existsSync(golden)) fail(`${golden} not found; record it first`);
  const want = readFileSync(golden, "utf8").replace(/\r\n/g, "\n");
  if (want === out) { process.stdout.write(`golden: identical (${cases.length} cases, ${Object.keys(constants).length} constants)\n`); process.exit(0); }
  const a = JSON.parse(want), b = JSON.parse(out);
  const diffs = [
    ...["version", "functions", "skipped", "constants"].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])),
    ...[...new Set([...Object.keys(a.cases), ...Object.keys(b.cases)])].filter((k) => JSON.stringify(a.cases[k]) !== JSON.stringify(b.cases[k])).map((k) => `case ${k}`),
  ];
  fail(`differs from ${golden}: ${diffs.join(", ") || "formatting only"}`, 1);
}
