/**
 * The console's paid-job feed to near-watch (test-console/console/job-feed.ts; chainaim-adminUI-NEAR
 * architecture-adminui-jobs.md ARCH-205), against the REAL near-watch server started from its own code
 * (near-watch-server.ts). The end-to-end behaviour with the console process is in scripts/test/console-paid-jobs.test.ts.
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { JobFeed, jobFeedConfig, jobSteps, quotedEvent, type JobFeedConfig } from "../console/job-feed.ts";
import { JobStore, internalHandler } from "../console/jobs.ts";
import { quoteJob, type Fees } from "../../packages/crossask/src/cost.ts";
import type { CrossAskResult } from "../../packages/crossask/src/index.ts";
import { INGEST_KEY, startNearWatch, type NearWatch } from "./near-watch-server.ts";

const MARKER = "Zqxjobfeedmarker";
const MODEL = "bedrock/nemotron-nano-3-30b";
const FEES: Fees = { perModelCallUsd: "0.001", analystUsd: "0.002", nearGasUsd: "0.0005", marginPct: "20", minPriceUsd: "0.01" };
const PRICES = { [MODEL]: { inputPerM: 0.0618, outputPerM: 0.2472 } };
/** What crossAsk returns for a job with the step timings on (a question, SQL, rows and an answer that must never leave). */
const RESULT: CrossAskResult = {
  question: `How much did ${MARKER} spend?`, schema: `orders(customer VARCHAR) -- C:\\data\\${MARKER}`, relations: [{ a: { table: "orders", column: "id" } }],
  attempts: [{ sql: `SELECT sum(amount) FROM orders WHERE customer = '${MARKER}'` }], sql: `SELECT sum(amount) FROM orders WHERE customer = '${MARKER}'`,
  result: { columns: ["total"], rows: [{ total: `${MARKER} 42` }], truncated: false }, answer: `${MARKER} spent 42.`, unverified: [], warnings: [],
  served: [
    { text: "```sql\nSELECT 1\n```", model: MODEL, zone: "private-cloud", usage: { promptTokens: 1000, completionTokens: 50 }, entityCounts: { PERSON: 1 }, residual: "pass" },
    { text: `${MARKER} spent 42.`, model: MODEL, zone: "private-cloud", usage: { promptTokens: 2000, completionTokens: 150 }, entityCounts: {}, residual: "pass" },
  ],
  sentToModel: [], timings: { relationsMs: 412, queryMs: 2310, sqlMs: 38, answerMs: 1804, callsMs: [2310, 1804], files: 2 },
};
const quote = quoteJob(RESULT.served.map((s) => ({ model: s.model!, promptTokens: s.usage!.promptTokens, completionTokens: s.usage!.completionTokens })), PRICES, FEES);
const KEY = "k".repeat(30);
const ID = (n: number) => n.toString(16).padStart(32, "a");
const job = (jobId: string) => ({ jobId, network: "near:testnet", expiresAt: Date.parse("2026-11-05T10:15:00Z"), out: RESULT, quote });
const waitFor = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 10)); };

describe("ARCH-205: configuration", () => {
  const env = { NEAR_WATCH_INGEST_KEY: KEY };
  test("ARCH-205: off without --job-feed-url; defaults with it", () => {
    assert.equal(jobFeedConfig({}, env, true), undefined);
    assert.equal(jobFeedConfig({ "job-feed-url": "" }, env, false), undefined);
    const c = jobFeedConfig({ "job-feed-url": "http://127.0.0.1:8790/ingest/job" }, env, true)!;
    assert.deepEqual([c.keyEnv, c.timeoutMs, c.maxInflight, c.expiryCheckSec], ["NEAR_WATCH_INGEST_KEY", 5000, 20, 30]);
  });
  test("ARCH-205: start-up refuses without --paid-jobs on, a key under 24 characters, a bad URL or a bad number; the key is never in a message", () => {
    const url = { "job-feed-url": "http://127.0.0.1:8790/ingest/job" };
    assert.throws(() => jobFeedConfig(url, env, false), /needs --paid-jobs on/);
    for (const e of [{}, { NEAR_WATCH_INGEST_KEY: "short-key" }]) {
      assert.throws(() => jobFeedConfig(url, e, true), (err: Error) => /needs the environment variable NEAR_WATCH_INGEST_KEY/.test(err.message) && !err.message.includes("short-key"));
    }
    assert.throws(() => jobFeedConfig({ ...url, "job-feed-key-env": "lower-case" }, env, true), /environment variable name/);
    assert.throws(() => jobFeedConfig({ "job-feed-url": "near-watch" }, env, true), /must be a URL/);
    assert.throws(() => jobFeedConfig({ "job-feed-url": "file:///x" }, env, true), /http or https/);
    assert.throws(() => jobFeedConfig({ ...url, "job-feed-max-inflight": "0" }, env, true), /job-feed-max-inflight/);
  });
});

