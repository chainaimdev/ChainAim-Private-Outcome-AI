/**
 * Continuous live payments for Live Ops (SW3): every tenant pays, again and again, with real XRP Ledger
 * transactions, so the console always has validated activity to show.
 *
 *   RLUSD lane (Testnet)  each tenant's Testnet wallet pays the paywall's pay-to (XRPL_PAY_TO_TESTNET).
 *                         --mode x402   through the paywall (scripts/xrpl.ts payAndFetch; the facilitator settles)
 *                         --mode direct a plain RLUSD Payment to the pay-to
 *                         --mode auto   x402; when a call does not settle (paywall down, t54 unreachable behind
 *                                       Sophos, a refusal), direct for --fallback-sec, then x402 again
 *   TUSD lane (Devnet)    each tenant's Devnet wallet pays ChainAim's Devnet account a plain TUSD Payment
 *                         (the lending demo's token, data/lending/devnet-run.json).
 *
 * Every direct payment is submitted and waited for until validated (xrpl.js submitAndWait); it counts as paid
 * only when the validated result is tesSUCCESS and delivered_amount is exactly the token and value sent. An x402
 * payment counts when the paywall served the call and returned a successful settlement receipt.
 *
 * Funding (each one capped per run, each one a real transaction, reported as it happens):
 *   RLUSD   bought with the wallet's own XRP on the ledger's exchange (scripts/buy-rlusd-core.ts: self-payment,
 *           SendMax from ripple_path_find + slippage, never partial), keeping --keep-xrp
 *   TUSD    sent by the lending issuer (LENDING_ISSUER_SEED_DEVNET), one mint at a time, --max-mint per run
 *   XRP     Devnet only: the Devnet faucet through xrpl.js fundWallet, when XRP falls below --min-xrp
 * A lane that cannot pay (no trust line, cap reached, ledger unreachable) records "paused" with the reason and
 * tries again after --pause-sec; a budget reached ends the lane.
 *
 * One connection per network (XrplLedger), shared by every lane on it: connect timeout, retries with doubling
 * back-off, and a network-id check (Testnet 1, Devnet 2) before anything is signed. One payment at a time per
 * wallet and lane; the issuer's mints are serialised (Minter), since an account numbers its transactions.
 *
 * Records (one JSON line per event) carry tenant, payer address, lane, kind, result, amount, token code, hash and
 * ledger index: never a seed. Seeds are read from the environment by stream.ts and never printed or written here.
 */
import { parseArgs } from "node:util";
import { Client, convertStringToHex, dropsToXrp, xrpToDrops, type Wallet } from "xrpl";
import { isValidClassicAddress } from "ripple-address-codec";
import type { LedgerRequest } from "../../web/src/balance.ts";
import { NETWORKS } from "../src/config.ts";
import { BuyRefused, bestXrpQuote, buyPayment, sendMaxDrops } from "./buy-rlusd-core.ts";
import { ENDPOINTS, pauseBeforeNext, prepareRequest, type Endpoint } from "./rig-core.ts";
import { seedSigner } from "./signer.ts";
import { traceEvent, type Tracer } from "./trace.ts";
import { decimalUnits, ledgerOverClient, payAndFetch, SetupError, unitsToDecimal, type Buyer, type Paid, type PayOptions, type PayStep, type StepInfo } from "./xrpl.ts";

export const STREAM_NETWORKS = ["testnet", "devnet"] as const;
export type StreamNetwork = (typeof STREAM_NETWORKS)[number];
/** server_info network_id of each network (xrpl.js Wallet/defaultFaucets.js uses the same ids). */
export const NETWORK_IDS: Record<StreamNetwork, number> = { testnet: 1, devnet: 2 };
export const DEFAULT_WS: Record<StreamNetwork, string> = { testnet: "wss://s.altnet.rippletest.net:51233/", devnet: "wss://s.devnet.rippletest.net:51233/" };
export const LANES = ["rlusd", "tusd"] as const;
export type Lane = (typeof LANES)[number];
export const MODES = ["auto", "x402", "direct"] as const;
export type Mode = (typeof MODES)[number];
export const MEMO_TYPE = "creditseal/stream";

export type TokenSpec = { code: string; currency: string; issuer: string };
export type Delivered = { currency: string; issuer: string | null; value: string };
export type PayResult = { hash: string | null; result: string; validated: boolean; ledgerIndex: number | null; delivered: Delivered | null };
export type Holding = { exists: boolean; xrp: string; token: string; trustLine: boolean };

/** The ledger as the lanes use it; XrplLedger is the real one. */
export interface LedgerPort {
  readonly network: StreamNetwork;
  /** Autofill, sign with `wallet`, submit and wait until validated (or until it can no longer be). */
  pay(wallet: Wallet, tx: Record<string, unknown>): Promise<PayResult>;
  /** XRP and the token balance of `address` from the validated ledger; an account not on the ledger holds nothing. */
  holding(address: string, token: TokenSpec): Promise<Holding>;
  /** The cheapest XRP price (drops) the server finds for delivering `amount` of `token` to `address` itself. */
  quoteXrp(address: string, token: TokenSpec, amount: string): Promise<{ drops: bigint; paths: unknown[] } | undefined>;
  /** Fund `wallet` from the network's faucet (Testnet and Devnet only). */
  fund(wallet: Wallet): Promise<void>;
  /** Reads over the shared connection, in the shape payAndFetch takes. */
  reads(): LedgerRequest;
  close(): Promise<void>;
}

