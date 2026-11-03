/**
 * Golden master for the analyst's HTTP routes: what a caller sees must not change while the internals are
 * restructured (decoupling Phases 2-3). Black box: generates seeded synthetic folders, starts src/main.ts on a free
 * port with a temporary data config, calls every route (including refusals), normalizes the values that change on
 * every run, and records or compares canonical JSON.
 *
 *   node scripts/golden-routes.ts --mode check                  (exit 0 identical, 1 different, 2 usage or setup)
 *   node scripts/golden-routes.ts --mode record [--force]
 *
 * Flags (defaults in brackets):
 *   --mode record|check
 *   --golden <path>           [test/golden/routes.golden.json]
 *   --analyst <path>          analyst entry point to start [src/main.ts]
 *   --pm-seed N               make-fixtures.ts seed [42]
 *   --production-rows N       make-fixtures.ts --production-rows [1500]
 *   --months N                make-fixtures.ts --months [6]
 *   --fin-seed N              make-finance-fixtures.ts seed [7]
 *   --fin-max-rows N          make-finance-fixtures.ts --max-rows [400]
 *   --timeout-ms N            start-up and per-request limit [60000]
 *   --keep-dir                keep the temporary folder (printed) for inspection
 *   --force                   let record overwrite an existing golden file
 *
 * Normalized: runId -> <RUN_n>, folderId -> <FOLDER_n>, the port -> <PORT>, the temporary root -> <ROOT> (and "\" -> "/" in those paths),
 * and the values of keys ranAt, lastRanAt, modified, ms, confirmedAt -> "<volatile>". Everything else is compared as returned.
 * Synthetic data only.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = fileURLToPath(new URL("..", import.meta.url));
const { values: o } = parseArgs({
  options: {
    mode: { type: "string" },
    golden: { type: "string", default: join(here, "test", "golden", "routes.golden.json") },
    analyst: { type: "string", default: join(here, "src", "main.ts") },
    "pm-seed": { type: "string", default: "42" },
    "production-rows": { type: "string", default: "1500" },
    months: { type: "string", default: "6" },
    "fin-seed": { type: "string", default: "7" },
    "fin-max-rows": { type: "string", default: "400" },
    "timeout-ms": { type: "string", default: "60000" },
    "keep-dir": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});
const fail = (msg: string, code = 2): never => { process.stderr.write(`golden-routes: ${msg}\n`); process.exit(code); };
if (o.mode !== "record" && o.mode !== "check") fail("--mode must be record or check");
const timeoutMs = Number(o["timeout-ms"]);
if (!(timeoutMs > 0)) fail("--timeout-ms must be a positive number");

// ---- synthetic folders --------------------------------------------------------------------------------------
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "analyst-golden-")));
const pm = join(root, "pm"), fin = join(root, "fin"), outside = realpathSync.native(mkdtempSync(join(tmpdir(), "analyst-golden-out-")));
const node = (script: string, args: string[]) => execFileSync(process.execPath, [join(here, "scripts", script), ...args], { stdio: "pipe" });
node("make-fixtures.ts", ["--out", pm, "--production-rows", o["production-rows"]!, "--months", o.months!, "--seed", o["pm-seed"]!]);
node("make-finance-fixtures.ts", ["--kind", "smb", "--out", fin, "--seed", o["fin-seed"]!, "--max-rows", o["fin-max-rows"]!]);
const cfgPath = join(root, "_golden-data-sources.json");
mkdirSync(join(root, "_analyst"), { recursive: true });
writeFileSync(cfgPath, JSON.stringify({ allowedRoots: [root], exclude: [], hideFolders: ["_*"] }));

// ---- start the analyst --------------------------------------------------------------------------------------
const port: number = await new Promise((ok, no) => { const s = createServer(); s.on("error", no); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
let log = "";
const child: ChildProcess = spawn(process.execPath, [resolve(o.analyst!), "--port", String(port), "--data-config", cfgPath, "--work-dir", join(root, "_analyst")], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
const cleanup = () => { child.kill(); if (!o["keep-dir"]) { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); } else process.stderr.write(`golden-routes: kept ${root}\n`); };

type Reply = { status: number; body: unknown };
/** node:http, not fetch: fetch drops a caller-set Host header, and the analyst's Host check must be exercised. */
function call(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((ok, no) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, timeout: timeoutMs,
      headers: { host: `127.0.0.1:${port}`, ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { text += d; });
      res.on("end", () => { let parsed: unknown; try { parsed = JSON.parse(text); } catch { parsed = { nonJson: text }; } ok({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms: ${method} ${path}`)));
    req.on("error", no);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const deadline = Date.now() + timeoutMs;
for (;;) {
  try { if ((await call("GET", "/healthz")).status === 200) break; } catch { /* not up yet */ }
  if (child.exitCode !== null || Date.now() > deadline) { cleanup(); fail(`the analyst did not start:\n${log}`); }
  await new Promise((r) => setTimeout(r, 200));
}

// ---- the calls: every route, success and refusal --------------------------------------------------------------
const steps: [string, Reply][] = [];
const step = async (name: string, p: Promise<Reply>) => { const r = await p; steps.push([name, r]); return r; };
try {
  await step("healthz", call("GET", "/healthz"));
  await step("refused.wrong-host", call("GET", "/healthz", undefined, { host: "example.com" }));
  await step("refused.get-on-post-route", call("GET", "/profile"));
  await step("refused.not-json", call("POST", "/profile", "folder=x", { "content-type": "text/plain" }));
  await step("refused.outside-roots", call("POST", "/profile", { folder: outside }));
  await step("refused.relative-folder", call("POST", "/profile", { folder: "pm" }));
  await step("refused.unknown-route", call("POST", "/nope", {}));
  for (const [label, folder] of [["pm", pm], ["fin", fin]] as const) {
    await step(`${label}.status.before`, call("POST", "/status", { folder }));
    await step(`${label}.analyze.no-recipe`, call("POST", "/analyze", { folder }));
    const prof = await step(`${label}.profile`, call("POST", "/profile", { folder }));
    const proposal = (prof.body as { proposal?: unknown }).proposal;
    await step(`${label}.recipe`, call("POST", "/recipe", { folder, recipe: proposal }));
    const an = await step(`${label}.analyze`, call("POST", "/analyze", { folder }));
    const runId = (an.body as { runId?: string }).runId;
    await step(`${label}.status.after`, call("POST", "/status", { folder }));
    const ev = await step(`${label}.evidence.default`, call("POST", "/evidence", { runId }));
    await step(`${label}.evidence.budget-4000`, call("POST", "/evidence", { runId, budget: 4000 }));
    await step(`${label}.evidence.budget-too-small`, call("POST", "/evidence", { runId, budget: 50 }));
    const evidence = String((ev.body as { text?: string }).text ?? "");
    const firstNumber = evidence.match(/\d{1,3}(?:,\d{3})+\.\d{2}/)?.[0] ?? "0.00";
    await step(`${label}.verify`, call("POST", "/verify", { runId, evidence, answer: `The largest figure is ${firstNumber}; another is 98,765.43 in 2026.` }));
    await step(`${label}.verify.not-strings`, call("POST", "/verify", { runId, evidence: 1, answer: 2 }));
    const rel = await step(`${label}.relations`, call("POST", "/relations", { folder }));
    const tables = ((rel.body as { tables?: { table?: string; name?: string }[] }).tables ?? []).map((t) => t.table ?? t.name).filter((t): t is string => typeof t === "string");
    for (const t of tables) await step(`${label}.sql.count.${t}`, call("POST", "/sql", { folder, sql: `SELECT COUNT(*) AS n FROM ${t}` }));
    await step(`${label}.sql.refused`, call("POST", "/sql", { folder, sql: `DELETE FROM ${tables[0] ?? "x"}` }));
  }
  await step("verify.unknown-run", call("POST", "/verify", { runId: "nope", answer: "1", evidence: "1" }));
  await step("evidence.unknown-run", call("POST", "/evidence", { runId: "nope" }));
} catch (e) { cleanup(); fail(`a call failed: ${(e as Error).message}\n${log}`); }
cleanup();

// ---- normalize and compare -----------------------------------------------------------------------------------
const tokens = new Map<string, string>();
const VOLATILE = new Set(["ranAt", "lastRanAt", "modified", "ms", "confirmedAt"]);
const roots = [root, outside].flatMap((r) => [r, r.toLowerCase()]);
function token(kind: string, v: string): string { if (!tokens.has(v)) tokens.set(v, `<${kind}_${[...tokens.values()].filter((t) => t.startsWith(`<${kind}_`)).length + 1}>`); return tokens.get(v)!; }
function norm(v: unknown, key?: string): unknown {
  if (key && VOLATILE.has(key)) return "<volatile>";
  if (key === "runId" || key === "lastRunId") return typeof v === "string" && v !== "nope" ? token("RUN", v) : v;
  if (key === "folderId" && typeof v === "string") return token("FOLDER", v);
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k], k)]));
  if (typeof v === "string") {
    let s = v.split(`127.0.0.1:${port}`).join("127.0.0.1:<PORT>").split(`localhost:${port}`).join("localhost:<PORT>");
    for (const [raw, t] of tokens) if (s.includes(raw)) s = s.split(raw).join(t);
    let hit = false;
    for (const r of roots) if (s.includes(r)) { s = s.split(r).join(r.startsWith(outside) || r.startsWith(outside.toLowerCase()) ? "<OUTSIDE>" : "<ROOT>"); hit = true; }
    return hit ? s.replace(/\\/g, "/") : s;
  }
  return v;
}
// First pass registers run and folder ids in call order, so their tokens are stable; second pass replaces them inside text too.
norm(steps.map(([, r]) => r.body));
const out = JSON.stringify({ version: 1, inputs: { pmSeed: o["pm-seed"], productionRows: o["production-rows"], months: o.months, finSeed: o["fin-seed"], finMaxRows: o["fin-max-rows"] },
  steps: steps.map(([name, r]) => ({ name, status: r.status, body: norm(r.body) })) }, null, 2) + "\n";
const golden = resolve(o.golden!);
if (o.mode === "record") {
  if (existsSync(golden) && !o.force) fail(`${golden} exists; pass --force to overwrite`);
  writeFileSync(golden, out);
  process.stdout.write(`golden-routes: recorded ${steps.length} calls -> ${golden}\n`);
} else {
  if (!existsSync(golden)) fail(`${golden} not found; record it first`);
  const want = readFileSync(golden, "utf8").replace(/\r\n/g, "\n");
  if (want === out) { process.stdout.write(`golden-routes: identical (${steps.length} calls)\n`); process.exit(0); }
  const a = JSON.parse(want), b = JSON.parse(out);
  const names = [...new Set([...a.steps.map((s: { name: string }) => s.name), ...b.steps.map((s: { name: string }) => s.name)])];
  const diff = names.filter((n) => JSON.stringify(a.steps.find((s: { name: string }) => s.name === n)) !== JSON.stringify(b.steps.find((s: { name: string }) => s.name === n)));
  if (JSON.stringify(a.inputs) !== JSON.stringify(b.inputs)) diff.unshift("inputs");
  fail(`differs from ${golden}: ${diff.join(", ") || "formatting only"}`, 1);
}
