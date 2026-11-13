/**
 * Cost-model calibration (privateAI-design-34 ARCH-635 = design-32 ARCH-602..604): real runs through the running console
 * API on this PC, then config/cost-model.json, which the estimate-first offers price with (packages/offer). Nothing is
 * invented: every number in the file comes from a measurement here (packages/offer/src/calibrate.ts does the arithmetic)
 * and the operator's compute price. Run it through `.\test-console\desk.ps1 -Calibrate`.
 *
 *   crossask   each template question (free, so a model writes the query) of each crossask dataset, --runs times:
 *              POST /crossask {folder, question, model, answerModel?, phrase, timings: true}
 *              -> analyst = relationsMs + sqlMs over the dataset's file bytes (GET /data/files?path=<folder>), from the
 *                 template's exact query when it has one (phrase none, no model: ARCH-635b), else from this run;
 *                 a run whose model-written query does not run is SKIPPED (reported, left out of the numbers: ARCH-635c);
 *                 one call sample per model call: callsMs[i], sentToModel[i].bytes / .chars, served[i].usage.promptTokens
 *   presidio   POST /gateway/scan and /gateway/mask {text} for each --presidio-kb size, --runs times, timed here (so the
 *              console relay and the gateway's own time count too: a worst case). The text is the start of the calibrated
 *              datasets' own sample files, read on this PC under --sample-root (never through the console); when the files
 *              hold less text than a size, their text is repeated up to it (the report lists those sizes).
 *
 *   node scripts/calibrate.ts --compute-usd-per-hour DEC [--api URL] [--root samples] [--datasets all|ID,ID]
 *       [--model ID] [--answer-model same|none|ID] [--runs 3] [--presidio-kb 1,4,16] [--tokens-per-byte bound|observed]
 *       [--machine NAME] [--out config/cost-model.json] [--sample-root sample-data] [--datasets-config FILE]
 *       [--report-dir test-console/runs] [--timeout-sec 600] [--rate-limit-retries 3] [--rate-limit-wait-sec 65] [--dry-run]
 *
 *   --compute-usd-per-hour DEC  required: what one hour of this machine's compute costs (an owner number, no default)
 *   --answer-model same|none|ID same (default): the query model also words the answer (phrase llm); none: phrase none
 *                        (no answer call is measured); ID: that model words it
 *   --runs N             each measurement N times (default 3, at least 2: safetyPct is the run-to-run spread)
 *   --analyst-size-ratio N  the largest calibrated dataset must be at least N times the smallest (default 16, at least 2):
 *                        the analyst is priced as a fixed time per run plus a time per MB (ARCH-635b), and the per-MB part
 *                        needs sizes far apart to be measured; --datasets all includes smb-erp-fin (about 2 MB) for that
 *   --gateway-size-ratio N  the largest model prompt must be at least N times the smallest (default 4, at least 2): a model
 *                        call is priced as a fixed time per call plus a time per KB of prompt (ARCH-635c)
 *   --tokens-per-byte    bound (default; design-32 --tokens-per-byte 1, checked against every call: V-P4) or observed
 *   --dry-run            list what would run (reads /datasets only; no model, no Presidio call), write nothing
 * Output: config/cost-model.json (+ an "observed" block: counts, worst ms per unit, spread, observed ratios) and
 * test-console/runs/calibrate-<time>.json with every sample (sizes, ms, token counts; never data, questions or answers).
 * Exit 0 = written; 1 = a run failed or the measurements cannot make a model (reason printed, nothing written);
 * 2 = usage, or the console API cannot be reached.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { costModelFrom, type CalibrationSample } from "../packages/offer/src/calibrate.ts";
import { parseDecimal } from "../packages/crossask/src/cost.ts";

class UsageError extends Error {}
const MODEL_RE = /^[\w.-]+\/[\w.:-]+$/;
const TEXT_EXT = [".csv", ".txt", ".tsv", ".json", ".md"];
/** The gateway's scan/mask limit is 20,000 characters (services/gateway/src/server.ts MAX_TEXT_CHARS); 19 KB stays under it. */
const MAX_PRESIDIO_KB = 19;
type Dataset = { id: string; engine: string; templates: { label: string; q: string; sql?: string }[]; defaultSubfolder: string | null; folder: string; exists: boolean; allowed: boolean; sets: { name: string }[] };

