/**
 * SW3 payment stream (scripts/stream-core.ts). Named STREAM-*; there is no ARCH-ID for Live Ops yet.
 * The lanes run against MemoryLedger, an in-process ledger used only by these tests (like the rig's stub ledger):
 * it applies Payments and TrustSets to balances and can be told to answer a result code or be unreachable.
 * The x402 path runs against a stand-in for payAndFetch that answers as the paywall does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "xrpl";
import {
  deliveredExactly,
  MEMO_TYPE,
  Minter,
  parseRunArgs,
  parseSetupArgs,
  plainDecimal,
  readAsset,
  runLane,
  Unreachable,
  type Holding,
  type LaneDeps,
  type LaneOptions,
  type LedgerPort,
  type PayResult,
  type StreamRecord,
  type TokenSpec,
} from "../scripts/stream-core.ts";
import { decimalUnits, SetupError, unitsToDecimal, type Paid } from "../scripts/xrpl.ts";

const DROP = 1_000_000_000n; // 10^-6 XRP in 10^-15 units

type Account = { xrp: bigint; token: bigint; trustLine: boolean };

class MemoryLedger implements LedgerPort {
  readonly network: "testnet" | "devnet";
  readonly accounts = new Map<string, Account>();
  readonly submitted: Record<string, unknown>[] = [];
  readonly results: string[] = [];
  quote: { drops: bigint; paths: unknown[] } | undefined = { drops: 12_000_000n, paths: [] };
  unreachableReads = 0;
  funded = 0;
  private ledgerIndex = 1000;
  private seq = 0;

  constructor(network: "testnet" | "devnet") {
    this.network = network;
  }
  open(address: string, a: Partial<{ xrp: string; token: string; trustLine: boolean }> = {}): void {
    this.accounts.set(address, { xrp: decimalUnits(a.xrp ?? "100"), token: decimalUnits(a.token ?? "0"), trustLine: a.trustLine ?? true });
  }
  tokenOf(address: string): string {
    return unitsToDecimal(this.accounts.get(address)?.token ?? 0n);
  }
  async pay(_wallet: Wallet, tx: Record<string, unknown>): Promise<PayResult> {
    this.submitted.push(tx);
    this.seq += 1;
    const hash = this.seq.toString(16).toUpperCase().padStart(64, "0");
    const ledgerIndex = ++this.ledgerIndex;
    const forced = this.results.shift();
    if (forced !== undefined && forced !== "tesSUCCESS") return { hash, result: forced, validated: true, ledgerIndex, delivered: null };
    const from = tx.Account as string;
    if (tx.TransactionType === "TrustSet") {
      this.accounts.get(from)!.trustLine = true;
      return { hash, result: "tesSUCCESS", validated: true, ledgerIndex, delivered: null };
    }
    const amt = tx.Amount as { currency: string; issuer: string; value: string };
    const to = tx.Destination as string;
    const v = decimalUnits(amt.value);
    if (from === to) {
      const acct = this.accounts.get(from)!;
      acct.xrp -= BigInt(tx.SendMax as string) * DROP;
      acct.token += v;
    } else {
      if (from !== amt.issuer) {
        const src = this.accounts.get(from)!;
        if (src.token < v) return { hash, result: "tecPATH_PARTIAL", validated: true, ledgerIndex, delivered: null };
        src.token -= v;
      }
      if (to !== amt.issuer) {
        if (!this.accounts.has(to)) this.open(to, { xrp: "50" });
        this.accounts.get(to)!.token += v;
      }
    }
    return { hash, result: "tesSUCCESS", validated: true, ledgerIndex, delivered: { currency: amt.currency, issuer: amt.issuer, value: amt.value } };
  }
  async holding(address: string): Promise<Holding> {
    if (this.unreachableReads > 0) {
      this.unreachableReads -= 1;
      throw new Unreachable(`${this.network}: account_info ${address}: timed out`);
    }
    const a = this.accounts.get(address);
    if (!a) return { exists: false, xrp: "0", token: "0", trustLine: false };
    return { exists: true, xrp: unitsToDecimal(a.xrp), token: unitsToDecimal(a.token), trustLine: a.trustLine };
  }
  async quoteXrp(): Promise<{ drops: bigint; paths: unknown[] } | undefined> {
    return this.quote;
  }
  async fund(wallet: Wallet): Promise<void> {
    this.funded += 1;
    const a = this.accounts.get(wallet.classicAddress);
    if (a) a.xrp += decimalUnits("100");
    else this.open(wallet.classicAddress, { xrp: "100", trustLine: false });
  }
  reads() {
    return async (): Promise<Record<string, unknown>> => ({});
  }
  async close(): Promise<void> {}
}

const ISSUER = Wallet.generate();
const TUSD: TokenSpec = { code: "TUSD", currency: "5455534400000000000000000000000000000000", issuer: ISSUER.classicAddress };
const RLUSD_ISSUER = Wallet.generate().classicAddress;
const RLUSD: TokenSpec = { code: "RLUSD", currency: "524C555344000000000000000000000000000000", issuer: RLUSD_ISSUER };
const SELLER = Wallet.generate().classicAddress;

/** A clock that moves only when the lane sleeps. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = Date.UTC(2026, 9, 30, 9, 0, 0);
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function options(o: Partial<LaneOptions> & Pick<LaneOptions, "lane" | "token">): LaneOptions {
  return {
    to: SELLER,
    amount: "0.01",
    maxSpend: "0.03",
    mode: "direct",
    ratePerMin: 60,
    jitter: 0,
    startDelayMs: 0,
    fallbackMs: 90_000,
    pauseMs: 15_000,
    topup: null,
    faucet: null,
    ...o,
  };
}

function lane(ledger: MemoryLedger, wallet: Wallet, extra: Partial<LaneDeps> = {}): { deps: LaneDeps; records: StreamRecord[] } {
  const records: StreamRecord[] = [];
  const c = clock();
  return { records, deps: { ledger, wallet, tenant: "t01", write: (r) => records.push(r), now: c.now, sleep: c.sleep, random: () => 0.5, ...extra } };
}

const settled = (amount = "0.01"): Paid => ({
  response: new Response("{}", { status: 200 }),
  amount,
  invoiceId: "inv-1",
  receipt: { success: true, transaction: "AB".repeat(32), network: "xrpl:1" },
});

test("STREAM-TUSD direct TUSD payments to ChainAim until the budget: validated, exact, plain (memo, no SourceTag or InvoiceID)", async () => {
  const ledger = new MemoryLedger("devnet");
  const buyer = Wallet.generate();
  ledger.open(buyer.classicAddress, { token: "0.05" });
  const { deps, records } = lane(ledger, buyer);
  const s = await runLane(options({ lane: "tusd", token: TUSD }), deps);
  assert.deepEqual(
    records.map((r) => [r.kind ?? "-", r.result]),
    [
      ["direct", "validated"],
      ["direct", "validated"],
      ["direct", "validated"],
      ["-", "ended"],
    ],
  );
  assert.equal(s.paid, 3);
  assert.equal(s.spent, "0.03");
  assert.match(s.ended, /budget 0\.03 TUSD/);
  assert.equal(ledger.tokenOf(SELLER), "0.03");
  assert.equal(ledger.tokenOf(buyer.classicAddress), "0.02");
  for (const tx of ledger.submitted) {
    assert.equal(tx.SourceTag, undefined);
    assert.equal(tx.InvoiceID, undefined);
    assert.equal(tx.Flags, undefined);
    assert.equal((tx.Memos as { Memo: { MemoType: string } }[])[0].Memo.MemoType, Buffer.from(MEMO_TYPE).toString("hex").toUpperCase());
  }
  assert.ok(records.every((r) => r.network === "devnet" && r.token === "TUSD" && r.payer === buyer.classicAddress && !JSON.stringify(r).includes(buyer.seed!)));
});

test("STREAM-FAIL a payment that is not validated tesSUCCESS with the exact amount is recorded as failed and not counted", async () => {
  const ledger = new MemoryLedger("devnet");
  const buyer = Wallet.generate();
  ledger.open(buyer.classicAddress, { token: "1" });
  ledger.results.push("tecPATH_DRY");
  const { deps, records } = lane(ledger, buyer);
  const s = await runLane(options({ lane: "tusd", token: TUSD, maxSpend: "0.01" }), deps);
  assert.equal(records[0].result, "failed");
  assert.equal(records[0].error, "tecPATH_DRY");
  assert.equal(records[1].result, "validated");
  assert.equal(s.failed, 1);
  assert.equal(s.paid, 1);
  assert.equal(s.spent, "0.01");
  const r: PayResult = { hash: null, result: "tesSUCCESS", validated: true, ledgerIndex: 1, delivered: { currency: TUSD.currency, issuer: TUSD.issuer, value: "0.009" } };
  assert.equal(deliveredExactly(r, TUSD, "0.01"), false, "a partial delivery is not a payment");
  assert.equal(deliveredExactly({ ...r, delivered: { ...r.delivered!, value: "1e-2" } }, TUSD, "0.01"), true);
  assert.equal(deliveredExactly({ ...r, validated: false, delivered: { ...r.delivered!, value: "0.01" } }, TUSD, "0.01"), false);
});

test("STREAM-TUSD-MINT a low TUSD balance is topped up by the issuer, one mint at a time, within --max-mint for the whole run", async () => {
  const ledger = new MemoryLedger("devnet");
  ledger.open(ISSUER.classicAddress, { trustLine: false });
  const a = Wallet.generate();
  const b = Wallet.generate();
  ledger.open(a.classicAddress);
  ledger.open(b.classicAddress);
  const minter = new Minter({ issuer: ISSUER, ledger, token: TUSD, maxMint: "1" });
  const topup = { below: "0.05", amount: "1", maxCount: 3 };
  const first = lane(ledger, a, { minter });
  const sa = await runLane(options({ lane: "tusd", token: TUSD, maxSpend: "0.01", topup }), first.deps);
  assert.deepEqual(first.records.map((r) => [r.kind ?? "-", r.result]).slice(0, 2), [["mint", "validated"], ["direct", "validated"]]);
  assert.equal(sa.paid, 1);
  assert.equal(ledger.tokenOf(a.classicAddress), "0.99");

  const second = lane(ledger, b, { minter });
  const c = clock();
  await runLane(options({ lane: "tusd", token: TUSD, topup, deadline: c.now() + 40_000 }), { ...second.deps, now: c.now, sleep: c.sleep });
  assert.ok(second.records.length > 0);
  assert.ok(second.records.every((r) => r.result === "paused" && /--max-mint 1 TUSD reached/.test(r.error ?? "")));
  assert.equal(minter.minted, decimalUnits("1"));
  assert.throws(() => new Minter({ issuer: Wallet.generate(), ledger, token: TUSD, maxMint: "1" }), /is issued by/);
});

test("STREAM-TOPUP RLUSD is bought with the wallet's XRP when low, never below --keep-xrp", async () => {
  const ledger = new MemoryLedger("testnet");
  const rich = Wallet.generate();
  ledger.open(rich.classicAddress, { xrp: "100", token: "0" });
  const topup = { below: "0.05", amount: "1", maxCount: 3 };
  const buy = { maxXrp: "15", slippagePct: 2, keepXrp: "20" };
  const r1 = lane(ledger, rich);
  await runLane(options({ lane: "rlusd", token: RLUSD, maxSpend: "0.01", topup, buy }), r1.deps);
  assert.deepEqual(r1.records.map((r) => [r.kind ?? "-", r.result]).slice(0, 2), [["topup", "validated"], ["direct", "validated"]]);
  const buyTx = ledger.submitted[0];
  assert.equal(buyTx.Account, buyTx.Destination);
  assert.equal(buyTx.SendMax, "12240000", "quote 12 XRP + 2 % slippage, in drops");
  assert.deepEqual(buyTx.Amount, { currency: RLUSD.currency, issuer: RLUSD.issuer, value: "1" });

  const poor = Wallet.generate();
  ledger.open(poor.classicAddress, { xrp: "25", token: "0" });
  const before = ledger.submitted.length;
  const c = clock();
  const r2 = lane(ledger, poor, { now: c.now, sleep: c.sleep });
  await runLane(options({ lane: "rlusd", token: RLUSD, topup, buy, deadline: c.now() + 20_000 }), r2.deps);
  assert.equal(ledger.submitted.length, before, "nothing bought or paid");
  assert.match(r2.records[0].error ?? "", /--keep-xrp 20/);
  assert.equal(r2.records[0].result, "paused");
});

test("STREAM-AUTO x402 first; when it does not settle the lane pays direct for --fallback-sec, then tries x402 again", async () => {
  const ledger = new MemoryLedger("testnet");
  const buyer = Wallet.generate();
  ledger.open(buyer.classicAddress, { token: "1" });
  const calls: string[] = [];
  const x402Pay = async (url: string): Promise<Paid> => {
    calls.push(url);
    if (calls.length === 1) throw new TypeError("fetch failed");
    return settled();
  };
  const { deps, records } = lane(ledger, buyer, { x402Pay });
  const s = await runLane(
    options({ lane: "rlusd", token: RLUSD, mode: "auto", ratePerMin: 1, fallbackMs: 90_000, x402: { url: "http://127.0.0.1:8080", endpoint: "scan", queries: ["Summarise the supplier dispute."], maxTokens: 64 } }),
    deps,
  );
  assert.deepEqual(
    records.map((r) => [r.kind ?? "-", r.result]),
    [
      ["x402", "error"],
      ["direct", "validated"],
      ["direct", "validated"],
      ["x402", "validated"],
      ["-", "ended"],
    ],
  );
  assert.equal(calls.length, 2, "x402 is not retried inside the fallback window");
  assert.equal(calls[0], "http://127.0.0.1:8080/v1/privacy/scan");
  assert.match(records[0].error ?? "", /paywall not reached: fetch failed/);
  assert.equal(records[3].hash, "AB".repeat(32));
  assert.equal(s.x402, 1);
  assert.equal(s.direct, 2);
  assert.equal(s.spent, "0.03");
});

test("STREAM-X402 mode x402 never pays direct: a refusal is recorded as not settled", async () => {
  const ledger = new MemoryLedger("testnet");
  const buyer = Wallet.generate();
  ledger.open(buyer.classicAddress, { token: "1" });
  const c = clock();
  const x402Pay = async (): Promise<Paid> => ({ response: new Response("", { status: 402 }), amount: "0.01", invoiceId: "inv-2", refusal: "fetch failed" });
  const { deps, records } = lane(ledger, buyer, { x402Pay, now: c.now, sleep: c.sleep });
  const s = await runLane(
    options({ lane: "rlusd", token: RLUSD, mode: "x402", deadline: c.now() + 2_500, x402: { url: "http://127.0.0.1:8080", endpoint: "scan", queries: ["Status of the order?"], maxTokens: 64 } }),
    deps,
  );
  assert.ok(records.length >= 2);
  assert.ok(records.every((r) => r.kind === "x402" && r.result === "not_settled" && r.error === "refused by the paywall: fetch failed"));
  assert.equal(ledger.submitted.length, 0);
  assert.equal(s.paid, 0);
  assert.equal(s.ended, "deadline");
});

test("STREAM-PAUSE an unreachable ledger, a missing trust line or account pauses with the reason and the lane carries on; the faucet funds a Devnet wallet", async () => {
  const ledger = new MemoryLedger("devnet");
  const buyer = Wallet.generate();
  ledger.open(buyer.classicAddress, { token: "1" });
  ledger.unreachableReads = 1;
  const r1 = lane(ledger, buyer);
  await runLane(options({ lane: "tusd", token: TUSD, maxSpend: "0.01" }), r1.deps);
  assert.equal(r1.records[0].result, "paused");
  assert.match(r1.records[0].error ?? "", /timed out/);
  assert.equal(r1.records[1].result, "validated");

  const noLine = Wallet.generate();
  ledger.open(noLine.classicAddress, { trustLine: false });
  const c = clock();
  const r2 = lane(ledger, noLine, { now: c.now, sleep: c.sleep });
  await runLane(options({ lane: "tusd", token: TUSD, deadline: c.now() + 20_000 }), r2.deps);
  assert.match(r2.records[0].error ?? "", /no TUSD trust line/);

  const fresh = Wallet.generate();
  const c3 = clock();
  const r3 = lane(ledger, fresh, { now: c3.now, sleep: c3.sleep });
  await runLane(options({ lane: "tusd", token: TUSD, faucet: { minXrp: "15" }, deadline: c3.now() + 10_000 }), r3.deps);
  assert.equal(ledger.funded, 1);
  assert.deepEqual([r3.records[0].kind, r3.records[0].result, r3.records[0].token, r3.records[0].amount], ["faucet", "validated", "XRP", "100"]);
  assert.match(r3.records[1].error ?? "", /no TUSD trust line/, "funded, but the trust line is setup-devnet's job");

  const stop = new AbortController();
  stop.abort();
  const r4 = lane(ledger, buyer, { signal: stop.signal });
  const s4 = await runLane(options({ lane: "tusd", token: TUSD }), r4.deps);
  assert.equal(s4.ended, "stopped");
  assert.equal(r4.records.length, 0);
});

test("STREAM-CLI run and setup-devnet flags: defaults match start-live.ps1, bad values are refused by name", () => {
  const d = parseRunArgs([]);
  assert.deepEqual([d.lanes, d.mode, d.url, d.endpoint, d.ratePerMin, d.amount, d.tusdAmount, d.maxSpend, d.payToEnv, d.traceUrl, d.traceKeyEnv, d.fallbackSec, d.faucet], [
    ["rlusd", "tusd"], "auto", "http://127.0.0.1:8080", "scan", 6, "0.01", "0.01", "1", "XRPL_PAY_TO_TESTNET", null, "LEDGER_WATCH_INGEST_KEY", 300, "devnet",
  ]);
  const live = parseRunArgs(["--lanes", "rlusd,tusd", "--mode", "auto", "--url", "http://127.0.0.1:8080", "--trace-url", "http://127.0.0.1:8790/ingest/trace", "--rate-per-min", "6"]);
  assert.equal(live.traceUrl, "http://127.0.0.1:8790/ingest/trace");
  assert.throws(() => parseRunArgs(["--lanes", "eur"]), /--lanes: eur/);
  assert.throws(() => parseRunArgs(["--mode", "fast"]), /--mode must be one of/);
  assert.throws(() => parseRunArgs(["--amount", "0"]), /--amount must be a decimal above zero/);
  assert.throws(() => parseRunArgs(["--rate-per-min", "0"]), /--rate-per-min/);
  assert.throws(() => parseRunArgs(["--tusd-to", "rptwZFjsikk6utPfyqMn7Swk9BcxoUqcqX"]), /--tusd-to/);
  assert.throws(() => parseRunArgs(["--seed", "sEd..."]), SetupError);
  assert.throws(() => parseSetupArgs([]), /--secrets-out FILE is required/);
  assert.equal(parseSetupArgs(["--secrets-out", "C:\\PRIV-AI-SECRETS\\rig-devnet.env"]).mintAmount, "2");
  assert.deepEqual(readAsset({ asset: { code: "TUSD", currency: TUSD.currency.toLowerCase(), issuer: TUSD.issuer } }, "state"), TUSD);
  assert.throws(() => readAsset({}, "state.json"), /has no "asset"/);
  assert.equal(plainDecimal("1e-2"), "0.01");
  assert.equal(plainDecimal("-3"), "0");
  assert.equal(plainDecimal("5.0400"), "5.04");
});
