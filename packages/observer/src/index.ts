/**
 * packages/observer, the observer view (privateAI-design-35 ARCH-650): what ANYONE reading
 * NEAR learns about one paid job, read the way an outsider would read it — public NEAR RPC, no key, no ChainAim data.
 *
 * Why: Outcome AI protects the content of a job (de-identified before any model, every NEAR AI call attested). It does
 * not hide the payment. Each job settles one USDC transfer on NEAR, so the payer's account, the amount and the time are
 * public. This view states that limit with the job's own transaction instead of leaving it unsaid.
 *
 * The payment is an x402 NEAR payment: a NEP-366 meta transaction. A relayer signs the outer transaction; it carries the
 * payer's Delegate action, whose inner action is ft_transfer {receiver_id: ChainAim's pay-to account, amount} on the USDC
 * contract (recorded real transaction: test/fixtures/x402-near-payment.json, from chainaim-adminUI-NEAR near-watch). A payer
 * that signs the ft_transfer itself (no relayer) is read too.
 *
 * Inputs come only from the job's signed receipt settlement {network, transaction, payer}. RPC `tx` routes by
 * sender_account_id only; the payer's account is enough on nodes that track all shards (checked live 2026-11-13 against
 * archival-rpc.testnet.near.org with both the relayer and the payer as sender). A node that has dropped the transaction
 * answers UNKNOWN_TRANSACTION, so the next URL (an archival node by default) is asked.
 */

export type ObserverNetwork = "near:testnet" | "near:mainnet";

export type ObserverRpc = {
  /** RPC URLs per network, asked in order (primary, then fallback). */
  urls: Record<ObserverNetwork, string[]>;
  timeoutMs: number;
  /** The token's decimals (NEAR USDC: 6). */
  decimals: number;
};

export type ObserverView = {
  network: ObserverNetwork;
  transaction: string;
  explorerUrl: string;
  /** Who signed the outer transaction: the relayer for a meta transaction, the payer otherwise. */
  signer: string;
  /** Whose USDC moved (the Delegate sender, or the signer for a direct transfer). */
  payer: string;
  /** The relayer account, or null for a direct transfer. */
  relayer: string | null;
  token: string;
  payTo: string;
  amountBase: string;
  amount: string;
  memo: string | null;
  /** The block the transfer executed in, and its time (ISO); null when the node did not give it. */
  blockHeight: number | null;
  blockTime: string | null;
  succeeded: boolean;
  /** What the chain does NOT carry for this job (fixed list; true of every x402 payment this console takes). */
  notOnChain: string[];
  /** Which RPC answered. */
  rpcUrl: string;
};

export const NOT_ON_CHAIN: readonly string[] = [
  "the question",
  "the data files and their rows",
  "the query and the computed result",
  "the answer",
  "which models ran (the route is in the signed receipt, which stays with the buyer and this console)",
];

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{20,100}$/;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const TRANSFERS = new Set(["ft_transfer", "ft_transfer_call"]);

export class ObserverError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** --observer-* flags into the RPC config; throws naming the bad flag. */
export function observerConfig(flags: Record<string, string | undefined>): ObserverRpc | undefined {
  const mode = flags.observer ?? "on";
  if (mode !== "on" && mode !== "off") throw new Error(`--observer must be on or off, got ${mode}`);
  if (mode === "off") return undefined;
  const url = (name: string): string => {
    const v = flags[name];
    if (!v) throw new Error(`--${name} must be set`);
    let u: URL;
    try { u = new URL(v); } catch { throw new Error(`--${name} must be a URL, got ${v}`); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`--${name} must be http(s), got ${v}`);
    return v.replace(/\/+$/, "");
  };
  const list = (net: "testnet" | "mainnet"): string[] => {
    const out = [url(`observer-rpc-${net}`)];
    const fb = flags[`observer-rpc-fallback-${net}`];
    if (fb !== undefined && fb !== "" && fb !== "none") out.push(url(`observer-rpc-fallback-${net}`));
    return out;
  };
  const timeoutMs = Number(flags["observer-timeout-ms"] ?? "15000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error(`--observer-timeout-ms must be an integer from 1000 to 120000, got ${flags["observer-timeout-ms"]}`);
  const decimals = Number(flags["observer-token-decimals"] ?? "6");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) throw new Error(`--observer-token-decimals must be an integer from 0 to 24, got ${flags["observer-token-decimals"]}`);
  return { urls: { "near:testnet": list("testnet"), "near:mainnet": list("mainnet") }, timeoutMs, decimals };
}

