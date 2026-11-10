/**
 * Tab 03 "agent mode" (architecture-tab03-agent-mode.md ARCH-302 to ARCH-306): a tenant's AI agent asks the
 * question, has ChainAim's existing paid job run and quoted, and pays the quote by itself in USDC on NEAR from the
 * tenant's own account. The HTTP server is scripts/agent-jobs.ts; this file holds the tenants, the payment queue,
 * the one tool and the run, so the tests can drive them in-process.
 *
 * One run (POST /run on the agent service):
 *   1. the typed question is masked here (scripts/prompt-scan.ts, fail closed) before the agent's model sees it;
 *      the `masked` step carries kinds and counts only
 *   2. a Strands agent with one tool, chainaim_ask_across_files, is invoked on the masked question
 *   3. the tool posts the job to the console (POST <console>/jobs/crossask: run, meter, quote, hold, register) with
 *      the user's question as typed, exactly as the manual Intear flow does; the console's job pipeline masks what
 *      its models see, as it does for every job
 *   4. it pays <paywall>/v1/jobs/<jobId>/release with payAndFetchNear (scripts/near.ts) and the tenant's payer:
 *      a NEP-366 delegate signed with the tenant's key and submitted by ChainAim's relayer, so the tenant account
 *      needs USDC only
 *   5. the released result goes to the run's event stream only. The tool's reply to the model is
 *      {status, amountUsdc, transaction, rows} (rows = how many result rows, never their values); the agent
 *      writes no summary and its final text is not used
 *
 * Payments run one at a time per tenant account (AccountQueue): one NEAR key signs one delegate at a time (its
 * nonce). A hang-up or timeout before the delegate is signed cancels the run with nothing paid; once signed, the run
 * completes and is logged. Logs carry the tenant, job id, status and milliseconds: never a question, a result or a key.
 */
import { Agent, tool, type Model } from "@strands-agents/sdk";
import { z } from "zod";
import { NEAR_NETWORKS } from "../src/config.ts";
import { nearBuyer, nearNetworkName, payAndFetchNear, SetupError, type NearBuyer } from "./near.ts";
import { AskRefused } from "./private-ask-core.ts";
import type { PromptScan } from "./prompt-scan.ts";
import { loadTenants } from "./rig-core.ts";

export { SetupError };

export const JOBS_TOOL_NAME = "chainaim_ask_across_files";

/** A tenant the agent pays for. The payer holds the key inside its signer; nothing here exposes it. */
export type AgentTenant = { id: string; name: string; accountId: string; keyVariable: string; buyer: NearBuyer };

/** What GET /tenants shows: ids, names and NEAR accounts, never a key or a variable's value. */
export type PublicTenant = { id: string; name: string; accountId: string };

/**
 * The relayer pays the gas and holds ChainAim's key; it must never sit beside the tenants' keys. Refuses start-up,
 * naming the variable only, when the agent's environment holds one.
 */
export function refuseRelayerKey(env: Record<string, string | undefined>): void {
  const found = Object.keys(env).filter((n) => /^NEAR_RELAYER_KEY_/.test(n) && (env[n] ?? "").trim() !== "");
  if (found.length > 0) throw new SetupError(`${found.join(", ")} is in the agent's environment: the relayer key never belongs in the agent's env file (ARCH-302); remove it`);
}

/**
 * The tenants in `ids`, from <dir>/<id>/tenant.json (near.accountId, near.keyEnv), each with its payer built by
 * nearBuyer from `env`. A missing tenant folder, NEAR entry or key stops here, naming the tenant and the variable.
 */