describe("ARCH-205: the events", () => {
  test("ARCH-205: job_quoted carries steps in run order, priced per call by cost.ts, and the quote's breakdown", () => {
    const e = quotedEvent(job(ID(1)), Date.parse("2026-11-05T10:00:00Z"));
    assert.equal(e.event, "job_quoted");
    if (e.event !== "job_quoted") return;
    assert.deepEqual([e.ts, e.expiresAt, e.amount, e.totalUsd], ["2026-11-05T10:00:00.000Z", "2026-11-05T10:15:00.000Z", quote.amount, quote.totalUsd]);
    assert.deepEqual(e.steps.map((s) => s.name), ["analyst", "query", "sql", "answer"]);
    assert.deepEqual(e.steps[0], { name: "analyst", ms: 412, files: 2, relations: 1 });
    assert.deepEqual(e.steps[2], { name: "sql", ms: 38, rows: 1 });
    assert.deepEqual(e.steps[1], { name: "query", ms: 2310, model: MODEL, zone: "private-cloud", promptTokens: 1000, completionTokens: 50, usd: quote.breakdown.calls[0].usd, entityCounts: { PERSON: 1 }, residual: "pass" });
    assert.equal((e.steps[3] as { usd: string }).usd, quote.breakdown.calls[1].usd);
    assert.deepEqual(e.breakdown, quote.breakdown);
  });
  test("ARCH-205: phrase none (no answer call): no answer step; no timings: refused", () => {
    const none = { ...RESULT, answer: null, served: RESULT.served.slice(0, 1), timings: { ...RESULT.timings!, answerMs: undefined, callsMs: [2310] } };
    const q1 = quoteJob([{ model: MODEL, promptTokens: 1000, completionTokens: 50 }], PRICES, FEES);
    assert.deepEqual(jobSteps(none, q1).map((s) => s.name), ["analyst", "query", "sql"]);
    assert.throws(() => jobSteps({ ...RESULT, timings: undefined }, quote), /no step timings/);
  });
  test("ARCH-205: the posted bodies contain no question, SQL, rows, answer or path (synthetic marker)", async () => {
    const bodies: string[] = [];
    const rec: Server = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { bodies.push(b); res.writeHead(202).end("{}"); }); });
    await new Promise<void>((ok) => rec.listen(0, "127.0.0.1", () => ok()));
    try {
      const feed = new JobFeed({ url: `http://127.0.0.1:${(rec.address() as AddressInfo).port}/ingest/job`, key: KEY, keyEnv: "X", timeoutMs: 2000, maxInflight: 5, expiryCheckSec: 30 }, () => {});
      feed.quoted(job(ID(2)));
      feed.released(ID(2));
      await feed.idle();
      assert.equal(bodies.length, 2);
      for (const b of bodies) for (const leak of [MARKER, "SELECT", "orders", "spent", "C:\\\\data", '"question":', '"sql":', '"answer":', '"schema":', '"result":']) assert.equal(b.includes(leak), false, `${leak} in ${b.slice(0, 80)}`);
    } finally {
      await new Promise<void>((ok) => rec.close(() => ok()));
    }
  });
});