/** The ledger server did not answer (connect failed, connection lost): the lane pauses and tries again. */
export class Unreachable extends Error {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errorCode = (e: unknown): string | undefined => {
  const c = (e as { data?: { error?: unknown } } | undefined)?.data?.error;
  return typeof c === "string" ? c : undefined;
};

/**
 * A ledger decimal as a plain non-negative decimal with at most 15 decimals (account_lines may answer "1e-2";
 * a holder's balance is never negative, a negative one is read as 0 here).
 */
export function plainDecimal(v: string): string {
  const s = v.trim();
  if (s.startsWith("-")) return "0";
  let out = s;
  if (!/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw new Error(`"${v}" is not a decimal amount`);
    out = n.toFixed(15);
  }
  const [whole, fraction = ""] = out.split(".");
  const f = fraction.slice(0, 15).replace(/0+$/, "");
  return `${BigInt(whole).toString()}${f ? `.${f}` : ""}`;
}

export const units = (v: string): bigint => decimalUnits(plainDecimal(v));

function amountOf(v: unknown): Delivered | null {
  if (typeof v === "string") return { currency: "XRP", issuer: null, value: String(dropsToXrp(v)) };
  if (v && typeof v === "object") {
    const a = v as { currency?: unknown; issuer?: unknown; value?: unknown };
    if (typeof a.currency === "string" && typeof a.value === "string") return { currency: a.currency.toUpperCase(), issuer: typeof a.issuer === "string" ? a.issuer : null, value: a.value };
  }
  return null;
}

/** Validated tesSUCCESS that delivered exactly `amount` of `token`. */
export function deliveredExactly(r: PayResult, token: TokenSpec, amount: string): boolean {
  return (
    r.validated &&
    r.result === "tesSUCCESS" &&
    r.delivered !== null &&
    r.delivered.currency.toUpperCase() === token.currency.toUpperCase() &&
    r.delivered.issuer === token.issuer &&
    units(r.delivered.value) === units(amount)
  );
}

export function memo(text: string): Record<string, unknown> {
  return { Memo: { MemoType: convertStringToHex(MEMO_TYPE), MemoData: convertStringToHex(text) } };
}

/** A plain token Payment (no SourceTag, no InvoiceID, no partial-payment flag). */
export function tokenPayment(from: string, to: string, token: TokenSpec, amount: string, note: string): Record<string, unknown> {
  return { TransactionType: "Payment", Account: from, Destination: to, Amount: { currency: token.currency, issuer: token.issuer, value: amount }, Memos: [memo(note)] };
}

export function trustSet(address: string, token: TokenSpec, limit: string): Record<string, unknown> {
  return { TransactionType: "TrustSet", Account: address, LimitAmount: { currency: token.currency, issuer: token.issuer, value: limit } };
}

export type ConnectOptions = { timeoutMs: number; retries: number; backoffMs: number; faucetHost: string | null };

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

/** The real ledger: one xrpl.js connection per network, opened on first use and reopened when lost. */
export class XrplLedger implements LedgerPort {
  readonly network: StreamNetwork;
  readonly wsUrl: string;
  private readonly opts: ConnectOptions;
  private readonly log: (line: string) => void;
  private client: Client | null = null;
  private opening: Promise<Client> | null = null;

  constructor(network: StreamNetwork, wsUrl: string, opts: ConnectOptions, log: (line: string) => void) {
    this.network = network;
    this.wsUrl = wsUrl;
    this.opts = opts;
    this.log = log;
  }

  private async connected(): Promise<Client> {
    if (this.client?.isConnected()) return this.client;
    if (!this.opening) this.opening = this.open().finally(() => (this.opening = null));
    return this.opening;
  }