export function loadAgentTenants(dir: string, ids: readonly string[], env: Record<string, string | undefined>): AgentTenant[] {
  if (ids.length === 0) throw new SetupError("--agent-tenants must name at least one tenant");
  refuseRelayerKey(env);
  const network = nearNetworkName(env);
  const tenants = loadTenants(dir, ids).map((t): AgentTenant => {
    if (!t.near) throw new SetupError(`tenant ${t.id}: ${t.id}/tenant.json has no "near" entry (accountId and keyEnv)`);
    let buyer: NearBuyer;
    try {
      buyer = nearBuyer(env, { accountId: t.near.accountId, keyPrefix: t.near.keyEnv });
    } catch (e) {
      if (!(e instanceof SetupError)) throw e;
      throw new SetupError(`tenant ${t.id}: ${e.message}`);
    }
    return { id: t.id, name: t.name, accountId: t.near.accountId, keyVariable: `${t.near.keyEnv}_${network.toUpperCase()}`, buyer };
  });
  const seen = new Map<string, string>();
  for (const t of tenants) {
    const other = seen.get(t.accountId);
    if (other) throw new SetupError(`tenants ${other} and ${t.id} use the same NEAR account ${t.accountId}; give each its own`);
    seen.set(t.accountId, t.id);
  }
  return tenants;
}

export function publicTenants(tenants: readonly AgentTenant[]): PublicTenant[] {
  return tenants.map(({ id, name, accountId }) => ({ id, name, accountId }));
}

/** One payment at a time per account, in the order asked; accounts run side by side. */
export class AccountQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(account: string, task: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(account) ?? Promise.resolve();
    const next = tail.then(task, task);
    const settled = next.catch(() => undefined);
    this.tails.set(account, settled);
    void settled.then(() => {
      if (this.tails.get(account) === settled) this.tails.delete(account);
    });
    return next;
  }
}

/** The run's steps, in order (ARCH-306). `refused` / `error` end a run early; `error` after signing carries the transaction when known. */
export type AgentEvent =
  | { type: "masked"; counts: Record<string, number> }
  | { type: "tool_called"; tool: string }
  | { type: "job_ran"; jobId: string; expiresAt: number }
  | { type: "quoted"; jobId: string; amount: string; totalUsd: string; network: string; asset: string; payTo: string }
  | { type: "signed"; account: string }
  | { type: "settled"; transaction: string; network: string }
  | { type: "released"; jobId: string; rows: number; calls: number; result: unknown }
  | { type: "done" }
  | { type: "refused"; reason: string }
  | { type: "error"; reason: string; transaction?: string };

/** What the agent's model receives from the tool: never the result's rows, table or worded answer (ARCH-305). */
export type JobsToolReply =
  | { status: "paid"; amountUsdc: string; transaction: string; rows: number }
  | { status: "refused" | "failed"; reason: string };

/**
 * One run, as POST /run takes it. The page's own tab 03 fields plus the tenant. datasetId / templateLabel (privateAI-design-32
 * ARCH-613) are passed on to the console's /jobs/crossask for the job's receipt; the console checks them again
 * (test-console/console/receipt.ts datasetIdOf, templateLabelOf).
 */
export type RunRequest = { tenant: string; folder: string; question: string; model?: string; answerModel?: string; phrase: "llm" | "none"; sql?: string; datasetId?: string; templateLabel?: string };

const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;
/** The same shapes the console accepts for a receipt (receipt.ts DATASET_ID, TEMPLATE_LABEL). */
const DATASET_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const TEMPLATE_LABEL = /^[\x20-\x7E]{1,120}$/;

