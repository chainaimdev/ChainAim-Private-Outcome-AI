/**
 * reconcile-explain.ts (Phase 4b-3): code reconciles, a model explains, the analyst checks every figure.
 *   analyst /reconcile -> /evidence (signed, no names) -> gateway (masks, routes by zone) -> analyst /verify (strict money check)
 * The analyst never calls a model; this script is the caller, like scripts/ask.ts, and uses the same key handling.
 *
 *   node scripts/reconcile-explain.ts --folder <abs folder> [--pack finance/rcm/dental] [--model chainaim/auto]
 *        [--question TEXT] [--budget N] [--analyst http://127.0.0.1:8740] [--gateway http://127.0.0.1:8720]
 *        [--key-file PATH | --key-env NAME] [--timeout-sec 300] [--json]
 *   --budget N      evidence characters (capped by the analyst's --evidence-max-chars)
 *   --key-env NAME  read the gateway key from this environment variable (its NAME; the key is never printed)
 * Exit 0 every figure verified; 1 a figure is not in the evidence, has the wrong sign or an unclear one (printed), a call
 * failed, or (Phase 4c) a model named in --model was not the one that served: the gateway falls back to its own choice when
 * it does not know the name, so the run is refused rather than reported as that model's; 2 bad flags.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analystClient, explainReconcile, gatewayChat } from "../../../packages/crossask/src/index.ts";

const { values: f } = parseArgs({
  args: process.argv.slice(2), strict: true,
  options: {
    folder: { type: "string" }, pack: { type: "string" }, model: { type: "string", default: "chainaim/auto" }, question: { type: "string" },
    budget: { type: "string" }, analyst: { type: "string", default: "http://127.0.0.1:8740" }, gateway: { type: "string", default: "http://127.0.0.1:8720" },
    "key-file": { type: "string", default: fileURLToPath(new URL("../../../test-console/local-gateway-key.txt", import.meta.url)) },
    "key-env": { type: "string" }, "timeout-sec": { type: "string", default: "300" }, json: { type: "boolean", default: false },
  },
});
const fail = (m: string, code = 2): never => { console.error(`reconcile-explain: ${m}`); process.exit(code); };
const int = (name: string, v: string | undefined, min: number): number => { const n = Number(v); if (!Number.isInteger(n) || n < min) fail(`--${name} must be a whole number >= ${min}, got ${v}`); return n; };
if (!f.folder) fail("--folder is required");
if (!/^[\w.-]+\/[\w.:-]+$/.test(f.model!)) fail(`--model must look like provider/name, got ${f.model}`);
if (f["key-env"] !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(f["key-env"])) fail("--key-env takes an environment variable NAME");
const timeoutMs = int("timeout-sec", f["timeout-sec"], 1) * 1000;
const budget = f.budget === undefined ? undefined : int("budget", f.budget, 1);
const key = f["key-env"] ? (process.env[f["key-env"]] ?? "") : (() => { try { return readFileSync(f["key-file"]!, "utf8").trim(); } catch { return ""; } })();
if (!key) fail(f["key-env"] ? `environment variable ${f["key-env"]} is empty` : `no gateway key in ${f["key-file"]}`);

// After the calls, the exit code is SET and the script ends on its own (no process.exit): exiting while fetch's sockets are
// still closing trips a libuv assertion on Windows (src\win\async.c: !(handle->flags & UV_HANDLE_CLOSING), exit 3221226505).
const done = (code: number): void => { process.exitCode = code; };
try {
  const r = await explainReconcile({ folder: f.folder!, model: f.model!, pack: f.pack, budget, question: f.question },
    { analyst: analystClient(f.analyst!, timeoutMs), chat: gatewayChat({ url: f.gateway!, key, timeoutMs }) });
  const mismatch = f.model !== "chainaim/auto" && r.model !== undefined && r.model !== f.model;
  if (f.json) { console.log(JSON.stringify({ ...r, ...(mismatch ? { modelMismatch: { asked: f.model, served: r.model } } : {}) }, null, 2)); done(r.verify.verified && !mismatch ? 0 : 1); }
  else report(r, mismatch);
} catch (e) { console.error(`reconcile-explain: ${(e as Error).message}`); done(1); }

function report(r: Awaited<ReturnType<typeof explainReconcile>>, mismatch: boolean): void {
  console.log(`RUN       ${r.runId}: ${r.exceptions} exception(s); evidence ${r.evidenceChars} chars`);
  for (const s of r.sentToModel) console.log(`SENT      ${s.step}: ${s.chars} chars (exception codes, signed amounts, payment IDs; no names; masked again by the gateway)`);
  if (r.model) console.log(`SERVED    ${r.model}${r.zone ? ` (zone ${r.zone})` : ""}`);
  console.log(`\nANSWER\n${r.answer}\n`);
  const v = r.verify;
  console.log(`VERIFY    ${v.checked} figure(s) checked: ${v.verified ? "every figure is in the evidence with the right direction" : "NOT VERIFIED"}`);
  if (v.notFound.length) console.log(`  not in the evidence: ${v.notFound.join(", ")}`);
  if (v.signMismatch.length) console.log(`  wrong direction (short vs over): ${v.signMismatch.join(", ")}`);
  if (v.signUnclear.length) console.log(`  direction unclear (say short/missing or over/extra): ${v.signUnclear.join(", ")}`);
  if (mismatch) console.log(`MODEL     asked for ${f.model} but the gateway served ${r.model}: ${f.model} is not in the gateway's current model list (it fell back to its own choice). Not counted as ${f.model}'s answer.`);
  done(v.verified && !mismatch ? 0 : 1);
}
