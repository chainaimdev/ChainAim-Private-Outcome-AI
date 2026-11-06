/**
 * UI template smoke check for tab 03 (handoff 2026-11-06): before the page is opened to people, every template it offers is
 * run against its dataset folder through the console API, with exactly the requests the page sends
 * (test-console/console/index.html, server.ts):
 *   GET  /datasets?root=<root>                                   the datasets, their folders (as the console API sees them) and sets
 *   POST /crossask {folder, question, model, answerModel?, phrase}  engine crossask: each template of config/datasets.json
 *   POST /analyst/pack-queries {pack}                            engine domain-pack: the pack's query bank
 *   POST /analyst/pack-run {folder, pack, ids:[id]}              each exact (sql) entry, one id per call as the page does
 *   POST /packask {folder, pack, id, model}                      each explained (model) entry: fact sheet, model, figure check
 * One line per template as it finishes, a summary, and a JSON report (ids, statuses, counts, timings and the generated SQL;
 * never result rows or answers). Terminal only: it changes nothing. Sequential, one model call at a time, like the page.
 *
 *   node scripts/ui-smoke.ts [--api URL] [--root samples] [--model ID] [--answer-model none|ID] [--datasets all|ID,ID]
 *       [--sets default|all] [--pack-explained on|off] [--timeout-sec N] [--require-rows on|off] [--strict-check off|on]
 *       [--skip-is-fail off|on] [--report-sql on|off] [--report-dir DIR] [--allow-root NAME] [--dry-run]
 *       [--rate-limit-retries N] [--rate-limit-wait-sec N]
 *
 *   --api URL            the console API (default http://127.0.0.1:8735, ca-console-api; its Host check accepts 127.0.0.1:8735)
 *   --root NAME          a root of config/datasets.json (default samples). Any other root needs --allow-root NAME too, since
 *                        the model then sees that root's column names, and with --answer-model or explained questions its data
 *   --model ID           writes each crossask query and words each explained answer (default bedrock/nemotron-nano-3-30b,
 *                        the page's default pick; provider/name)
 *   --answer-model none|ID  crossask: none (default) = table only, no result rows sent to any model; ID = that model words the
 *                        answer (phrase llm), and figures it could not tie to the result are reported as WARN
 *   --datasets all|ID,ID which datasets (default all)
 *   --sets default|all   default: each dataset's defaultSubfolder only (the page's first pick); all: every set
 *   --pack-explained on|off  domain-pack explained questions through the model (default on); off = exact queries only
 *   --timeout-sec N      one request (default 600; the console's own per-call limit is its --crossask-timeout-sec)
 *   --require-rows on|off  a crossask result with 0 rows is FAIL (on, default) or WARN (off). Exact pack queries may return
 *                        0 rows legitimately (no leak in a POS set) and are never judged on rows
 *   --strict-check off|on  an explained answer whose figures did not match the facts is WARN (off, default: the page then
 *                        shows the computed facts) or FAIL (on)
 *   --skip-is-fail off|on  an exact pack query skipped because the set lacks that file kind is SKIP (off, default) or FAIL
 *   --report-sql on|off  keep each generated SQL in the report (default on; sample data only)
 *   --report-dir DIR     where ui-smoke-<time>.json goes (default test-console/runs, git-ignored)
 *   --dry-run            list what would run (reads /datasets and the query banks only; no model call), no report
 *   --rate-limit-retries N  a model call the gateway refuses with rate_limited (its --free-rpm window, default 20 calls
 *                        per 60 s, counted Bedrock calls too in the 2026-11-06 run) is waited out and sent again up to N
 *                        times (default 3); a refused call never reached a model. 0 = report it as FAIL at once
 *   --rate-limit-wait-sec N  the wait before each retry (default 65: the gateway's 60 s window and a margin)
 *
 * PASS / WARN / SKIP / FAIL:
 *   crossask      PASS: no error, a result, rows > 0. WARN: the console's join warnings, unverified figures, 0 rows with
 *                 --require-rows off. FAIL: HTTP error, an error, no result, 0 rows with --require-rows on.
 *   pack-sql      PASS: columns and no error. SKIP: skipped (missing file kind). FAIL: an error.
 *   pack-explained PASS: every figure checked. WARN: a figure did not match (--strict-check off). FAIL: HTTP error.
 *   dataset       SKIP: folder not found, or no templates. FAIL: folder outside allowedRoots, or a domain pack without a pack.
 * Exit 0 = no FAIL, 1 = at least one FAIL, 2 = usage error or the console API cannot be reached.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type Status = "PASS" | "WARN" | "SKIP" | "FAIL" | "PLAN";
type Kind = "crossask" | "pack-sql" | "pack-explained" | "dataset";
type Item = { dataset: string; set: string; item: string; id?: string; kind: Kind; status: Status; rows: number | null; ms: number; tries?: number; note: string; sql?: string | null };
type Dataset = { id: string; label?: string; engine: string; pack: string | null; templates: { label: string; q: string }[]; templatesFrom: string | null;
  defaultSubfolder: string | null; folder: string; exists: boolean; allowed: boolean; files: string[]; sets: { name: string; files: string[] }[] };
type BankEntry = { id: string; title: string; kind: "sql" | "model"; question?: string };

class UsageError extends Error {}
const MODEL_RE = /^[\w.-]+\/[\w.:-]+$/; // the console's own check (server.ts)

function options(argv: string[]) {
  let v;
  try {
    ({ values: v } = parseArgs({
      args: argv,
      strict: true,
      options: {
        api: { type: "string", default: "http://127.0.0.1:8735" },
        root: { type: "string", default: "samples" },
        model: { type: "string", default: "bedrock/nemotron-nano-3-30b" },
        "answer-model": { type: "string", default: "none" },
        datasets: { type: "string", default: "all" },
        sets: { type: "string", default: "default" },
        "pack-explained": { type: "string", default: "on" },
        "timeout-sec": { type: "string", default: "600" },
        "require-rows": { type: "string", default: "on" },
        "strict-check": { type: "string", default: "off" },
        "skip-is-fail": { type: "string", default: "off" },
        "report-sql": { type: "string", default: "on" },
        "report-dir": { type: "string", default: fileURLToPath(new URL("../test-console/runs", import.meta.url)) },
        "allow-root": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "rate-limit-retries": { type: "string", default: "3" },
        "rate-limit-wait-sec": { type: "string", default: "65" },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const onOff = (name: string): boolean => {
    const x = (v as Record<string, unknown>)[name];
    if (x !== "on" && x !== "off") throw new UsageError(`--${name} must be on or off, got ${x}`);
    return x === "on";
  };
  const api = v.api!.replace(/\/+$/, "");
  if (!URL.canParse(api) || !/^https?:$/.test(new URL(api).protocol)) throw new UsageError(`--api must be an http(s) URL, got ${v.api}`);
  if (!/^[A-Za-z0-9_-]+$/.test(v.root!)) throw new UsageError(`--root must be a root name of config/datasets.json, got ${v.root}`);
  if (v.root !== "samples" && v["allow-root"] !== v.root) throw new UsageError(`--root ${v.root} is not the sample data: add --allow-root ${v.root} to confirm the model may see it`);
  if (!MODEL_RE.test(v.model!)) throw new UsageError(`--model must look like provider/name, got ${v.model}`);
  const answerModel = v["answer-model"] === "none" ? undefined : v["answer-model"]!;
  if (answerModel !== undefined && !MODEL_RE.test(answerModel)) throw new UsageError(`--answer-model must be none or provider/name, got ${answerModel}`);
  if (v.sets !== "default" && v.sets !== "all") throw new UsageError(`--sets must be default or all, got ${v.sets}`);
  const timeoutSec = Number(v["timeout-sec"]);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) throw new UsageError(`--timeout-sec must be 1-3600, got ${v["timeout-sec"]}`);
  const rlRetries = Number(v["rate-limit-retries"]);
  if (!Number.isInteger(rlRetries) || rlRetries < 0 || rlRetries > 20) throw new UsageError(`--rate-limit-retries must be 0-20, got ${v["rate-limit-retries"]}`);
  const rlWaitSec = Number(v["rate-limit-wait-sec"]);
  if (!Number.isInteger(rlWaitSec) || rlWaitSec < 0 || rlWaitSec > 600) throw new UsageError(`--rate-limit-wait-sec must be 0-600, got ${v["rate-limit-wait-sec"]}`);
  const datasets = v.datasets === "all" ? null : v.datasets!.split(",").map((s) => s.trim()).filter(Boolean);
  if (datasets && !datasets.length) throw new UsageError("--datasets must be all or a comma-separated list of dataset ids");
  return {
    api, root: v.root!, model: v.model!, answerModel, datasets, sets: v.sets as "default" | "all", packExplained: onOff("pack-explained"),
    timeoutMs: timeoutSec * 1000, requireRows: onOff("require-rows"), strictCheck: onOff("strict-check"), skipIsFail: onOff("skip-is-fail"),
    reportSql: onOff("report-sql"), reportDir: resolve(v["report-dir"]!), dryRun: v["dry-run"]!, rlRetries, rlWaitMs: rlWaitSec * 1000,
  };
}
type Opt = ReturnType<typeof options>;

/** The page's dsJoin: the set's folder under the dataset folder, with the folder's own separator. */
const dsJoin = (base: string, rel: string): string => {
  if (!rel) return base;
  const sp = base.includes("\\") ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + sp + rel.split("/").join(sp);
};
/** default: the dataset's defaultSubfolder (else the first set by name); all: every set; no sets: the folder itself. */
function setsOf(d: Dataset, which: "default" | "all"): string[] {
  const names = (d.sets ?? []).map((s) => s.name).sort();
  if (!names.length) return [""];
  if (which === "all") return names;
  return [d.defaultSubfolder && names.includes(d.defaultSubfolder) ? d.defaultSubfolder : names[0]];
}
const oneLine = (s: unknown, max = 140): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

