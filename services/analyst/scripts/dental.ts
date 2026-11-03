/**
 * dental.ts: one short entry point for the dental test data (Phase 4c), so nobody types a full path. It only resolves where the
 * data lives and then runs the existing, tested scripts (make-dental-fixtures.ts, reconcile-check.ts, reconcile-explain.ts) with
 * an absolute path; it has no reconciliation logic of its own. From the repo root:
 *
 *   npm run dental -- sets    [--set SET-2] [--scenarios all|pos,neg-all,...] [--seed N] [--leak-seed N]
 *   npm run dental -- gen     --set SET-2/TRY-1 [generator flags, e.g. --scenario neg-eft-missing --seed 7]
 *   npm run dental -- check   --set SET-2/NEG-ALL [reconcile-check flags, e.g. --json]
 *   npm run dental -- explain --set SET-2/NEG-ALL [reconcile-explain flags, e.g. --question "..."]
 *   npm run dental -- query   --set SET-2/NEG-ALL [--id leak-summary,top-leaks | all] [--kind sql|model|all] [--list]
 *                             [--sql "SELECT ..."] [--with-ask] [--model local/deepseek-r1-8b] [--format table|csv|json]
 *                             [--max-rows 50] [--bank <queries.json>]
 *   --kind model runs every model question in the bank (with --model for all of them) and ends with how many verified.
 *   Model questions (Phase 4c fact sheets): DuckDB classifies, totals, ranks and attaches an action to every exception; each
 *   question gets only the fact sections it names ("facts" in the bank: totals, groups, losses, extra, timing, posting, payers,
 *   card, branch, eft, all), tagged [T#]/[G#]/[F#]; the model rewords them through the gateway (no analyst server); src/facts.ts
 *   checks every figure and payment ID against the fact it cites, the loss wording and that every fact is mentioned. A failed
 *   check shows the computed facts instead. A "cooling_down" refusal (the gateway benches a model after failures, 30 s by default)
 *   is waited out once (--cooldown-wait-sec 35; 0 = do not wait). Extra flags: [--max-tokens N] [--timeout-sec 600] [--show-facts] [--facts-only: print each
 *   question's fact sheet, call no model] [--scan: send each question's model input to the gateway's /v1/privacy/scan and report
 *   what it would mask; call no model. Anything masked reaches the model as a placeholder, so a clean sheet scans as 0].
 *
 *   npm run dental -- status                     containers, gateway, analysts, key file
 *   npm run dental -- up                         start the containers the explanations need and wait for the gateway
 *   npm run dental -- probe "text" ["text" ...]  what the gateway's privacy scan would mask in each text (no model is called)
 * Stack flags (status, up, explain, query): [--containers ca-presidio,ca-openrouter-stub,ca-gateway] [--gateway http://127.0.0.1:8720]
 *   [--wait-sec 180] [--analyst-port 8741] [--no-docker]. explain and model queries start the containers when the gateway is
 *   down (unless --no-docker), then run their own analyst on --analyst-port with a generated data config that allows only the
 *   data root, and stop it when done; the test console's analyst (8740) and config/data-sources.json are never touched.
 *
 * query: reconciles the folder once (same engine as check), then answers queries from the bank
 * (config/domain-packs/finance/rcm/dental/queries.json, or --bank): "sql" entries exactly, by code, with the analyst's
 * read-only runner (one SELECT, row limit, timeout, file access locked); "question" entries through reconcile-explain (model,
 * every figure checked) only when named in --id or with --with-ask. --sql runs one ad-hoc SELECT. --list prints the bank.
 *
 * Where: --set <SET[/SCENARIO]> is a folder under the data root; --data-root <dir> (default: env DENTAL_DATA_ROOT, else
 * <repo>/data/pms/dent-pms-c-sample); --folder <dir> instead of --set, relative to the folder you ran npm from. Any other
 * flag is passed on to the script unchanged. "sets" generates every scenario into <SET>/<SCENARIO> (upper case, like the tests
 * expect) and checks each against its answer key; exit 0 only when all pass. Exit 2 = bad flags.
 */
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { gatewayChat } from "../../../packages/crossask/src/index.ts";
import { type Category, type ExceptionFact, type Fact, FACT_SYSTEM, type FactSheet, plainFacts, renderSheet, verifyFactAnswer } from "../src/facts.ts";
import { PackRegistry, SourceRegistry } from "../src/core/registry.ts";
import { type Db, ident, literal, openDb } from "../src/db.ts";
import { BUILT_IN_PACKS } from "../src/domain-packs/index.ts";
import { readReconcileConfig } from "../src/engines/deposit-match.ts";
import { type ReconcileReport, reconcileFolder } from "../src/reconcile.ts";
import { BUILT_IN_SOURCES } from "../src/sources/index.ts";
import { checkSelect, runSelect } from "../src/sqlrun.ts";
import { SCENARIOS } from "../src/synth/dental-gen.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const usage = (m: string): never => { process.stderr.write(`dental: ${m}\n(see the header of services/analyst/scripts/dental.ts)\n`); process.exit(2); };