/** Base units to a decimal string with `decimals` places, trailing zeros trimmed (10000, 6 -> "0.01"). */
export function baseToDecimal(base: string, decimals: number): string {
  if (!/^\d+$/.test(base)) throw new ObserverError(502, `amount is not base units: ${base.slice(0, 40)}`);
  const s = base.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function explorerUrl(network: ObserverNetwork, transaction: string): string {
  return `https://${network === "near:mainnet" ? "" : "testnet."}nearblocks.io/txns/${transaction}`;
}

function argsOf(fc: Obj): Obj | null {
  if (typeof fc.args !== "string") return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(fc.args, "base64").toString("utf8"));
    return isObj(v) ? v : null;
  } catch { return null; }
}

/** The first transfer FunctionCall in a list of actions, with its args. */
function transferIn(actions: unknown): { method: string; args: Obj } | null {
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!isObj(a) || !isObj(a.FunctionCall) || !TRANSFERS.has(String(a.FunctionCall.method_name))) continue;
    const args = argsOf(a.FunctionCall);
    if (args) return { method: String(a.FunctionCall.method_name), args };
  }
  return null;
}

/**
 * Decodes an RPC `tx` / `EXPERIMENTAL_tx_status` result into what an observer learns. `expectedPayer` is the receipt's
 * payer: a transaction whose transfer moves someone else's tokens is refused (wrong transaction for this job).
 * Block time is filled by the caller (it needs an RPC `block` call); this returns the transfer's block hash for that.
 */
export function decodePayment(raw: unknown, network: ObserverNetwork, expectedPayer: string | null, decimals: number):
  Omit<ObserverView, "blockHeight" | "blockTime" | "rpcUrl"> & { blockHash: string | null } {
  if (!isObj(raw) || !isObj(raw.transaction)) throw new ObserverError(502, "the RPC answer has no transaction");
  const t = raw.transaction;
  if (typeof t.hash !== "string" || typeof t.signer_id !== "string" || typeof t.receiver_id !== "string") throw new ObserverError(502, "the RPC transaction lacks hash, signer_id or receiver_id");
  let payer: string; let relayer: string | null; let token: string; let transfer: { method: string; args: Obj } | null = null;
  const delegate = (Array.isArray(t.actions) ? t.actions : []).find((a) => isObj(a) && isObj(a.Delegate) && isObj((a.Delegate as Obj).delegate_action));
  if (delegate) {
    const da = ((delegate as Obj).Delegate as Obj).delegate_action as Obj;
    if (typeof da.sender_id !== "string" || typeof da.receiver_id !== "string") throw new ObserverError(502, "the Delegate action lacks sender_id or receiver_id");
    payer = da.sender_id; relayer = t.signer_id; token = da.receiver_id; transfer = transferIn(da.actions);
  } else {
    payer = t.signer_id; relayer = null; token = t.receiver_id; transfer = transferIn(t.actions);
  }
  if (!transfer) throw new ObserverError(502, `transaction ${t.hash} carries no ft_transfer: not a payment`);
  const payTo = transfer.args.receiver_id; const amount = transfer.args.amount;
  if (typeof payTo !== "string" || !ACCOUNT.test(payTo) || typeof amount !== "string") throw new ObserverError(502, `transaction ${t.hash}: the transfer lacks receiver_id or amount`);
  if (expectedPayer !== null && payer !== expectedPayer) throw new ObserverError(409, `transaction ${t.hash} moves ${payer}'s tokens, but the receipt names ${expectedPayer}`);
  // The transfer's own receipt outcome: executed by the token contract; its status says whether the tokens moved.
  const outcome = (Array.isArray(raw.receipts_outcome) ? raw.receipts_outcome : []).find((ro) => isObj(ro) && isObj(ro.outcome) && ro.outcome.executor_id === token) as Obj | undefined;
  const status = isObj(outcome?.outcome) ? (outcome!.outcome as Obj).status : undefined;
  const succeeded = isObj(status) && "SuccessValue" in status && isObj(raw.status) && !("Failure" in raw.status);
  return {
    network, transaction: t.hash, explorerUrl: explorerUrl(network, t.hash), signer: t.signer_id, payer, relayer, token, payTo,
    amountBase: amount, amount: baseToDecimal(amount, decimals),
    memo: typeof transfer.args.memo === "string" ? transfer.args.memo.slice(0, 200) : null,
    blockHash: typeof outcome?.block_hash === "string" ? outcome.block_hash : null, succeeded, notOnChain: [...NOT_ON_CHAIN],
  };
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function rpc(fetcher: Fetcher, url: string, method: string, params: Obj, timeoutMs: number): Promise<{ result?: unknown; unknownTx?: boolean }> {
  const r = await fetcher(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "chainaim-observer", method, params }), signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => null);
  if (isObj(j) && isObj(j.error)) {
    const cause = isObj(j.error.cause) ? j.error.cause.name : undefined;
    if (cause === "UNKNOWN_TRANSACTION") return { unknownTx: true };
    throw new Error(`${method}: ${String(cause ?? j.error.message ?? "error").slice(0, 120)}`);
  }
  if (!r.ok || !isObj(j) || !("result" in j)) throw new Error(`${method}: HTTP ${r.status}`);
  return { result: j.result };
}