describe("ARCH-205: against the real near-watch", () => {
  let nw: NearWatch;
  before(async () => { nw = await startNearWatch(); });
  after(async () => { await nw.close(); });
  const cfg = (over: Partial<JobFeedConfig> = {}): JobFeedConfig => ({ url: nw.ingestUrl, key: INGEST_KEY, keyEnv: "NEAR_WATCH_INGEST_KEY", timeoutMs: 2000, maxInflight: 20, expiryCheckSec: 30, ...over });

  test("ARCH-205: each event arrives once and is accepted (quoted, released; quoted, expired)", async () => {
    const logs: string[] = [];
    const feed = new JobFeed(cfg(), (l) => logs.push(l));
    feed.quoted(job(ID(3)));
    await feed.idle();
    feed.released(ID(3));
    feed.released(ID(3)); // a second release of the same job is not sent again
    feed.quoted(job(ID(4)));
    await feed.idle();
    feed.expired(ID(4));
    await feed.idle();
    assert.deepEqual(logs, []);
    assert.deepEqual(feed.counters, { sent: 4, failed: 0 });
    assert.deepEqual([nw.liveOps.jobs.counters.events, nw.liveOps.jobs.counters.repeats, nw.liveOps.counters.refused], [4, 0, 0]);
    assert.equal(nw.store.getJob(ID(3))?.state, "released");
    assert.equal(nw.store.getJob(ID(4))?.state, "expired");
    assert.deepEqual([nw.store.getJob(ID(3))?.amount, nw.store.getJob(ID(3))?.totalUsd], [quote.amount, quote.totalUsd]);
  });

  test("ARCH-205: the store's expiry and the internal release hook drive the feed", async () => {
    let now = 1_000;
    const seen: string[] = [];
    const feed = new JobFeed(cfg(), () => {});
    const store = new JobStore(5, 60_000, () => now, (j) => { seen.push(`expired ${j.jobId}`); feed.expired(j.jobId); });
    for (const id of [ID(5), ID(6)]) { store.hold({ jobId: id, result: RESULT, amount: quote.amount, breakdown: quote.breakdown, expiresAt: now + 60_000 }); feed.quoted({ ...job(id), expiresAt: now + 60_000 }); }
    await feed.idle();
    const handler = internalHandler(store, KEY, (id) => { seen.push(`released ${id}`); feed.released(id); });
    const srv: Server = createServer(handler);
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    try {
      const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/internal/jobs/${ID(5)}/released`, { method: "POST", headers: { "x-jobs-key": KEY } });
      assert.equal(r.status, 200);
      await r.text();
      now += 60_000;
      assert.equal(store.size(), 0, "ID(6) expired");
      assert.equal(store.size(), 0);
      await feed.idle();
      assert.deepEqual(seen, [`released ${ID(5)}`, `expired ${ID(6)}`], "each once");
      await waitFor(() => nw.store.getJob(ID(6))?.state === "expired");
      assert.deepEqual([nw.store.getJob(ID(5))?.state, nw.store.getJob(ID(6))?.state], ["released", "expired"]);
    } finally {
      await new Promise<void>((ok) => { srv.closeAllConnections(); srv.close(() => ok()); });
    }
  });

  test("ARCH-205: a near-watch that is down, refuses or is busy never throws; each failed post is logged once (job id and reason only)", async () => {
    const logs: string[] = [];
    const down = new JobFeed(cfg({ url: "http://127.0.0.1:9/ingest/job" }), (l) => logs.push(l));
    down.quoted(job(ID(7)));
    await down.idle();
    const wrongKey = new JobFeed(cfg({ key: "x".repeat(30) }), (l) => logs.push(l));
    wrongKey.quoted(job(ID(8)));
    await wrongKey.idle();
    const busy = new JobFeed(cfg({ maxInflight: 1 }), (l) => logs.push(l));
    busy.quoted(job(ID(9)));
    busy.quoted(job(ID(10)));
    await busy.idle();
    const lines = logs.map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.event, l.jobId, l.reason]), [["job_feed_failed", ID(7), "unreachable"], ["job_feed_failed", ID(8), "HTTP 401"], ["job_feed_failed", ID(10), "too many in flight"]]);
    for (const l of logs) for (const leak of [INGEST_KEY, "x".repeat(30), MARKER]) assert.equal(l.includes(leak), false);
    assert.equal(nw.store.getJob(ID(9))?.state, "quoted");
  });
});
