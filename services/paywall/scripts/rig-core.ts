/**
 * The test rig's logic: several tenants, each with its own XRP Ledger wallet,
 * pay a paywall route in RLUSD again and again, as many agents would. The
 * command line is scripts/rig.ts; this file holds what it runs, so the tests
 * can drive it in-process against a stub paywall and a stub ledger.
 *
 * A tenant is a folder: tenant.json names it and the variable prefix its
 * seed is read from (never the seed), and queries.json holds the texts it
 * sends. Every text is masked on this machine first (scripts/client-mask.ts),
 * exactly as private-ask.ts does, and refused if the masked text still holds
 * something that should have been masked.
 *
 * One payment from a wallet at a time: each XRP Ledger account numbers its
 * transactions, so a tenant's calls run one after another while tenants run
 * side by side. Each tenant has a spending ceiling, checked before every
 * payment is signed.
 *
 * Records written per call carry the tenant, payer address, status, amount,
 * invoice id and transaction: never a seed, a request text or an answer.
 *
 * Loop mode (live ops, Phase 2): calls may be unlimited (null) and bounded by
 * a deadline and/or an abort signal instead; pacing is either a pause after
 * each call (intervalMs, as before) or a steady rate per tenant (ratePerMin,
 * measured start to start), each with optional jitter. The spending ceiling
 * applies in every mode. Each step of a paid call can be traced to
 * ledger-watch (scripts/trace.ts), fire-and-forget.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detect, maskText } from "./client-mask.ts";
import { isNearAccountId } from "../src/config.ts";
import { traceEvent, type Tracer } from "./trace.ts";
import { payAndFetchNear, type NearBuyer } from "./near.ts";
import { decimalUnits, payAndFetch, SetupError, unitsToDecimal, type Buyer, type Paid, type PayOptions, type PayStep, type StepInfo } from "./xrpl.ts";

/**
 * A tenant pays on one rail per run (rig.ts --rail): an XRPL Buyer (RLUSD) or
 * a NearBuyer (USDC on NEAR). Both prices are dollar stablecoin decimals, so
 * the spending ceiling and the records read the same on either rail.
 */
export type RigBuyer = Buyer | NearBuyer;

export function isNearBuyer(buyer: RigBuyer): buyer is NearBuyer {
  return "accountId" in buyer.signer;
}

/** The paying account: an XRPL address or a NEAR account id. */
export function payerOf(buyer: RigBuyer): string {
  return isNearBuyer(buyer) ? buyer.signer.accountId : buyer.signer.classicAddress;
}

export const ENDPOINTS = { scan: "/v1/privacy/scan", mask: "/v1/privacy/mask", chat: "/v1/chat/completions" } as const;
export type Endpoint = keyof typeof ENDPOINTS;
/** The gateway's limits: 48,000 characters of chat text; 20,000 for scan and mask. */
const LIMITS: Record<Endpoint, number> = { chat: 48_000, scan: 20_000, mask: 20_000 };

export type Tenant = {
  id: string;
  name: string;
  seedPrefix: string;
  queries: string[];
  /** The tenant's NEAR account and the prefix of the variable holding its key (PREFIX_TESTNET), for --rail near. */
  near?: { accountId: string; keyEnv: string };
};

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new SetupError(`cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new SetupError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * The tenants under `dir`, in folder-name order: every folder holding a
 * tenant.json, or only those named in `only`. A folder's id must match its
 * tenant.json id, so a copied folder cannot silently pay as another tenant.
 */
export function loadTenants(dir: string, only?: readonly string[]): Tenant[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
  } catch (e) {
    throw new SetupError(`cannot read the tenants folder ${dir}: ${(e as Error).message}`);
  }
  if (only) {
    const missing = only.filter((id) => !names.includes(id));
    if (missing.length > 0) throw new SetupError(`no tenant folder for ${missing.join(", ")} in ${dir}`);
    names = names.filter((n) => only.includes(n));
  }
  const tenants = names.map((folder): Tenant => {
    const t = readJson(join(dir, folder, "tenant.json")) as { id?: unknown; name?: unknown; seedPrefix?: unknown; near?: unknown };
    if (t.id !== folder) throw new SetupError(`${folder}/tenant.json: "id" must be "${folder}", the folder's name`);
    if (typeof t.name !== "string" || !t.name.trim()) throw new SetupError(`${folder}/tenant.json: "name" is required`);
    if (typeof t.seedPrefix !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(t.seedPrefix)) {
      throw new SetupError(`${folder}/tenant.json: "seedPrefix" must be a variable name prefix such as XRPL_SEED_T01 (capital letters, digits, _)`);
    }
    const q = readJson(join(dir, folder, "queries.json"));
    if (!Array.isArray(q) || q.length === 0 || !q.every((s) => typeof s === "string" && s.trim() !== "")) {
      throw new SetupError(`${folder}/queries.json must be a non-empty list of texts`);
    }
    let near: Tenant["near"];
    if (t.near !== undefined) {
      const n = t.near as { accountId?: unknown; keyEnv?: unknown } | null;
      if (typeof n?.accountId !== "string" || !isNearAccountId(n.accountId)) throw new SetupError(`${folder}/tenant.json: "near.accountId" must be a NEAR account id such as t01.chainaim.testnet`);
      if (typeof n.keyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(n.keyEnv)) {
        throw new SetupError(`${folder}/tenant.json: "near.keyEnv" must be a variable name prefix such as NEAR_KEY_T01 (capital letters, digits, _)`);
      }
      near = { accountId: n.accountId, keyEnv: n.keyEnv };
    }
    return { id: folder, name: t.name, seedPrefix: t.seedPrefix, queries: q as string[], ...(near ? { near } : {}) };
  });
  if (tenants.length === 0) throw new SetupError(`no tenants in ${dir}: each tenant is a folder with tenant.json and queries.json`);
  return tenants;
}

