/**
 * The console's paid-job store and checks (test-console/console/jobs.ts, architecture.md ARCH-104, ARCH-105, ARCH-114),
 * with a clock passed in so expiry is tested without waiting. The end-to-end behaviour (real console, analyst, gateway
 * and paywall processes) is in scripts/test/console-paid-jobs.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { JobStore, internalHandler, meterOf, paidJobsConfig, priceRoundOf, FEE_FLAGS } from "../console/jobs.ts";
import type { CrossAskResult } from "../../packages/crossask/src/index.ts";

const RESULT = { question: "q", answer: "a" } as unknown as CrossAskResult;
const held = (jobId: string, expiresAt: number) => ({ jobId, result: RESULT, amount: "100", breakdown: {} as never, expiresAt });
const ID = "0123456789abcdef0123456789abcdef";
const KEY = "k".repeat(24) + "-paid-jobs-test";

test("ARCH-104: expiry removes the job", () => {
  let now = 1_000_000;
  const store = new JobStore(2, 15 * 60_000, () => now);
  assert.equal(store.expiryFromNow(), now + 15 * 60_000);
  store.hold(held(ID, now + 1000));
  assert.equal(store.get(ID)?.jobId, ID);
  now += 999;
  assert.ok(store.get(ID));
  now += 1;
  assert.equal(store.get(ID), undefined, "gone at its expiry");
  assert.equal(store.size(), 0);
});

test("ARCH-104: --job-max open jobs at most; an expired one frees its place", () => {
  let now = 0;
  const store = new JobStore(2, 60_000, () => now);
  store.hold(held("a".repeat(32), 100));
  store.hold(held("b".repeat(32), 200));
  assert.equal(store.full(), true);
  now = 150;
  assert.equal(store.full(), false);
  assert.match(store.newJobId(), /^[0-9a-f]{32}$/);
  assert.notEqual(store.newJobId(), store.newJobId());
});

test("ARCH-104: the meter is one line per model call from the gateway's usage; a call without usage stays unpriced", () => {
  assert.deepEqual(meterOf([{ text: "x", model: "m/a", usage: { promptTokens: 3, completionTokens: 4 } }, { text: "y", model: "m/b" }]), [
    { model: "m/a", promptTokens: 3, completionTokens: 4 },
    { model: "m/b", promptTokens: undefined, completionTokens: undefined },
  ]);
});

test("ARCH-105: the internal handler: key, 404 unknown, the result, released", async () => {
  const store = new JobStore(5, 60_000);
  store.hold(held(ID, Date.now() + 60_000));
  const server: Server = createServer(internalHandler(store, KEY));
  const port = await new Promise<number>((ok) => server.listen(0, "127.0.0.1", () => ok((server.address() as AddressInfo).port)));
  const call = (method: string, path: string, key?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: key ? { "x-jobs-key": key } : {} }, (res) => {
      let t = ""; res.on("data", (d) => (t += d)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(t) }));
    });
    req.on("error", reject); req.end();
  });
  try {
    assert.equal((await call("GET", `/internal/jobs/${ID}`)).status, 401);
    assert.equal((await call("GET", `/internal/jobs/${ID}`, KEY + "x")).status, 401);
    assert.equal((await call("GET", `/internal/jobs/${"f".repeat(32)}`, KEY)).status, 404);
    assert.equal((await call("GET", "/internal/jobs/../../etc", KEY)).status, 404);
    const r = await call("GET", `/internal/jobs/${ID}`, KEY);
    assert.deepEqual(r, { status: 200, body: { jobId: ID, result: RESULT } });
    assert.equal((await call("POST", `/internal/jobs/${ID}/released`, KEY)).status, 200);
    assert.equal((await call("GET", `/internal/jobs/${ID}`, KEY)).status, 404);
    assert.equal((await call("POST", `/internal/jobs/${ID}/released`, KEY)).status, 404);
  } finally { await new Promise<void>((ok) => server.close(() => ok())); }
});

test("ARCH-114: off by default; with on, each fee flag and the catalog are required, and the key is never in a message", () => {
  const catalog = fileURLToPath(new URL("../../config/catalog.bedrock.json", import.meta.url));
  const fees = Object.fromEntries(FEE_FLAGS.map((f) => [f, "0.001"]));
  assert.equal(paidJobsConfig({}, {}), undefined);
  assert.equal(paidJobsConfig({ "paid-jobs": "off" }, {}), undefined);
  assert.throws(() => paidJobsConfig({ "paid-jobs": "yes" }, {}), /--paid-jobs must be on or off/);
  const on = { "paid-jobs": "on", "pricing-catalog": catalog, ...fees };
  assert.throws(() => paidJobsConfig({ ...on, "pricing-catalog": undefined }, { PAID_JOBS_KEY: KEY }), /needs --pricing-catalog/);
  for (const f of FEE_FLAGS) assert.throws(() => paidJobsConfig({ ...on, [f]: undefined }, { PAID_JOBS_KEY: KEY }), new RegExp(`needs --${f}`));
  assert.throws(() => paidJobsConfig(on, { PAID_JOBS_KEY: "short" }), (e: Error) => /at least 24 characters/.test(e.message) && !e.message.includes("short"));
  const c = paidJobsConfig(on, { PAID_JOBS_KEY: KEY })!;
  assert.deepEqual([c.internalHost, c.internalPort, c.ttlMs, c.max, c.keyEnv], ["127.0.0.1", 8731, 15 * 60_000, 100, "PAID_JOBS_KEY"]);
  assert.deepEqual(c.prices.get("bedrock/nemotron-nano-3-30b"), { inputPerM: 0.0618, outputPerM: 0.2472 });
  assert.equal(c.priceRound, "micro");
});

test("ARCH-629: --price-round micro by default, cent under --ap2 on, micro with --ap2 on refused", () => {
  const catalog = fileURLToPath(new URL("../../config/catalog.bedrock.json", import.meta.url));
  const on = { "paid-jobs": "on", "pricing-catalog": catalog, ...Object.fromEntries(FEE_FLAGS.map((f) => [f, "0.001"])) };
  const env = { PAID_JOBS_KEY: KEY };
  assert.equal(paidJobsConfig({ ...on, "price-round": "cent" }, env)!.priceRound, "cent");
  assert.equal(paidJobsConfig({ ...on, "price-round": "micro" }, env)!.priceRound, "micro");
  assert.equal(priceRoundOf({ ap2: "on" }), "cent");
  assert.equal(priceRoundOf({ ap2: "off" }), "micro");
  assert.throws(() => paidJobsConfig({ ...on, "price-round": "dollar" }, env), /--price-round must be micro or cent/);
  assert.throws(() => priceRoundOf({ ap2: "on", "price-round": "micro" }), /--ap2 on needs --price-round cent/);
  assert.throws(() => paidJobsConfig({ "price-round": "cent" }, {}), /--price-round needs --paid-jobs on/);
});

test("ARCH-637 ARCH-638: POST /internal/jobs/:id/run runs an offer through the hook; a job already held is answered, not run again; no hook = 404", async () => {
  const store = new JobStore(5, 60_000);
  const ran: string[] = [];
  const OFFER = "a".repeat(32), REFUSED = "b".repeat(32);
  const run = async (jobId: string) => {
    ran.push(jobId);
    if (jobId === REFUSED) return { status: 409, body: { error: "the folder has grown since the estimate" } };
    store.hold(held(jobId, Date.now() + 60_000));
    return { status: 200, body: { jobId, result: RESULT } };
  };
  const start = (h: ReturnType<typeof internalHandler>) => new Promise<{ server: Server; port: number }>((ok) => { const server = createServer(h); server.listen(0, "127.0.0.1", () => ok({ server, port: (server.address() as AddressInfo).port })); });
  const call = (port: number, method: string, path: string, key?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: key ? { "x-jobs-key": key } : {} }, (res) => {
      let t = ""; res.on("data", (d) => (t += d)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(t) }));
    });
    req.on("error", reject); req.end();
  });
  const a = await start(internalHandler(store, KEY, undefined, run));
  const b = await start(internalHandler(new JobStore(5, 60_000), KEY));
  try {
    assert.equal((await call(a.port, "POST", `/internal/jobs/${OFFER}/run`)).status, 401, "the key first");
    assert.deepEqual(await call(a.port, "POST", `/internal/jobs/${OFFER}/run`, KEY), { status: 200, body: { jobId: OFFER, result: RESULT } });
    assert.deepEqual(await call(a.port, "POST", `/internal/jobs/${OFFER}/run`, KEY), { status: 200, body: { jobId: OFFER, result: RESULT } }, "a retried release after a failed settlement");
    assert.deepEqual(ran, [OFFER], "run once");
    assert.deepEqual(await call(a.port, "POST", `/internal/jobs/${REFUSED}/run`, KEY), { status: 409, body: { error: "the folder has grown since the estimate" } });
    assert.equal((await call(a.port, "GET", `/internal/jobs/${OFFER}/run`, KEY)).status, 404, "POST only");
    assert.equal((await call(a.port, "POST", "/internal/jobs/NOTHEX/run", KEY)).status, 404);
    assert.equal((await call(b.port, "POST", `/internal/jobs/${OFFER}/run`, KEY)).status, 404, "a console without offers has no run route");
    assert.equal((await call(a.port, "POST", `/internal/jobs/${OFFER}/released`, KEY)).status, 200, "released as before");
  } finally {
    await new Promise<void>((ok) => a.server.close(() => ok()));
    await new Promise<void>((ok) => b.server.close(() => ok()));
  }
});

test("ARCH-671: the run notice keeps the upfront paidTx and payer when well formed, and drops malformed ones", async () => {
  const { parseRunNotice } = await import("../console/jobs.ts");
  const paidTx = "4vv6QJSaB1cdEFGhijkLMNoPQRstuVWXyz23456789ab";
  assert.deepEqual(parseRunNotice({ invoiceId: "C702E26D", paidTx, payer: "chainaim-buyer-seller.testnet" }), { invoiceId: "C702E26D", paidTx, payer: "chainaim-buyer-seller.testnet" });
  assert.deepEqual(parseRunNotice({ invoiceId: "C702E26D", paidTx: "0OIl not base58", payer: "Not An Account" }), { invoiceId: "C702E26D" });
  assert.deepEqual(parseRunNotice({ invoiceId: "C702E26D" }), { invoiceId: "C702E26D" }, "the authorization flow's notice is unchanged");
});
