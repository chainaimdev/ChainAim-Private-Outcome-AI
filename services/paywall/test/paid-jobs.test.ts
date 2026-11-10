/**
 * Paid jobs on the paywall (architecture.md ARCH-101, ARCH-106 to ARCH-110): job intake, the NEAR-only release route
 * priced from the job, release only after settlement, one payment per job, and what happens after settlement.
 * Loopback only: the paywall as its own NEAR facilitator (a relayer key generated for this run), real ed25519-signed
 * delegates from the buyer's payment code, and the NEAR JSON-RPC protocol double that checks every signature and runs
 * the ft_transfer (the same double the NEAR rail tests use). The console's internal listener is played by a small HTTP
 * server holding results by job id, with the same routes and key check as test-console/console/jobs.ts.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { nearPaymentHeader } from "../../web/src/near-payment.ts";
import { loadConfig } from "../src/config.ts";
import { routesConfig } from "../src/routes.ts";
import { keySigner } from "../scripts/near-signer.ts";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { snapshotRoutes, SNAPSHOT_ENVS } from "./routes-snapshot.ts";
import { close, listen, stubGateway } from "./stubs.ts";

const TOKEN = "usdc.chainaim-test.testnet";
const NEAR_PAY_TO = "merchant.chainaim-test.testnet";
const BUYER = "buyer.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";
const JOBS_KEY = randomBytes(24).toString("hex");
const MARKER = "MARKER-7f3a-private-question";

type Required = { accepts: Record<string, any>[]; resource?: Record<string, unknown>; error?: string };
const decode = (header: string | null): Required => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
const newJobId = () => randomBytes(16).toString("hex");

describe("ARCH-101 paid jobs off", () => {
  it("ARCH-101: routesConfig without PAID_JOBS equals today's", () => {
    const before = JSON.parse(readFileSync(new URL("./fixtures/routes-before-paid-jobs.json", import.meta.url), "utf8"));
    for (const [name, env] of Object.entries(SNAPSHOT_ENVS)) {
      const c = loadConfig(env);
      assert.equal("paidJobs" in c, false, name);
      assert.deepEqual(JSON.parse(JSON.stringify(snapshotRoutes(routesConfig(c, () => "INV-1")))), before[name], name);
    }
    assert.equal("paidJobs" in loadConfig({ ...SNAPSHOT_ENVS.near, PAID_JOBS: "off" }), false);
  });
});

describe("ARCH-106 configuration", () => {
  const env = { ...SNAPSHOT_ENVS.near, PAID_JOBS: "on", PAID_JOBS_KEY: JOBS_KEY, PAID_JOBS_RESULT_URL: "http://host.docker.internal:8731" };
  it("ARCH-106: start-up errors for each missing variable", () => {
    assert.throws(() => loadConfig({ ...env, PAY_RAILS: "xrpl" }), /PAID_JOBS=on needs the NEAR rail/);
    assert.throws(() => loadConfig({ ...env, PAID_JOBS_KEY: "" }), /PAID_JOBS_KEY is required/);
    assert.throws(() => loadConfig({ ...env, PAID_JOBS_KEY: "short-key" }), /at least 24 characters/);
    assert.throws(() => loadConfig({ ...env, PAID_JOBS_RESULT_URL: "" }), /PAID_JOBS_RESULT_URL is required/);
    assert.throws(() => loadConfig({ ...env, PAID_JOBS: "yes" }), /PAID_JOBS must be on or off/);
    assert.throws(() => loadConfig({ ...env, PAID_JOBS_TTL_SEC: "5" }), /PAID_JOBS_TTL_SEC/);
    assert.throws(() => loadConfig({ ...env, PAID_JOBS_MAX: "0" }), /PAID_JOBS_MAX/);
    // integer() refuses a negative itself ("must be a whole number"); the range check catches the rest.
    assert.throws(() => loadConfig({ ...env, PAID_JOBS_CLOCK_SKEW_SEC: "-1" }), /PAID_JOBS_CLOCK_SKEW_SEC/);
    assert.throws(() => loadConfig({ ...env, PAID_JOBS_CLOCK_SKEW_SEC: "301" }), /PAID_JOBS_CLOCK_SKEW_SEC must be from 0 to 300/);
    assert.equal(loadConfig({ ...env, PAID_JOBS_CLOCK_SKEW_SEC: "0" }).paidJobs?.clockSkewSec, 0);
    for (const bad of [{ PAID_JOBS_KEY: "short-key" }, { PAID_JOBS_RESULT_URL: "" }]) {
      try { loadConfig({ ...env, ...bad }); } catch (e) { assert.equal((e as Error).message.includes(JOBS_KEY), false); }
    }
    assert.deepEqual(loadConfig(env).paidJobs, { key: JOBS_KEY, resultUrl: "http://host.docker.internal:8731", ttlSec: 900, clockSkewSec: 30, max: 1000 });
  });
});

describe("paid jobs (PAID_JOBS=on, PAY_RAILS=xrpl,near)", () => {
  const buyerKey = KeyPair.fromRandom("ed25519");
  const relayerKey = KeyPair.fromRandom("ed25519");
  const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
  const gateway = stubGateway();
  const logs: string[] = [];
  let now = Date.now();
  // The console's internal listener: held results by job id, x-jobs-key checked.
  const held = new Map<string, unknown>();
  const consoleSeen: { method: string; path: string; key: string | undefined }[] = [];
  const consoleState = { failGet: false, failReleased: false };
  const consoleServer: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const key = req.headers["x-jobs-key"] as string | undefined;
      consoleSeen.push({ method: req.method!, path: req.url!, key });
      const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (key !== JOBS_KEY) return send(401, { error: "x-jobs-key is missing or wrong" });
      const get = /^\/internal\/jobs\/([0-9a-f]{32})$/.exec(req.url!);
      const rel = /^\/internal\/jobs\/([0-9a-f]{32})\/released$/.exec(req.url!);
      if (req.method === "GET" && get) {
        if (consoleState.failGet || !held.has(get[1])) return send(404, { error: "no such job" });
        return send(200, { jobId: get[1], result: held.get(get[1]) });
      }
      if (req.method === "POST" && rel) {
        if (consoleState.failReleased) return send(500, { error: "down" });
        held.delete(rel[1]);
        return send(200, { released: true });
      }
      send(404, { error: "no route" });
    });
  });
  let paywall: { url: string; close: () => Promise<void> };
  let rpcUrl = "";
  let signer: ReturnType<typeof keySigner>;

  before(async () => {
    rpcUrl = await listen(double.server);
    const gatewayUrl = await listen(gateway.server);
    const consoleUrl = await listen(consoleServer);
    addAccount(double.state, BUYER, buyerKey.getPublicKey().toString());
    addAccount(double.state, RELAYER, relayerKey.getPublicKey().toString());
    addAccount(double.state, NEAR_PAY_TO);
    paywall = await startNearPaywall(
      {
        PAY_RAILS: "xrpl,near",
        XRPL_PAY_TO_TESTNET: "rwaugYNb1VYhPVhV3oEa77Pa9itayatbJd",
        NEAR_PAY_TO_TESTNET: NEAR_PAY_TO,
        NEAR_USDC_CONTRACT_TESTNET: TOKEN,
        NEAR_USDC_DECIMALS_TESTNET: "6",
        NEAR_RPC_URL_TESTNET: rpcUrl,
        NEAR_RELAYER_ACCOUNT_TESTNET: RELAYER,
        NEAR_RELAYER_KEY_TESTNET: relayerKey.toString(),
        GATEWAY_URL: gatewayUrl,
        CHAINAIM_GATEWAY_KEY: "test-gateway-key",
        PAID_JOBS: "on",
        PAID_JOBS_KEY: JOBS_KEY,
        PAID_JOBS_RESULT_URL: consoleUrl,
        PAID_JOBS_TTL_SEC: "900",
        PAID_JOBS_MAX: "3",
      },
      (line) => logs.push(line),
      { now: () => now },
    );
    signer = keySigner({ accountId: BUYER, secretKey: buyerKey.toString(), network: "near:testnet", rpcUrl });
  });
  after(async () => {
    await paywall.close();
    await close(double.server);
    await close(gateway.server);
    await close(consoleServer);
  });
  beforeEach(() => {
    const t = double.state.token;
    t.registered.clear();
    t.registered.add(NEAR_PAY_TO);
    t.registered.add(BUYER);
    t.balances.clear();
    t.balances.set(BUYER, 10_000_000n);
    double.state.transfers.length = 0;
    double.state.calls.length = 0;
    double.state.failNextTransfer = undefined;
    consoleSeen.length = 0;
    consoleState.failGet = false;
    consoleState.failReleased = false;
    logs.length = 0;
    // Time only moves forward, past every job an earlier test registered (at most 600 s), so the cap of 3 is per test.
    now += 700_000;
  });

  const register = (body: unknown, key: string | null = JOBS_KEY) =>
    fetch(`${paywall.url}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", ...(key === null ? {} : { "x-jobs-key": key }) }, body: typeof body === "string" ? body : JSON.stringify(body) });
  /** A job registered here and held by the console stand-in. */
  async function job(amount: string, result: unknown = { answer: `the answer to ${MARKER}`, rows: [{ who: MARKER }] }): Promise<string> {
    const jobId = newJobId();
    held.set(jobId, result);
    const r = await register({ jobId, amount, expiresAt: now + 600_000 });
    assert.equal(r.status, 201, await r.clone().text());
    return jobId;
  }
  const releaseUrl = (jobId: string) => `${paywall.url}/v1/jobs/${jobId}/release`;
  const quote = async (jobId: string) => {
    const r = await fetch(releaseUrl(jobId), { method: "POST" });
    assert.equal(r.status, 402);
    return decode(r.headers.get("payment-required"));
  };
  async function signedHeader(jobId: string): Promise<{ header: string; signed: string; offer: Record<string, any>; quoted: Required }> {
    const quoted = await quote(jobId);
    const offer = quoted.accepts[0];
    const signed = await signer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: offer as never });
    return { header: nearPaymentHeader(offer as never, signed, quoted.resource), signed, offer, quoted };
  }
  const pay = (jobId: string, header: string) => fetch(releaseUrl(jobId), { method: "POST", headers: { "PAYMENT-SIGNATURE": header } });
  const waitFor = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 20)); };

  // ---- ARCH-106 ----
  it("ARCH-106: 401 without/with wrong key", async () => {
    const body = { jobId: newJobId(), amount: "100", expiresAt: now + 60_000 };
    assert.equal((await register(body, null)).status, 401);
    assert.equal((await register(body, "x".repeat(48))).status, 401);
    assert.equal((await register(body, JOBS_KEY.slice(1))).status, 401);
  });

  it("ARCH-106: 400 per invalid field", async () => {
    const ok = { jobId: newJobId(), amount: "100", expiresAt: now + 60_000 };
    const cases: [unknown, RegExp][] = [
      ["not json", /body must be JSON/],
      [{ ...ok, jobId: "ABC" }, /jobId/],
      [{ ...ok, jobId: ok.jobId.toUpperCase() }, /jobId/],
      [{ ...ok, amount: "0" }, /amount/],
      [{ ...ok, amount: 100 }, /amount/],
      [{ ...ok, amount: "1.5" }, /amount/],
      [{ ...ok, expiresAt: "soon" }, /expiresAt/],
      [{ ...ok, expiresAt: now - 1 }, /in the future/],
      // Past PAID_JOBS_TTL_SEC (900) plus the default PAID_JOBS_CLOCK_SKEW_SEC (30); 901 s is now accepted (job-clock-skew.test.ts).
      [{ ...ok, expiresAt: now + 931_000 }, /PAID_JOBS_TTL_SEC.*PAID_JOBS_CLOCK_SKEW_SEC/],
    ];
    for (const [body, re] of cases) {
      const r = await register(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match((await r.json()).error.message, re);
    }
  });

  it("ARCH-106: 201 stored, 503 at the cap, and the key never appears in a log", async () => {
    const ids = [newJobId(), newJobId(), newJobId()];
    for (const jobId of ids) assert.equal((await register({ jobId, amount: "100", expiresAt: now + 60_000 })).status, 201);
    assert.equal((await register({ jobId: ids[0], amount: "100", expiresAt: now + 60_000 })).status, 409, "an id is registered once");
    const full = await register({ jobId: newJobId(), amount: "100", expiresAt: now + 60_000 });
    assert.equal(full.status, 503);
    // the three expire: the cap frees up
    now += 61_000;
    assert.equal((await register({ jobId: newJobId(), amount: "100", expiresAt: now + 60_000 })).status, 201);
    assert.equal(logs.some((l) => l.includes(JOBS_KEY)), false);
  });

  // ---- ARCH-107 ----
  it("ARCH-107: 404/410/409 cases return no payment-required header", async () => {
    const unknown = await fetch(releaseUrl(newJobId()), { method: "POST" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get("payment-required"), null);
    const notAnId = await fetch(`${paywall.url}/v1/jobs/..%2f/release`, { method: "POST" });
    assert.equal(notAnId.status, 404);
    assert.equal(notAnId.headers.get("payment-required"), null);
    const expiring = await job("2000");
    now += 600_001;
    const expired = await fetch(releaseUrl(expiring), { method: "POST" });
    assert.equal(expired.status, 410);
    assert.equal(expired.headers.get("payment-required"), null);
    const paid = await job("2000");
    assert.equal((await pay(paid, (await signedHeader(paid)).header)).status, 200);
    const again = await fetch(releaseUrl(paid), { method: "POST" });
    assert.equal(again.status, 409);
    assert.equal(again.headers.get("payment-required"), null);
  });

  it("ARCH-107: a known job's 402 has one NEAR offer with the job's amount; two jobs with different amounts get different 402 amounts", async () => {
    const a = await job("5562"), b = await job("12001");
    const qa = await quote(a), qb = await quote(b);
    for (const [q, amount] of [[qa, "5562"], [qb, "12001"]] as const) {
      assert.equal(q.accepts.length, 1, "NEAR only, although PAY_RAILS also has xrpl");
      assert.deepEqual([q.accepts[0].scheme, q.accepts[0].network, q.accepts[0].asset, q.accepts[0].payTo, q.accepts[0].amount], ["exact", "near:testnet", TOKEN, NEAR_PAY_TO, amount]);
      assert.match(q.accepts[0].extra.invoiceId, /^[0-9A-F]{32}$/);
    }
    // the existing routes still offer both rails at their configured price
    const chat = decode((await fetch(`${paywall.url}/v1/privacy/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).headers.get("payment-required"));
    assert.deepEqual(chat.accepts.map((x) => [x.network, x.amount]), [["xrpl:1", "0.01"], ["near:testnet", "10000"]]);
  });

  // ---- ARCH-108 ----
  it("ARCH-108: settle success → 200 body equals the held result and has payment-response", async () => {
    const result = { question: MARKER, sql: "select 1", rows: [{ n: 1 }], answer: "one" };
    const jobId = await job("7300", result);
    const r = await pay(jobId, (await signedHeader(jobId)).header);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await r.json(), result);
    const receipt = JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString("utf8"));
    assert.equal(receipt.success, true);
    assert.equal(double.state.transfers.length, 1);
    assert.deepEqual([double.state.transfers[0].sender, double.state.transfers[0].receiver, double.state.transfers[0].amount], [BUYER, NEAR_PAY_TO, 7300n]);
    assert.equal(receipt.transaction, double.state.transfers[0].txHash);
  });

  it("ARCH-108: settle failure → response body does not contain the result", async () => {
    const jobId = await job("4100");
    double.state.failNextTransfer = "ft_transfer failed in the double";
    const r = await pay(jobId, (await signedHeader(jobId)).header);
    const text = await r.text();
    assert.notEqual(r.status, 200);
    assert.equal(text.includes(MARKER), false, "the held result was not released");
    assert.equal(double.state.transfers.length, 0);
    assert.equal(logs.some((l) => l.includes('"payment_settled"')), false);
    assert.ok(logs.some((l) => l.includes('"payment_settle_failed"')));
    // the job is still open: it can be paid again
    const again = await pay(jobId, (await signedHeader(jobId)).header);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).answer, `the answer to ${MARKER}`);
  });

  it("ARCH-108: result fetch failure → 502 and no settle call recorded", async () => {
    const jobId = await job("3000");
    consoleState.failGet = true;
    const r = await pay(jobId, (await signedHeader(jobId)).header);
    assert.equal(r.status, 502);
    assert.equal(double.state.calls.includes("send_tx"), false, "nothing was sent on chain");
    assert.equal(double.state.transfers.length, 0);
    assert.equal(r.headers.get("payment-response"), null);
    assert.equal(consoleSeen[0].key, JOBS_KEY, "the console was asked with the jobs key");
  });

  // ---- ARCH-109 ----
  it("ARCH-109: a delegate signed for job A presented to job B → refused, not settled", async () => {
    const a = await job("2500"), b = await job("2500");
    const forA = await signedHeader(a);
    const r = await pay(b, forA.header);
    assert.equal(r.status, 402);
    assert.equal(consoleSeen.length, 0, "job B's result was never read");
    assert.equal(double.state.transfers.length, 0);
    // a job invoice does not pay another route either
    const scan = await fetch(`${paywall.url}/v1/privacy/scan`, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": forA.header }, body: "{}" });
    assert.equal(scan.status, 402);
    assert.equal(gateway.seen.some((s) => s.path === "/v1/privacy/scan"), false);
    assert.equal(double.state.transfers.length, 0);
  });

  it("ARCH-109: the same delegate presented twice to job A → second refused (payment_already_used)", async () => {
    const a = await job("2600");
    consoleState.failGet = true;
    const first = await signedHeader(a);
    assert.equal((await pay(a, first.header)).status, 502, "refused, so never settled");
    consoleState.failGet = false;
    const fresh = await quote(a);
    assert.notEqual(fresh.accepts[0].extra.invoiceId, first.offer.extra.invoiceId);
    const replay = await pay(a, nearPaymentHeader(fresh.accepts[0] as never, first.signed, fresh.resource));
    assert.equal(replay.status, 402);
    assert.equal(decode(replay.headers.get("payment-required")).error, "payment_already_used");
    assert.equal(double.state.transfers.length, 0);
    const sameInvoice = await pay(a, first.header);
    assert.equal(sameInvoice.status, 402, "the claimed invoice is not payable again");
    assert.equal(double.state.transfers.length, 0);
  });

  // ---- ARCH-110 ----
  it("ARCH-110: the log line matches today's schema; a second release call → 409; the console's job is gone after settlement", async () => {
    const jobId = await job("8800");
    const r = await pay(jobId, (await signedHeader(jobId)).header);
    assert.equal(r.status, 200);
    const line = JSON.parse(logs.find((l) => l.includes('"payment_settled"'))!);
    assert.deepEqual(Object.keys(line), ["ts", "event", "route", "amount", "asset", "network", "payer", "transaction"]);
    assert.deepEqual([line.route, line.amount, line.asset, line.network, line.payer, line.transaction], [`POST /v1/jobs/${jobId}/release`, "8800", TOKEN, "near:testnet", BUYER, double.state.transfers[0].txHash]);
    await waitFor(() => consoleSeen.some((s) => s.path === `/internal/jobs/${jobId}/released`));
    assert.ok(consoleSeen.some((s) => s.method === "POST" && s.path === `/internal/jobs/${jobId}/released` && s.key === JOBS_KEY));
    assert.equal(held.has(jobId), false, "the console dropped the result");
    assert.equal((await fetch(releaseUrl(jobId), { method: "POST" })).status, 409);
    assert.equal(logs.some((l) => l.includes("job_release_notify_failed")), false);
  });

  it("ARCH-110: notify failure produces the log line and nothing else", async () => {
    const jobId = await job("8900");
    consoleState.failReleased = true;
    const r = await pay(jobId, (await signedHeader(jobId)).header);
    assert.equal(r.status, 200, "the result was released all the same");
    await waitFor(() => logs.some((l) => l.includes("job_release_notify_failed")));
    const line = JSON.parse(logs.find((l) => l.includes("job_release_notify_failed"))!);
    assert.deepEqual(Object.keys(line), ["ts", "event", "jobId", "reason"]);
    assert.deepEqual([line.jobId, line.reason], [jobId, "HTTP 500"]);
  });

  // ---- ARCH-113 (paywall side) ----
  it("ARCH-113: nothing of the job's question, rows, answer or key is in any log line", async () => {
    const jobId = await job("1500");
    await pay(jobId, (await signedHeader(jobId)).header);
    const failing = await job("1600");
    double.state.failNextTransfer = "fail";
    await pay(failing, (await signedHeader(failing)).header);
    await waitFor(() => consoleSeen.some((s) => s.path.endsWith("/released")));
    assert.ok(logs.length >= 2);
    for (const l of logs) {
      assert.equal(l.includes(MARKER), false, l);
      assert.equal(l.includes(JOBS_KEY), false, l);
    }
  });
});
