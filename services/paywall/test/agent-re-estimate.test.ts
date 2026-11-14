/**
 * privateAI-design-42 ARCH-712: the agent's pre-payment size re-check (--re-estimate on) through the REAL paywall. The
 * agent (runAgentJob, scripted model, real tenant files with throwaway keys) asks the console to re-size the job's folder
 * (GET /offers/<id>/recheck, ARCH-711; the real route is covered in scripts/test/console-paid-jobs.test.ts) after the
 * policy and before the mandate and the payment are signed. Pinned here: the order, that a grown folder (409
 * estimate_stale) or a re-check that cannot be made refuses the run with nothing signed, run or paid, and that with the
 * re-check off the console is never asked (as before).
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from "@strands-agents/sdk";
import { mandateSha256, publicJwkOf, signerFromKey, signMerchantAuthorization } from "../../../packages/ap2/src/index.ts";
import { signerFromKey as receiptSignerFromKey } from "../../../packages/receipt/src/index.ts";
import { SellerSigner } from "../../../packages/signer/src/index.ts";
import type { QuotedJob } from "../scripts/agent-ap2.ts";
import { AccountQueue, JOBS_TOOL_NAME, loadAgentTenants, runAgentJob, type AgentEvent, type AgentTenant, type RunDeps, type RunRequest } from "../scripts/agent-jobs-core.ts";
import type { MandateSigner } from "../scripts/agent-mandate.ts";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { close, listen, stubGateway } from "./stubs.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TENANTS = join(ROOT, "rig", "tenants");
const TOKEN = "usdc.chainaim-test.testnet";
const PAY_TO = "merchant.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";
const T01 = "chainaim-buyer-seller.testnet";
const JOBS_KEY = randomBytes(24).toString("hex");
const t01Key = KeyPair.fromRandom("ed25519");
const ap2 = signerFromKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
const tenantMandateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
const RESULT = { result: { columns: ["n"], rows: [{ n: 3 }] }, served: [] };

function checkoutFor(j: QuotedJob): Record<string, unknown> {
  const cents = Number(BigInt(j.amount) / 10_000n);
  const totals = [{ type: "subtotal", amount: cents }, { type: "total", amount: cents }];
  return {
    ucp: { version: "2026-08-25", capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }], "dev.ucp.common.payment.ap2_mandate": [{ version: "2026-08-25" }] }, payment_handlers: { "x402.near.exact": [{ id: "x402_near_exact", version: "2026-08-25" }] } },
    id: j.jobId, status: "ready_for_complete", currency: "USD",
    line_items: [{ id: "job", quantity: 1, item: { id: "chainaim.crossask.nearai/standin", title: "ChainAim private analysis job", price: cents }, totals }],
    totals, links: [{ type: "terms_of_service", url: "https://chainaim.example/terms" }], expires_at: new Date(j.expiresAt).toISOString(),
    "dev.chainaim.job": { network: j.network, asset: j.asset, payTo: j.payTo, amountUnits: j.amount, usdcDecimals: 6, mode: "estimate-first" },
  };
}

class ScriptedModel extends Model<BaseModelConfig> {
  private calls = 0;
  private config: BaseModelConfig = { modelId: "scripted" };
  updateConfig(c: BaseModelConfig): void { this.config = { ...this.config, ...c }; }
  getConfig(): BaseModelConfig { return this.config; }
  async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls++;
    yield { type: "modelMessageStartEvent", role: "assistant" };
    if (this.calls === 1) {
      yield { type: "modelContentBlockStartEvent", start: { type: "toolUseStart", name: JOBS_TOOL_NAME, toolUseId: "call-0" } };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "toolUseInputDelta", input: JSON.stringify({ question: "How many orders?" }) } };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
      return;
    }
    yield { type: "modelContentBlockStartEvent" };
    yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: "Done." } };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

/** ChainAim's signer in the console stand-in: the AP2 key that signs the quotes and the tenants' registered mandate keys. */
const registry = [{ tenant: "t01", accountId: T01, keys: [publicJwkOf(tenantMandateKey)] }];
const signerFor = (aud: string) => new SellerSigner({ ap2, receipt: receiptSignerFromKey(generateKeyPairSync("ed25519").privateKey), pricing: { prices: new Map(), fees: { perModelCallUsd: "0", analystUsd: "0", nearGasUsd: "0", marginPct: "0", minPriceUsd: "0.01" }, round: "cent" }, termsUrl: "https://chainaim.example/terms", mandates: { registry, aud, skewSec: 30, maxLifetimeSec: 900 } });
const state = { signer: signerFor("chainaim"), offers: new Map<string, { checkout: Record<string, unknown>; merchant_authorization: string }>(), notices: [] as Record<string, unknown>[], runs: [] as string[], held: new Map<string, unknown>(),
  rechecks: [] as string[], recheck: { status: 200, body: within as unknown } };
let paywallUrl = "";

