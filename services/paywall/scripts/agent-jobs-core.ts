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
 *   3a. with the signed-quote check (privateAI-design-33 ARCH-630; --ap2-verify on), the console's ap2 checkout is verified
 *      with the PINNED AP2 public key and bound to the quote (agent-ap2.ts): step `quote_signed`, or `refused` carrying
 *      the AP2 error code; the paywall's 402 offer is then bound to the same payee, asset and amount before signing
 *   3b. with a spending policy (privateAI-design-32 ARCH-620; --agent-policy on), the quote goes through the tenant's
 *      policy (packages/agent-policy decide(), the "policy" block of tenant.json) and today's spend from the ledger;
 *      the `policy` step carries each check and the decision. Anything but "pay" ends the run: nothing is signed or paid.
 *      The decision is deterministic code: the agent's model only triggers the tool and never decides to pay
 *   4. it pays <paywall>/v1/jobs/<jobId>/release with payAndFetchNear (scripts/near.ts) and the tenant's payer:
 *      a NEP-366 delegate signed with the tenant's key and submitted by ChainAim's relayer, so the tenant account
 *      needs USDC only
 *   3c. with checkout mandates (privateAI-design-36 ARCH-666; --ap2-mandate on) and a signed estimate-first quote, right
 *      before the payment is signed the agent signs a closed AP2 Checkout Mandate for that quote with the tenant's mandate
 *      key, nonce = the paywall's invoice id (agent-mandate.ts): step `mandate_signed`; it goes with the paid release
 *      (header x-ap2-checkout-mandate) and ChainAim's signer verifies it before the job runs. After the receipt check, the
 *      step `mandate_verified` says whether the receipt records exactly this mandate
 *   4b. with a receipt check (privateAI-design-32 step B; --receipt-verify on), after the release the agent fetches the
 *      job's signed receipt from the console and verifies it with the PINNED public key (agent-receipt.ts): signature,
 *      settlement, the released result's hash, the job id, the amount and the transaction it paid with. The step is
 *      `receipt_verified` or `receipt_failed` (a reason; the payment stands, so never `refused`)
 *   5. the released result goes to the run's event stream only. The tool's reply to the model is
 *      {status, amountUsdc, transaction, rows} (rows = how many result rows, never their values); the agent
 *      writes no summary and its final text is not used
 *
 * Payments run one at a time per tenant account (AccountQueue): one NEAR key signs one delegate at a time (its
 * nonce). The policy check, the payment and the ledger entry run inside the same queue slot, so two runs of one tenant
 * can never both pass the daily cap on the same spend. A hang-up or timeout before the delegate is signed cancels the run with nothing paid; once signed, the run
 * completes and is logged. Logs carry the tenant, job id, status and milliseconds: never a question, a result or a key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, tool, type Model } from "@strands-agents/sdk";
import { z } from "zod";
import { checksFor, decide, parsePolicy, policyView, type Policy, type PolicyCheck, type PolicyView, type Quote, type SpendLedger } from "../../../packages/agent-policy/src/index.ts";
import { NEAR_NETWORKS } from "../src/config.ts";
import { nearBuyer, nearNetworkName, payAndFetchNear, SetupError, type NearBuyer } from "./near.ts";
import { AskRefused } from "./private-ask-core.ts";
import { verifyPaidReceipt, type PaidJob, type ReceiptCheck, type ReceiptEvent } from "./agent-receipt.ts";
import { checkSignedQuote, type Ap2Check, type QuoteSignedEvent } from "./agent-ap2.ts";
import { MANDATE_HEADER, signMandateFor, type MandateSignedEvent, type MandateSigner, type MandateVerifiedEvent } from "./agent-mandate.ts";
import type { Ap2ErrorCode } from "../../../packages/ap2/src/index.ts";
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

/** The buyer-side spending policy (ARCH-620): one parsed policy per tenant and the shared spend ledger. */
export type AgentPolicy = { policies: ReadonlyMap<string, Policy>; ledger: SpendLedger; now?: () => number };

/**
 * The "policy" block of <dir>/<id>/tenant.json for each tenant in `ids` (packages/agent-policy parsePolicy). A missing or
 * malformed block stops start-up, naming the tenant and the field: with the policy on, no tenant is paid for without one.
 */
export function loadPolicies(dir: string, ids: readonly string[]): Map<string, Policy> {
  const out = new Map<string, Policy>();
  for (const id of ids) {
    let raw: { policy?: unknown };
    try {
      raw = JSON.parse(readFileSync(join(dir, id, "tenant.json"), "utf8")) as { policy?: unknown };
    } catch (e) {
      throw new SetupError(`tenant ${id}: ${id}/tenant.json could not be read (${(e as NodeJS.ErrnoException).code ?? "not JSON"})`);
    }
    try {
      out.set(id, parsePolicy(raw.policy, id));
    } catch (e) {
      throw new SetupError((e as Error).message);
    }
  }
  return out;
}