const [cmd, ...argv] = process.argv.slice(2);
if (!cmd || !["sets", "gen", "check", "explain", "query", "status", "up", "probe"].includes(cmd)) usage("first argument must be sets, gen, check, explain, query, status, up or probe");
const STACK = ["explain", "query", "status", "up", "probe"].includes(cmd);
const own = new Set(["--set", "--folder", "--data-root", ...(cmd === "sets" ? ["--scenarios", "--seed", "--leak-seed"] : []),
  ...(cmd === "query" ? ["--id", "--sql", "--format", "--max-rows", "--bank", "--kind", "--model", "--max-tokens", "--timeout-sec", "--cooldown-wait-sec"] : []),
  ...(STACK ? ["--containers", "--gateway", "--wait-sec", "--analyst-port"] : [])]);
const ownBool = new Set([...(cmd === "query" ? ["--list", "--with-ask", "--show-facts", "--facts-only", "--scan"] : []), ...(STACK ? ["--no-docker"] : [])]);
const opt: Record<string, string> = {}; const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]; const [k, v] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
  if (ownBool.has(k)) { opt[k.slice(2)] = "true"; continue; }
  if (own.has(k)) { const val = v ?? argv[++i]; if (val === undefined || val.startsWith("--")) usage(`${k} needs a value`); opt[k.slice(2)] = val!; }
  else rest.push(a);
}
// npm runs scripts from the repo root; INIT_CWD is the folder the person ran npm from, so a relative --folder means what they typed.
const base = process.env.INIT_CWD ?? process.cwd();
const env = opt["data-root"] ?? process.env.DENTAL_DATA_ROOT?.trim();
const dataRoot = env ? (isAbsolute(env) ? env : resolve(base, env)) : join(REPO, "data", "pms", "dent-pms-c-sample");
const where = (): string => {
  if (opt.set && opt.folder) usage("give --set or --folder, not both");
  if (opt.folder) return resolve(base, opt.folder);
  if (!opt.set) usage("--set <SET/SCENARIO> (or --folder <dir>) is required");
  if (isAbsolute(opt.set) || opt.set.split(/[\\/]/).includes("..")) usage("--set is a name under the data root (e.g. SET-2/NEG-ALL), not a path");
  return join(dataRoot, ...opt.set.split(/[\\/]/));
};
const run = (script: string, args: string[], quiet = false): number => {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" });
  if (quiet && r.status !== 0) process.stderr.write(r.stderr || r.stdout || "");
  return r.status ?? 1;
};

