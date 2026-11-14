/**
 * desk.ps1 -AgentAsk (privateAI-design-32 step C): one tab 03 "AI agent" run from the terminal, no browser.
 *
 *   node scripts/agent-ask.ts --tenant t01 --dataset smb-fin-1 [--template 1|LABEL] [--question TEXT] [--set NAME]
 *        [--root samples] [--answer-model default|none|provider/name] [--query-model default|provider/name]
 *        [--api http://127.0.0.1:8735]
 *        [--out-dir runtime/agent-ask] [--show-rows 20] [--receipt-poll-ms 1000] [--receipt-poll-max 15]
 *
 *   --tenant         the tenant whose agent pays (one the agent service lists, e.g. t01)
 *   --dataset        a crossask dataset id of config/datasets.json (GET <api>/datasets?root=<root>)
 *   --template       the template, 1-based number or its label (default 1); its question and exact query are sent, and
 *                    its label names the job in the receipt, as tab 03 does
 *   --question       ask this instead of a template (no exact query, no template label)
 *   --set            the dataset's set (subfolder), for datasets that have sets (default its defaultSubfolder)
 *   --answer-model   default = the console's default answer model (GET <api>/gateway/models), none = table only
 *   --query-model    the model that writes the SQL (tab 03's "Writes the query"); default = the console's default. A
 *                    template with an exact query sends none. An agent whose policy requires the attested route pays
 *                    only when every model call is attested, e.g. nearai/deepseek-v4.1-flash for both models
 *   --api            the console API (default http://127.0.0.1:8735): the run goes through POST /agent/crossask, the
 *                    same relay, agent, spending policy, payment and receipt check as tab 03
 *   --out-dir        where the paid job's receipt and result are saved (default runtime/agent-ask, git-ignored):
 *                    chainaim-receipt-<jobId>.json = {receipt, publicKeyPem} (the page's "Download receipt" format) and
 *                    chainaim-result-<jobId>.json = the released result, for desk.ps1 -VerifyReceipt
 *
 * Prints each step with who did it, then the released result. Never prints a key.
 * Exit 0 = paid, result released and the agent's receipt check passed (or the agent has it off); 1 = refused, error or
 * the receipt check failed; 2 = usage, or the console / agent is not reachable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildRun, nearblocks, parseFrame, resultText, stepLine, type ListedDataset } from "./agent-ask-core.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const say = (tag: string, text: string) => process.stdout.write(`${tag.padEnd(7)} ${text}\n`);
const usage = (m: string): never => { process.stderr.write(`agent-ask: ${m}\n`); process.exit(2); };

let o: Record<string, string | undefined>;
try {
  o = parseArgs({
    strict: true,
    options: {
      tenant: { type: "string" }, dataset: { type: "string" }, template: { type: "string", default: "1" }, question: { type: "string" },
      set: { type: "string" }, root: { type: "string", default: "samples" }, "answer-model": { type: "string", default: "default" }, "query-model": { type: "string", default: "default" },
      // privateAI-design-34 D5: estimate-first (default: priced from sizes, runs only after payment) or run-hold.
      "offer-mode": { type: "string", default: "estimate-first" },
      api: { type: "string", default: "http://127.0.0.1:8735" }, "out-dir": { type: "string", default: join(REPO, "runtime", "agent-ask") },
      "show-rows": { type: "string", default: "20" }, "receipt-poll-ms": { type: "string", default: "1000" }, "receipt-poll-max": { type: "string", default: "15" },
    },
  }).values as Record<string, string | undefined>;
} catch (e) {
  usage((e as Error).message);
}
const whole = (name: string, min: number, max: number): number => {
  const raw = o![name]!; const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) usage(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const tenant = o!.tenant ?? usage("--tenant is required, e.g. t01");
if (!/^[A-Za-z0-9_-]{1,32}$/.test(tenant)) usage("--tenant must be a tenant id such as t01");
const dataset = o!.dataset ?? usage("--dataset is required, e.g. smb-fin-1");
const api = o!.api!.replace(/\/+$/, "");
if (!/^https?:\/\//.test(api) || !URL.canParse(api)) usage(`--api must be an http(s) URL, got ${o!.api}`);
if (!/^[A-Za-z0-9_-]{1,32}$/.test(o!.root!)) usage("--root must be a root id of config/datasets.json, e.g. samples");
const showRows = whole("show-rows", 0, 10000), pollMs = whole("receipt-poll-ms", 100, 60000), pollMax = whole("receipt-poll-max", 1, 120);
const outDir = resolve(o!["out-dir"]!);

/** A stop inside getJson: main() answers its exit code. */
class Stop { readonly code: number; constructor(code: number) { this.code = code; } }