/** What GET /policy shows: each tenant's limits and today's spend; `error` when the ledger cannot be read. */
export function policyViews(tenants: readonly AgentTenant[], policy: AgentPolicy): ({ id: string } & (PolicyView | { error: string }))[] {
  return tenants.map((t) => {
    const p = policy.policies.get(t.id);
    if (!p) return { id: t.id, error: "no policy" };
    try {
      return { id: t.id, ...policyView(p, policy.ledger.spentToday(t.id)) };
    } catch (e) {
      return { id: t.id, error: (e as Error).message };
    }
  });
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
  /** privateAI-design-34 ARCH-642: an estimate-first offer: priced from sizes, nothing run yet (it runs inside the paid release). */
  | { type: "estimated"; jobId: string; expiresAt: number }
  | { type: "quoted"; jobId: string; amount: string; totalUsd: string; network: string; asset: string; payTo: string }
  /** ARCH-630: ChainAim's signed quote verified with the pinned key and bound to the quote; after quoted, before policy. */
  | QuoteSignedEvent
  /** ARCH-620: the tenant's policy applied to the quote; every check with its limit and value, the decision and why. */
  | { type: "policy"; tenant: string; decision: "pay" | "approve" | "counter" | "refuse"; reason: string; checks: PolicyCheck[]; spentTodayUsd: string }
  /** ARCH-666: the tenant's checkout mandate for this quote and this payment, signed right before the payment. */
  | MandateSignedEvent
  | { type: "signed"; account: string }
  | { type: "settled"; transaction: string; network: string }
  | { type: "released"; jobId: string; rows: number; calls: number; result: unknown }
  /** Step B: the job's signed receipt checked against the pinned key (agent-receipt.ts); after released, before done. */
  | ReceiptEvent
  /** ARCH-668: the receipt records the mandate ChainAim's signer verified before the run (or does not). */
  | MandateVerifiedEvent
  | { type: "done" }
  /** code: the UCP AP2 error code when the signed-quote check refused (ARCH-630). */
  | { type: "refused"; reason: string; code?: Ap2ErrorCode }
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
export type RunRequest = { tenant: string; folder: string; question: string; model?: string; answerModel?: string; phrase: "llm" | "none"; sql?: string; datasetId?: string; templateLabel?: string; offerMode?: OfferMode };
/** privateAI-design-34 owner D4/D5: estimate-first = POST /offers (no work before payment); run-hold = POST /jobs/crossask (as before). */
export type OfferMode = "estimate-first" | "run-hold";
export const OFFER_MODES: readonly OfferMode[] = ["estimate-first", "run-hold"];

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
  if (b.offerMode !== undefined && !(OFFER_MODES as readonly unknown[]).includes(b.offerMode)) return { error: `offerMode must be ${OFFER_MODES.join(" or ")}` };
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
    ...(b.offerMode !== undefined ? { offerMode: b.offerMode as OfferMode } : {}),
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
  /** The tenants' spending policy (ARCH-620); unset = no policy step (--agent-policy off). */
  policy?: AgentPolicy;
  /** The receipt check after a paid release (step B); unset = no receipt step (--receipt-verify off). */
  receiptCheck?: ReceiptCheck;
  /** The signed-quote check before the policy (ARCH-630); unset = no quote_signed step (--ap2-verify off). */
  ap2Check?: Ap2Check;
  /** ARCH-666: the tenants' checkout mandate keys (--ap2-mandate on); unset = no mandate is signed. */
  mandates?: MandateSigner;
  queue: AccountQueue;
  /** The mode for a run that names none (agent-jobs.ts --offer-mode, default estimate-first); unset = run-hold. */
  defaultOfferMode?: OfferMode;
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

  // estimate-first (ARCH-642): POST /offers prices from sizes and runs nothing; run-hold: POST /jobs/crossask runs, meters,
  // quotes, holds and registers. Either way the console answers the cost and the job id only.
  const mode: OfferMode = req.offerMode ?? deps.defaultOfferMode ?? "run-hold";
  const estimateFirst = mode === "estimate-first";
  let job: { jobId: string; totalUsd: string; amount: string; network: string; asset: string; payTo: string; expiresAt: number; route?: string; attested: boolean; ap2?: unknown };
  try {
    const r = await fetch(`${deps.console}${estimateFirst ? "/offers" : "/jobs/crossask"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: req.folder, question: req.question, model: req.model, answerModel: req.answerModel, phrase: req.phrase, sql: req.sql, datasetId: req.datasetId, templateLabel: req.templateLabel }),
      signal,
    });
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (estimateFirst && r.status === 404) return refuse("this console does not offer estimate-first pricing (no config/cost-model.json: run desk.ps1 -Calibrate), so nothing was run or paid; ask again with offerMode run-hold");
    if (!r.ok) return refuse(`${estimateFirst ? "the job could not be estimated" : "the job did not run"}, so nothing was paid: ${typeof j?.error === "string" ? j.error : `HTTP ${r.status} from the console`}`);
    if (
      typeof j?.jobId !== "string" || !/^[0-9a-f]{32}$/.test(j.jobId) || typeof j.totalUsd !== "string" || typeof j.amount !== "string" ||
      typeof j.network !== "string" || typeof j.asset !== "string" || typeof j.payTo !== "string" || typeof j.expiresAt !== "number"
    ) return refuse("the console's quote could not be read, so nothing was paid");
    // route / attested (ARCH-620): what the console says the job ran on; a console that does not say counts as not attested.
    job = { jobId: j.jobId, totalUsd: j.totalUsd, amount: j.amount, network: j.network, asset: j.asset, payTo: j.payTo, expiresAt: j.expiresAt,
      ...(typeof j.route === "string" ? { route: j.route } : {}), attested: j.attested === true, ...(j.ap2 !== undefined ? { ap2: j.ap2 } : {}) };
  } catch (e) {
    return refuse(signal.aborted ? "the request was cancelled before anything was paid" : `the console could not be reached at ${deps.console}, so nothing was run or paid (${(e as Error).name})`);
  }
  setJobId(job.jobId);
  emit({ type: estimateFirst ? "estimated" : "job_ran", jobId: job.jobId, expiresAt: job.expiresAt });
  if (job.network !== tenant.buyer.network) return refuse(`the job is quoted on ${job.network}, but this agent pays on ${tenant.buyer.network}; nothing was paid`);
  emit({ type: "quoted", jobId: job.jobId, amount: job.amount, totalUsd: job.totalUsd, network: job.network, asset: job.asset, payTo: job.payTo });
  // ARCH-630: the signed quote, before the policy and before anything is signed.
  if (deps.ap2Check) {
    const v = checkSignedQuote(deps.ap2Check, job.ap2, job);
    if (!v.ok) {
      const reason = `ChainAim's signed quote was refused (${v.code}): ${v.reason}; nothing was signed or paid`;
      return { reply: { status: "refused" as const, reason }, terminal: { type: "refused" as const, reason, code: v.code } };
    }
    emit(v.event);
  }

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

  type Slot = { reply: JobsToolReply; terminal?: AgentEvent & { type: "refused" | "error" }; paid?: PaidJob };
  let mandateSha: string | undefined;
  const out: Slot = await deps.queue.run(tenant.accountId, async (): Promise<Slot> => {
    // ARCH-620: the policy decides before anything is signed; in this queue slot, so today's spend cannot change under it.
    let maxAmount = deps.maxAmount;
    if (deps.policy) {
      const verdict = applyPolicy(deps.policy, tenant.id, job, emit);
      if ("refused" in verdict) return refuse(verdict.refused);
      maxAmount = verdict.maxAmount(maxAmount);
    }
    // ARCH-666: a mandate only for an estimate-first quote ChainAim signed (that is the run step its signer checks it in).
    const ap2 = job.ap2 as { checkout?: unknown; merchant_authorization?: unknown } | undefined;
    const withMandate = deps.mandates !== undefined && estimateFirst && typeof ap2?.merchant_authorization === "string" && typeof ap2.checkout === "object" && ap2.checkout !== null;
    let paid;
    try {
      paid = await payAndFetchNear(`${deps.paywall}/v1/jobs/${job.jobId}/release`, { method: "POST", headers: {}, body: "" }, payer, {
        ...(maxAmount ? { maxAmount } : {}),
        ...(deps.ap2Check ? { requireOffer: { payTo: job.payTo, asset: job.asset, amount: job.amount } } : {}),
        ...(withMandate ? {
          headersFor: (offer: { invoiceId?: string }) => {
            const m = signMandateFor(deps.mandates!, tenant.id, job.jobId, ap2 as { checkout: Record<string, unknown>; merchant_authorization: string }, offer.invoiceId);
            mandateSha = m.event.sha256;
            emit(m.event);
            return { [MANDATE_HEADER]: m.presentation };
          },
        } : {}),
      });
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
    if (deps.policy) {
      // Only a settled payment counts toward the daily cap. A failed write is logged (ids only); the payment stands.
      try {
        deps.policy.ledger.record(tenant.id, job.jobId, job.totalUsd, transaction);
      } catch (e) {
        deps.log?.(JSON.stringify({ ts: new Date().toISOString(), route: "agent-run", event: "spend_record_failed", tenant: tenant.id, jobId: job.jobId, reason: String((e as Error).message).slice(0, 200) }));
      }
    }
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
    return { reply: { status: "paid" as const, amountUsdc: job.totalUsd, transaction, rows }, paid: { jobId: job.jobId, amount: job.amount, transaction, result } };
  });
  // Step B, outside the queue slot (the tenant's next payment need not wait for it): the receipt of the paid job.
  if (out.paid && deps.receiptCheck) {
    const rc = await verifyPaidReceipt(deps.receiptCheck, deps.console, out.paid);
    emit(rc);
    // ARCH-668: ChainAim's signer verified the mandate before the run exactly when the receipt it signed records this hash.
    if (mandateSha) {
      const recorded = rc.type === "receipt_verified" ? rc.mandateSha256 : undefined;
      emit(recorded === mandateSha
        ? { type: "mandate_verified", jobId: out.paid.jobId, sha256: mandateSha, by: "ChainAim's signer", ok: true }
        : { type: "mandate_verified", jobId: out.paid.jobId, sha256: mandateSha, by: "ChainAim's signer", ok: false, reason: rc.type === "receipt_verified" ? (recorded ? "the receipt records another mandate" : "the receipt records no mandate (is the signer's mandate key registry loaded?)") : "the receipt could not be checked" });
    }
  }
  return { reply: out.reply, ...(out.terminal ? { terminal: out.terminal } : {}) };
}

/**
 * The tenant's policy on one quote (ARCH-620). Emits the `policy` step. "pay" returns how to cap the signer: the
 * smaller of --agent-max-amount and the quoted price, so the payer cannot sign more than the policy approved even if
 * the paywall asked for more. Anything else returns the refusal: nothing is signed or paid. ARCH-621 (a person approves
 * in tab 03) and ARCH-623 (counter-offers) are not built yet, so "approve" and "counter" stop the run and say so.
 */
function applyPolicy(
  policy: AgentPolicy,
  tenantId: string,
  job: { jobId: string; totalUsd: string; expiresAt: number; route?: string; attested: boolean },
  emit: (e: AgentEvent) => void,
): { refused: string } | { maxAmount: (cap: string | undefined) => string } {
  const p = policy.policies.get(tenantId);
  if (!p) return { refused: `tenant ${tenantId} has no spending policy, so nothing was signed or paid` };
  let spent: bigint;
  try {
    spent = policy.ledger.spentToday(tenantId);
  } catch (e) {
    return { refused: `the spend ledger could not be read (${(e as Error).message}), so nothing was signed or paid` };
  }
  // The quote in plain decimals ("0.010000" -> "0.01"), so the checks and the reasons read as the page shows prices.
  const quote: Quote = { quoteId: job.jobId, route: job.route ?? "unknown", priceUsd: plainUsd(job.totalUsd), attested: job.attested, expiresAt: job.expiresAt };
  const now = (policy.now ?? Date.now)();
  let checks: PolicyCheck[];
  let d: ReturnType<typeof decide>;
  try {
    checks = checksFor(p, quote, { spentTodayMicro: spent, now });
    d = decide(p, [quote], { spentTodayMicro: spent, now });
  } catch (e) {
    return { refused: `the quote could not be checked against the policy (${(e as Error).message}), so nothing was signed or paid` };
  }
  emit({ type: "policy", tenant: tenantId, decision: d.action, reason: d.reason, checks, spentTodayUsd: policyView(p, spent).spentTodayUsd });
  if (d.action === "pay") {
    return { maxAmount: (cap) => (cap !== undefined && decimalLess(cap, job.totalUsd) ? cap : job.totalUsd) };
  }
  const by = `${tenantId}'s spending policy`;
  if (d.action === "approve") return { refused: `${by} needs a person to approve this ${plainUsd(job.totalUsd)} USDC job (${d.reason}); approval in tab 03 is not built yet (ARCH-621), so nothing was signed or paid` };
  if (d.action === "counter") return { refused: `${by} would ask for a smaller job at ${d.ceilingUsd} USD (${d.reason}); counter-offers are not built yet (ARCH-623), so nothing was signed or paid` };
  return { refused: `refused by ${by}: ${d.reason}; nothing was signed or paid` };
}

/** A non-negative decimal without trailing zeros ("0.010000" -> "0.01", "1.000" -> "1"); anything else unchanged. */
export function plainUsd(v: string): string {
  if (!/^\d+\.\d+$/.test(v)) return v;
  return v.replace(/0+$/, "").replace(/\.$/, "");
}

/** a < b for two non-negative decimal strings of any length (no float). */
function decimalLess(a: string, b: string): boolean {
  const [ai, af = ""] = a.split("."), [bi, bf = ""] = b.split(".");
  const n = Math.max(af.length, bf.length);
  return BigInt(ai + af.padEnd(n, "0")) < BigInt(bi + bf.padEnd(n, "0"));
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