/** RunRequest from a parsed body, or a plain reason it is refused (400). The same checks as the console's /jobs/crossask, plus the tenant. */
export function parseRunRequest(body: unknown, tenants: ReadonlySet<string>): RunRequest | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.tenant !== "string" || !tenants.has(b.tenant)) return { error: `tenant must be one of ${[...tenants].join(", ")}` };
  if (typeof b.folder !== "string" || !b.folder || typeof b.question !== "string" || !b.question.trim()) return { error: "folder and question are required" };
  if (b.question.length > 4000) return { error: "question must be at most 4000 characters" };
  for (const k of ["model", "answerModel"] as const) {
    if (b[k] !== undefined && b[k] !== "" && (typeof b[k] !== "string" || !MODEL_ID.test(b[k] as string))) return { error: `${k} must look like provider/name` };
  }
  if (b.phrase !== undefined && b.phrase !== "llm" && b.phrase !== "none") return { error: "phrase must be llm or none" };
  if (b.sql !== undefined && typeof b.sql !== "string") return { error: "sql must be a string" };
  if (b.datasetId !== undefined && (typeof b.datasetId !== "string" || !DATASET_ID.test(b.datasetId))) return { error: "datasetId must be 1-64 letters, digits, dot, dash or underscore" };
  if (b.templateLabel !== undefined && (typeof b.templateLabel !== "string" || !TEMPLATE_LABEL.test(b.templateLabel.trim()))) return { error: "templateLabel must be 1-120 printable ASCII characters" };
  return {
    tenant: b.tenant,
    folder: b.folder,
    question: b.question,
    ...(typeof b.model === "string" && b.model ? { model: b.model } : {}),
    ...(typeof b.answerModel === "string" && b.answerModel ? { answerModel: b.answerModel } : {}),
    phrase: b.phrase === "none" ? "none" : "llm",
    ...(typeof b.sql === "string" && b.sql.trim() ? { sql: b.sql } : {}),
    ...(typeof b.datasetId === "string" ? { datasetId: b.datasetId } : {}),
    ...(typeof b.templateLabel === "string" ? { templateLabel: b.templateLabel.trim() } : {}),
  };
}

export type RunDeps = {
  tenants: ReadonlyMap<string, AgentTenant>;
  /** The console API's base address (its /jobs/crossask). */
  console: string;
  /** The paywall's base address (its /v1/jobs/<id>/release). */
  paywall: string;
  /** How the question is masked; required when promptMask is on. */
  scan?: PromptScan;
  promptMask: boolean;
  /** A model for one run: Bedrock in the service, a scripted model in the tests. */
  makeModel: () => Model;
  maxTurns: number;
  /** A USDC ceiling per payment; unset = no limit (owner decision 1). */
  maxAmount?: string;
  queue: AccountQueue;
  /** How the agent's instructions name the tenant; the tenant's real name is never sent unless given here. */
  tenantLabel: string;
  /** One JSON line per run: tenant, job id, status, milliseconds. */
  log?: (line: string) => void;
};

export function systemPrompt(tenantLabel: string): string {
  return [
    `You are the paying agent of ${tenantLabel}. The user asks a question about their data files, and you answer it with one tool, ${JOBS_TOOL_NAME}.`,
    "Call the tool exactly once, with the user's question as given. Do not ask the user anything first.",
    "The tool runs ChainAim's job on the user's files, pays its quoted price in USDC on NEAR from the user's own account, and shows the result to the user directly.",
    "You receive only whether it was paid, the amount, the transaction and how many result rows there are. You never see the result.",
    "Values like <C_PERSON_1> stand for personal details kept out of your view; repeat them exactly as written.",
    "After the tool returns, reply with one short sentence saying whether it was paid and that the result is shown on the page. Do not describe, summarise or guess the result. If the tool refused or failed, say why and do not call it again.",
  ].join("\n");
}

type Terminal = "done" | "refused" | "error";

/**
 * One run. `emit` gets the steps in order and always ends with done, refused or error. `signal` is the caller's
 * hang-up or the run's timeout: honoured until the delegate is signed, ignored after it.
 */