/** Two tenants sharing one wallet would race for its transaction numbers. */
export function checkDistinct(buyers: readonly { tenant: Tenant; buyer: RigBuyer }[]): void {
  const seen = new Map<string, string>();
  for (const { tenant, buyer } of buyers) {
    const payer = payerOf(buyer);
    const other = seen.get(payer);
    if (other) throw new SetupError(`tenants ${other} and ${tenant.id} use the same account ${payer}; give each its own ${isNearBuyer(buyer) ? "NEAR account" : "seed"}`);
    seen.set(payer, tenant.id);
  }
}

export type Prepared = { bodyText: string; counts: Record<string, number> };

/**
 * Mask one text on this machine and build the request body for the endpoint.
 * Throws a SetupError when the masked text still holds a value that should be
 * masked, or is too long: nothing is sent and nothing is paid.
 */
export function prepareRequest(endpoint: Endpoint, text: string, maxTokens: number): Prepared {
  const { masked, counts } = maskText(text);
  if (detect(masked).length > 0) throw new SetupError("the masked text still holds a value that should be masked; nothing was sent");
  if (masked.length > LIMITS[endpoint]) throw new SetupError(`the text is ${masked.length} characters after masking; ${endpoint} takes at most ${LIMITS[endpoint]}; nothing was sent`);
  const body = endpoint === "chat" ? { model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens } : { text: masked };
  return { bodyText: JSON.stringify(body), counts };
}

export type RunOptions = {
  /** The paywall's base address, without a trailing slash. */
  url: string;
  endpoint: Endpoint;
  /** Calls per tenant; null = no limit (loop mode: a deadline, the signal or the spending ceiling ends the run). */
  calls: number | null;
  /** Pause between one tenant's calls (after one ends, before the next starts). Ignored when ratePerMin is set. */
  intervalMs: number;
  /** Calls per minute per tenant, start to start; a slow call is not made up for with a burst. */
  ratePerMin?: number;
  /** 0 to 1: each pause is scaled by a random factor in [1 - jitter, 1 + jitter]. */
  jitter?: number;
  /** Absolute time (deps.now clock) after which no new call starts. */
  deadline?: number;
  /** The most one tenant may spend in this run, in the rail's dollar stablecoin (RLUSD or NEAR USDC). */
  maxSpend: string;
  /** Longest chat answer. */
  maxTokens: number;
};

export type CallResult = "settled" | "not_settled" | "refused_local" | "stopped" | "error";

export type CallRecord = {
  ts: string;
  tenant: string;
  payer: string;
  call: number;
  endpoint: Endpoint;
  result: CallResult;
  status?: number;
  amount?: string;
  transaction?: string;
  network?: string;
  latencyMs: number;
  masked?: Record<string, number>;
  /** The invoice the price carried: the join key to the paywall's claim, the ledger payment and the traces. */
  invoiceId?: string;
  error?: string;
};

/** Why a tenant's loop ended without an error: its call count, the deadline, or the signal (Ctrl+C). */
export type Ended = "calls" | "deadline" | "interrupted";

export type TenantSummary = { tenant: string; payer: string; settled: number; notSettled: number; refused: number; errors: number; spent: string; stoppedBy?: string; ended?: Ended };

export type TenantDeps = {
  /** Called once per call record. */
  write: (record: CallRecord) => void;
  /** Passed to payAndFetch: a ledger stand-in in tests, the buyer's server otherwise. */
  ledger?: PayOptions["ledger"];
  /** Resolves after ms, or as soon as the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Aborted to stop the loop: the call in progress finishes and is recorded, no new one starts. */
  signal?: AbortSignal;
  /** Each step of a paid call is sent here when set (fire-and-forget). */
  tracer?: Tracer;
  /** [0, 1); Math.random by default. Used only for jitter. */
  random?: () => number;
};

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * How long to wait before the next call. With ratePerMin the target is start to
 * start, so the time the last call took (sinceLastStartMs) is subtracted;
 * otherwise it is intervalMs after the last call ended. Jitter scales the
 * target by a factor in [1 - jitter, 1 + jitter].
 */