function options(argv: string[]) {
  let v;
  try {
    ({ values: v } = parseArgs({
      args: argv, strict: true,
      options: {
        "compute-usd-per-hour": { type: "string", default: "" },
        api: { type: "string", default: "http://127.0.0.1:8735" },
        root: { type: "string", default: "samples" },
        datasets: { type: "string", default: "all" },
        model: { type: "string", default: "bedrock/nemotron-nano-3-30b" },
        "answer-model": { type: "string", default: "same" },
        runs: { type: "string", default: "3" },
        "presidio-kb": { type: "string", default: "1,4,16" },
        "tokens-per-byte": { type: "string", default: "bound" },
        "analyst-size-ratio": { type: "string", default: "16" },
        "gateway-size-ratio": { type: "string", default: "4" },
        machine: { type: "string", default: hostname() },
        out: { type: "string", default: fileURLToPath(new URL("../config/cost-model.json", import.meta.url)) },
        "sample-root": { type: "string", default: fileURLToPath(new URL("../sample-data", import.meta.url)) },
        "datasets-config": { type: "string", default: fileURLToPath(new URL("../config/datasets.json", import.meta.url)) },
        "report-dir": { type: "string", default: fileURLToPath(new URL("../test-console/runs", import.meta.url)) },
        "timeout-sec": { type: "string", default: "600" },
        "rate-limit-retries": { type: "string", default: "3" },
        "rate-limit-wait-sec": { type: "string", default: "65" },
        "dry-run": { type: "boolean", default: false },
      },
    }));
  } catch (e) { throw new UsageError((e as Error).message); }
  const int = (name: string, lo: number, hi: number): number => {
    const n = Number((v as Record<string, unknown>)[name]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new UsageError(`--${name} must be a whole number ${lo}-${hi}, got ${(v as Record<string, unknown>)[name]}`);
    return n;
  };
  const dryRun = v["dry-run"]!;
  const cuh = v["compute-usd-per-hour"]!;
  if (!dryRun) {
    if (!cuh) throw new UsageError("--compute-usd-per-hour is required: what one hour of this machine's compute costs in USD (an owner number; there is no default)");
    try { if (parseDecimal(cuh, "--compute-usd-per-hour").n <= 0n) throw new Error("must be above 0"); }
    catch (e) { throw new UsageError(`--compute-usd-per-hour must be a decimal above 0 such as 0.50, got ${cuh} (${(e as Error).message})`); }
  }
  const api = v.api!.replace(/\/+$/, "");
  if (!URL.canParse(api) || !/^https?:$/.test(new URL(api).protocol)) throw new UsageError(`--api must be an http(s) URL, got ${v.api}`);
  if (v.root !== "samples") throw new UsageError("--root must be samples: calibration sends the files' column names and Presidio text, so only the sample data is used");
  if (!MODEL_RE.test(v.model!)) throw new UsageError(`--model must look like provider/name, got ${v.model}`);
  const am = v["answer-model"]!;
  if (am !== "same" && am !== "none" && !MODEL_RE.test(am)) throw new UsageError(`--answer-model must be same, none or provider/name, got ${am}`);
  if (v["tokens-per-byte"] !== "bound" && v["tokens-per-byte"] !== "observed") throw new UsageError(`--tokens-per-byte must be bound or observed, got ${v["tokens-per-byte"]}`);
  const kb = v["presidio-kb"]!.split(",").map((s) => Number(s.trim()));
  if (!kb.length || kb.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_PRESIDIO_KB)) throw new UsageError(`--presidio-kb must be whole KB sizes 1-${MAX_PRESIDIO_KB} separated by commas (the gateway takes up to 20,000 characters), got ${v["presidio-kb"]}`);
  if (!/^[\x20-\x7E]{1,64}$/.test(v.machine!)) throw new UsageError("--machine must be 1-64 printable ASCII characters");
  const datasets = v.datasets === "all" ? null : v.datasets!.split(",").map((s) => s.trim()).filter(Boolean);
  if (datasets && !datasets.length) throw new UsageError("--datasets must be all or dataset ids separated by commas");
  return {
    computeUsdPerHour: cuh, api, root: v.root!, datasets, model: v.model!, answerModel: am === "same" ? v.model! : am === "none" ? undefined : am,
    phrase: (am === "none" ? "none" : "llm") as "llm" | "none", runs: int("runs", 2, 20), presidioKb: [...new Set(kb)].sort((a, b) => a - b),
    tokensPerByte: v["tokens-per-byte"] as "bound" | "observed", machine: v.machine!, out: resolve(v.out!), sampleRoot: resolve(v["sample-root"]!),
    datasetsConfig: resolve(v["datasets-config"]!), reportDir: resolve(v["report-dir"]!), timeoutMs: int("timeout-sec", 1, 3600) * 1000,
    analystSizeRatio: int("analyst-size-ratio", 2, 1_000_000), gatewaySizeRatio: int("gateway-size-ratio", 2, 1_000_000), rlRetries: int("rate-limit-retries", 0, 20), rlWaitMs: int("rate-limit-wait-sec", 0, 600) * 1000, dryRun,
  };
}
type Opt = ReturnType<typeof options>;