export async function runAgentJob(req: RunRequest, deps: RunDeps, emit: (e: AgentEvent) => void, signal: AbortSignal): Promise<Terminal> {
  const started = Date.now();
  let jobId: string | undefined;
  let ended: Terminal | undefined;
  const end = (e: AgentEvent & { type: Terminal }): Terminal => {
    if (ended === undefined) {
      ended = e.type;
      emit(e);
    }
    return ended;
  };
  const finish = (status: Terminal): Terminal => {
    deps.log?.(JSON.stringify({ ts: new Date().toISOString(), route: "agent-run", tenant: req.tenant, jobId: jobId ?? null, status, ms: Date.now() - started }));
    return status;
  };
  const tenant = deps.tenants.get(req.tenant);
  if (!tenant) return finish(end({ type: "refused", reason: `unknown tenant ${req.tenant}` }));

  // 1. The question is masked before any model call; a scanner that fails refuses it (fail closed).
  let masked: string;
  try {
    if (deps.promptMask) {
      if (!deps.scan) throw new AskRefused("prompt masking is on but no scanner is set up; nothing was sent");
      const m = await deps.scan.mask(req.question);
      masked = m.masked;
      emit({ type: "masked", counts: m.counts });
    } else {
      masked = req.question;
      emit({ type: "masked", counts: {} });
    }
  } catch (e) {
    if (!(e instanceof AskRefused)) throw e;
    return finish(end({ type: "refused", reason: e.message }));
  }
  if (signal.aborted) return finish(end({ type: "refused", reason: "the request was cancelled before anything was run or paid" }));

  // 2-5. The agent and its one tool. The tool emits the job's steps; its reply to the model has no result in it.
  let called = false;
  const jobsTool = tool({
    name: JOBS_TOOL_NAME,
    description:
      "Run ChainAim's paid job for the user's question on their data files and pay its quoted price in USDC on NEAR from the user's account. The result is shown to the user directly; you receive only the status, the amount, the transaction and the number of result rows.",
    inputSchema: z.object({ question: z.string().min(1).max(4000).describe("The user's question, as given.") }),
    callback: async (): Promise<JobsToolReply> => {
      if (called) return { status: "refused", reason: "this request's job was already run; one job per request" };
      called = true;
      emit({ type: "tool_called", tool: JOBS_TOOL_NAME });
      const out = await runAndPay(req, tenant, deps, emit, signal, (id) => (jobId = id));
      if (out.terminal) end(out.terminal);
      return out.reply;
    },
  });
  const agent = new Agent({ model: deps.makeModel(), tools: [jobsTool], systemPrompt: systemPrompt(deps.tenantLabel), toolExecutor: "sequential", printer: false });
  try {
    await agent.invoke(masked, { limits: { turns: deps.maxTurns } });
  } catch (e) {
    // After a paid release the result has already gone out; a failing last model turn changes nothing for the user.
    if (ended === undefined && !called) return finish(end({ type: "error", reason: `the agent's model failed, so no job was run and nothing was paid: ${e instanceof Error ? e.message : String(e)}` }));
  }
  if (!called) return finish(end({ type: "error", reason: "the agent's model did not call the tool, so no job was run and nothing was paid; ask again" }));
  return finish(end({ type: "done" }));
}