async function getJson(path: string): Promise<{ status: number; body: any }> {
  let r: Response;
  try { r = await fetch(api + path, { signal: AbortSignal.timeout(15000) }); } catch (e) { say("STOP", `the console API is not answering at ${api} (${(e as Error).name}): start the desk first (.\\test-console\\desk.ps1)`); throw new Stop(2); }
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** usage() once the console was asked: the same message and exit 2, without process.exit (see main). */
const stopUsage = (m: string): never => { process.stderr.write(`agent-ask: ${m}\n`); throw new Stop(2); };

/**
 * Everything that talks to the console. Its exit code is SET and the script ends on its own: process.exit() while fetch's
 * keep-alive sockets are still closing trips a libuv assertion on Windows (src\win\async.c: !(handle->flags &
 * UV_HANDLE_CLOSING), exit 3221226505), which turned every exit code of this CLI into a crash.
 */
async function main(): Promise<number> {
  const ds = await getJson(`/datasets?root=${encodeURIComponent(o!.root!)}`);
  if (ds.status !== 200 || !Array.isArray(ds.body?.datasets)) { say("STOP", `GET ${api}/datasets answered HTTP ${ds.status}${typeof ds.body?.error === "string" ? `: ${ds.body.error}` : ""}`); return 2; }
  const ag = await getJson("/agent/config");
  if (ag.status !== 200 || !Array.isArray(ag.body?.tenants)) { say("STOP", `agent mode is not on at ${api} (GET /agent/config answered HTTP ${ag.status}): start the desk with the agent (desk.ps1 -All)`); return 2; }
  const t = (ag.body.tenants as { id: string; name: string; accountId: string }[]).find((x) => x.id === tenant);
  if (!t) { say("STOP", `the agent does not pay for ${tenant} (it pays for: ${(ag.body.tenants as { id: string }[]).map((x) => x.id).join(", ")})`); return 2; }
  let defaultAnswer: string | null = null;
  if (o!["answer-model"] === "default") {
    const gm = await getJson("/gateway/models");
    defaultAnswer = typeof gm.body?.defaultAnswerModel === "string" && gm.body.defaultAnswerModel ? gm.body.defaultAnswerModel : null;
  }
  const built = buildRun(tenant, ds.body.datasets as ListedDataset[], { dataset, template: o!.template!, question: o!.question, set: o!.set, answerModel: o!["answer-model"]!, queryModel: o!["query-model"]! }, defaultAnswer);
  if ("error" in built) stopUsage(built.error);
  const { run } = built as Exclude<typeof built, { error: string }>;
  if (o!["offer-mode"] !== "estimate-first" && o!["offer-mode"] !== "run-hold") stopUsage(`--offer-mode must be estimate-first or run-hold, got ${o!["offer-mode"]}`);
  run.offerMode = o!["offer-mode"]!;

  say("RUN", `AI agent for ${t.name} (${tenant}) pays from ${t.accountId}; dataset ${built.datasetLabel}${built.templateLabel ? `, template "${built.templateLabel}"` : ""}; query ${run.model ?? (run.sql ? "none (exact query)" : "console default")}; answer ${run.answerModel ?? "none (table only)"}`);
  say("ASK", run.question);

  let r: Response;
  try {
    r = await fetch(`${api}/agent/crossask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(run) });
  } catch (e) {
    say("STOP", `the console API is not answering at ${api} (${(e as Error).name}); nothing was run or paid`); return 2;
  }
  if (!r.ok || !/^text\/event-stream/i.test(r.headers.get("content-type") ?? "")) {
    const j = (await r.json().catch(() => ({}))) as { error?: unknown };
    say("STOP", `the run was not started (HTTP ${r.status}${typeof j.error === "string" ? `: ${j.error}` : ""}); nothing was run or paid`); return 2;
  }

  let n = 0, jobId: string | null = null, settled: { transaction: string; network: string } | null = null, released: unknown, receipt: "verified" | "failed" | "none" = "none", end = "ended";
  const reader = r.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
      const f = parseFrame(buffer.slice(0, at)); buffer = buffer.slice(at + 2);
      if (!f) continue;
      // estimate-first (the default) names the job in "estimated", run-hold in "job_ran" (agent-jobs-core.ts emit).
      if ((f.type === "job_ran" || f.type === "estimated") && typeof f.data.jobId === "string" && /^[0-9a-f]{32}$/.test(f.data.jobId)) jobId = f.data.jobId;
      if (f.type === "settled") settled = { transaction: String(f.data.transaction), network: String(f.data.network) };
      if (f.type === "released") released = f.data.result;
      if (f.type === "receipt_verified") receipt = "verified";
      if (f.type === "receipt_failed") receipt = "failed";
      if (["done", "refused", "error"].includes(f.type)) end = f.type;
      const line = stepLine(tenant, f.type, f.data);
      if (line !== undefined) process.stdout.write(`  ${String(++n).padStart(2)}. ${line}\n`);
      else process.stdout.write(`  ${String(++n).padStart(2)}. [ChainAim] Result released: ${String(f.data.rows)} row(s)\n`);
    }
  }

  if (released !== undefined) process.stdout.write(`\n${resultText(released, showRows)}\n\n`);
  if (end !== "done" || released === undefined || !settled || !jobId) {
    say("FAIL", end === "refused" ? "not paid (refused): see the last step" : `the run ${end} before the result arrived${settled ? ` (it was paid: transaction ${settled.transaction})` : ""}`);
    return 1;
  }
  say("PAID", `transaction ${settled.transaction} on ${settled.network}: ${nearblocks(settled.network, settled.transaction)}`);

  // The signed receipt, saved in the page's download format, with the released result beside it for -VerifyReceipt.
  let saved: { receipt: unknown; publicKeyPem: unknown; ap2?: unknown; mandate?: unknown; attestation?: unknown } | null = null;
  for (let i = 1; i <= pollMax && !saved; i++) {
    if (i > 1) await new Promise((ok) => setTimeout(ok, pollMs));
    const g = await getJson(`/jobs/${jobId}/receipt`);
    // ap2 (privateAI-design-33 ARCH-631): the signed quote the receipt points at, when the console runs with --ap2 on.
    // mandate (privateAI-design-36 ARCH-668): the agent's checkout mandate the receipt records, so -VerifyReceipt re-checks it.
    if (g.status === 200 && g.body?.receipt) saved = { receipt: g.body.receipt, publicKeyPem: g.body.publicKeyPem, ...(g.body.ap2 !== undefined ? { ap2: g.body.ap2 } : {}), ...(typeof g.body.mandate === "string" ? { mandate: g.body.mandate } : {}), ...(g.body.attestation !== undefined ? { attestation: g.body.attestation } : {}) };
    else if (g.status === 404 && /receipts are off/.test(String(g.body?.error))) break;
  }
  mkdirSync(outDir, { recursive: true });
  const resultFile = join(outDir, `chainaim-result-${jobId}.json`);
  writeFileSync(resultFile, JSON.stringify(released, null, 2));
  if (saved) {
    const receiptFile = join(outDir, `chainaim-receipt-${jobId}.json`);
    writeFileSync(receiptFile, JSON.stringify(saved, null, 2));
    say("SAVED", `receipt ${receiptFile}`);
    say("SAVED", `result  ${resultFile}`);
    say("NEXT", `check it offline: .\\test-console\\desk.ps1 -VerifyReceipt "${receiptFile}"`);
  } else {
    say("WARN", `no receipt from the console for job ${jobId} (receipts off, or not made: the console log names job_receipt_failed); result saved to ${resultFile}`);
  }
  if (receipt === "failed") { say("FAIL", "paid, but the agent's receipt check failed: see the step above"); return 1; }
  say("OK", receipt === "verified" ? "paid, result released, receipt verified by the agent with the pinned key" : "paid and result released (the agent's receipt check is off)");
  return 0;
}

try { process.exitCode = await main(); }
catch (e) { if (e instanceof Stop) process.exitCode = e.code; else throw e; }
