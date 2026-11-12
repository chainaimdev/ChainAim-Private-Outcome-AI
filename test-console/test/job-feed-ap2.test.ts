/**
 * The job feed's signed quote and receipt (privateAI-design-33 section 7 admin UI; chainaim-adminUI-NEAR near-watch
 * ARCH-701 job_receipt, ARCH-702 job_quoted.ap2), against the REAL near-watch server started from its own code
 * (near-watch-server.ts), with a receipt signed by packages/receipt (real Ed25519).
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
const ID = (n: number) => (0xa2000000 + n).toString(16).padStart(32, "0");
const AP2 = { kid: "83816e6fd32b879fd96d0318a40cd40d", merchantAuthSha256: sha256Hex("eyJhbGciOiJFUzI1NiJ9..sig") };
const env = { NEAR_WATCH_INGEST_KEY: "k".repeat(24) };

test("ARCH-628 (adminUI ARCH-702): --job-feed-ap2 is off by default, needs --job-feed-url, and only on/off", () => {
  const url = { "job-feed-url": "http://127.0.0.1:8790/ingest/job" };
  assert.equal(jobFeedConfig(url, env, true)!.ap2, false);
  assert.equal(jobFeedConfig({ ...url, "job-feed-ap2": "on" }, env, true)!.ap2, true);
  assert.throws(() => jobFeedConfig({ "job-feed-ap2": "on" }, env, true), /--job-feed-ap2 on needs --job-feed-url/);
  assert.throws(() => jobFeedConfig({ ...url, "job-feed-ap2": "yes" }, env, true), /--job-feed-ap2 must be on or off/);
});

test("ARCH-628 (adminUI ARCH-702): job_quoted carries ap2 {kid, merchantAuthSha256} only when given; a cent quote's breakdown sends no beforeCentUsd", () => {
  const job = { jobId: ID(1), network: NETWORK, expiresAt: Date.parse("2026-11-11T20:00:00Z"), out: RESULT, quote };
  const plain = quotedEvent(job) as Record<string, any>;
  assert.equal("ap2" in plain, false);
  assert.equal("beforeCentUsd" in plain.breakdown, false, "near-watch refuses unknown breakdown fields");
  assert.deepEqual((quotedEvent({ ...job, ap2: AP2 }) as Record<string, any>).ap2, AP2);
});

describe("ARCH-628 ARCH-631 (adminUI ARCH-701 ARCH-702): the REAL near-watch accepts what the console sends", { skip: nearWatchSkip() }, () => {
  let nw: NearWatch;
  before(async () => { nw = await startNearWatch(); });
  after(async () => { await nw?.close(); });
  const feed = (ap2: boolean, receipts: boolean, logs: string[]) =>
    new JobFeed({ url: nw.ingestUrl, key: INGEST_KEY, keyEnv: "X", timeoutMs: 5000, maxInflight: 10, expiryCheckSec: 30, ap2, receipts }, (l) => logs.push(l), () => Date.parse("2026-11-11T19:30:00Z"));
  const job = (jobId: string) => ({ jobId, network: NETWORK, expiresAt: Date.parse("2026-11-11T19:45:00Z"), out: RESULT, quote, ap2: AP2 });
  const store = () => nw.store as unknown as { getSignedQuote(id: string): { kid: string; merchantAuthSha256: string } | undefined; getReceipt(id: string): { receiptId: string; settled: boolean; transaction: string | null } | undefined; getJob(id: string): unknown };

  test("ARCH-702: with --job-feed-ap2 on, job_quoted with ap2 is stored with its signed quote; off, the job is stored without one", async () => {
    const logs: string[] = [];
    const on = feed(true, false, logs);
    on.quoted(job(ID(10)));
    const off = feed(false, false, logs);
    off.quoted(job(ID(11)));
    await on.idle(); await off.idle();
    assert.deepEqual(logs, []);
    assert.equal(nw.liveOps.counters.refused, 0);
    // near-watch keeps its own network name for the row (watchedNetwork): compare the signed-quote fields only.
    const sq = store().getSignedQuote(ID(10));
    assert.deepEqual([sq?.kid, sq?.merchantAuthSha256], [AP2.kid, AP2.merchantAuthSha256]);
    assert.ok(store().getJob(ID(11)));
    assert.equal(store().getSignedQuote(ID(11)), undefined);
  });

  test("ARCH-701: a real signed and settled receipt's job_receipt is accepted and stored", async () => {
    const signer = signerFromKey(generateKeyPairSync("ed25519").privateKey);
    const files = [{ name: "orders.csv", bytes: 10, sha256: sha256Hex("f") }];
    const r = addSettlement(signReceipt({
      v: 1, receiptId: sha256Hex("r").slice(0, 32), jobId: ID(12), quoteId: ID(12), route: MODEL, datasetId: "d", files, filesRoot: filesRoot(files),
      sqlSha256: sha256Hex("s"), resultSha256: resultSha256({ n: 1 }), calls: [], merchantAuthSha256: AP2.merchantAuthSha256,
      price: { amountUnits: quote.amount, usdcDecimals: 6, priceUsd: quote.totalUsd, quoteBasis: {} }, createdAt: "2026-11-11T19:31:00.000Z",
    }, signer), { network: NETWORK, transaction: "6RoFLYdZ3q8m4hWbKcBtZ8x1yNvP2sTuQwErAa", invoiceId: "inv", payer: "t01.testnet", settledAt: "2026-11-11T19:31:05.000Z" }, signer);
    const logs: string[] = [];
    const f = feed(true, true, logs);
    f.quoted(job(ID(12)));
    f.receipt(r, NETWORK);
    await f.idle();
    assert.deepEqual(logs, []);
    assert.equal(nw.liveOps.counters.refused, 0);
    assert.deepEqual(receiptEvent(r, NETWORK).event, "job_receipt");
    const got = store().getReceipt(ID(12));
    assert.deepEqual([got?.receiptId, got?.settled, got?.transaction], [r.body.receiptId, true, "6RoFLYdZ3q8m4hWbKcBtZ8x1yNvP2sTuQwErAa"]);
  });
});