const CONTAINERS = (opt.containers ?? "ca-presidio,ca-openrouter-stub,ca-gateway").split(",").map((x) => x.trim()).filter(Boolean);
const GATEWAY = (opt.gateway ?? "http://127.0.0.1:8720").replace(/\/+$/, "");
const WAIT_SEC = Number(opt["wait-sec"] ?? 180);
const ANALYST_PORT = Number(opt["analyst-port"] ?? 8741);
if (STACK && (!Number.isInteger(WAIT_SEC) || WAIT_SEC < 0)) usage("--wait-sec must be a whole number of seconds");
if (STACK && (!Number.isInteger(ANALYST_PORT) || ANALYST_PORT < 1024 || ANALYST_PORT > 65535)) usage("--analyst-port must be 1024-65535");
const KEY_FILE = join(REPO, "test-console", "local-gateway-key.txt");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SECTIONS = ["totals", "groups", "losses", "extra", "timing", "posting", "payers", "card", "branch", "eft", "all"];
const CATEGORY_SQL = `CASE WHEN severity = 'watch' THEN 'timing' WHEN direction = 'negative' THEN 'loss' WHEN direction = 'positive' THEN 'extra' ELSE 'posting' END`;
const RANK_SQL = `CASE category WHEN 'loss' THEN 0 WHEN 'extra' THEN 1 WHEN 'timing' THEN 2 ELSE 3 END`;
const WHERE: Record<string, string> = { losses: "category = 'loss'", extra: "category = 'extra'", timing: "category = 'timing'", posting: "category = 'posting'",
  payers: "payer IS NOT NULL AND category IN ('loss', 'extra')", card: "grp = 'card_processor'", branch: "grp = 'branch_atm_deposit'", eft: "grp = 'insurance_eft'", all: "TRUE" };

if (cmd === "gen") process.exit(run("make-dental-fixtures.ts", ["--out", where(), ...rest]));
if (cmd === "check") process.exit(run("reconcile-check.ts", ["--folder", where(), ...rest]));
if (cmd === "explain") { const folder = where(); process.exit(await withModelStack((an) => run("reconcile-explain.ts", ["--folder", folder, "--analyst", an, "--gateway", GATEWAY, ...rest]))); }
if (cmd === "status") process.exit(await status());
if (cmd === "probe") process.exit(await probe(rest));
if (cmd === "up") { if (rest.length) usage(`up does not take ${rest.join(" ")}`); const ok = await ensureGateway(); await status(); process.exit(ok ? 0 : 1); }

if (cmd === "query") process.exit(await query());

