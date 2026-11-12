/**
 * chainaim-analyst: exact cross-file analysis of a folder of CSV/TSV files, for the test console's
 * "03 Private chat + analysis" tab. Compute only: it never calls a model, holds no keys and listens on 127.0.0.1.
 *
 *   node src/main.ts [flags]
 *
 *   --port N                     default 8740
 *   --bind HOST                  listen address (default 127.0.0.1; 0.0.0.0 only inside a container, DOCKERIZE-PLAN A1)
 *   --allowed-hosts LIST         Host headers accepted, comma-separated host:port (default 127.0.0.1:<port>,localhost:<port>;
 *                                e.g. analyst:8740 for the console in Docker, DOCKERIZE-PLAN A2)
 *   --data-config PATH           allowed data folders, shared with the console (default ../../config/data-sources.json)
 *   --work-dir PATH              recipes and run manifests, no data (default <first allowedRoot>/_analyst)
 *   --period week|month|quarter  default month
 *   --baseline-periods N         periods before a variance run shown as its baseline (default 3)
 *   --variance-pct P             a period is "off" when |variance| is over P% ... (default 2)
 *   --variance-amount A          ... and over A (default 100)
 *   --date-window-days D         matching: dates within D days (default 3)
 *   --amount-tolerance T         matching: amounts within T (default 0.01)
 *   --match auto|one-to-one|many-to-one|none   default auto (both; matching counts only when at least 20% (by
 *                                reference) or 50% (by amount) of a file's rows match)
 *   --pair-mode auto|tie|ratio   tie: later stage should equal earlier; ratio: should keep a stable share;
 *                                auto: tie when the median |ratio - 1| is at most 10% (default auto)
 *   --aging-days N               unmatched rows older than N days at the last date of the later file (default 30)
 *   --evidence-max-chars N       hard ceiling for an evidence pack (default 16000)
 *   --evidence-rows-per-finding N  example rows per finding (default 3)
 *   --max-findings N             default 12
 *   --max-bytes N                largest file analyzed (default 500000000)
 *   --max-files N                most data files in one folder (default 20)
 *   --keep-findings              also write findings.json next to each manifest (holds real amounts and names)
 *   --runs-in-memory N           analyses and reconciliations kept for evidence/verify calls (default 10)
 *   --reconcile-trail-rows N     match-trail rows in a reconcile evidence pack (default: the pack's evidence.trailRows)
 *   --relation-min-overlap X     cross-file relations: least share of the smaller column's distinct values found in the
 *                                other column (default 0.5)
 *   --relation-min-shared N      ... and at least N shared distinct values (default 3)
 *   --relation-max-distinct N    distinct values compared per column at most (default 50000)
 *   --relation-max N             most relations returned, best first (default 40)
 *   --schema-code-values N       code columns (status, type, method, category, currency, ...) with at most N distinct
 *                                values list them in the schema text a model gets (default 12; 0 = never)
 *   --row-filters FILE|off       rows that are not data, dropped by header line before a model sees the tables (default
 *                                <config-root>/row-filters.json; off = keep every row). Checked at start-up.
 *   --sql-max-rows N             most rows a /sql query returns (default 200; truncated is then true)
 *   --sql-timeout-ms N           a /sql query is stopped after this long (default 15000)
 *   --erpnext-bundles on|off     a <borrower>.erpnext-data.json in a folder is read directly as one table per ERPNext
 *                                DocType and child list, the tables tools/erpnext-split writes as CSVs (default on;
 *                                off = loaded like any JSON file, one table). One bundle per folder; a bundle and a CSV
 *                                that would be the same table are refused (409). See src/erpnext-bundle.ts.
 *   --erpnext-suffix S           the file name ending that marks a bundle (default .erpnext-data.json)
 *   --erpnext-doctypes LIST|all  parent DocTypes kept, comma-separated (default: the splitter's: Customer, Supplier,
 *                                Item, Sales Order, Sales Invoice, Purchase Invoice, Payment Entry, Bank Transaction)
 *   --erpnext-include-drafts     also documents whose docstatus is not 1 (default: submitted only, as the splitter)
 *   --erpnext-children on|off    child lists (items, references, taxes, credit limits) become tables (default on)
 *   --erpnext-max-tables N       most tables one bundle may give (default 40)
 *
 * A folder's recipe may override period, baselinePeriods, variancePct, varianceAmount, dateWindowDays,
 * amountTolerance, match, pairMode, agingDays and expectedRatio (pins the ratio for ratio pairs) in "settings".
 *
 * Routes (JSON; Host must be one of --allowed-hosts, by default 127.0.0.1:<port> or localhost:<port>):
 *   GET  /healthz
 *   POST /profile  {folder}            files, columns, proposed recipe, saved recipe
 *   POST /recipe   {folder, recipe}    validate and save the confirmed recipe
 *   POST /analyze  {folder}            run every check with the saved recipe
 *   POST /status   {folder}            have the files changed since the last analysis?
 *   POST /reconcile {folder, pack?}    deposit reconciliation; also stores the run and returns its runId (Phase 4b-3)
 *   POST /evidence {runId, budget?}    the evidence pack, within min(budget, --evidence-max-chars); for a reconcile run,
 *                                      every exception, signed bank minus Curve, no names and no raw bank descriptions
 *   POST /verify   {runId, answer, evidence}  numbers in the answer not found in the evidence; for a reconcile run the
 *                                      strict money check: notFound, signMismatch, signUnclear
 *   POST /relations {folder}           every file as a typed table, and how the files relate (column, overlap,
 *                                      cardinality), plus "schema", the text a model gets: headers only, no values.
 *                                      Needs no recipe.
 *   POST /sql {folder, sql}            one read-only SELECT on those tables (checked, file access locked, row limit,
 *                                      timeout): {columns, rows, truncated, ms}. 400 with the reason when refused.
 *
 * Tests: npm test (generates synthetic data with planted problems; no real data needed).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type Analysis, analyze } from "./analyze.ts";
import { type DataConfig, type Flags, HttpError, insideRoots, isFolder, parseFlags, readDataConfig, settingsOf } from "./config.ts";
import { isBundleFile } from "./erpnext-bundle.ts";
import { type Db, lockFiles, openDb } from "./db.ts";
import { type Relation, type RowFilter, type TableSchema, loadAndRelate, readRowFilters, schemaText } from "./relate.ts";
import { SqlRefused, runSelect } from "./sqlrun.ts";
import { type FileProfile, folderId, listDataFiles, profileFolder, proposeRecipe, readRecipe, saveRecipe, sha256File, validateRecipe, writeJson } from "./profile.ts";
import { type Finding, evidenceOf, findingsOf, scorecardOf } from "./report.ts";
import { verifyAnswer, verifyMoney } from "../../../packages/crossask/src/verify.ts";
import { PackError, PackRegistry, SourceRegistry } from "./core/registry.ts";
import type { ResolvedPack } from "./core/ports.ts";
import { BUILT_IN_PACKS, DEFAULT_PACK } from "./domain-packs/index.ts";
import { BUILT_IN_SOURCES } from "./sources/index.ts";
import { type ReconcileReport, reconcileFolder } from "./reconcile.ts";
import { type EvidenceConfig, readReconcileConfig } from "./engines/deposit-match.ts";
import { reconcileEvidenceOf } from "./reconcile-evidence.ts";
import { bankPathOf, buildTables, factSheet, loadBank } from "./packquery.ts";
import { loadPackFolder } from "./packload.ts";
import { FACT_SYSTEM, type FactSheet, plainFacts, verifyFactAnswer } from "./facts.ts";
import { checkSelect } from "./sqlrun.ts";

const VERSION = "1.0.0";
const flags: Flags = parseFlags(process.argv.slice(2));
// Composition root: the only place that knows which domain packs exist.
const packs = new PackRegistry();
for (const p of BUILT_IN_PACKS) packs.register(p);
const sources = new SourceRegistry();
for (const a of BUILT_IN_SOURCES) sources.register(a);
const defaultPack = flags.pack ?? DEFAULT_PACK;
const rowFilters: RowFilter[] = (() => {
  if (!flags.rowFilters) return [];
  try { return readRowFilters(flags.rowFilters); } catch (e) { console.error(`analyst: --row-filters ${(e as Error).message}`); process.exit(2); }
})();
try {
  if (flags.printPack !== null) { console.log(JSON.stringify(packs.describe(flags.printPack), null, 2)); process.exit(0); }
  packs.resolve(defaultPack);
  packs.resolve(flags.reconcilePack);
} catch (e) {
  if (!(e instanceof PackError)) throw e;
  console.error(`[analyst] ${e.message}`); process.exit(2);
}
/** The pack a recipe asks for (absent = --pack default); an unknown or malformed one is the request's fault. */
function packFor(id: unknown): ResolvedPack {
  if (id !== undefined && typeof id !== "string") throw new HttpError(400, "recipe: pack must be a pack id string");
  try { return packs.resolve(id ?? defaultPack); } catch (e) { if (e instanceof PackError) throw new HttpError(400, `recipe: ${e.message}`); throw e; }
}
/** A domain pack for /pack-* (absent = --reconcile-pack, the dental pack by default); it must have a reconciliation config. */
function resolvePack(id: unknown): ResolvedPack {
  if (id !== undefined && typeof id !== "string") throw new HttpError(400, "pack must be a pack id string");
  let p: ResolvedPack;
  try { p = packs.resolve((id as string | undefined) ?? flags.reconcilePack); } catch (e) { if (e instanceof PackError) throw new HttpError(400, e.message); throw e; }
  if (!p.reconcile && !existsSync(bankPathOf(flags.configRoot, p.id))) throw new HttpError(400, `pack ${p.id} has no reconciliation config and no query bank to run`);
  return p;
}
/** One store for every run /evidence and /verify can use (Phase 4b-3: analysis or reconcile), oldest evicted beyond --runs-in-memory. */
type Stored = { kind: "analysis"; runId: string; folder: string; analysis: Analysis; findings: Finding[] }
  | { kind: "reconcile"; runId: string; folder: string; report: ReconcileReport; evidence: EvidenceConfig | null };