  private async open(): Promise<Client> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      if (attempt > 0) await realSleep(this.opts.backoffMs * 2 ** (attempt - 1));
      const client = new Client(this.wsUrl, { connectionTimeout: this.opts.timeoutMs });
      try {
        await client.connect();
        const info = (await client.request({ command: "server_info" })).result.info as { network_id?: unknown };
        if (info.network_id !== NETWORK_IDS[this.network]) {
          await client.disconnect().catch(() => undefined);
          throw new SetupError(`${this.wsUrl} reports network ${String(info.network_id ?? "unknown")}, not ${this.network} (${NETWORK_IDS[this.network]}); nothing was paid`);
        }
        const old = this.client;
        this.client = client;
        if (old) await old.disconnect().catch(() => undefined);
        if (attempt > 0) this.log(`${this.network}: connected to ${this.wsUrl} on attempt ${attempt + 1}`);
        return client;
      } catch (e) {
        if (e instanceof SetupError) throw e;
        last = e;
        await client.disconnect().catch(() => undefined);
        this.log(`${this.network}: connect attempt ${attempt + 1} of ${this.opts.retries + 1} to ${this.wsUrl} failed: ${message(e)}`);
      }
    }
    throw new Unreachable(`cannot connect to the ${this.network} server ${this.wsUrl} after ${this.opts.retries + 1} attempts: ${message(last)}`);
  }

  async pay(wallet: Wallet, tx: Record<string, unknown>): Promise<PayResult> {
    const client = await this.connected();
    let prepared: Parameters<Wallet["sign"]>[0];
    try {
      prepared = await client.autofill(tx as Parameters<Client["autofill"]>[0]);
    } catch (e) {
      if (errorCode(e) === "actNotFound") throw new SetupError(`account ${wallet.classicAddress} is not on ${this.network}: fund it first; nothing was paid`);
      throw new Unreachable(`${this.network}: could not prepare the transaction: ${message(e)}`);
    }
    const signed = wallet.sign(prepared);
    try {
      const res = await client.submitAndWait(signed.tx_blob);
      const meta = res.result.meta as { TransactionResult?: unknown; delivered_amount?: unknown } | undefined;
      return {
        hash: res.result.hash,
        result: typeof meta?.TransactionResult === "string" ? meta.TransactionResult : "unknown",
        validated: res.result.validated === true,
        ledgerIndex: typeof res.result.ledger_index === "number" ? res.result.ledger_index : null,
        delivered: amountOf(meta?.delivered_amount),
      };
    } catch (e) {
      // Not validated as far as this connection knows (rejected before the ledger, or the wait was cut off):
      // never counted as paid; ledger-watch shows the truth if it was validated after all.
      return { hash: signed.hash, result: `not validated: ${message(e)}`, validated: false, ledgerIndex: null, delivered: null };
    }
  }

  async holding(address: string, token: TokenSpec): Promise<Holding> {
    const client = await this.connected();
    let drops: string;
    try {
      const r = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
      drops = r.result.account_data.Balance;
    } catch (e) {
      if (errorCode(e) === "actNotFound") return { exists: false, xrp: "0", token: "0", trustLine: false };
      throw new Unreachable(`${this.network}: account_info ${address}: ${message(e)}`);
    }
    let lines: { currency: string; balance: string }[];
    try {
      lines = (await client.request({ command: "account_lines", account: address, peer: token.issuer, ledger_index: "validated" })).result.lines;
    } catch (e) {
      throw new Unreachable(`${this.network}: account_lines ${address}: ${message(e)}`);
    }
    const line = lines.find((l) => l.currency.toUpperCase() === token.currency.toUpperCase());
    return { exists: true, xrp: plainDecimal(String(dropsToXrp(drops))), token: line ? plainDecimal(line.balance) : "0", trustLine: line !== undefined };
  }

  async quoteXrp(address: string, token: TokenSpec, amount: string): Promise<{ drops: bigint; paths: unknown[] } | undefined> {
    const client = await this.connected();
    try {
      const r = await client.request({
        command: "ripple_path_find",
        source_account: address,
        destination_account: address,
        destination_amount: { currency: token.currency, issuer: token.issuer, value: amount },
        source_currencies: [{ currency: "XRP" }],
      } as never);
      return bestXrpQuote((r as { result: Parameters<typeof bestXrpQuote>[0] }).result);
    } catch (e) {
      throw new Unreachable(`${this.network}: ripple_path_find: ${message(e)}`);
    }
  }

  async fund(wallet: Wallet): Promise<void> {
    const client = await this.connected();
    try {
      await client.fundWallet(wallet, this.opts.faucetHost ? { faucetHost: this.opts.faucetHost } : {});
    } catch (e) {
      throw new Unreachable(`${this.network}: faucet did not fund ${wallet.classicAddress}: ${message(e)}`);
    }
  }

  reads(): LedgerRequest {
    return async (command, params) => ledgerOverClient(await this.connected())(command, params);
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c?.isConnected()) await c.disconnect().catch(() => undefined);
  }
}