/** Header time in ms from timestamp_nanosec (string) or timestamp (number, ns). */
function headerTime(h: Obj): string | null {
  const ns = typeof h.timestamp_nanosec === "string" && /^\d+$/.test(h.timestamp_nanosec) ? BigInt(h.timestamp_nanosec)
    : typeof h.timestamp === "number" ? BigInt(Math.trunc(h.timestamp)) : null;
  return ns === null ? null : new Date(Number(ns / 1_000_000n)).toISOString();
}

/**
 * The observer view of one settled job: asks each RPC URL of the network in order until one knows the transaction,
 * then that same URL for the transfer's block. Throws ObserverError (502 when no RPC answered, 404 when none knows it).
 */
export async function observe(settlement: { network: string; transaction: string; payer: string | null }, cfg: ObserverRpc, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<ObserverView> {
  if (settlement.network !== "near:testnet" && settlement.network !== "near:mainnet") throw new ObserverError(400, `not a NEAR network: ${settlement.network}`);
  const network = settlement.network as ObserverNetwork;
  if (!TX_HASH.test(settlement.transaction)) throw new ObserverError(400, "the settlement's transaction is not a NEAR transaction hash");
  if (settlement.payer === null || !ACCOUNT.test(settlement.payer)) throw new ObserverError(409, "the settlement names no payer account, so the transaction cannot be looked up");
  const failures: string[] = [];
  let unknownEverywhere = true;
  for (const url of cfg.urls[network]) {
    let got: { result?: unknown; unknownTx?: boolean };
    try {
      got = await rpc(fetcher, url, "tx", { tx_hash: settlement.transaction, sender_account_id: settlement.payer, wait_until: "FINAL" }, cfg.timeoutMs);
    } catch (e) { unknownEverywhere = false; failures.push(`${new URL(url).host}: ${(e as Error).message}`); continue; }
    if (got.unknownTx) { failures.push(`${new URL(url).host}: unknown transaction`); continue; }
    const view = decodePayment(got.result, network, settlement.payer, cfg.decimals);
    let blockHeight: number | null = null; let blockTime: string | null = null;
    if (view.blockHash) {
      try {
        const b = await rpc(fetcher, url, "block", { block_id: view.blockHash }, cfg.timeoutMs);
        const h = isObj(b.result) && isObj(b.result.header) ? b.result.header : null;
        if (h) { blockHeight = typeof h.height === "number" ? h.height : null; blockTime = headerTime(h); }
      } catch { /* the transfer is shown without its block time; the explorer link has it */ }
    }
    const { blockHash: _drop, ...rest } = view;
    return { ...rest, blockHeight, blockTime, rpcUrl: url };
  }
  throw new ObserverError(unknownEverywhere ? 404 : 502, `no RPC could show transaction ${settlement.transaction}: ${failures.join("; ")}`);
}
