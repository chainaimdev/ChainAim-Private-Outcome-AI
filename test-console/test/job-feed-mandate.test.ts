/**
 * The job feed's checkout mandate on job_receipt (privateAI-design-42 ARCH-710; chainaim-adminUI-NEAR near-watch ARCH-704,
 * admin console ARCH-705), against the REAL near-watch server started from its own code (near-watch-server.ts), with a
 * receipt signed by packages/receipt (real Ed25519) that records a checkout mandate (design-36 ARCH-668).
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { JobFeed, jobFeedConfig, quotedEvent, receiptEvent } from "../console/job-feed.ts";
import { quoteJob, type Fees } from "../../packages/crossask/src/cost.ts";
import type { CrossAskResult } from "../../packages/crossask/src/index.ts";
import { addSettlement, filesRoot, resultSha256, sha256Hex, signerFromKey, signReceipt } from "../../packages/receipt/src/index.ts";
import { INGEST_KEY, nearWatchSkip, startNearWatch, type NearWatch } from "./near-watch-server.ts";

const MODEL = "bedrock/nemotron-nano-3-30b";
const FEES: Fees = { perModelCallUsd: "0.001", analystUsd: "0.002", nearGasUsd: "0.0005", marginPct: "20", minPriceUsd: "0.01" };
const RESULT: CrossAskResult = {
  question: "q", schema: "s", relations: [], attempts: [{ sql: "SELECT 1" }], sql: "SELECT 1", result: { columns: ["n"], rows: [{ n: 1 }], truncated: false },
  answer: "1", unverified: [], warnings: [],
  served: [{ text: "x", model: MODEL, zone: "private-cloud", usage: { promptTokens: 1000, completionTokens: 50 } }, { text: "1", model: MODEL, zone: "private-cloud", usage: { promptTokens: 2000, completionTokens: 150 } }],
  sentToModel: [], timings: { relationsMs: 10, queryMs: 20, sqlMs: 5, answerMs: 30, callsMs: [20, 30], files: 1 },
};
const quote = quoteJob(RESULT.served.map((s) => ({ model: s.model!, promptTokens: s.usage!.promptTokens, completionTokens: s.usage!.completionTokens })), { [MODEL]: { inputPerM: 0.0618, outputPerM: 0.2472 } }, FEES, { round: "cent" });
const NETWORK = "near:testnet";
const ID = (n: number) => (0xa4200000 + n).toString(16).padStart(32, "0");
const AP2 = { kid: "83816e6fd32b879fd96d0318a40cd40d", merchantAuthSha256: sha256Hex("eyJhbGciOiJFUzI1NiJ9..sig") };
const env = { NEAR_WATCH_INGEST_KEY: "k".repeat(24) };

const MANDATE = { sha256: "7cd12328f2e8e1d0fee66764ba5e84b80858e194fafe9c31d4caa578884d1250", kid: "964b1199a73a9b22e6be8bc2e4b2ce26", tenant: "t01", accountId: "chainaim-buyer-seller.testnet", nonce: "7E891A98F5D8491F95C631504A07007C" };
const TX = "6RoFLYdZ3q8m4hWbKcBtZ8x1yNvP2sTuQwErAa";
const signer = signerFromKey(generateKeyPairSync("ed25519").privateKey);
const FILES = [{ name: "orders.csv", bytes: 10, sha256: sha256Hex("f") }];
function settledReceipt(jobId: string, withMandate: boolean) {
  return addSettlement(signReceipt({
    v: 1, receiptId: sha256Hex(`r${jobId}`).slice(0, 32), jobId, quoteId: jobId, route: MODEL, datasetId: "d", files: FILES, filesRoot: filesRoot(FILES),
    sqlSha256: sha256Hex("s"), resultSha256: resultSha256({ n: 1 }), calls: [], merchantAuthSha256: AP2.merchantAuthSha256,
    price: { amountUnits: quote.amount, usdcDecimals: 6, priceUsd: quote.totalUsd, quoteBasis: {} }, createdAt: "2026-11-11T19:31:00.000Z",
    ...(withMandate ? { mandate: MANDATE } : {}),
  }, signer), { network: NETWORK, transaction: TX, invoiceId: MANDATE.nonce, payer: MANDATE.accountId, settledAt: "2026-11-11T19:31:05.000Z" }, signer);
}

test("ARCH-710: --job-feed-mandate is off by default, only on/off, and needs --job-feed-url and --job-feed-receipts on", () => {
  const url = { "job-feed-url": "http://127.0.0.1:8790/ingest/job" };
  assert.equal(jobFeedConfig(url, env, true)!.mandate, false);
  assert.equal(jobFeedConfig({ ...url, "job-feed-receipts": "on", "job-feed-mandate": "on" }, env, true)!.mandate, true);
  assert.throws(() => jobFeedConfig({ "job-feed-mandate": "on" }, env, true), /--job-feed-mandate on needs --job-feed-url/);
  assert.throws(() => jobFeedConfig({ ...url, "job-feed-mandate": "on" }, env, true), /--job-feed-mandate on needs --job-feed-receipts on/);
  assert.throws(() => jobFeedConfig({ ...url, "job-feed-receipts": "on", "job-feed-mandate": "yes" }, env, true), /--job-feed-mandate must be on or off/);
});

test("ARCH-710: job_receipt carries mandate {kid, tenant, sha256} only when asked and recorded; never accountId or nonce", () => {
  const withM = settledReceipt(ID(1), true);
  const off = receiptEvent(withM, NETWORK) as Record<string, any>;
  assert.equal("mandate" in off, false, "off by default: the event is exactly as before");
  const on = receiptEvent(withM, NETWORK, Date.now(), true) as Record<string, any>;
  assert.deepEqual(on.mandate, { kid: MANDATE.kid, tenant: MANDATE.tenant, sha256: MANDATE.sha256 });
  const text = JSON.stringify(on);
  assert.equal(text.includes(MANDATE.accountId), false);
  assert.equal(text.includes(MANDATE.nonce), false);
  assert.equal("mandate" in (receiptEvent(settledReceipt(ID(2), false), NETWORK, Date.now(), true) as Record<string, any>), false, "a receipt with no mandate sends none");
});

describe("ARCH-710 (adminUI ARCH-704): the REAL near-watch accepts the mandate the console sends", { skip: nearWatchSkip() }, () => {
  let nw: NearWatch;
  before(async () => { nw = await startNearWatch(); });
  after(async () => { await nw?.close(); });
  const feed = (mandate: boolean, logs: string[]) =>
    new JobFeed({ url: nw.ingestUrl, key: INGEST_KEY, keyEnv: "X", timeoutMs: 5000, maxInflight: 10, expiryCheckSec: 30, ap2: true, receipts: true, mandate }, (l) => logs.push(l), () => Date.parse("2026-11-11T19:30:00Z"));
  const job = (jobId: string) => ({ jobId, network: NETWORK, expiresAt: Date.parse("2026-11-11T19:45:00Z"), out: RESULT, quote, ap2: AP2 });
  const store = () => nw.store as unknown as { getMandate(id: string): { kid: string; tenant: string; sha256: string } | undefined; getReceipt(id: string): { receiptId: string } | undefined };

  test("ARCH-710: with --job-feed-mandate on the mandate is stored beside the receipt; off, the receipt is stored without one", async () => {
    const logs: string[] = [];
    const on = feed(true, logs);
    on.quoted(job(ID(10)));
    on.receipt(settledReceipt(ID(10), true), NETWORK);
    const off = feed(false, logs);
    off.quoted(job(ID(11)));
    off.receipt(settledReceipt(ID(11), true), NETWORK);
    await on.idle(); await off.idle();
    assert.deepEqual(logs, []);
    assert.equal(nw.liveOps.counters.refused, 0);
    const m = store().getMandate(ID(10));
    assert.deepEqual([m?.kid, m?.tenant, m?.sha256], [MANDATE.kid, MANDATE.tenant, MANDATE.sha256]);
    assert.ok(store().getReceipt(ID(11)));
    assert.equal(store().getMandate(ID(11)), undefined);
  });
});