/**
 * The start of the datasets' own text files under the local sample root, at most maxBytes, cut on a character boundary.
 * fill: when the files hold less, their text is repeated (newline between copies) up to maxBytes, so Presidio still does
 * real work on real sample text at every size (smb-fin-1's statements hold 2,600 bytes of text; owner run 2026-11-12).
 */
export function sampleText(dirs: readonly string[], maxBytes: number, fill = false): string {
  const parts: Buffer[] = [];
  let have = 0;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((n) => TEXT_EXT.includes(extname(n).toLowerCase()) && !n.startsWith("_")).sort()) {
      const p = join(d, f);
      if (!statSync(p).isFile()) continue;
      const b = readFileSync(p);
      parts.push(b.subarray(0, maxBytes - have));
      have += Math.min(b.length, maxBytes - have);
      if (have >= maxBytes) break;
    }
    if (have >= maxBytes) break;
  }
  let buf = Buffer.concat(parts);
  if (fill && buf.length && buf.length < maxBytes) {
    const copies: Buffer[] = [];
    for (let n = 0; n < maxBytes; n += buf.length + 1) copies.push(buf, Buffer.from("\n"));
    buf = Buffer.concat(copies).subarray(0, maxBytes);
  }
  // A cut inside a multi-byte character decodes to U+FFFD at the end: drop it so the text is what the files hold.
  return buf.toString("utf8").replace(/\uFFFD+$/, "");
}