/** The tool's body: run and quote the job on the console, pay its release, emit the result. */
async function runAndPay(
  req: RunRequest,
  tenant: AgentTenant,
  deps: RunDeps,
  emit: (e: AgentEvent) => void,
  signal: AbortSignal,
  setJobId: (id: string) => void,
): Promise<{ reply: JobsToolReply; terminal?: AgentEvent & { type: "refused" | "error" } }> {
  const refuse = (reason: string) => ({ reply: { status: "refused" as const, reason }, terminal: { type: "refused" as const, reason } });
  if (signal.aborted) return refuse("the request was cancelled before anything was run or paid");

  // Run, meter, quote, hold, register: the console answers the cost and the job id only.
  let job: { jobId: string; totalUsd: string; amount: string; network: string; asset: string; payTo: string; expiresAt: number };
  try {
    const r = await fetch(`${deps.console}/jobs/crossask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: req.folder, question: req.question, model: req.model, answerModel: req.answerModel, phrase: req.phrase, sql: req.sql, datasetId: req.datasetId, templateLabel: req.templateLabel }),
      signal,
    });
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (!r.ok) return refuse(`the job did not run, so nothing was paid: ${typeof j?.error === "string" ? j.error : `HTTP ${r.status} from the console`}`);
    if (
      typeof j?.jobId !== "string" || !/^[0-9a-f]{32}$/.test(j.jobId) || typeof j.totalUsd !== "string" || typeof j.amount !== "string" ||
      typeof j.network !== "string" || typeof j.asset !== "string" || typeof j.payTo !== "string" || typeof j.expiresAt !== "number"
    ) return refuse("the console's quote could not be read, so nothing was paid");
    job = { jobId: j.jobId, totalUsd: j.totalUsd, amount: j.amount, network: j.network, asset: j.asset, payTo: j.payTo, expiresAt: j.expiresAt };
  } catch (e) {
    return refuse(signal.aborted ? "the request was cancelled before anything was paid" : `the console could not be reached at ${deps.console}, so nothing was run or paid (${(e as Error).name})`);
  }
  setJobId(job.jobId);
  emit({ type: "job_ran", jobId: job.jobId, expiresAt: job.expiresAt });
  if (job.network !== tenant.buyer.network) return refuse(`the job is quoted on ${job.network}, but this agent pays on ${tenant.buyer.network}; nothing was paid`);
  emit({ type: "quoted", jobId: job.jobId, amount: job.amount, totalUsd: job.totalUsd, network: job.network, asset: job.asset, payTo: job.payTo });

  // The payer, with the hang-up checked right before signing and the `signed` step reported right after.
  let signed = false;
  const inner = tenant.buyer.signer;
  const payer: NearBuyer = {
    ...tenant.buyer,
    signer: {
      accountId: inner.accountId,
      publicKey: inner.publicKey,
      createSignedDelegateAction: async (input) => {
        if (signal.aborted) throw new SetupError("the request was cancelled before the payment was signed; nothing was paid");
        const out = await inner.createSignedDelegateAction(input);
        signed = true;
        emit({ type: "signed", account: inner.accountId });
        return out;
      },
    },
  };
  const fail = (reason: string, transaction?: string) =>
    signed
      ? { reply: { status: "failed" as const, reason }, terminal: { type: "error" as const, reason, ...(transaction ? { transaction } : {}) } }
      : refuse(reason);

  return deps.queue.run(tenant.accountId, async () => {
    let paid;
    try {
      paid = await payAndFetchNear(`${deps.paywall}/v1/jobs/${job.jobId}/release`, { method: "POST", headers: {}, body: "" }, payer, deps.maxAmount ? { maxAmount: deps.maxAmount } : {});
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return fail(signed ? `${reason}; the payment was signed, check ${tenant.accountId}'s recent transactions` : reason);
    }
    if (!signed && paid.response.status !== 200) {
      // The paywall answered without asking for a payment (the job expired, was already released, ...): nothing was signed.
      const text = await paid.response.text().catch(() => "");
      return refuse(`the paywall did not ask for the payment (HTTP ${paid.response.status}${errorMessage(text) ? `: ${errorMessage(text)}` : ""}); nothing was paid`);
    }
    const transaction = paid.receipt?.success === true ? paid.receipt.transaction : undefined;
    let text: string;
    try {
      text = await paid.response.text();
    } catch {
      return fail("the result was lost after the payment went through", transaction);
    }
    if (paid.refusal) return fail(`refused by the paywall: ${paid.refusal}`, transaction);
    if (paid.response.status !== 200 || !transaction) {
      return fail(`the job was not released (HTTP ${paid.response.status}${errorMessage(text) ? `: ${errorMessage(text)}` : ""})`, transaction);
    }
    emit({ type: "settled", transaction, network: paid.receipt?.network ?? job.network });
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      return fail("the released result could not be read", transaction);
    }
    const r = result as { result?: { rows?: unknown[] } | null; served?: { model?: unknown }[] };
    const rows = Array.isArray(r?.result?.rows) ? r.result.rows.length : 0;
    const calls = Array.isArray(r?.served) ? r.served.filter((s) => s && typeof s.model === "string" && s.model !== "").length : 0;
    emit({ type: "released", jobId: job.jobId, rows, calls, result });
    return { reply: { status: "paid" as const, amountUsdc: job.totalUsd, transaction, rows } };
  });
}

/** error.message or error from a JSON error body, cut to one plain line. */
function errorMessage(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as { error?: unknown };
    const said = typeof j.error === "string" ? j.error : typeof (j.error as { message?: unknown })?.message === "string" ? (j.error as { message: string }).message : undefined;
    return said?.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  } catch {
    return undefined;
  }
}

/** One server-sent event, as POST /run writes it. */
export function sseFrame(e: AgentEvent): string {
  const { type, ...data } = e;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The NEAR network the tenants pay on (CAIP-2), for the start-up line. */
export function payingNetwork(env: Record<string, string | undefined>): string {
  return NEAR_NETWORKS[nearNetworkName(env)];
}