function within(jobId: string): unknown {
  return { jobId, ok: true, files: 1, totalBytes: 100, estimated: { files: 1, totalBytes: 100, sizeTolerancePct: 10 }, signedLimits: true };
}
const consoleServer: Server = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const path = new URL(req.url ?? "/", "http://console").pathname;
  const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
  if (req.method === "POST" && path === "/offers") {
    const jobId = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 600_000;
    const reg = await fetch(`${paywallUrl}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-jobs-key": JOBS_KEY }, body: JSON.stringify({ jobId, amount: "20000", expiresAt, run: true }) });
    await reg.body?.cancel();
    const q = await fetch(`${paywallUrl}/v1/jobs/${jobId}/release`, { method: "POST" });
    await q.body?.cancel();
    const offer = (JSON.parse(Buffer.from(q.headers.get("payment-required")!, "base64").toString("utf8")) as { accepts: Record<string, string>[] }).accepts[0];
    const j: QuotedJob = { jobId, amount: "20000", network: offer.network, asset: offer.asset, payTo: offer.payTo, expiresAt };
    const checkout = checkoutFor(j);
    const signed = { checkout, merchant_authorization: signMerchantAuthorization(checkout, ap2) };
    state.offers.set(jobId, signed);
    return send(200, { ...j, offerId: jobId, mode: "estimate-first", totalUsd: "0.020000", route: "nearai/standin", attested: true, ap2: signed });
  }
  // ARCH-711 stand-in: the console's answer is set per test (state.recheck); every ask is counted.
  const rc = /^\/offers\/([0-9a-f]{32})\/recheck$/.exec(path);
  if (rc && req.method === "GET") {
    state.rechecks.push(rc[1]);
    if (state.recheck.status === 0) { req.socket.destroy(); return; } // the console went away mid-ask
    return send(state.recheck.status, typeof state.recheck.body === "function" ? state.recheck.body(rc[1]) : state.recheck.body);
  }
  if (req.headers["x-jobs-key"] !== JOBS_KEY) return send(401, { error: "key" });
  const run = /^\/internal\/jobs\/([0-9a-f]{32})\/run$/.exec(path);
  if (run && req.method === "POST" && state.offers.has(run[1])) {
    // As server.ts runOffer: the mandate is verified by the signer BEFORE anything runs; a refusal is 422 (nothing settles).
    const notice = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    state.notices.push(notice);
    if (notice.checkoutMandate) {
      const v = state.signer.verifyMandate({ mandate: notice.checkoutMandate, jobId: run[1], nonce: notice.invoiceId ?? "", ap2: state.offers.get(run[1])! });
      if (!v.ok) return send(422, { error: `the checkout mandate was refused by ChainAim's signer (${v.code}): ${v.reason}`, code: v.code });
    }
    state.runs.push(run[1]);
    state.held.set(run[1], RESULT);
    return send(200, { jobId: run[1], result: RESULT });
  }
  const m = /^\/internal\/jobs\/([0-9a-f]{32})(\/released)?$/.exec(path);
  if (m && req.method === "POST" && m[2]) return send(200, {});
  send(404, { error: "not found" });
});

const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
const gateway = stubGateway();
const relayerKey = KeyPair.fromRandom("ed25519");
let paywall: { url: string; close: () => Promise<void> };
let consoleUrl = "";
let tenants: AgentTenant[] = [];