// sets: generate every scenario, then check each one
if (opt.folder) usage("sets takes --set <SET> (a set name), not --folder");
const set = opt.set ?? "SET-2";
if (set.includes("/") || set.includes("\\")) usage("sets takes a set name (e.g. SET-2), not SET/SCENARIO");
const want = !opt.scenarios || opt.scenarios === "all" ? SCENARIOS : opt.scenarios.split(",").map((s) => s.trim()).filter(Boolean);
for (const s of want) if (!SCENARIOS.includes(s)) usage(`unknown scenario ${s} (known: ${SCENARIOS.join(", ")})`);
let failed = 0;
for (const s of want) {
  const dir = join(dataRoot, set, s.toUpperCase());
  const gen = ["--out", dir, "--scenario", s, ...(opt.seed ? ["--seed", opt.seed] : []), ...(opt["leak-seed"] ? ["--leak-seed", opt["leak-seed"]] : []), ...rest];
  if (run("make-dental-fixtures.ts", gen, true) !== 0) { failed++; process.stdout.write(`${s.padEnd(22)} GENERATION FAILED\n`); continue; }
  const r = spawnSync(process.execPath, [join(HERE, "reconcile-check.ts"), "--folder", dir], { encoding: "utf8" });
  const line = (r.stdout.split(/\r?\n/).find((l) => l.startsWith("reconcile-check:")) ?? r.stderr.trim().split(/\r?\n/).pop() ?? "").replace(/^reconcile-check: /, "");
  if (r.status !== 0) failed++;
  process.stdout.write(`${s.padEnd(22)} ${line}\n`);
}
process.stdout.write(`dental sets: ${want.length - failed}/${want.length} scenarios pass (${join(dataRoot, set)})\n`);
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------- query
type Entry = { id: string; title: string; sql?: string; question?: string; facts?: string[] };
async function query(): Promise<number> {
  if (rest.length) usage(`query does not take ${rest.join(" ")}`);
  const bankPath = opt.bank ? resolve(base, opt.bank) : join(REPO, "config", "domain-packs", "finance", "rcm", "dental", "queries.json");
  const bank = JSON.parse(readFileSync(bankPath, "utf8")) as { version: number; queries: Entry[] };
  if (bank.version !== 1 || !Array.isArray(bank.queries)) usage(`${bankPath}: version must be 1 with a queries list`);
  const seen = new Set<string>();
  for (const q of bank.queries) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(q.id ?? "") || seen.has(q.id) || !q.title || (!q.sql === !q.question)) usage(`${bankPath}: entry ${q.id}: needs a unique lowercase id, a title, and exactly one of sql / question`);
    if (q.question && (!Array.isArray(q.facts) || !q.facts.length || q.facts.some((x) => !SECTIONS.includes(x)))) usage(`${bankPath}: entry ${q.id}: a question needs "facts", a list of ${SECTIONS.join(", ")}`);
    seen.add(q.id);
  }
  if (opt.list) { for (const q of bank.queries) process.stdout.write(`${q.id.padEnd(28)} ${q.sql ? "sql  " : "model"} ${q.title}\n`); return 0; }
  const format = opt.format ?? "table"; if (!["table", "csv", "json"].includes(format)) usage("--format is table, csv or json");
  const maxRows = Number(opt["max-rows"] ?? 50); if (!Number.isInteger(maxRows) || maxRows < 1) usage("--max-rows must be a positive integer");
  let picked: Entry[];
  const kind = opt.kind ?? (opt["with-ask"] ? "all" : "sql"); if (!["sql", "model", "all"].includes(kind)) usage("--kind is sql, model or all");
  if (opt.sql) picked = [{ id: "ad-hoc", title: "your query", sql: opt.sql }];
  else if (!opt.id || opt.id === "all") picked = bank.queries.filter((q) => kind === "all" || (kind === "sql" ? q.sql : q.question));
  else picked = opt.id.split(",").map((x) => x.trim()).filter(Boolean).map((id) => bank.queries.find((q) => q.id === id) ?? usage(`no query ${id} in the bank (--list shows them)`));
  for (const q of picked) if (q.sql) checkSelect(q.sql);
  const folder = where();
  const sqlQs = picked.filter((q) => q.sql), askQs = picked.filter((q) => q.question);
  const out: { id: string; title: string; columns?: string[]; rows?: Record<string, unknown>[]; truncated?: boolean; skipped?: string; error?: string }[] = [];
  let failures = 0;
  const sheets = new Map<string, FactSheet>();
  if (sqlQs.length || askQs.length) {
    const sources = new SourceRegistry(); for (const a of BUILT_IN_SOURCES) sources.register(a);
    const packs = new PackRegistry(); for (const p of BUILT_IN_PACKS) packs.register(p);
    const pack = packs.resolve("finance/rcm/dental"); const configRoot = join(REPO, "config");
    const { cfg } = readReconcileConfig(join(configRoot, pack.reconcile!), configRoot);
    const actions = ((cfg as unknown as { actions?: Record<string, string> }).actions) ?? {};
    const { readdirSync, statSync } = await import("node:fs");
    const files = readdirSync(folder).filter((n) => /\.(csv|tsv)$/i.test(n) && statSync(join(folder, n)).isFile()).sort().map((n) => ({ name: n, path: join(folder, n) }));
    await reconcileFolder({ files, sources, pack, configRoot, sourceOptions: { patientNameFormat: "last_first" }, toleranceCents: null, open: openDb,
      inspect: async (db, tables, report) => {
        await buildTables(db, tables, report, cfg.evidence?.directions ?? {});
        for (const q of askQs) sheets.set(q.id, await factSheet(db, q.facts!, actions));
        for (const q of sqlQs) {
          try { const r = await runSelect(db, q.sql!, { maxRows, timeoutMs: 15000 }); out.push({ id: q.id, title: q.title, columns: r.columns, rows: r.rows, truncated: r.truncated }); }
          catch (e) {
            const m = (e as Error).message; const miss = /Table with name (\w+) does not exist/i.exec(m);
            if (miss) out.push({ id: q.id, title: q.title, skipped: `no ${miss[1]} file in this folder` });
            else { failures++; out.push({ id: q.id, title: q.title, error: m.split("\n")[0] }); }
          }
        }
      } });
  }
  if (format === "json") process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  else for (const r of out) {
    process.stdout.write(`\n== ${r.id}: ${r.title}\n`);
    if (r.skipped) { process.stdout.write(`(skipped: ${r.skipped})\n`); continue; }
    if (r.error) { process.stdout.write(`ERROR: ${r.error}\n`); continue; }
    process.stdout.write(format === "csv" ? toCsv(r.columns!, r.rows!) : toTable(r.columns!, r.rows!));
    if (r.truncated) process.stdout.write(`(first ${maxRows} rows; --max-rows for more)\n`);
  }
  if (askQs.length) failures += await askWithFacts(askQs, sheets);
  return failures ? 1 : 0;
}