const runs = new Map<string, Stored>();
const newRunId = () => `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
function remember(s: Stored): void {
  runs.set(s.runId, s);
  while (runs.size > flags.runsInMemory) runs.delete(runs.keys().next().value as string);
}

/** Domain-pack runs (DESIGN/xrplh-29): the fact sheets a console question is checked against, by runId; same eviction as runs. */
const packRuns = new Map<string, { folder: string; sheets: Map<string, FactSheet> }>();
function rememberPack(runId: string, v: { folder: string; sheets: Map<string, FactSheet> }): void {
  packRuns.set(runId, v);
  while (packRuns.size > flags.runsInMemory) packRuns.delete(packRuns.keys().next().value as string);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string, any>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 4_000_000) throw new HttpError(413, "request body over 4 MB"); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "body must be JSON"); }
}
const hostOk = (req: IncomingMessage): boolean => flags.allowedHosts.includes((req.headers.host ?? "").toLowerCase());

async function folderOf(b: Record<string, any>, cfg: DataConfig): Promise<string> {
  const folder = await insideRoots(b.folder, cfg);
  if (!(await isFolder(folder))) throw new HttpError(400, "not a folder");
  return folder;
}
const profiles = (folder: string, cfg: DataConfig): Promise<FileProfile[]> => profileFolder(folder, cfg, flags.maxFiles, flags.maxBytes, openDb, flags.bundles);

async function runAnalysis(folder: string, cfg: DataConfig) {
  const recipe = await readRecipe(cfg.workDir, folder);
  if (!recipe) throw new HttpError(409, "no confirmed recipe for this folder yet: POST /profile, review the proposal, then POST /recipe");
  const profs = await profiles(folder, cfg);
  const recipeChecked = validateRecipe(recipe, profs, packFor(recipe.pack)); // the folder may have changed since the recipe was saved
  const tooBig = profs.filter((p) => p.tooBig && recipeChecked.files[p.name]?.include);
  if (tooBig.length) throw new HttpError(413, `over --max-bytes: ${tooBig.map((p) => p.name).join(", ")}`);
  const settings = { ...settingsOf(flags), ...(recipe.settings ?? {}) };
  const started = Date.now();
  const db = await openDb();
  let analysis: Analysis;
  try { analysis = await analyze(db, recipeChecked, profs, settings, { topRows: Math.max(5, flags.evidenceRowsPerFinding) }); }
  finally { db.close(); }
  const findings = findingsOf(analysis, flags.maxFindings);
  const runId = newRunId();
  const files = [];
  for (const p of profs) if (recipeChecked.files[p.name]?.include) files.push({ name: p.name, bytes: p.bytes, modified: p.modified, rows: p.rows, sha256: await sha256File(p.path) });
  const manifest = { runId, folderId: folderId(folder), ranAt: new Date().toISOString(), ms: Date.now() - started, analystVersion: VERSION, files, flow: recipeChecked.flow, settings,
    counts: { rows: analysis.files.reduce((n, f) => n + f.rows, 0), pairs: analysis.pairs.length, findings: findings.length } };
  const dir = join(cfg.workDir, "runs", folderId(folder));
  await writeJson(join(dir, runId, "manifest.json"), manifest);
  await writeJson(join(dir, "latest.json"), manifest);
  if (flags.keepFindings) await writeJson(join(dir, runId, "findings.json"), { findings, scorecard: scorecardOf(analysis) });
  remember({ kind: "analysis", runId, folder, analysis, findings });
  return { runId, folder, manifest, scorecard: scorecardOf(analysis), findings, files: analysis.files, pairs: analysis.pairs, periodUnit: analysis.periodUnit };
}

async function status(folder: string, cfg: DataConfig) {
  let last: { runId: string; ranAt: string; files: { name: string; bytes: number; modified: string }[] } | null = null;
  try { last = JSON.parse(await readFile(join(cfg.workDir, "runs", folderId(folder), "latest.json"), "utf8")); } catch { /* never analyzed */ }
  const recipe = await readRecipe(cfg.workDir, folder);
  if (!last) return { analyzed: false, recipe: Boolean(recipe), changed: true, differences: ["never analyzed"] };
  const now = await listDataFiles(folder, cfg, flags.maxFiles);
  // A bundle's tables are recorded under their own names (sales-invoice ...); they change exactly when the bundle file does.
  const bundle = now.find((f) => isBundleFile(f.name, flags.bundles));
  const included = recipe ? Object.entries(recipe.files).filter(([, f]) => f.include).map(([n]) => n) : last.files.map((f) => f.name);
  const differences: string[] = [];
  for (const name of included) {
    const a = last.files.find((f) => f.name === name), b = now.find((f) => f.name === name) ?? bundle;
    if (!b) differences.push(`${name} is gone`);
    else if (!a) differences.push(`${name} is new`);
    else if (a.bytes !== b.bytes || a.modified !== b.modified) differences.push(`${name} changed`);
  }
  return { analyzed: true, recipe: Boolean(recipe), lastRunId: last.runId, lastRanAt: last.ranAt, changed: differences.length > 0, differences };
}

/** The folder's files as typed tables with their relations, file access then locked. The caller closes the db. */
async function relatedDb(folder: string, cfg: DataConfig): Promise<{ db: Db; tables: TableSchema[]; relations: Relation[]; skipped: string[] }> {
  const profs = await profiles(folder, cfg);
  const db = await openDb();
  try {
    const { tables, relations } = await loadAndRelate(db, profs, { minOverlap: flags.relationMinOverlap, minShared: flags.relationMinShared, maxDistinct: flags.relationMaxDistinct, maxRelations: flags.relationMax, codeValues: flags.schemaCodeValues, rowFilters });
    await lockFiles(db);
    return { db, tables, relations, skipped: profs.filter((p) => p.tooBig).map((p) => p.name) };
  } catch (e) { db.close(); throw e; }
}

const stored = (b: Record<string, any>): Stored => {
  const s = typeof b.runId === "string" ? runs.get(b.runId) : undefined;
  if (!s) throw new HttpError(404, "unknown or expired runId: run the analysis again");
  return s;
};

createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 403, { error: `use http://127.0.0.1:${flags.port}` });
    const path = new URL(req.url ?? "/", "http://analyst").pathname;
    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true, version: VERSION });
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const b = await body(req);
    const cfg = readDataConfig(flags);
    if (path === "/profile") {
      const folder = await folderOf(b, cfg);
      const profs = await profiles(folder, cfg);
      const saved = await readRecipe(cfg.workDir, folder);
      const proposal = proposeRecipe(folder, profs, packFor(saved?.pack));
      if (saved?.pack !== undefined) proposal.pack = saved.pack; // keep an explicit pack choice; the default is never stamped in
      return send(res, 200, { folder, folderId: folderId(folder), files: profs, proposal, saved });
    }
    if (path === "/recipe") {
      const folder = await folderOf(b, cfg);
      const recipe = validateRecipe({ ...b.recipe, folder }, await profiles(folder, cfg), packFor(b.recipe?.pack));
      await saveRecipe(cfg.workDir, recipe);
      return send(res, 200, { ok: true, recipe });
    }
    if (path === "/analyze") return send(res, 200, await runAnalysis(await folderOf(b, cfg), cfg));
    if (path === "/reconcile") {
      const folder = await folderOf(b, cfg);
      if (b.pack !== undefined && typeof b.pack !== "string") throw new HttpError(400, "pack must be a pack id string");
      let pack: ResolvedPack;
      try { pack = packs.resolve(b.pack ?? flags.reconcilePack); } catch (e) { if (e instanceof PackError) throw new HttpError(400, e.message); throw e; }
      const report = await reconcileFolder({ files: await listDataFiles(folder, cfg, flags.maxFiles), sources, pack, configRoot: flags.configRoot,
        sourceOptions: { patientNameFormat: flags.patientNameFormat }, toleranceCents: flags.reconcileToleranceCents, open: openDb });
      // the evidence settings as they were for this run (reconcileFolder has already checked the config)
      const evidence = readReconcileConfig(join(flags.configRoot, pack.reconcile!), flags.configRoot).cfg.evidence ?? null;
      const runId = newRunId();
      remember({ kind: "reconcile", runId, folder, report, evidence });
      return send(res, 200, { runId, ...report });
    }
    // ---- domain-pack queries (DESIGN/xrplh-29): the pack's query bank over one reconciliation of a folder ----
    if (path === "/pack-queries") {
      const pack = resolvePack(b.pack);
      const bank = loadBank(bankPathOf(flags.configRoot, pack.id));
      return send(res, 200, { pack: pack.id, mode: pack.reconcile ? "reconcile" : "load", topics: bank.topics ?? [], queries: bank.queries.map((q) => ({ id: q.id, title: q.title, kind: q.sql ? "sql" : "model", topic: q.topic ?? null, pair: q.pair ?? null, ...(q.question ? { question: q.question, facts: q.facts } : {}) })) });
    }
    if (path === "/pack-run") {
      const folder = await folderOf(b, cfg);
      const pack = resolvePack(b.pack);
      const bank = loadBank(bankPathOf(flags.configRoot, pack.id));
      const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : [];
      const own = typeof b.sql === "string" && b.sql.trim() ? b.sql : null;
      const picked = ids.map((id) => bank.queries.find((q) => q.id === id) ?? (() => { throw new HttpError(400, `no query ${id} in ${pack.id}'s bank`); })());
      if (!picked.length && !own) throw new HttpError(400, "give ids (query bank entries) or sql");
      try { for (const q of picked) if (q.sql) checkSelect(q.sql); if (own) checkSelect(own); } catch (e) { if (e instanceof SqlRefused) throw new HttpError(400, e.message); throw e; }
      const maxRows = Number.isInteger(b.maxRows) && b.maxRows > 0 ? Math.min(b.maxRows, flags.sqlMaxRows) : flags.sqlMaxRows;
      if (!pack.reconcile) {
        // load-only pack (no reconciliation yet): exact entries only; a model entry needs reconciliation facts
        const asked = picked.filter((q) => q.question).map((q) => q.id);
        if (asked.length) throw new HttpError(400, `pack ${pack.id} has no reconciliation yet, so its model questions (${asked.join(", ")}) cannot run; use the exact (Table) answers`);
        const results: { id: string; title: string; columns?: string[]; rows?: Record<string, unknown>[]; truncated?: boolean; skipped?: string; error?: string }[] = [];
        const rep = await loadPackFolder({ files: await listDataFiles(folder, cfg, flags.maxFiles, bank.tables?.extensions ?? []), sources, pack, configRoot: flags.configRoot,
          sourceOptions: { patientNameFormat: flags.patientNameFormat }, spec: bank.tables, open: openDb,
          inspect: async (db) => {
            for (const q of [...picked.map((x) => ({ id: x.id, title: x.title, sql: x.sql! })), ...(own ? [{ id: "your-query", title: "your query", sql: own }] : [])]) {
              try { const r = await runSelect(db, q.sql, { maxRows, timeoutMs: flags.sqlTimeoutMs }); results.push({ id: q.id, title: q.title, columns: r.columns, rows: r.rows, truncated: r.truncated }); }
              catch (e) {
                const m = (e as Error).message; const miss = /Table with name (\w+) does not exist/i.exec(m);
                results.push(miss ? { id: q.id, title: q.title, skipped: `no ${miss[1]} file in this folder` } : { id: q.id, title: q.title, error: m.split("\n")[0] });
              }
            }
          } });
        return send(res, 200, { runId: newRunId(), pack: pack.id, mode: "load", files: rep.files.map((f) => ({ name: f.name, adapter: f.adapter, rows: f.rows })), exceptions: 0, results, questions: [], system: FACT_SYSTEM });
      }
      const { cfg: rc } = readReconcileConfig(join(flags.configRoot, pack.reconcile!), flags.configRoot);
      const actions = ((rc as unknown as { actions?: Record<string, string> }).actions) ?? {};
      const results: { id: string; title: string; columns?: string[]; rows?: Record<string, unknown>[]; truncated?: boolean; skipped?: string; error?: string }[] = [];
      const sheets = new Map<string, FactSheet>();
      const report = await reconcileFolder({ files: await listDataFiles(folder, cfg, flags.maxFiles), sources, pack, configRoot: flags.configRoot,
        sourceOptions: { patientNameFormat: flags.patientNameFormat }, toleranceCents: flags.reconcileToleranceCents, open: openDb,
        inspect: async (db, tables, rep) => {
          await buildTables(db, tables, rep, rc.evidence?.directions ?? {}, bank.tables);
          const sqls = [...picked.filter((q) => q.sql).map((q) => ({ id: q.id, title: q.title, sql: q.sql! })), ...(own ? [{ id: "your-query", title: "your query", sql: own }] : [])];
          for (const q of sqls) {
            try { const r = await runSelect(db, q.sql, { maxRows, timeoutMs: flags.sqlTimeoutMs }); results.push({ id: q.id, title: q.title, columns: r.columns, rows: r.rows, truncated: r.truncated }); }
            catch (e) {
              const m = (e as Error).message; const miss = /Table with name (\w+) does not exist/i.exec(m);
              results.push(miss ? { id: q.id, title: q.title, skipped: `no ${miss[1]} file in this folder` } : { id: q.id, title: q.title, error: m.split("\n")[0] });
            }
          }
          for (const q of picked.filter((x) => x.question)) sheets.set(q.id, await factSheet(db, q.facts!, actions));
        } });
      const runId = newRunId();
      if (sheets.size) rememberPack(runId, { folder, sheets });
      return send(res, 200, { runId, pack: pack.id, files: report.files.map((f) => ({ name: f.name, adapter: f.adapter, rows: f.rows })), exceptions: report.exceptions.length, results,
        questions: picked.filter((q) => q.question).map((q) => ({ id: q.id, title: q.title, question: q.question, facts: sheets.get(q.id)!.facts.length, sheet: sheets.get(q.id)!.text })),
        system: FACT_SYSTEM });
    }
    if (path === "/pack-verify") {
      const run = typeof b.runId === "string" ? packRuns.get(b.runId) : undefined;
      if (!run) throw new HttpError(404, "unknown or expired runId: run the question again");
      const sheet = typeof b.id === "string" ? run.sheets.get(b.id) : undefined;
      if (!sheet) throw new HttpError(400, "id is not a question of this run");
      if (typeof b.answer !== "string") throw new HttpError(400, "answer must be text");
      const check = verifyFactAnswer(b.answer, sheet);
      return send(res, 200, { ok: check.ok, checked: check.checked, problems: check.problems, computed: plainFacts(sheet) });
    }
    if (path === "/status") return send(res, 200, await status(await folderOf(b, cfg), cfg));
    if (path === "/relations") {
      const folder = await folderOf(b, cfg);
      const r = await relatedDb(folder, cfg);
      r.db.close();
      return send(res, 200, { folder, tables: r.tables, relations: r.relations, skipped: r.skipped, schema: schemaText(r.tables, r.relations) });
    }
    if (path === "/sql") {
      const folder = await folderOf(b, cfg);
      const r = await relatedDb(folder, cfg);
      try { return send(res, 200, await runSelect(r.db, b.sql, { maxRows: flags.sqlMaxRows, timeoutMs: flags.sqlTimeoutMs })); }
      catch (e) { if (e instanceof SqlRefused) throw new HttpError(400, e.message); throw e; }
      finally { r.db.close(); }
    }
    if (path === "/evidence") {
      const s = stored(b);
      const budget = Math.min(flags.evidenceMaxChars, Number.isInteger(b.budget) && b.budget > 0 ? b.budget : flags.evidenceMaxChars);
      if (s.kind === "reconcile") {
        if (!s.evidence) throw new HttpError(400, `pack ${s.report.pack} has no evidence section in its reconciliation config`);
        try { return send(res, 200, { runId: s.runId, kind: s.kind, ...reconcileEvidenceOf(s.report, s.evidence, budget, flags.reconcileTrailRows ?? s.evidence.trailRows) }); }
        catch (e) { throw new HttpError(413, (e as Error).message); }
      }
      try { return send(res, 200, { runId: s.runId, ...evidenceOf(s.analysis, s.findings, budget, flags.evidenceRowsPerFinding) }); }
      catch (e) { throw new HttpError(413, (e as Error).message); }
    }
    if (path === "/verify") {
      const s = stored(b);
      if (typeof b.answer !== "string" || typeof b.evidence !== "string") throw new HttpError(400, "answer and evidence must be strings");
      // reconcile runs: the strict, sign-aware money check (owner decision 2026-11-01 20:59); analysis runs: unchanged
      return send(res, 200, s.kind === "reconcile" ? { kind: s.kind, ...verifyMoney(b.answer, b.evidence) } : verifyAnswer(b.answer, b.evidence));
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error("[analyst]", e);
    return send(res, 500, { error: (e as Error).message });
  }
}).listen(flags.port, flags.bind, () => {
  let where = "";
  try { const c = readDataConfig(flags); where = ` data: ${c.allowedRoots.join(", ")}; work dir: ${c.workDir}`; } catch (e) { where = ` ${(e as Error).message}`; }
  console.log(`[analyst] http://127.0.0.1:${flags.port}${where}${flags.bind === "127.0.0.1" ? "" : `  (listening on ${flags.bind}; hosts ${flags.allowedHosts.join(",")})`}`);
});
