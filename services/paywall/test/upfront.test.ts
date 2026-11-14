/**
 * privateAI-design-37 ARCH-670..672 on the paywall: pay before work, automatic refund.
 * Loopback only, the same rig as paid-jobs.test.ts: the paywall as its own NEAR facilitator, real ed25519-signed delegates,
 * the NEAR JSON-RPC protocol double that runs the ft_transfer. Two small HTTP servers play the console's internal listener
 * (run / released) and ChainAim's signer refund API (POST /v1/refunds, GET /v1/refunds/:invoiceId) with their key checks.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { nearPaymentHeader } from "../../web/src/near-payment.ts";
import { loadConfig } from "../src/config.ts";
import { keySigner } from "../scripts/near-signer.ts";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { SNAPSHOT_ENVS } from "./routes-snapshot.ts";
import { close, listen, stubGateway } from "./stubs.ts";

const TOKEN = "usdc.chainaim-test.testnet";
const NEAR_PAY_TO = "merchant.chainaim-test.testnet";
const BUYER = "buyer.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";
const JOBS_KEY = randomBytes(24).toString("hex");
const SIGNER_KEY = randomBytes(24).toString("hex");
const MARKER = "MARKER-37-upfront-private-question";

type Required = { accepts: Record<string, any>[]; resource?: Record<string, unknown>; error?: string };
const decode = (header: string | null): Required => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
const newJobId = () => randomBytes(16).toString("hex");

describe("ARCH-670 PAID_JOBS_FLOW configuration", () => {
  const env = { ...SNAPSHOT_ENVS.near, PAID_JOBS: "on", PAID_JOBS_KEY: JOBS_KEY, PAID_JOBS_RESULT_URL: "http://host.docker.internal:8731" };
  const up = { ...env, PAID_JOBS_FLOW: "upfront", PAID_JOBS_REFUND_URL: "http://host.docker.internal:8780/", SIGNER_REQUEST_KEY: SIGNER_KEY };
  it("ARCH-670: default authorization leaves the configuration as it was", () => {
    const c = loadConfig(env).paidJobs!;
    assert.equal("flow" in c, false);
    assert.equal("refund" in c, false);
    assert.equal("flow" in loadConfig({ ...env, PAID_JOBS_FLOW: "authorization" }).paidJobs!, false);
  });
  it("ARCH-670: a bad value, and upfront without the refund URL or key, are start-up errors naming the variable", () => {
    assert.throws(() => loadConfig({ ...env, PAID_JOBS_FLOW: "escrow" }), /PAID_JOBS_FLOW must be authorization or upfront, got escrow/);
    assert.throws(() => loadConfig({ ...up, PAID_JOBS_REFUND_URL: "" }), /PAID_JOBS_REFUND_URL is required with PAID_JOBS_FLOW=upfront/);
    assert.throws(() => loadConfig({ ...up, PAID_JOBS_REFUND_URL: "ftp://x" }), /PAID_JOBS_REFUND_URL must be an http\(s\) URL/);
    assert.throws(() => loadConfig({ ...up, SIGNER_REQUEST_KEY: "" }), /SIGNER_REQUEST_KEY \(named by PAID_JOBS_REFUND_KEY_ENV\) is required/);
    assert.throws(() => loadConfig({ ...up, SIGNER_REQUEST_KEY: "short" }), /at least 24 characters/);
    assert.throws(() => loadConfig({ ...up, PAID_JOBS_REFUND_KEY_ENV: "lower-case" }), /PAID_JOBS_REFUND_KEY_ENV must name an environment variable/);
    assert.throws(() => loadConfig({ ...up, PAID_JOBS_REFUND_TIMEOUT_MS: "999" }), /PAID_JOBS_REFUND_TIMEOUT_MS must be from 1000 to 120000/);
    for (const bad of [{ PAID_JOBS_REFUND_URL: "" }, { PAID_JOBS_FLOW: "escrow" }]) {
      try { loadConfig({ ...up, ...bad }); } catch (e) { assert.equal((e as Error).message.includes(SIGNER_KEY), false); }
    }
  });
  it("ARCH-670: upfront reads the URL, the key from the named variable and the timeout", () => {
    assert.deepEqual(loadConfig(up).paidJobs!.refund, { url: "http://host.docker.internal:8780", key: SIGNER_KEY, timeoutMs: 20_000 });
    assert.equal(loadConfig(up).paidJobs!.flow, "upfront");
    const other = loadConfig({ ...up, SIGNER_REQUEST_KEY: "", PAID_JOBS_REFUND_KEY_ENV: "MY_SIGNER_KEY", MY_SIGNER_KEY: SIGNER_KEY, PAID_JOBS_REFUND_TIMEOUT_MS: "5000" });
    assert.deepEqual(other.paidJobs!.refund, { url: "http://host.docker.internal:8780", key: SIGNER_KEY, timeoutMs: 5000 });
  });
});

describe("ARCH-671 ARCH-672 upfront release (PAID_JOBS_FLOW=upfront)", () => {
  const buyerKey = KeyPair.fromRandom("ed25519");
  const relayerKey = KeyPair.fromRandom("ed25519");
  const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
  const gateway = stubGateway();
  const logs: string[] = [];
  let now = Date.now();
  // The console's internal listener: estimate-first offers run on POST /internal/jobs/:id/run, held results on GET.
  const offers = new Map<string, unknown>();
  const held = new Map<string, unknown>();
  const consoleSeen: { method: string; path: string; body: string; transfersAtCall: number }[] = [];
  const consoleState = { runStatus: 200 as 200 | 409 | 422 | 500, runError: "the folder has grown since the estimate (re-estimate it)", runCode: undefined as string | undefined, failGet: false };
  const consoleServer: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      consoleSeen.push({ method: req.method!, path: req.url!, body: raw, transfersAtCall: double.state.transfers.length });
      const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.headers["x-jobs-key"] !== JOBS_KEY) return send(401, { error: "x-jobs-key is missing or wrong" });
      const run = /^\/internal\/jobs\/([0-9a-f]{32})\/run$/.exec(req.url!);
      const get = /^\/internal\/jobs\/([0-9a-f]{32})$/.exec(req.url!);
      const rel = /^\/internal\/jobs\/([0-9a-f]{32})\/released$/.exec(req.url!);
      if (req.method === "POST" && run) {
        if (consoleState.runStatus !== 200) return send(consoleState.runStatus, { error: consoleState.runError, ...(consoleState.runCode ? { code: consoleState.runCode } : {}) });
        return send(200, { jobId: run[1], result: offers.get(run[1]) });
      }
      if (req.method === "GET" && get) {
        if (consoleState.failGet || !held.has(get[1])) return send(404, { error: "no such job" });
        return send(200, { jobId: get[1], result: held.get(get[1]) });
      }
      if (req.method === "POST" && rel) return send(200, { released: true });
      send(404, { error: "no route" });
    });
  });
  // ChainAim's signer refund API, as packages/signer answers it: X-Signer-Key, one signed record per invoice.
  const refunds = new Map<string, Record<string, unknown>>();
  const signerSeen: { method: string; path: string; body: Record<string, unknown> | undefined; key: string | undefined }[] = [];
  const signerState = { mode: "refunded" as "refunded" | "pending" | "refuse" | "down" };
  const signerServer: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const key = req.headers["x-signer-key"] as string | undefined;
      signerSeen.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined, key });
      const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (key !== SIGNER_KEY) return send(401, { error: { message: "X-Signer-Key is missing or wrong" } });
      const one = /^\/v1\/refunds\/([0-9A-F]{32})$/.exec(req.url!);
      if (req.method === "GET" && one) return refunds.has(one[1]) ? send(200, refunds.get(one[1])) : send(404, { error: { message: "no refund" } });
      if (req.method === "POST" && req.url === "/v1/refunds") {
        const b = JSON.parse(raw) as Record<string, string>;
        if (signerState.mode === "down") return send(503, { error: { message: "down" } });
        if (signerState.mode === "refuse") return send(409, { error: { message: "a receipt was delivered for this job; no refund" } });
        const record = {
          status: signerState.mode === "pending" ? "refund_pending" : "refunded",
          invoiceId: b.invoiceId, jobId: b.jobId, paidTx: b.paidTx, refundTx: `REFUND${b.invoiceId.slice(0, 8)}`, payer: BUYER,
          amountUnits: b.amountUnits, network: b.network, reason: b.reason, at: new Date(now).toISOString(), sig: "ab".repeat(32),
        };
        refunds.set(b.invoiceId, record);
        return send(200, record);
      }
      send(404, { error: { message: "no route" } });
    });
  });
  let paywall: { url: string; close: () => Promise<void> };
  let rpcUrl = "";
  let signer: ReturnType<typeof keySigner>;

  before(async () => {
    rpcUrl = await listen(double.server);
    const gatewayUrl = await listen(gateway.server);
    const consoleUrl = await listen(consoleServer);
    const signerUrl = await listen(signerServer);
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
        PAID_JOBS_MAX: "5",
        PAID_JOBS_FLOW: "upfront",
        PAID_JOBS_REFUND_URL: signerUrl,
        SIGNER_REQUEST_KEY: SIGNER_KEY,
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
    await close(signerServer);
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
    signerSeen.length = 0;
    consoleState.runStatus = 200;
    consoleState.runError = "the folder has grown since the estimate (re-estimate it)";
    consoleState.runCode = undefined;
    consoleState.failGet = false;
    signerState.mode = "refunded";
    logs.length = 0;
    now += 700_000;
  });

  const register = (body: unknown) =>
    fetch(`${paywall.url}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-jobs-key": JOBS_KEY }, body: JSON.stringify(body) });
  async function offer(amount: string): Promise<string> {
    const jobId = newJobId();
    offers.set(jobId, { answer: `the answer to ${MARKER}`, rows: [{ who: MARKER }] });
    assert.equal((await register({ jobId, amount, expiresAt: now + 600_000, run: true })).status, 201);
    return jobId;
  }
  async function heldJob(amount: string): Promise<string> {
    const jobId = newJobId();
    held.set(jobId, { answer: `the answer to ${MARKER}` });
    assert.equal((await register({ jobId, amount, expiresAt: now + 600_000 })).status, 201);
    return jobId;
  }
  const releaseUrl = (jobId: string) => `${paywall.url}/v1/jobs/${jobId}/release`;
  const quote = async (jobId: string) => {
    const r = await fetch(releaseUrl(jobId), { method: "POST" });
    assert.equal(r.status, 402);
    return decode(r.headers.get("payment-required"));
  };
  async function pay(jobId: string): Promise<{ r: Response; invoiceId: string }> {
    const quoted = await quote(jobId);
    const accept = quoted.accepts[0];
    const signed = await signer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: accept as never });
    const r = await fetch(releaseUrl(jobId), { method: "POST", headers: { "PAYMENT-SIGNATURE": nearPaymentHeader(accept as never, signed, quoted.resource) } });
    return { r, invoiceId: accept.extra.invoiceId };
  }
  const waitFor = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 20)); };
  const paymentResponse = (r: Response) => JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString("utf8"));

  it("ARCH-670: the release accept carries paymentFlow upfront; the chat routes never do", async () => {
    const q = await quote(await offer("20000"));
    assert.equal(q.accepts.length, 1);
    assert.equal(q.accepts[0].extra.paymentFlow, "upfront");
    assert.match(q.accepts[0].extra.invoiceId, /^[0-9A-F]{32}$/);
    const chat = decode((await fetch(`${paywall.url}/v1/privacy/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).headers.get("payment-required"));
    for (const a of chat.accepts) assert.equal(a.extra?.paymentFlow, undefined, a.network);
  });

  it("ARCH-671: the payment settles before the run; a 200 releases the job and tells the console with the stored settlement", async () => {
    const id = await offer("20000");
    const { r, invoiceId } = await pay(id);
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual((await r.json()).rows, [{ who: MARKER }]);
    assert.equal(double.state.transfers.length, 1);
    const paidTx = double.state.transfers[0].txHash;
    const run = consoleSeen.find((s) => s.path === `/internal/jobs/${id}/run`)!;
    assert.equal(run.transfersAtCall, 1, "the money moved before the console was asked to run");
    assert.deepEqual(JSON.parse(run.body), { invoiceId, paidTx, payer: BUYER });
    assert.equal(paymentResponse(r).transaction, paidTx);
    await waitFor(() => consoleSeen.some((s) => s.path === `/internal/jobs/${id}/released`));
    const released = consoleSeen.find((s) => s.path === `/internal/jobs/${id}/released`)!;
    // privateAI-design-40 ARCH-691: the notice names the flow, so the receipt's settlement says the money moved before the run.
    assert.deepEqual(JSON.parse(released.body), { transaction: paidTx, network: "near:testnet", payer: BUYER, invoiceId, flow: "upfront" });
    const line = JSON.parse(logs.find((l) => l.includes('"payment_settled"'))!);
    assert.deepEqual([line.phase, line.transaction, line.invoiceId], ["before-handler", paidTx, invoiceId]);
    assert.equal(signerSeen.length, 0, "no refund for a delivered job");
    assert.equal((await fetch(releaseUrl(id), { method: "POST" })).status, 409, "released: not payable again");
  });

  for (const [status, error, reason, code] of [
    [409, "the folder has grown since the estimate (re-estimate it)", "over_estimate", undefined],
    [422, "the job did not produce a result", "refused", undefined],
    [422, "the AP2 checkout mandate was refused: amount differs", "mandate_refused", undefined],
    // privateAI-design-39 ARCH-689: the console's --pay-only-attested verified refusal is refunded under its own reason.
    [422, "privacy was not proven for this job (NEAR AI attestation: unavailable)", "attestation_not_proven", "attestation_not_proven"],
  ] as const) {
    it(`ARCH-672${code ? " ARCH-689" : ""}: a ${status} run (${reason}) asks the signer for one refund and returns its record`, async () => {
      const id = await offer("20000");
      consoleState.runStatus = status;
      consoleState.runError = error;
      consoleState.runCode = code;
      const { r, invoiceId } = await pay(id);
      assert.equal(r.status, status);
      const body = await r.json();
      const paidTx = double.state.transfers[0].txHash;
      assert.equal(double.state.transfers.length, 1, "the payment had settled before the run");
      assert.equal(signerSeen.length, 1, "exactly one refund request (the cancel hook adds none)");
      assert.equal(signerSeen[0].key, SIGNER_KEY);
      assert.deepEqual(signerSeen[0].body, { invoiceId, jobId: id, paidTx, network: "near:testnet", amountUnits: "20000", reason });
      assert.equal(body.refund.status, "refunded");
      assert.equal(body.refund.paidTx, paidTx);
      assert.match(body.error.message, new RegExp(`your payment ${paidTx} was refunded in REFUND`));
      assert.equal(body.error.message.includes("you were not charged"), false);
      assert.equal(paymentResponse(r).transaction, paidTx, "PAYMENT-RESPONSE echoes the upfront settlement");
      // this job only: the previous case's successful re-payment notifies the console in the background (void notifyReleased)
      // and can land after beforeEach cleared consoleSeen on a busy machine.
      assert.equal(consoleSeen.some((s) => s.path === `/internal/jobs/${id}/released`), false, "nothing released for this job");
      const refundLine = JSON.parse(logs.find((l) => l.includes('"job_refund"'))!);
      assert.deepEqual([refundLine.jobId, refundLine.invoiceId, refundLine.status, refundLine.reason], [id, invoiceId, "refunded", reason]);
      // the job is payable again with a new invoice
      consoleState.runStatus = 200;
      const again = await pay(id);
      assert.equal(again.r.status, 200);
      assert.notEqual(again.invoiceId, invoiceId);
    });
  }

  it("ARCH-672: a held job whose result cannot be read (502) is refunded as bad_result", async () => {
    const id = await heldJob("3000");
    consoleState.failGet = true;
    const { r } = await pay(id);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).refund.status, "refunded");
    assert.equal(signerSeen[0].body!.reason, "bad_result");
  });

  it("ARCH-672: the signer down → refund_pending, unsigned, logged with ids only; GET /v1/refunds proxies the signer", async () => {
    const id = await offer("20000");
    consoleState.runStatus = 409;
    signerState.mode = "down";
    const { r, invoiceId } = await pay(id);
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.deepEqual([body.refund.status, body.refund.invoiceId, body.refund.sig], ["refund_pending", invoiceId, undefined]);
    assert.match(body.error.message, new RegExp(`is being refunded \\(GET /v1/refunds/${invoiceId}\\)`));
    const failed = JSON.parse(logs.find((l) => l.includes('"refund_request_failed"'))!);
    assert.deepEqual([failed.invoiceId, failed.reason], [invoiceId, "HTTP 503"]);
    assert.equal((await fetch(`${paywall.url}/v1/refunds/${invoiceId}`)).status, 404, "the signer holds no record yet");
    // the owner retries: the signer now holds the record, and the buyer's GET finds it
    refunds.set(invoiceId, { status: "refunded", invoiceId, paidTx: body.refund.paidTx, refundTx: "REFUNDLATER", sig: "cd".repeat(32) });
    const got = await fetch(`${paywall.url}/v1/refunds/${invoiceId}`);
    assert.equal(got.status, 200);
    assert.equal((await got.json()).refundTx, "REFUNDLATER");
    assert.equal((await fetch(`${paywall.url}/v1/refunds/not-an-invoice`)).status, 404);
  });

  it("ARCH-672: a signer refusal (409) → refund_refused with its reason", async () => {
    const id = await offer("20000");
    consoleState.runStatus = 422;
    signerState.mode = "refuse";
    const { r } = await pay(id);
    assert.equal(r.status, 422);
    const body = await r.json();
    assert.equal(body.refund.status, "refund_refused");
    assert.match(body.refund.reason, /a receipt was delivered/);
    assert.match(body.error.message, /was not refunded automatically/);
  });

  it("ARCH-672: the signer's pending answer is passed on", async () => {
    const id = await offer("20000");
    consoleState.runStatus = 409;
    signerState.mode = "pending";
    const { r } = await pay(id);
    assert.equal((await r.json()).refund.status, "refund_pending");
  });

  it("ARCH-672: no key, question or answer in any log line", async () => {
    const ok = await offer("20000");
    await pay(ok);
    const refused = await offer("20000");
    consoleState.runStatus = 409;
    await pay(refused);
    for (const l of logs) {
      for (const secret of [JOBS_KEY, SIGNER_KEY, MARKER]) assert.equal(l.includes(secret), false, l);
    }
  });
});