describe("privateAI-design-42 ARCH-712 the agent re-sizes the folder before paying (--re-estimate on), through the real paywall", () => {
  before(async () => {
    const rpcUrl = await listen(double.server);
    consoleUrl = await listen(consoleServer);
    addAccount(double.state, RELAYER, relayerKey.getPublicKey().toString());
    addAccount(double.state, PAY_TO);
    addAccount(double.state, T01, t01Key.getPublicKey().toString());
    tenants = loadAgentTenants(TENANTS, ["t01"], { NEAR_NETWORK: "testnet", NEAR_RPC_URL_TESTNET: rpcUrl, NEAR_USDC_CONTRACT_TESTNET: TOKEN, NEAR_BUYER_KEY_TESTNET: t01Key.toString() });
    paywall = await startNearPaywall({
      PAY_RAILS: "near", NEAR_PAY_TO_TESTNET: PAY_TO, NEAR_USDC_CONTRACT_TESTNET: TOKEN, NEAR_USDC_DECIMALS_TESTNET: "6", NEAR_RPC_URL_TESTNET: rpcUrl,
      NEAR_RELAYER_ACCOUNT_TESTNET: RELAYER, NEAR_RELAYER_KEY_TESTNET: relayerKey.toString(), GATEWAY_URL: await listen(gateway.server), CHAINAIM_GATEWAY_KEY: "test-gateway-key",
      PAID_JOBS: "on", PAID_JOBS_KEY: JOBS_KEY, PAID_JOBS_RESULT_URL: consoleUrl, PAID_JOBS_TTL_SEC: "900",
    }, () => undefined);
    paywallUrl = paywall.url;
  });
  after(async () => {
    await paywall?.close();
    await close(consoleServer);
    await close(double.server);
    await close(gateway.server);
  });
  beforeEach(() => {
    const t = double.state.token;
    t.registered.clear(); t.registered.add(PAY_TO); t.balances.clear(); t.registered.add(T01); t.balances.set(T01, 1_000_000n);
    double.state.transfers.length = 0;
    state.signer = signerFor("chainaim");
    state.notices.length = 0;
    state.runs.length = 0;
    state.rechecks.length = 0;
    state.recheck = { status: 200, body: within };
  });

  const mandates = (keys = new Map([["t01", { key: tenantMandateKey, kid: publicJwkOf(tenantMandateKey).kid }]])): MandateSigner => ({ keys, aud: "chainaim", lifetimeSec: 300 });
  const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
    tenants: new Map(tenants.map((t) => [t.id, t])), console: consoleUrl, paywall: paywall.url, promptMask: false,
    makeModel: () => new ScriptedModel(), maxTurns: 6, queue: new AccountQueue(), tenantLabel: "the user's organisation",
    ap2Check: { keys: [ap2.publicJwk], kids: [ap2.kid], keyPath: "test", skewSec: 30 }, mandates: mandates(), defaultOfferMode: "estimate-first", ...over,
  });
  const req: RunRequest = { tenant: "t01", folder: "/data/orders", question: "How many orders?", phrase: "none", offerMode: "estimate-first" };
  async function run(d: RunDeps): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    await runAgentJob(req, d, (e) => events.push(e), new AbortController().signal);
    return events;
  }

  const transfers = () => double.state.transfers.length;

  it("ARCH-712: on: estimate -> signed quote -> rechecked -> mandate -> payment signed -> run -> settled; the console was asked once, for this job", async () => {
    const events = await run(deps({ reEstimate: true }));
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "rechecked", "mandate_signed", "signed", "settled", "released", "done"], JSON.stringify(events));
    const est = events.find((e) => e.type === "estimated") as { jobId: string };
    assert.deepEqual(state.rechecks, [est.jobId]);
    assert.deepEqual(events.find((e) => e.type === "rechecked"), { type: "rechecked", jobId: est.jobId, files: 1, totalBytes: 100, estimatedFiles: 1, estimatedBytes: 100, tolerancePct: 10 });
    assert.equal(state.runs.length, 1);
    assert.equal(transfers(), 1);
  });

  it("ARCH-712: a folder that grew since the estimate (409 estimate_stale) is refused before the mandate and the payment: nothing signed, run or paid", async () => {
    state.recheck = { status: 409, body: { error: "the folder has 2 data files now, 1 when it was estimated: estimate it again", code: "estimate_stale", files: 2, totalBytes: 200 } };
    const events = await run(deps({ reEstimate: true }));
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "refused"], JSON.stringify(events));
    const r = events.at(-1) as { reason: string; code?: string };
    assert.equal(r.code, "estimate_stale");
    assert.match(r.reason, /the folder changed since the estimate \(the folder has 2 data files now, 1 when it was estimated: estimate it again\); nothing was signed or paid: ask again for a new estimate/);
    assert.equal(state.notices.length, 0, "the paid release was never asked for");
    assert.equal(state.runs.length, 0);
    assert.equal(transfers(), 0);
  });

  it("ARCH-712: a re-check that cannot be made (offer gone, an unreadable answer) is refused too, with no code: nothing signed or paid", async () => {
    for (const [status, body, why] of [
      [404, { error: "no such offer (it expired, already ran, or was never made)" }, /could not be re-checked before paying \(no such offer/],
      [200, { ok: true }, /re-check answer could not be read/],
      [200, (id: string) => ({ ...(within(id) as object), jobId: "f".repeat(32) }), /re-check answer could not be read/],
    ] as const) {
      state.recheck = { status, body };
      const events = await run(deps({ reEstimate: true }));
      const r = events.at(-1) as { type: string; reason: string; code?: string };
      assert.equal(r.type, "refused", JSON.stringify(events));
      assert.match(r.reason, why);
      assert.equal(r.code, undefined);
      assert.equal(events.some((e) => e.type === "signed" || e.type === "mandate_signed"), false);
    }
    assert.equal(transfers(), 0);
  });

  it("ARCH-712: a console that drops the re-check is refused: nothing signed or paid", async () => {
    state.recheck = { status: 0, body: {} };
    const events = await run(deps({ reEstimate: true }));
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "refused"], JSON.stringify(events));
    assert.match((events.at(-1) as { reason: string }).reason, /the job's size could not be re-checked \(the console at .* could not be reached: TypeError\); nothing was signed or paid/);
    assert.equal(state.rechecks.length, 1);
    assert.equal(transfers(), 0);
  });

  it("ARCH-712: off (the default): the console is never asked and the steps are exactly as before", async () => {
    const events = await run(deps());
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "mandate_signed", "signed", "settled", "released", "done"]);
    assert.equal(state.rechecks.length, 0);
    assert.equal(transfers(), 1);
  });
});