/** The report as tables (amounts in cents and as dollars), and the loaded sources under short names. */
async function buildTables(db: Db, tables: Readonly<Record<string, string>>, rep: ReconcileReport, dirs: Record<string, string>): Promise<void> {
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
  const short: Record<string, string> = { "bank/bofa": "bank", "pms/curve-hero/deposit-detail": "deposit", "pms/curve-hero/ledger": "ledger", "pms/curve-hero/patient-list": "patients",
    "pms/curve-hero/procedures": "procedures", "financing/carecredit": "carecredit", "financing/cherry": "cherry", "financing/hfd": "hfd" };
  for (const [id, t] of Object.entries(tables)) if (short[id]) await db.conn.run(`CREATE VIEW ${ident(short[id])} AS SELECT * FROM ${ident(t)}`);
}

function cell(x: unknown): string { return x === null || x === undefined ? "" : typeof x === "object" ? JSON.stringify(x) : String(x); }
function toTable(cols: string[], rows: Record<string, unknown>[]): string {
  if (!rows.length) return "(no rows)\n";
  const w = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const fit = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "~" : s.padEnd(n));
  return [cols.map((c, i) => fit(c, w[i])).join("  "), w.map((n) => "-".repeat(n)).join("  "), ...rows.map((r) => cols.map((c, i) => fit(cell(r[c]), w[i])).join("  "))].join("\n") + "\n";
}
function toCsv(cols: string[], rows: Record<string, unknown>[]): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [cols.map(q).join(","), ...rows.map((r) => cols.map((c) => q(cell(r[c]))).join(","))].join("\n") + "\n";
}

// ---------------------------------------------------------------- stack: containers, gateway, a temporary analyst