/** The lending issuer's mints, one at a time (one account, one sequence), capped per run. */
export class Minter {
  readonly token: TokenSpec;
  readonly cap: bigint;
  minted = 0n;
  private readonly issuer: Wallet;
  private readonly ledger: LedgerPort;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: { issuer: Wallet; ledger: LedgerPort; token: TokenSpec; maxMint: string }) {
    if (o.issuer.classicAddress !== o.token.issuer) throw new SetupError(`the issuer seed is for ${o.issuer.classicAddress}, but ${o.token.code} is issued by ${o.token.issuer}`);
    this.issuer = o.issuer;
    this.ledger = o.ledger;
    this.token = o.token;
    this.cap = decimalUnits(o.maxMint);
  }

  mint(to: string, amount: string, note: string): Promise<PayResult | { refused: string }> {
    const run = async (): Promise<PayResult | { refused: string }> => {
      const want = decimalUnits(amount);
      if (this.minted + want > this.cap) return { refused: `--max-mint ${unitsToDecimal(this.cap)} ${this.token.code} reached for this run (${unitsToDecimal(this.minted)} sent)` };
      const r = await this.ledger.pay(this.issuer, tokenPayment(this.issuer.classicAddress, to, this.token, amount, note));
      if (deliveredExactly(r, this.token, amount)) this.minted += want;
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export type RecordKind = "x402" | "direct" | "topup" | "mint" | "faucet";
export type RecordResult = "validated" | "failed" | "not_settled" | "error" | "paused" | "ended";

export type StreamRecord = {
  ts: string;
  lane: Lane;
  network: StreamNetwork;
  tenant: string;
  payer: string;
  kind?: RecordKind;
  result: RecordResult;
  token: string;
  amount?: string;
  to?: string;
  hash?: string;
  ledgerIndex?: number;
  invoiceId?: string;
  status?: number;
  latencyMs?: number;
  error?: string;
};

export type LaneOptions = {
  lane: Lane;
  token: TokenSpec;
  /** Who is paid: the paywall's pay-to (RLUSD) or ChainAim's Devnet account (TUSD). */
  to: string;
  /** Each direct payment. An x402 payment pays the paywall's quoted price. */
  amount: string;
  /** Most of the token this lane may pay in this run (payments only; funding is capped separately). */
  maxSpend: string;
  /** RLUSD lane only; the TUSD lane is always direct. */
  mode: Mode;
  ratePerMin: number;
  jitter: number;
  startDelayMs: number;
  /** Absolute time (deps.now clock) after which no payment starts; undefined = until stopped. */
  deadline?: number;
  fallbackMs: number;
  pauseMs: number;
  /** Fund the token when the balance is below max(amount, below). null = off. */
  topup: { below: string; amount: string; maxCount: number } | null;
  /** RLUSD top-ups: buy on the exchange. */
  buy?: { maxXrp: string; slippagePct: number; keepXrp: string };
  /** Devnet faucet when XRP is below minXrp. null = off. */
  faucet: { minXrp: string } | null;
  /** x402 calls (RLUSD lane, modes x402 and auto). */
  x402?: { url: string; endpoint: Endpoint; queries: readonly string[]; maxTokens: number };
};

export type LaneDeps = {
  ledger: LedgerPort;
  wallet: Wallet;
  tenant: string;
  write: (r: StreamRecord) => void;
  log?: (line: string) => void;
  /** TUSD top-ups. */
  minter?: Minter;
  /** payAndFetch, or a stand-in in tests. */
  x402Pay?: (url: string, init: { method: string; headers: Record<string, string>; body: string }, buyer: Buyer, options: PayOptions) => Promise<Paid>;
  tracer?: Tracer;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  signal?: AbortSignal;
};

export type LaneSummary = { tenant: string; lane: Lane; payer: string; paid: number; x402: number; direct: number; failed: number; spent: string; token: string; ended: string };

/** Run one tenant's lane until the deadline, the signal, the budget or a setup error. */
export async function runLane(o: LaneOptions, d: LaneDeps): Promise<LaneSummary> {
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const random = d.random ?? Math.random;
  const log = d.log ?? (() => undefined);
  const payer = d.wallet.classicAddress;
  const network = d.ledger.network;
  const amount = decimalUnits(o.amount);
  const budget = decimalUnits(o.maxSpend);
  const summary: LaneSummary = { tenant: d.tenant, lane: o.lane, payer, paid: 0, x402: 0, direct: 0, failed: 0, spent: "0", token: o.token.code, ended: "" };
  let spent = 0n;
  let topups = 0;
  let fallbackUntil = 0;
  let call = 0;
  const base = { lane: o.lane, network, tenant: d.tenant, payer, token: o.token.code };
  const write = (r: Omit<StreamRecord, keyof typeof base | "ts">): void => d.write({ ts: new Date(now()).toISOString(), ...base, ...r });
  const pastDeadline = (): boolean => o.deadline !== undefined && now() >= o.deadline;
  const pause = async (): Promise<void> => {
    let ms = o.pauseMs;
    if (o.deadline !== undefined) ms = Math.min(ms, Math.max(0, o.deadline - now()));
    await sleep(ms, d.signal);
  };

  if (o.startDelayMs > 0) await sleep(o.startDelayMs, d.signal);
  let lastStart = now();
  let first = true;
  for (;;) {
    if (!first) {
      let wait = pauseBeforeNext({ intervalMs: 0, ratePerMin: o.ratePerMin, jitter: o.jitter }, now() - lastStart, random);
      if (o.deadline !== undefined) wait = Math.min(wait, Math.max(0, o.deadline - now()));
      if (wait > 0) await sleep(wait, d.signal);
    }
    first = false;
    if (d.signal?.aborted) {
      summary.ended = "stopped";
      break;
    }
    if (pastDeadline()) {
      summary.ended = "deadline";
      break;
    }
    if (spent + amount > budget) {
      summary.ended = `budget ${o.maxSpend} ${o.token.code} reached`;
      write({ result: "ended", error: summary.ended });
      break;
    }
    lastStart = now();
    const started = now();
    try {
      // 1. Can this wallet pay? Fund it when allowed, otherwise pause with the reason.
      let h = await d.ledger.holding(payer, o.token);
      if (o.faucet && (!h.exists || units(h.xrp) < units(o.faucet.minXrp))) {
        await d.ledger.fund(d.wallet);
        const after = await d.ledger.holding(payer, o.token);
        write({ kind: "faucet", result: "validated", token: "XRP", amount: plainDecimal(unitsToDecimal(units(after.xrp) - units(h.xrp) > 0n ? units(after.xrp) - units(h.xrp) : 0n)) });
        h = after;
      }
      if (!h.exists) {
        write({ result: "paused", error: `account not on ${network}: fund it with XRP (setup-devnet does this for Devnet)` });
        await pause();
        continue;
      }
      if (!h.trustLine) {
        write({ result: "paused", error: `no ${o.token.code} trust line to ${o.token.issuer} (setup-devnet / trust-line.ts opens it)` });
        await pause();
        continue;
      }
      const floor = o.topup && units(o.topup.below) > amount ? units(o.topup.below) : amount;
      if (o.topup && units(h.token) < floor) {
        const refused = await fundToken(o, d, h, topups, write);
        if (refused === null) {
          topups += 1;
          h = await d.ledger.holding(payer, o.token);
        } else if (units(h.token) < amount) {
          write({ result: "paused", error: refused });
          await pause();
          continue;
        }
      }
      if (units(h.token) < amount) {
        write({ result: "paused", error: `${o.token.code} balance ${h.token} is below the payment ${o.amount}${o.topup ? "" : " (top-up off)"}` });
        await pause();
        continue;
      }

      // 2. Pay: x402 first when the mode says so.
      call += 1;
      const tryX402 = o.lane === "rlusd" && o.x402 !== undefined && (o.mode === "x402" || (o.mode === "auto" && now() >= fallbackUntil));
      if (tryX402) {
        const r = await x402Once(o, d, call, spent, budget, started, now);
        if (r.settled) {
          spent += decimalUnits(r.amount!);
          summary.paid += 1;
          summary.x402 += 1;
          write({ kind: "x402", result: "validated", amount: r.amount, to: o.to, hash: r.hash, invoiceId: r.invoiceId, status: r.status, latencyMs: now() - started });
          continue;
        }
        write({ kind: "x402", result: r.error ? "error" : "not_settled", amount: r.amount, invoiceId: r.invoiceId, status: r.status, latencyMs: now() - started, error: r.reason });
        if (o.mode === "x402") continue;
        fallbackUntil = now() + o.fallbackMs;
        log(`${d.tenant} rlusd: x402 did not settle (${r.reason}); paying direct for ${Math.round(o.fallbackMs / 1000)} s`);
      }
      const r = await d.ledger.pay(d.wallet, tokenPayment(payer, o.to, o.token, o.amount, `${o.lane}:${d.tenant}:${call}`));
      const ok = deliveredExactly(r, o.token, o.amount);
      if (ok) {
        spent += amount;
        summary.paid += 1;
        summary.direct += 1;
      } else {
        summary.failed += 1;
      }
      write({
        kind: "direct",
        result: ok ? "validated" : "failed",
        amount: o.amount,
        to: o.to,
        ...(r.hash ? { hash: r.hash } : {}),
        ...(r.ledgerIndex !== null ? { ledgerIndex: r.ledgerIndex } : {}),
        latencyMs: now() - started,
        ...(ok ? {} : { error: r.result }),
      });
    } catch (e) {
      if (e instanceof SetupError) {
        summary.ended = e.message;
        write({ result: "ended", error: e.message });
        break;
      }
      write({ result: e instanceof Unreachable ? "paused" : "error", error: message(e) });
      await pause();
    }
  }
  summary.spent = unitsToDecimal(spent);
  return summary;
}

/** One top-up; returns null when the funds arrived, else why not (the record is written either way). */
async function fundToken(o: LaneOptions, d: LaneDeps, h: Holding, done: number, write: (r: Omit<StreamRecord, "ts" | "lane" | "network" | "tenant" | "payer" | "token">) => void): Promise<string | null> {
  const t = o.topup!;
  if (done >= t.maxCount) return `${o.token.code} balance ${h.token} is low and --max-topups ${t.maxCount} is reached for this run`;
  const payer = d.wallet.classicAddress;
  if (o.lane === "tusd") {
    if (!d.minter) return `${o.token.code} balance ${h.token} is low and no issuer seed was given for top-ups`;
    const r = await d.minter.mint(payer, t.amount, `topup:${d.tenant}`);
    if ("refused" in r) return r.refused;
    const ok = deliveredExactly(r, o.token, t.amount);
    write({ kind: "mint", result: ok ? "validated" : "failed", amount: t.amount, ...(r.hash ? { hash: r.hash } : {}), ...(r.ledgerIndex !== null ? { ledgerIndex: r.ledgerIndex } : {}), ...(ok ? {} : { error: r.result }) });
    return ok ? null : `the ${o.token.code} mint failed: ${r.result}`;
  }
  const b = o.buy;
  if (!b) return `${o.token.code} balance ${h.token} is low and buying is off`;
  const quote = await d.ledger.quoteXrp(payer, o.token, t.amount);
  if (!quote) return `the ledger found no XRP -> ${o.token.code} path for ${t.amount}`;
  let sendMax: bigint;
  try {
    sendMax = sendMaxDrops(quote.drops, b.maxXrp, b.slippagePct);
  } catch (e) {
    if (e instanceof BuyRefused) return e.message;
    throw e;
  }
  const spendable = BigInt(xrpToDrops(h.xrp)) - BigInt(xrpToDrops(b.keepXrp));
  if (sendMax > spendable) return `buying ${t.amount} ${o.token.code} may cost up to ${dropsToXrp(sendMax.toString())} XRP, which would leave less than --keep-xrp ${b.keepXrp} XRP`;
  const r = await d.ledger.pay(d.wallet, { ...buyPayment(payer, o.token, t.amount, sendMax, quote.paths), Memos: [memo(`topup:${d.tenant}`)] });
  const ok = deliveredExactly(r, o.token, t.amount);
  write({ kind: "topup", result: ok ? "validated" : "failed", amount: t.amount, ...(r.hash ? { hash: r.hash } : {}), ...(r.ledgerIndex !== null ? { ledgerIndex: r.ledgerIndex } : {}), ...(ok ? {} : { error: r.result }) });
  return ok ? null : `buying ${o.token.code} failed: ${r.result}`;
}

async function x402Once(
  o: LaneOptions,
  d: LaneDeps,
  call: number,
  spent: bigint,
  budget: bigint,
  started: number,
  now: () => number,
): Promise<{ settled: boolean; amount?: string; hash?: string; invoiceId?: string; status?: number; reason?: string; error?: boolean }> {
  const x = o.x402!;
  const pay = d.x402Pay ?? payAndFetch;
  let body: string;
  try {
    body = prepareRequest(x.endpoint, x.queries[(call - 1) % x.queries.length], x.maxTokens).bodyText;
  } catch (e) {
    return { settled: false, reason: `request refused on this machine: ${message(e)}`, error: true };
  }
  const buyer: Buyer = { networkName: "testnet", network: NETWORKS.testnet, wsUrl: "(shared stream connection)", signer: seedSigner(d.wallet) };
  const who = { tenant: d.tenant, payer: d.wallet.classicAddress };
  const tracer = d.tracer;
  try {
    const paid = await pay(`${x.url}${ENDPOINTS[x.endpoint]}`, { method: "POST", headers: { "content-type": "application/json" }, body }, buyer, {
      ledger: d.ledger.reads(),
      maxAmount: unitsToDecimal(budget - spent),
      ...(tracer ? { onStep: (step: PayStep, info: StepInfo) => tracer.send(traceEvent(step, info, who, now() - started)) } : {}),
    });
    await paid.response.arrayBuffer().catch(() => undefined);
    const settled = paid.response.ok && paid.receipt?.success === true && paid.amount !== undefined;
    return {
      settled,
      ...(paid.amount !== undefined ? { amount: paid.amount } : {}),
      ...(paid.receipt?.transaction ? { hash: paid.receipt.transaction } : {}),
      ...(paid.invoiceId !== undefined ? { invoiceId: paid.invoiceId } : {}),
      status: paid.response.status,
      ...(settled ? {} : { reason: paid.refusal ? `refused by the paywall: ${paid.refusal}` : `HTTP ${paid.response.status} without a settlement` }),
    };
  } catch (e) {
    return { settled: false, reason: e instanceof SetupError ? e.message : `paywall not reached: ${message(e)}`, error: true };
  }
}

// ---------------------------------------------------------------- command line (parsed here so the tests can check it)

export type RunArgs = {
  lanes: Lane[];
  mode: Mode;
  url: string;
  endpoint: Endpoint;
  maxTokens: number;
  traceUrl: string | null;
  traceKeyEnv: string;
  traceTimeoutMs: number;
  traceMaxInflight: number;
  ratePerMin: number;
  jitter: number;
  staggerMs: number;
  durationSec: number;
  tenantsDir: string | null;
  only: string[] | null;
  amount: string;
  tusdAmount: string;
  maxSpend: string;
  tusdMaxSpend: string;
  payToEnv: string;
  tusdTo: string | null;
  assetFile: string | null;
  fallbackSec: number;
  pauseSec: number;
  topup: boolean;
  topupBelow: string;
  topupRlusd: string;
  maxTopups: number;
  maxTopupXrp: string;
  slippagePct: number;
  keepXrp: string;
  mint: string;
  maxMint: string;
  faucet: "devnet" | "off";
  minXrp: string;
  faucetHost: string | null;
  testnetWs: string | null;
  devnetWs: string | null;
  connectTimeoutMs: number;
  connectRetries: number;
  connectBackoffMs: number;
  out: string | null;
};

export type SetupArgs = {
  tenantsDir: string | null;
  only: string[] | null;
  secretsOut: string;
  mintAmount: string;
  trustLimit: string;
  assetFile: string | null;
  devnetWs: string | null;
  faucetHost: string | null;
  connectTimeoutMs: number;
  connectRetries: number;
  connectBackoffMs: number;
};

export const RUN_USAGE = `node scripts/stream.ts run [flags]          (seeds come from the environment / --env-file, never from flags)
  --lanes rlusd,tusd           which lanes run (default rlusd,tusd)
  --mode auto|x402|direct      RLUSD lane: x402, direct, or x402 with direct fallback (default auto)
  --url URL                    the paywall (default http://127.0.0.1:8080)
  --endpoint scan|mask|chat    the paid route x402 calls (default scan)    --max-tokens N   chat only (default 64)
  --trace-url URL|none         ledger-watch /ingest/trace (default none)   --trace-key-env NAME (default LEDGER_WATCH_INGEST_KEY)
  --trace-timeout-ms N (1500)  --trace-max-inflight N (64)
  --rate-per-min N             payments per minute per tenant per lane, start to start (default 6)
  --jitter F                   0..1, each pause scaled by 1 +/- F (default 0.2)
  --stagger-ms N               delay between tenants' first payments (default 1000)
  --duration-sec N             stop after N seconds; 0 = until Ctrl+C (default 0)
  --tenants-dir DIR            rig tenants (default <repo>/rig/tenants)    --only t01,t02   some tenants only
  --amount DEC                 each direct RLUSD payment (default 0.01)    --tusd-amount DEC (default 0.01)
  --max-spend DEC              RLUSD each tenant may pay this run (default 1)   --tusd-max-spend DEC (default 5)
  --pay-to-env NAME            env var with the RLUSD pay-to (default XRPL_PAY_TO_TESTNET)
  --tusd-to rADDR|auto         who the TUSD lane pays; auto = LENDING_CHAINAIM_SEED_DEVNET's account (default auto)
  --asset-file PATH            Devnet token {asset:{code,currency,issuer}} (default <repo>/data/lending/devnet-run.json)
  --fallback-sec N             auto mode: pay direct this long after x402 fails (default 300)
  --pause-sec N                wait after a pause or an unreachable ledger (default 15)
  --topup on|off               fund the token when low (default on)        --topup-below DEC (default 0.05)
  --topup-rlusd DEC            RLUSD bought per top-up (default 1)          --max-topups N per tenant and lane (default 3)
  --max-topup-xrp DEC          most XRP one RLUSD top-up may cost (default 15)   --slippage-pct N (default 2)
  --keep-xrp DEC               XRP a wallet keeps when buying (default 20)
  --mint DEC                   TUSD the issuer sends per top-up (default 1)  --max-mint DEC per run, all tenants (default 10)
  --faucet devnet|off          Devnet faucet when XRP is low (default devnet)   --min-xrp DEC (default 15)
  --faucet-host HOST           faucet host instead of xrpl.js's choice by network id
  --testnet-ws URL             default XRPL_WS_URL_TESTNET, else ${DEFAULT_WS.testnet}
  --devnet-ws URL              default XRPL_WS_URL_DEVNET, else ${DEFAULT_WS.devnet}
  --connect-timeout-ms N (15000)  --connect-retries N (3)  --connect-backoff-ms N (1000)
  --out PATH                   records (default <repo>/rig/out/stream-<time>.jsonl)`;

export const SETUP_USAGE = `node scripts/stream.ts setup-devnet --secrets-out FILE [flags]
  Gives each tenant a Devnet wallet for the TUSD lane: faucet XRP, a TUSD trust line, --mint-amount TUSD from the
  lending issuer (LENDING_ISSUER_SEED_DEVNET), and its public "devnetAddress" in rig/tenants/<id>/tenant.json.
  A new seed is appended to --secrets-out (outside the repository) as <seedPrefix>_DEVNET and never printed; a seed
  already in the environment is reused. Safe to run again.
  --secrets-out FILE   required     --tenants-dir DIR   --only t01,t02
  --mint-amount DEC (default 2)     --trust-limit DEC (default 1000000)   --asset-file PATH
  --devnet-ws URL  --faucet-host HOST  --connect-timeout-ms N (15000)  --connect-retries N (3)  --connect-backoff-ms N (1000)`;

const DECIMAL = /^(0|[1-9]\d*)(\.\d{1,15})?$/;

function dec(name: string, raw: string, allowZero = false): string {
  if (!DECIMAL.test(raw) || (!allowZero && decimalUnits(raw) === 0n)) throw new SetupError(`--${name} must be a decimal${allowZero ? "" : " above zero"} with at most 15 decimals, got ${raw}`);
  return raw;
}
function int(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new SetupError(`--${name} must be a whole number from ${min} to ${max}, got ${raw}`);
  return n;
}
function num(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < min || n > max) throw new SetupError(`--${name} must be a number from ${min} to ${max}, got ${raw}`);
  return n;
}
function ws(name: string, raw: string): string | null {
  if (raw === "") return null;
  if (!/^wss?:\/\//.test(raw) || !URL.canParse(raw)) throw new SetupError(`--${name} must be a ws:// or wss:// URL`);
  return raw;
}
function envName(name: string, raw: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(raw)) throw new SetupError(`--${name} must be an environment variable name, got ${raw}`);
  return raw;
}
function onlyList(raw: string): string[] | null {
  if (raw === "") return null;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new SetupError(`--only: "${id}" is not a tenant id`);
  return ids;
}
const pathOrNull = (raw: string): string | null => (raw.trim() === "" ? null : raw.trim());

function parse(argv: string[], options: Record<string, { type: "string"; default: string }>, usage: string): Record<string, string> {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values as Record<string, string>;
  } catch (e) {
    throw new SetupError(`${message(e)}\n\n${usage}`);
  }
}