export function pauseBeforeNext(options: Pick<RunOptions, "intervalMs" | "ratePerMin" | "jitter">, sinceLastStartMs: number, random: () => number): number {
  const jitter = options.jitter ?? 0;
  const factor = jitter > 0 ? 1 + jitter * (2 * random() - 1) : 1;
  if (options.ratePerMin !== undefined && options.ratePerMin > 0) return Math.max(0, Math.round((60_000 / options.ratePerMin) * factor - sinceLastStartMs));
  return Math.max(0, Math.round(options.intervalMs * factor));
}

/**
 * Run one tenant's calls in order. A SetupError (budget reached, account not
 * funded, wrong network, a signer problem) stops this tenant; any other error
 * is recorded and the next call goes ahead.
 */
export async function runTenant(tenant: Tenant, buyer: RigBuyer, options: RunOptions, deps: TenantDeps): Promise<TenantSummary> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const budget = decimalUnits(options.maxSpend);
  let spent = 0n;
  const payer = payerOf(buyer);
  const summary: TenantSummary = { tenant: tenant.id, payer, settled: 0, notSettled: 0, refused: 0, errors: 0, spent: "0" };
  const url = `${options.url}${ENDPOINTS[options.endpoint]}`;
  const who = { tenant: tenant.id, payer };
  const pastDeadline = (): boolean => options.deadline !== undefined && now() >= options.deadline;
  let lastStart = now();

  for (let call = 1; options.calls === null || call <= options.calls; call++) {
    if (call > 1) {
      let pause = pauseBeforeNext(options, now() - lastStart, random);
      if (options.deadline !== undefined) pause = Math.min(pause, Math.max(0, options.deadline - now()));
      if (pause > 0) await sleep(pause, deps.signal);
    }
    if (deps.signal?.aborted) {
      summary.ended = "interrupted";
      break;
    }
    if (pastDeadline()) {
      summary.ended = "deadline";
      break;
    }
    const started = now();
    lastStart = started;
    const base = { tenant: tenant.id, payer, call, endpoint: options.endpoint };
    const record = (fields: Omit<CallRecord, keyof typeof base | "ts" | "latencyMs">): CallRecord => ({ ts: new Date().toISOString(), ...base, ...fields, latencyMs: now() - started });

    let prepared: Prepared;
    try {
      prepared = prepareRequest(options.endpoint, tenant.queries[(call - 1) % tenant.queries.length], options.maxTokens);
    } catch (e) {
      if (!(e instanceof SetupError)) throw e;
      summary.refused++;
      deps.write(record({ result: "refused_local", error: e.message }));
      continue;
    }

    try {
      const tracer = deps.tracer;
      const init = { method: "POST", headers: { "content-type": "application/json" }, body: prepared.bodyText };
      const onStep = tracer ? { onStep: (step: PayStep, info: StepInfo) => tracer.send(traceEvent(step, info, who, now() - started)) } : {};
      const paid: Paid = isNearBuyer(buyer)
        ? await payAndFetchNear(url, init, buyer, { maxAmount: unitsToDecimal(budget - spent), ...onStep })
        : await payAndFetch(url, init, buyer, { ledger: deps.ledger, maxAmount: unitsToDecimal(budget - spent), ...onStep });
      // The body is read so the connection is released; it is never recorded.
      await paid.response.arrayBuffer();
      const settled = paid.response.ok && paid.receipt?.success === true && paid.amount !== undefined;
      if (settled) {
        spent += decimalUnits(paid.amount!);
        summary.settled++;
      } else {
        summary.notSettled++;
      }
      deps.write(
        record({
          result: settled ? "settled" : "not_settled",
          status: paid.response.status,
          ...(paid.amount !== undefined ? { amount: paid.amount } : {}),
          ...(paid.invoiceId !== undefined ? { invoiceId: paid.invoiceId } : {}),
          ...(paid.receipt?.transaction ? { transaction: paid.receipt.transaction } : {}),
          ...(paid.receipt?.network ? { network: paid.receipt.network } : {}),
          ...(paid.refusal ? { error: `refused by the paywall: ${paid.refusal}` } : {}),
          masked: prepared.counts,
        }),
      );
    } catch (e) {
      if (e instanceof SetupError) {
        summary.stoppedBy = e.message;
        deps.write(record({ result: "stopped", error: e.message, masked: prepared.counts }));
        break;
      }
      summary.errors++;
      deps.write(record({ result: "error", error: e instanceof Error ? e.message : String(e), masked: prepared.counts }));
    }
  }
  summary.spent = unitsToDecimal(spent);
  if (summary.ended === undefined && summary.stoppedBy === undefined) summary.ended = "calls";
  return summary;
}