async function healthy(url: string): Promise<boolean> {
  try { const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}
function docker(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.error) return { ok: false, out: `docker not found or not runnable (${(r.error as Error).message})` };
  return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() };
}
async function ensureGateway(): Promise<boolean> {
  if (await healthy(GATEWAY)) return true;
  if (opt["no-docker"]) { process.stderr.write(`dental: the gateway at ${GATEWAY} is not answering (--no-docker: nothing started)\n`); return false; }
  process.stdout.write(`dental: starting ${CONTAINERS.join(", ")} ...\n`);
  const d = docker(["start", ...CONTAINERS]);
  if (!d.ok) { process.stderr.write(`dental: docker could not start the containers. Is Docker Desktop running?\n${d.out}\n`); return false; }
  process.stdout.write(`dental: waiting up to ${WAIT_SEC}s for ${GATEWAY}/healthz (Presidio can take a minute after Docker starts) `);
  for (const end = Date.now() + WAIT_SEC * 1000; Date.now() < end; await sleep(2000)) {
    if (await healthy(GATEWAY)) { process.stdout.write("ready\n"); return true; }
    process.stdout.write(".");
  }
  process.stdout.write("\n"); process.stderr.write(`dental: the gateway did not answer within ${WAIT_SEC}s; check 'docker logs ca-gateway'\n`);
  return false;
}
/** Starts the gateway when needed and a temporary analyst confined to the data root, runs fn, stops the analyst. */
async function withModelStack(fn: (analystUrl: string) => number | Promise<number>): Promise<number> {
  if (!(await ensureGateway())) return 1;
  const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  if (!existsSync(KEY_FILE)) { process.stderr.write(`dental: no gateway key file at ${KEY_FILE}\n`); return 1; }
  const url = `http://127.0.0.1:${ANALYST_PORT}`;
  if (await healthy(url)) { process.stderr.write(`dental: port ${ANALYST_PORT} is already in use by an analyst; stop it or pass --analyst-port\n`); return 1; }
  const tmp = mkdtempSync(join(tmpdir(), "dental-analyst-"));
  const cfgPath = join(tmp, "data-sources.json");
  writeFileSync(cfgPath, JSON.stringify({ notes: "generated by scripts/dental.ts for one run; deleted afterwards", allowedRoots: [dataRoot],
    extensions: [".csv", ".tsv", ".json"], maxBytes: { "*": 20000000 }, exclude: ["~$*", ".*"], hideFolders: ["_*"], maxFiles: 500 }, null, 2));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [join(HERE, "..", "src", "main.ts"), "--port", String(ANALYST_PORT), "--data-config", cfgPath, "--work-dir", join(tmp, "work")],
    { stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (b) => { log += b; }); child.stderr.on("data", (b) => { log += b; });
  try {
    for (const end = Date.now() + 30000; !(await healthy(url)); await sleep(500)) {
      if (child.exitCode !== null || Date.now() > end) { process.stderr.write(`dental: the analyst did not start on ${url}\n${log.slice(-2000)}\n`); return 1; }
    }
    return await fn(url);
  } finally {
    child.kill(); rmSync(tmp, { recursive: true, force: true });
  }
}
async function status(): Promise<number> {
  const line = (k: string, v: string) => process.stdout.write(`${k.padEnd(26)} ${v}\n`);
  for (const c of CONTAINERS) { const d = docker(["inspect", "-f", "{{.State.Status}}", c]); line(`container ${c}`, d.ok ? d.out : "not found / docker unavailable"); }
  line(`gateway ${GATEWAY}`, (await healthy(GATEWAY)) ? "healthy" : "not answering");
  line("analyst :8740 (console)", (await healthy("http://127.0.0.1:8740")) ? "running" : "not running");
  line(`analyst :${ANALYST_PORT} (dental)`, (await healthy(`http://127.0.0.1:${ANALYST_PORT}`)) ? "running" : "not running (started on demand)");
  const { existsSync } = await import("node:fs");
  line("gateway key file", existsSync(KEY_FILE) ? "present" : `missing (${KEY_FILE})`);
  if (existsSync(KEY_FILE) && (await healthy(GATEWAY))) {
    // the names --model accepts: a name the gateway does not list is not refused by it, it silently picks its own model
    try {
      const key = readFileSync(KEY_FILE, "utf8").trim();
      const r = await fetch(`${GATEWAY}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
      const ids = r.ok ? ((await r.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [] : [];
      line("gateway models (--model)", ids.length ? ids.join(", ") : `could not list (HTTP ${r.status})`);
    } catch (e) { line("gateway models (--model)", `could not list (${(e as Error).message})`); }
  }
  line("data root", dataRoot);
  return 0;
}

// ---------------------------------------------------------------- fact sheets (DuckDB) and model questions

/** One question's facts, computed by DuckDB from the reconciliation tables: classified, signed, totalled, ranked, with actions. */
async function factSheet(db: Db, sections: string[], actions: Record<string, string>): Promise<FactSheet> {
  const { rows } = await import("../src/db.ts");
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

async function askWithFacts(qs: Entry[], sheets: Map<string, FactSheet>): Promise<number> {
  if (opt["facts-only"]) {
    for (const q of qs) { const sh = sheets.get(q.id)!; process.stdout.write(`\n== ${q.id}: ${q.title}\nQUESTION  ${q.question}\n${sh.text}\n(${sh.text.length} chars)\n`); }
    return 0;
  }
  if (!(await ensureGateway())) return qs.length;
  const { existsSync } = await import("node:fs");
  if (!existsSync(KEY_FILE)) { process.stderr.write(`dental: no gateway key file at ${KEY_FILE}\n`); return qs.length; }
  if (opt.scan) {
    const key = readFileSync(KEY_FILE, "utf8").trim(); let dirty = 0;
    for (const q of qs) {
      const text = `${q.question}\n\n${sheets.get(q.id)!.text}`;
      // /v1/privacy/scan (no model is called) returns each entity it would mask with its offsets in OUR text (UTF-16, as the gateway
      // converts them), so the exact trigger is cut out locally. The sheet holds only generated codes, IDs, dates and amounts.
      const r = await fetch(`${GATEWAY}/v1/privacy/scan`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ text }), signal: AbortSignal.timeout(30000) });
      if (!r.ok) { process.stdout.write(`${q.id.padEnd(24)} scan failed: HTTP ${r.status}\n`); dirty++; continue; }
      const j = await r.json() as { dataClass?: string; counts?: Record<string, number>; entities?: { type: string; start: number; end: number; score: number }[] };
      const counts = Object.entries(j.counts ?? {}).filter(([, n]) => n > 0);
      if (counts.length) dirty++;
      process.stdout.write(`${q.id.padEnd(24)} ${text.length} chars, class ${j.dataClass ?? "?"}: ${counts.length ? counts.map(([k, n]) => `${k} x${n}`).join(", ") + " would be masked" : "nothing masked"}\n`);
      // An older gateway image returns counts without entities: then scan each line alone and report the lines that trip it.
      if (counts.length && !(j.entities ?? []).some((e) => e.type !== "HEALTH_TERM")) {
        for (const line of text.split("\n").filter((l) => /\d/.test(l))) {
          const lr = await fetch(`${GATEWAY}/v1/privacy/scan`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ text: line }), signal: AbortSignal.timeout(30000) });
          if (!lr.ok) continue;
          const lc = Object.entries(((await lr.json()) as { counts?: Record<string, number> }).counts ?? {}).filter(([, k]) => k > 0);
          if (lc.length) process.stdout.write(`    ${lc.map(([k, c]) => `${k} x${c}`).join(", ").padEnd(34)} in: ${line.length > 150 ? line.slice(0, 147) + "..." : line}\n`);
        }
      }
      for (const e of j.entities ?? []) {
        if (e.type === "HEALTH_TERM") continue; // classified only, never masked
        const lineStart = text.lastIndexOf("\n", e.start - 1) + 1, lineEnd = text.indexOf("\n", e.end);
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        process.stdout.write(`    ${e.type.padEnd(18)} "${text.slice(e.start, e.end)}" (score ${e.score.toFixed(2)})  in: ${line.length > 140 ? line.slice(0, 137) + "..." : line}\n`);
      }
    }
    process.stdout.write(`== privacy scan: ${qs.length - dirty}/${qs.length} model inputs reach the model unmasked\n`);
    return dirty;
  }
  const maxTokens = opt["max-tokens"] ? Number(opt["max-tokens"]) : undefined;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 64)) usage("--max-tokens must be a whole number >= 64");
  const timeoutSec = Number(opt["timeout-sec"] ?? 600); if (!Number.isInteger(timeoutSec) || timeoutSec < 10) usage("--timeout-sec must be a whole number >= 10");
  const chat = gatewayChat({ url: GATEWAY, key: readFileSync(KEY_FILE, "utf8").trim(), timeoutMs: timeoutSec * 1000, maxTokens });
  const coolWait = Number(opt["cooldown-wait-sec"] ?? 35); if (!Number.isInteger(coolWait) || coolWait < 0) usage("--cooldown-wait-sec must be a whole number >= 0");
  /** One model call; a cooling_down refusal is waited out once, so one failed question does not fail the rest. */
  const ask = async (messages: Parameters<typeof chat>[0]) => {
    try { return await chat(messages, model); }
    catch (e) {
      if (!coolWait || !/cooling_down/.test((e as Error).message)) throw e;
      process.stdout.write(`WAIT      the gateway benched ${model} after a failure (cooling_down); waiting ${coolWait}s, then one retry\n`);
      await sleep(coolWait * 1000);
      return chat(messages, model);
    }
  };
  const model = opt.model ?? "chainaim/auto";
  let failed = 0; const summary: string[] = [];
  for (const q of qs) {
    const sheet = sheets.get(q.id)!;
    process.stdout.write(`\n== ${q.id}: ${q.title}\nFACTS     ${sheet.facts.length} fact(s), ${sheet.text.length} chars (sections: ${q.facts!.join(", ")}; no names)\n`);
    if (opt["show-facts"]) process.stdout.write(`${sheet.text}\n`);
    const t0 = Date.now(); let verdict: string;
    try {
      const r = await ask([{ role: "system", content: FACT_SYSTEM }, { role: "user", content: `${q.question}\n\n${sheet.text}` }]);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const mismatch = model !== "chainaim/auto" && r.model !== undefined && r.model !== model;
      const check = verifyFactAnswer(r.text, sheet);
      process.stdout.write(`SERVED    ${r.model ?? "?"}${r.zone ? ` (zone ${r.zone})` : ""} in ${secs}s\n`);
      if (mismatch) process.stdout.write(`MODEL     asked for ${model} but the gateway served ${r.model} (not in its model list); not counted as ${model}'s answer\n`);
      if (check.ok && !mismatch) { process.stdout.write(`\nANSWER\n${r.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()}\n\nCHECK     ${check.checked} figure(s)/ID(s): every one matches the fact it cites; every fact mentioned\n`); verdict = `VERIFIED (${secs}s)`; }
      else {
        failed++; verdict = mismatch ? "WRONG MODEL" : `FAILED CHECK (${check.problems.length} problem(s), ${secs}s)`;
        process.stdout.write(`\nMODEL ANSWER (not shown as the answer: it failed the check)\n${r.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()}\n\nCHECK     NOT VERIFIED:\n${check.problems.map((p) => `  - ${p}`).join("\n")}\n\nANSWER (computed facts)\n${plainFacts(sheet)}\n`);
      }
    } catch (e) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1); failed++;
      verdict = `ERROR after ${secs}s: ${(e as Error).message.split("\n")[0]}`;
      process.stdout.write(`ERROR     after ${secs}s: ${(e as Error).message}\n\nANSWER (computed facts)\n${plainFacts(sheet)}\n`);
    }
    summary.push(`${q.id.padEnd(24)} ${verdict}`);
  }
  process.stdout.write(`\n== model answers: ${qs.length - failed}/${qs.length} verified (model ${model}); failed ones show the computed facts\n${summary.join("\n")}\n`);
  return failed;
}

/** Scans each text with the gateway's /v1/privacy/scan and prints what would be masked (type, the text, score). */
async function probe(texts: string[]): Promise<number> {
  if (!texts.length) usage('probe needs one or more texts, e.g. probe "amount -164.00" "amount -$164.00"');
  if (!(await ensureGateway())) return 1;
  const key = readFileSync(KEY_FILE, "utf8").trim();
  for (const text of texts) {
    const r = await fetch(`${GATEWAY}/v1/privacy/scan`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) { process.stdout.write(`HTTP ${r.status}  ${text}\n`); continue; }
    const j = await r.json() as { entities?: { type: string; start: number; end: number; score: number }[] };
    const hits = (j.entities ?? []).filter((e) => e.type !== "HEALTH_TERM");
    process.stdout.write(`${hits.length ? "MASKED " : "clean  "} ${JSON.stringify(text)}${hits.length ? "  ->  " + hits.map((e) => `${e.type} "${text.slice(e.start, e.end)}" ${e.score.toFixed(2)}`).join("; ") : ""}\n`);
  }
  return 0;
}