const s = (d: string) => ({ type: "string" as const, default: d });

export function parseRunArgs(argv: string[]): RunArgs {
  const v = parse(
    argv,
    {
      lanes: s("rlusd,tusd"), mode: s("auto"), url: s("http://127.0.0.1:8080"), endpoint: s("scan"), "max-tokens": s("64"),
      "trace-url": s("none"), "trace-key-env": s("LEDGER_WATCH_INGEST_KEY"), "trace-timeout-ms": s("1500"), "trace-max-inflight": s("64"),
      "rate-per-min": s("6"), jitter: s("0.2"), "stagger-ms": s("1000"), "duration-sec": s("0"), "tenants-dir": s(""), only: s(""),
      amount: s("0.01"), "tusd-amount": s("0.01"), "max-spend": s("1"), "tusd-max-spend": s("5"), "pay-to-env": s("XRPL_PAY_TO_TESTNET"),
      "tusd-to": s("auto"), "asset-file": s(""), "fallback-sec": s("300"), "pause-sec": s("15"),
      topup: s("on"), "topup-below": s("0.05"), "topup-rlusd": s("1"), "max-topups": s("3"), "max-topup-xrp": s("15"), "slippage-pct": s("2"), "keep-xrp": s("20"),
      mint: s("1"), "max-mint": s("10"), faucet: s("devnet"), "min-xrp": s("15"), "faucet-host": s(""),
      "testnet-ws": s(""), "devnet-ws": s(""), "connect-timeout-ms": s("15000"), "connect-retries": s("3"), "connect-backoff-ms": s("1000"), out: s(""),
    },
    RUN_USAGE,
  );
  const lanes = [...new Set(v.lanes.split(",").map((x) => x.trim()).filter(Boolean))];
  if (lanes.length === 0) throw new SetupError("--lanes names no lane");
  for (const l of lanes) if (!(LANES as readonly string[]).includes(l)) throw new SetupError(`--lanes: ${l} is not one of ${LANES.join(", ")}`);
  if (!(MODES as readonly string[]).includes(v.mode)) throw new SetupError(`--mode must be one of ${MODES.join(", ")}, got ${v.mode}`);
  if (!Object.hasOwn(ENDPOINTS, v.endpoint)) throw new SetupError(`--endpoint must be one of ${Object.keys(ENDPOINTS).join(", ")}`);
  if (!/^https?:\/\//.test(v.url) || !URL.canParse(v.url)) throw new SetupError("--url must be an http(s) URL");
  const traceUrl = v["trace-url"] === "none" || v["trace-url"] === "" ? null : v["trace-url"];
  if (traceUrl !== null && (!/^https?:\/\//.test(traceUrl) || !URL.canParse(traceUrl))) throw new SetupError("--trace-url must be an http(s) URL or none");
  if (v.topup !== "on" && v.topup !== "off") throw new SetupError("--topup must be on or off");
  if (v.faucet !== "devnet" && v.faucet !== "off") throw new SetupError("--faucet must be devnet or off");
  const tusdTo = v["tusd-to"] === "auto" ? null : v["tusd-to"];
  if (tusdTo !== null && !isValidClassicAddress(tusdTo)) throw new SetupError("--tusd-to must be auto or an XRPL classic address with a valid checksum");
  const rate = num("rate-per-min", v["rate-per-min"], 0.1, 600);
  return {
    lanes: lanes as Lane[],
    mode: v.mode as Mode,
    url: v.url.replace(/\/+$/, ""),
    endpoint: v.endpoint as Endpoint,
    maxTokens: int("max-tokens", v["max-tokens"], 1, 4096),
    traceUrl,
    traceKeyEnv: envName("trace-key-env", v["trace-key-env"]),
    traceTimeoutMs: int("trace-timeout-ms", v["trace-timeout-ms"], 100, 60_000),
    traceMaxInflight: int("trace-max-inflight", v["trace-max-inflight"], 1, 10_000),
    ratePerMin: rate,
    jitter: num("jitter", v.jitter, 0, 1),
    staggerMs: int("stagger-ms", v["stagger-ms"], 0, 600_000),
    durationSec: int("duration-sec", v["duration-sec"], 0, 30 * 86_400),
    tenantsDir: pathOrNull(v["tenants-dir"]),
    only: onlyList(v.only),
    amount: dec("amount", v.amount),
    tusdAmount: dec("tusd-amount", v["tusd-amount"]),
    maxSpend: dec("max-spend", v["max-spend"]),
    tusdMaxSpend: dec("tusd-max-spend", v["tusd-max-spend"]),
    payToEnv: envName("pay-to-env", v["pay-to-env"]),
    tusdTo,
    assetFile: pathOrNull(v["asset-file"]),
    fallbackSec: int("fallback-sec", v["fallback-sec"], 0, 86_400),
    pauseSec: int("pause-sec", v["pause-sec"], 1, 3600),
    topup: v.topup === "on",
    topupBelow: dec("topup-below", v["topup-below"], true),
    topupRlusd: dec("topup-rlusd", v["topup-rlusd"]),
    maxTopups: int("max-topups", v["max-topups"], 0, 1000),
    maxTopupXrp: dec("max-topup-xrp", v["max-topup-xrp"]),
    slippagePct: num("slippage-pct", v["slippage-pct"], 0, 50),
    keepXrp: dec("keep-xrp", v["keep-xrp"], true),
    mint: dec("mint", v.mint),
    maxMint: dec("max-mint", v["max-mint"], true),
    faucet: v.faucet as "devnet" | "off",
    minXrp: dec("min-xrp", v["min-xrp"], true),
    faucetHost: pathOrNull(v["faucet-host"]),
    testnetWs: ws("testnet-ws", v["testnet-ws"]),
    devnetWs: ws("devnet-ws", v["devnet-ws"]),
    connectTimeoutMs: int("connect-timeout-ms", v["connect-timeout-ms"], 1000, 120_000),
    connectRetries: int("connect-retries", v["connect-retries"], 0, 20),
    connectBackoffMs: int("connect-backoff-ms", v["connect-backoff-ms"], 0, 60_000),
    out: pathOrNull(v.out),
  };
}

export function parseSetupArgs(argv: string[]): SetupArgs {
  const v = parse(
    argv,
    {
      "secrets-out": s(""), "tenants-dir": s(""), only: s(""), "mint-amount": s("2"), "trust-limit": s("1000000"), "asset-file": s(""),
      "devnet-ws": s(""), "faucet-host": s(""), "connect-timeout-ms": s("15000"), "connect-retries": s("3"), "connect-backoff-ms": s("1000"),
    },
    SETUP_USAGE,
  );
  if (v["secrets-out"].trim() === "") throw new SetupError(`--secrets-out FILE is required: new Devnet seeds are appended there (outside the repository)\n\n${SETUP_USAGE}`);
  return {
    secretsOut: v["secrets-out"].trim(),
    tenantsDir: pathOrNull(v["tenants-dir"]),
    only: onlyList(v.only),
    mintAmount: dec("mint-amount", v["mint-amount"], true),
    trustLimit: dec("trust-limit", v["trust-limit"]),
    assetFile: pathOrNull(v["asset-file"]),
    devnetWs: ws("devnet-ws", v["devnet-ws"]),
    faucetHost: pathOrNull(v["faucet-host"]),
    connectTimeoutMs: int("connect-timeout-ms", v["connect-timeout-ms"], 1000, 120_000),
    connectRetries: int("connect-retries", v["connect-retries"], 0, 20),
    connectBackoffMs: int("connect-backoff-ms", v["connect-backoff-ms"], 0, 60_000),
  };
}

/** The Devnet token from the lending demo's state file: {"asset": {"code", "currency", "issuer"}}. */
export function readAsset(json: unknown, from: string): TokenSpec {
  const a = (json as { asset?: { code?: unknown; currency?: unknown; issuer?: unknown } } | null)?.asset;
  if (!a || typeof a.code !== "string" || typeof a.currency !== "string" || typeof a.issuer !== "string") {
    throw new SetupError(`${from} has no "asset" {code, currency, issuer}: run services/lending "lending.ts issue" first`);
  }
  if (!/^[0-9A-Fa-f]{40}$/.test(a.currency) && !/^[A-Za-z0-9]{3}$/.test(a.currency)) throw new SetupError(`${from}: asset.currency must be a 3-character code or 40 hex characters`);
  if (!isValidClassicAddress(a.issuer)) throw new SetupError(`${from}: asset.issuer is not an XRPL classic address with a valid checksum`);
  return { code: a.code, currency: a.currency.length === 40 ? a.currency.toUpperCase() : a.currency, issuer: a.issuer };
}