export async function run(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<number> {
  let o: Opt;
  try { o = options(argv); } catch (e) { out(`calibrate: ${(e as Error).message}`); return 2; }
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const r = await fetch(o.api + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };
  let waits = 0;
  /** A model call the gateway refused with rate_limited never reached a model: wait and send it again. */
  const modelCall = async (path: string, body: unknown) => {
    for (let i = 0; ; i++) {
      const r = await call("POST", path, body);
      if (!/rate_limited/.test(String(r.json?.error ?? r.json?.body?.error?.message ?? r.json?.body?.error ?? "")) || i >= o.rlRetries) return r;
      out(`  (gateway rate limit: waiting ${o.rlWaitMs / 1000} s, then retry ${i + 1}/${o.rlRetries})`);
      waits++;
      await new Promise((ok) => setTimeout(ok, o.rlWaitMs));
    }
  };

  let reg;
  try { reg = await call("GET", `/datasets?root=${encodeURIComponent(o.root)}`); }
  catch (e) { out(`calibrate: the console API is not answering at ${o.api} (${(e as Error).message}): start the desk (.\\test-console\\desk.ps1 -All) first`); return 2; }
  if (reg.status !== 200 || !Array.isArray(reg.json?.datasets)) { out(`calibrate: GET /datasets answered HTTP ${reg.status}`); return 2; }
  const all = (reg.json.datasets as Dataset[]).filter((d) => d.engine === "crossask");
  if (o.datasets) for (const id of o.datasets) if (!all.some((d) => d.id === id)) { out(`calibrate: ${id} is not a crossask dataset (crossask: ${all.map((d) => d.id).join(", ")})`); return 2; }
  const chosen = (o.datasets ? all.filter((d) => o.datasets!.includes(d.id)) : all).filter((d) => d.exists && d.allowed && d.templates.some((t) => t.q?.trim()));
  if (!chosen.length) { out("calibrate: no crossask dataset with a template question is present and allowed in the sample root"); return 1; }
  let localRel: Map<string, string>;
  try { localRel = new Map((JSON.parse(readFileSync(o.datasetsConfig, "utf8").replace(/^﻿/, "")).datasets ?? []).map((d: { id: string; folder: string }) => [d.id, d.folder])); }
  catch (e) { out(`calibrate: --datasets-config ${o.datasetsConfig}: ${(e as Error).message}`); return 2; }
  const setOf = (d: Dataset) => (d.sets.length ? (d.defaultSubfolder && d.sets.some((s) => s.name === d.defaultSubfolder) ? d.defaultSubfolder : d.sets.map((s) => s.name).sort()[0]) : "");
  const join2 = (base: string, rel: string) => (rel ? `${base.replace(/[\\/]+$/, "")}${base.includes("\\") ? "\\" : "/"}${rel.split("/").join(base.includes("\\") ? "\\" : "/")}` : base);

  const nTpl = chosen.reduce((n, d) => n + d.templates.filter((t) => t.q?.trim()).length, 0);
  out(`calibrate ${o.dryRun ? "(dry run) " : ""}api ${o.api}  model ${o.model}  answer ${o.answerModel ?? "none"}  runs ${o.runs}  presidio ${o.presidioKb.join(",")} KB  tokens-per-byte ${o.tokensPerByte}  machine ${o.machine}`);
  out(`plan: ${nTpl} template question(s) in ${chosen.map((d) => d.id).join(", ")} x ${o.runs} runs; ${o.presidioKb.length} size(s) x scan, mask x ${o.runs} runs`);
  if (o.dryRun) { out("dry run: nothing was sent to a model or Presidio, nothing written."); return 0; }

  const started = new Date();
  const samples: CalibrationSample[] = [];
  const problems: string[] = [];
  const skipped: string[] = [];
  for (const d of chosen) {
    const set = setOf(d), folder = join2(d.folder, set);
    const files = await call("GET", `/data/files?path=${encodeURIComponent(folder)}`);
    if (files.status !== 200 || !Array.isArray(files.json?.files)) { problems.push(`${d.id}: GET /data/files answered HTTP ${files.status} ${files.json?.error ?? ""}`); continue; }
    if (files.json.truncated) problems.push(`${d.id}: the folder lists more than ${files.json.maxFiles} files; only those were sized`);
    const bytes = (files.json.files as { size: number }[]).reduce((n, f) => n + f.size, 0);
    if (!bytes) { problems.push(`${d.id}: the folder has no data bytes`); continue; }
    for (const [ti, t] of d.templates.entries()) {
      if (!t.q?.trim()) continue;
      const g = `${d.id}|t${ti + 1}`;
      // ARCH-635b: a template with an exact query times the analyst on it, with no model in the run: deterministic, and a
      // model that writes a bad query cannot fail it. Such a run failing is a real problem (the template is broken).
      const exact = typeof t.sql === "string" && t.sql.trim() !== "";
      if (exact) for (let r = 1; r <= o.runs; r++) {
        let res;
        try { res = await call("POST", "/crossask", { folder, question: t.q, sql: t.sql, model: o.model, phrase: "none", timings: true }); }
        catch (e) { problems.push(`${g} exact run ${r}: ${(e as Error).message}`); out(`  FAIL ${g} exact run ${r}: ${(e as Error).message}`); continue; }
        const j = res.json ?? {};
        if (res.status !== 200 || j.error || !j.result) { const why = j.error ?? `HTTP ${res.status}`; problems.push(`${g} exact run ${r}: ${why}`); out(`  FAIL ${g} exact run ${r}: ${String(why).slice(0, 160)}`); continue; }
        if (!j.timings) { out("calibrate: the console API returned no step timings: it is older than ARCH-635. Rebuild it (.\\test-console\\desk.ps1 -All -AllSkipTests), then run -Calibrate again"); return 1; }
        samples.push({ kind: "analyst", group: `${g}|exact`, bytes, ms: j.timings.relationsMs + j.timings.sqlMs });
        out(`  ok   ${g} exact run ${r}: analyst ${j.timings.relationsMs + j.timings.sqlMs} ms over ${bytes} B, no model`);
      }
      for (let r = 1; r <= o.runs; r++) {
        const t0 = performance.now();
        let res;
        try { res = await modelCall("/crossask", { folder, question: t.q, model: o.model, ...(o.answerModel ? { answerModel: o.answerModel } : {}), phrase: o.phrase, timings: true }); }
        catch (e) { problems.push(`${g} run ${r}: ${(e as Error).message}`); out(`  FAIL ${g} run ${r}: ${(e as Error).message}`); continue; }
        const j = res.json ?? {};
        // ARCH-635c: the model wrote a query that did not run (or no query). That is the model's answer, not a fault of the
        // machine being measured: the run is reported and left out of the numbers, and calibration goes on. Anything else
        // (no answer, HTTP errors) is still a problem that writes nothing.
        // A rate limit still there after the retries is the gateway's, not the model's query: a problem, not a skip.
        if (res.status === 200 && typeof j.error === "string" && !j.result && !/rate_limited/.test(j.error)) { skipped.push(`${g} run ${r}: ${j.error}`); out(`  SKIP ${g} run ${r}: ${j.error.slice(0, 160)}`); continue; }
        if (res.status !== 200 || j.error || !j.result) { const why = j.error ?? `HTTP ${res.status}`; problems.push(`${g} run ${r}: ${why}`); out(`  FAIL ${g} run ${r}: ${String(why).slice(0, 160)}`); continue; }
        if (!j.timings) { out("calibrate: the console API returned no step timings: it is older than ARCH-635. Rebuild it (.\\test-console\\desk.ps1 -All -AllSkipTests), then run -Calibrate again"); return 1; }
        const tm = j.timings, served = j.served ?? [], sent = j.sentToModel ?? [];
        if (tm.callsMs.length !== served.length || sent.length !== served.length || sent.some((s: { bytes?: unknown }) => typeof s.bytes !== "number")) {
          problems.push(`${g} run ${r}: the calls, their timings and their sizes do not line up (${served.length}/${tm.callsMs.length}/${sent.length}); run skipped`);
          continue;
        }
        if (!exact) samples.push({ kind: "analyst", group: g, bytes, ms: tm.relationsMs + tm.sqlMs });
        served.forEach((s: { usage?: { promptTokens?: number } }, i: number) => samples.push({
          kind: "call", group: `${g}|${sent[i].step}|${i}`, promptBytes: sent[i].bytes, promptChars: sent[i].chars, promptTokens: typeof s.usage?.promptTokens === "number" ? s.usage.promptTokens : null, ms: tm.callsMs[i],
        }));
        out(`  ok   ${g} run ${r}: analyst ${tm.relationsMs + tm.sqlMs} ms over ${bytes} B, ${served.length} call(s) ${tm.callsMs.join("+")} ms, prompt ${sent.map((x: { bytes: number }) => x.bytes).join("+")} B  (${Math.round(performance.now() - t0)} ms)`);
      }
    }
  }
  const repeated: number[] = [];
  const dirs = chosen.flatMap((d) => { const rel = localRel.get(d.id), set = setOf(d); return rel ? [join(o.sampleRoot, ...rel.split("/"), ...(set ? set.split("/") : []))] : []; });
  for (const kb of o.presidioKb) {
    const own = Buffer.byteLength(sampleText(dirs, kb * 1024), "utf8");
    if (!own) { problems.push(`presidio ${kb} KB: the sample folders hold no text file (${TEXT_EXT.join(", ")})`); continue; }
    const text = sampleText(dirs, kb * 1024, true);
    const bytes = Buffer.byteLength(text, "utf8");
    if (own < bytes) { repeated.push(kb); out(`  NOTE presidio ${kb} KB: the sample files hold ${own} bytes of text, repeated to ${bytes} bytes`); }
    for (const op of ["scan", "mask"] as const) {
      for (let r = 1; r <= o.runs; r++) {
        const t0 = performance.now();
        let res;
        try { res = await call("POST", `/gateway/${op}`, { text }); }
        catch (e) { problems.push(`presidio ${op} ${kb} KB run ${r}: ${(e as Error).message}`); continue; }
        const ms = performance.now() - t0;
        if (res.status !== 200 || res.json?.status !== 200) { problems.push(`presidio ${op} ${kb} KB run ${r}: HTTP ${res.json?.status ?? res.status}`); out(`  FAIL presidio ${op} ${kb} KB run ${r}: HTTP ${res.json?.status ?? res.status}`); continue; }
        samples.push({ kind: "presidio", group: `${op}|${kb}kb`, op, bytes, ms });
        out(`  ok   presidio ${op} ${kb} KB run ${r}: ${Math.ceil(ms)} ms`);
      }
    }
  }

  const report = { tool: "calibrate", startedAt: started.toISOString(), finishedAt: new Date().toISOString(), api: o.api, model: o.model, answerModel: o.answerModel ?? null, runs: o.runs,
    presidioKb: o.presidioKb, presidioKbRepeatedText: repeated, tokensPerByte: o.tokensPerByte, machine: o.machine, rateLimitWaits: waits, problems, skipped, samples };
  try { mkdirSync(o.reportDir, { recursive: true }); const f = join(o.reportDir, `calibrate-${started.toISOString().replace(/[:.]/g, "-")}.json`); writeFileSync(f, JSON.stringify(report, null, 2) + "\n"); out(`report: ${f}`); }
  catch (e) { out(`NOTE: the report could not be written to ${o.reportDir}: ${(e as Error).message}`); }
  if (skipped.length) { out(`\n${skipped.length} model run(s) skipped: the model's query did not run; left out of the numbers (listed in the report):`); for (const p of skipped) out(`  - ${p.slice(0, 200)}`); }
  if (problems.length) { out(`\n${problems.length} problem(s); nothing written, so offers stay off until a clean run:`); for (const p of problems) out(`  - ${p}`); return 1; }

  let made;
  try {
    made = costModelFrom(samples, {
      computeUsdPerHour: o.computeUsdPerHour, tokensPerByte: o.tokensPerByte, analystSizeRatio: o.analystSizeRatio, gatewaySizeRatio: o.gatewaySizeRatio, calibratedAt: started.toISOString(), machine: o.machine,
      source: `desk.ps1 -Calibrate run of ${started.toISOString().slice(0, 10)} over sample datasets ${chosen.map((d) => d.id).join(", ")}; model ${o.model}, answer ${o.answerModel ?? "none"}; ${o.runs} runs; compute ${o.computeUsdPerHour} USD/h`,
    });
  } catch (e) { out(`\ncalibrate: ${(e as Error).message}; nothing written`); return 1; }
  mkdirSync(resolve(o.out, ".."), { recursive: true });
  writeFileSync(o.out, JSON.stringify({ ...made.model, observed: made.observed }, null, 2) + "\n");
  const m = made.model;
  out(`\nwritten ${o.out}`);
  out(`  presidio ${m.units.presidioPerKbUsd} USD/KB  analyst ${m.units.analystBaseUsd} USD/run + ${m.units.analystPerMbUsd} USD/MB (sizes ${made.observed.analystSizes.join(", ")} B)`);
  // The query prompts' real size (schema + question), so the owner can set --crossask-max-prompt-chars from data: offers
  // price every query call at that cap, and the run refuses a larger prompt (nothing charged).
  const qChars = samples.flatMap((x) => (x.kind === "call" && /\|query/.test(x.group) ? [x.promptChars] : []));
  if (qChars.length) out(`  largest query prompt ${Math.max(...qChars)} characters (the console's --crossask-max-prompt-chars caps it; offers price each query call at that cap)`);
  out(`  model call ${m.units.gatewayBaseUsd} USD/call + ${m.units.gatewayPerKbPromptUsd} USD/KB prompt (prompts ${made.observed.gatewayPromptBytes.join(" to ")} B)`);
  out(`  safety per line: presidio ${m.safetyPctByUnit.presidio} %, analyst ${m.safetyPctByUnit.analyst} %, model call ${m.safetyPctByUnit.gateway} % (widest overall ${m.safetyPct} %, ${made.observed.spreadGroup})`);
  out(`  tokensPerByte ${m.tokensPerByte} (observed max ${made.observed.tokensPerByteObservedMax})  bytesPerChar ${m.bytesPerChar}  (${Math.round((Date.now() - started.getTime()) / 1000)} s${waits ? `, ${waits} rate-limit wait(s)` : ""})`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The exit code is SET and the process ends on its own: process.exit() while fetch's sockets are still closing trips a
  // libuv assertion on Windows (src\win\async.c: !(handle->flags & UV_HANDLE_CLOSING), exit 3221226505).
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`calibrate: ${(e as Error).stack ?? e}`); process.exitCode = 2; });
}