async function call(o: Opt, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(o.api + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(o.timeoutMs),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** The verdict on one /crossask answer (server.ts returns 200 with out.error set when the job ran but failed). */
function judgeCrossask(o: Opt, r: { status: number; json: any }): Pick<Item, "status" | "rows" | "note" | "tries" | "sql"> {
  const j = r.json ?? {};
  const tries = Array.isArray(j.attempts) ? j.attempts.length : 0;
  const last = Array.isArray(j.attempts) ? j.attempts.at(-1) : undefined;
  const sql = typeof j.sql === "string" ? j.sql : typeof last?.sql === "string" && last.sql ? last.sql : null;
  if (r.status !== 200) return { status: "FAIL", rows: null, tries, sql, note: oneLine(j.error ?? `HTTP ${r.status}`) };
  if (j.error) return { status: "FAIL", rows: null, tries, sql, note: oneLine(j.error) };
  if (!j.result) return { status: "FAIL", rows: null, tries, sql, note: oneLine(last?.error ? `no result: ${last.error}` : "no result") };
  const rows = Array.isArray(j.result.rows) ? j.result.rows.length : 0;
  const notes: string[] = [];
  let status: Status = "PASS";
  if (rows === 0) { status = o.requireRows ? "FAIL" : "WARN"; notes.push("0 rows"); }
  if (tries > 1) notes.push(`query fixed on try ${tries}`);
  const warnings = Array.isArray(j.warnings) ? j.warnings : [];
  if (warnings.length) { if (status === "PASS") status = "WARN"; notes.push(`${warnings.length} join warning(s): ${warnings[0]}`); }
  const unverified = j.answer !== null && Array.isArray(j.unverified) ? j.unverified : [];
  if (unverified.length) { if (status === "PASS") status = "WARN"; notes.push(`${unverified.length} figure(s) in the answer not found in the result`); }
  return { status, rows, tries, sql, note: oneLine(notes.join("; ")) };
}

function judgePackSql(o: Opt, r: { status: number; json: any }): Pick<Item, "status" | "rows" | "note"> {
  const res = r.json?.results?.[0];
  if (r.status !== 200) return { status: "FAIL", rows: null, note: oneLine(r.json?.error ?? `HTTP ${r.status}`) };
  if (!res) return { status: "FAIL", rows: null, note: "no result for this query" };
  if (res.error) return { status: "FAIL", rows: null, note: oneLine(res.error) };
  if (res.skipped) return { status: o.skipIsFail ? "FAIL" : "SKIP", rows: null, note: oneLine(res.skipped) };
  if (!Array.isArray(res.columns)) return { status: "FAIL", rows: null, note: "no columns in the result" };
  const rows = Array.isArray(res.rows) ? res.rows.length : 0;
  return { status: "PASS", rows, note: res.truncated ? "first rows only" : "" };
}

function judgePackAsk(o: Opt, r: { status: number; json: any }): Pick<Item, "status" | "rows" | "note"> {
  const j = r.json ?? {};
  if (r.status !== 200) return { status: "FAIL", rows: null, note: oneLine(j.error ?? `HTTP ${r.status}`) };
  const served = `${j.served?.model ?? "?"}${j.served?.seconds !== undefined ? `, ${j.served.seconds} s` : ""}`;
  if (j.check?.ok === true) return { status: "PASS", rows: null, note: oneLine(`${j.check.checked} figure(s) checked; ${served}`) };
  const n = Array.isArray(j.check?.problems) ? j.check.problems.length : 0;
  return { status: o.strictCheck ? "FAIL" : "WARN", rows: null, note: oneLine(`${n} figure(s) did not match the facts (the page shows the computed facts); ${served}`) };
}

const COLS = "DATASET          SET                        TEMPLATE                               KIND            STATUS  ROWS   SEC  NOTE";
function line(it: Item): string {
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "~" : s).padEnd(n);
  return `${pad(it.dataset, 16)} ${pad(it.set || "-", 26)} ${pad(it.item, 38)} ${pad(it.kind, 15)} ${pad(it.status, 7)} ${String(it.rows ?? "-").padStart(4)} ${String(Math.round(it.ms / 1000)).padStart(5)}  ${it.note}`;
}

export async function run(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<number> {
  let o: Opt;
  try { o = options(argv); } catch (e) { out(`ui-smoke: ${(e as Error).message}`); return 2; }
  let reg;
  try { reg = await call(o, "GET", `/datasets?root=${encodeURIComponent(o.root)}`); }
  catch (e) { out(`ui-smoke: the console API is not answering at ${o.api} (${(e as Error).message}): start the desk (.\\test-console\\desk.ps1) first`); return 2; }
  if (reg.status !== 200 || !Array.isArray(reg.json?.datasets)) { out(`ui-smoke: GET /datasets answered HTTP ${reg.status}: ${oneLine(reg.json?.error ?? "")}`); return 2; }
  const all = reg.json.datasets as Dataset[];
  if (o.datasets) for (const id of o.datasets) if (!all.some((d) => d.id === id)) { out(`ui-smoke: unknown dataset ${id} (known: ${all.map((d) => d.id).join(", ")})`); return 2; }
  const chosen = o.datasets ? all.filter((d) => o.datasets!.includes(d.id)) : all;
  if (!reg.json.rootAllowed) out(`NOTE: root ${o.root} (${reg.json.rootPath}) is not in the console's allowedRoots`);

  const items: Item[] = [];
  const started = new Date();
  out(`ui-smoke ${o.dryRun ? "(dry run) " : ""}api ${o.api}  root ${o.root}  model ${o.model}  answer ${o.answerModel ?? "none (table only)"}  sets ${o.sets}  explained ${o.packExplained ? "on" : "off"}`);
  out(COLS);
  const add = (it: Item) => { items.push(it); out(line(it)); };
  const timed = async <T>(f: () => Promise<T>): Promise<[T | null, number, string | null]> => {
    const t0 = performance.now();
    try { return [await f(), performance.now() - t0, null]; } catch (e) { return [null, performance.now() - t0, (e as Error).name === "TimeoutError" ? `no answer within ${o.timeoutMs / 1000} s (--timeout-sec)` : (e as Error).message]; }
  };
  /** A model call, waited out and sent again while the gateway refuses it with rate_limited (no model was reached). */
  let waits = 0;
  const modelCall = async (path: string, body: unknown): Promise<{ status: number; json: any }> => {
    for (let i = 0; ; i++) {
      const r = await call(o, "POST", path, body);
      if (!/rate_limited/.test(String(r.json?.error ?? "")) || i >= o.rlRetries) return r;
      out(`        (gateway rate limit: waiting ${o.rlWaitMs / 1000} s, then retry ${i + 1}/${o.rlRetries})`);
      waits++;
      await new Promise((res) => setTimeout(res, o.rlWaitMs));
    }
  };
  const base = (d: Dataset, set: string, item: string, kind: Kind, id?: string) => ({ dataset: d.id, set, item, kind, ...(id ? { id } : {}) });

  for (const d of chosen) {
    if (!d.allowed) { add({ ...base(d, "", "(dataset)", "dataset"), status: "FAIL", rows: null, ms: 0, note: `folder ${d.folder} is outside the console's allowedRoots` }); continue; }
    if (!d.exists) { add({ ...base(d, "", "(dataset)", "dataset"), status: "SKIP", rows: null, ms: 0, note: `folder not found: ${d.folder}` }); continue; }

    if (d.engine === "domain-pack") {
      if (!d.pack) { add({ ...base(d, "", "(dataset)", "dataset"), status: "FAIL", rows: null, ms: 0, note: "engine domain-pack without a pack" }); continue; }
      const [bankR, , bankErr] = await timed(() => call(o, "POST", "/analyst/pack-queries", { pack: d.pack }));
      if (bankErr || bankR!.status !== 200 || !Array.isArray(bankR!.json?.queries)) {
        add({ ...base(d, "", "(query bank)", "dataset"), status: "FAIL", rows: null, ms: 0, note: oneLine(bankErr ?? bankR!.json?.error ?? `HTTP ${bankR!.status}`) });
        continue;
      }
      const bank = (bankR!.json.queries as BankEntry[]).filter((q) => q.kind === "sql" || (q.kind === "model" && o.packExplained));
      for (const set of setsOf(d, o.sets)) {
        const folder = dsJoin(d.folder, set);
        for (const q of bank) {
          const kind: Kind = q.kind === "sql" ? "pack-sql" : "pack-explained";
          if (o.dryRun) { add({ ...base(d, set, q.title, kind, q.id), status: "PLAN", rows: null, ms: 0, note: q.id }); continue; }
          const [r, ms, err] = q.kind === "sql"
            ? await timed(() => call(o, "POST", "/analyst/pack-run", { folder, pack: d.pack, ids: [q.id] }))
            : await timed(() => modelCall("/packask", { folder, pack: d.pack, id: q.id, model: o.model }));
          if (err) { add({ ...base(d, set, q.title, kind, q.id), status: "FAIL", rows: null, ms, note: oneLine(err) }); continue; }
          add({ ...base(d, set, q.title, kind, q.id), ms, ...(q.kind === "sql" ? judgePackSql(o, r!) : judgePackAsk(o, r!)) });
        }
      }
      continue;
    }

    if (!d.templates?.length) { add({ ...base(d, "", "(dataset)", "dataset"), status: "SKIP", rows: null, ms: 0, note: "no templates for this dataset" }); continue; }
    for (const set of setsOf(d, o.sets)) {
      const folder = dsJoin(d.folder, set);
      for (const t of d.templates) {
        if (o.dryRun) { add({ ...base(d, set, t.label, "crossask"), status: "PLAN", rows: null, ms: 0, note: oneLine(t.q, 80) }); continue; }
        // The page's body (index.html "xaskGo"): answerModel and phrase llm only when an answer model is picked.
        const body = { folder, question: t.q, model: o.model, ...(o.answerModel ? { answerModel: o.answerModel } : {}), phrase: o.answerModel ? "llm" : "none" };
        const [r, ms, err] = await timed(() => modelCall("/crossask", body));
        if (err) { add({ ...base(d, set, t.label, "crossask"), status: "FAIL", rows: null, ms, note: oneLine(err) }); continue; }
        const v = judgeCrossask(o, r!);
        add({ ...base(d, set, t.label, "crossask"), ms, ...v, ...(o.reportSql ? {} : { sql: undefined }) });
      }
    }
  }

  const count = (s: Status) => items.filter((i) => i.status === s).length;
  if (o.dryRun) { out(`\n${count("PLAN")} template run(s) planned; nothing was sent to a model.`); return 0; }
  const fails = count("FAIL");
  out(`\nPASS ${count("PASS")}  WARN ${count("WARN")}  SKIP ${count("SKIP")}  FAIL ${fails}   (${Math.round((Date.now() - started.getTime()) / 1000)} s${waits ? `, ${waits} rate-limit wait(s) included` : ""})`);
  const report = {
    tool: "ui-smoke", startedAt: started.toISOString(), finishedAt: new Date().toISOString(), api: o.api, root: o.root, model: o.model,
    answerModel: o.answerModel ?? null, sets: o.sets, packExplained: o.packExplained, requireRows: o.requireRows, strictCheck: o.strictCheck,
    skipIsFail: o.skipIsFail, rateLimitWaits: waits, counts: { pass: count("PASS"), warn: count("WARN"), skip: count("SKIP"), fail: fails },
    items: items.map((i) => (o.reportSql ? i : { ...i, sql: undefined })),
  };
  try {
    mkdirSync(o.reportDir, { recursive: true });
    const file = join(o.reportDir, `ui-smoke-${started.toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    out(`report: ${file}`);
  } catch (e) {
    out(`NOTE: the report could not be written to ${o.reportDir}: ${(e as Error).message}`);
  }
  return fails ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`ui-smoke: ${(e as Error).stack ?? e}`); process.exit(2); });
}
