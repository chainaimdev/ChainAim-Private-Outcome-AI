/**
 * privateAI-design-36 ARCH-666 / ARCH-667 / ARCH-611: the buyer side of the two-sided AP2 deal through the REAL paywall.
 * The agent (runAgentJob, scripted model, real tenant files with throwaway keys) signs a closed checkout mandate right
 * before it signs the NEAR payment, nonce = the paywall's invoice id; the real paywall in-process (NEAR rail, PAID_JOBS=on,
 * the NEAR JSON-RPC protocol double) verifies the payment, then forwards the invoice id and the mandate to the console's
 * run step; the console stand-in has ChainAim's signer (packages/signer SellerSigner, real keys) verify it there, as
 * test-console/console/server.ts runOffer does (covered end to end in scripts/test/console-signer.test.ts). Pinned here:
 * the order (mandate after the policy, before the payment signature), and that a refused mandate settles nothing.
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
const state = { signer: signerFor("chainaim"), offers: new Map<string, { checkout: Record<string, unknown>; merchant_authorization: string }>(), notices: [] as Record<string, unknown>[], runs: [] as string[], held: new Map<string, unknown>() };
let paywallUrl = "";

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

describe("ARCH-666 ARCH-667 the agent's checkout mandate through the real paywall", () => {
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

  it("ARCH-666 ARCH-667: estimate -> signed quote -> mandate (nonce = invoice) -> payment signed -> signer verifies -> run -> settled", async () => {
    const events = await run(deps());
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "mandate_signed", "signed", "settled", "released", "done"], JSON.stringify(events));
    const ms = events.find((e) => e.type === "mandate_signed") as Extract<AgentEvent, { type: "mandate_signed" }>;
    assert.equal(ms.kid, publicJwkOf(tenantMandateKey).kid);
    assert.equal(state.notices.length, 1);
    const n = state.notices[0];
    assert.equal(n.invoiceId, ms.nonce, "the paywall forwarded the invoice the payment names, which the mandate is bound to");
    assert.equal(mandateSha256(n.checkoutMandate as string), ms.sha256, "the mandate arrived at the run step as the agent signed it");
    assert.equal(state.runs.length, 1);
    assert.deepEqual(double.state.transfers.map((t) => [t.sender, t.amount]), [[T01, 20000n]]);
  });

  it("ARCH-667 ARCH-611: a mandate ChainAim's signer refuses (another audience) runs nothing and settles nothing", async () => {
    state.signer = signerFor("another-business");
    const events = await run(deps());
    assert.deepEqual(events.slice(0, 7).map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "mandate_signed", "signed"]);
    const last = events.find((e) => e.type === "error") as { reason: string } | undefined;
    assert.ok(last, JSON.stringify(events));
    assert.match(last!.reason, /HTTP 422: the checkout mandate was refused by ChainAim's signer \(mandate_scope_mismatch\).*you were not charged/);
    assert.equal(state.runs.length, 0, "nothing ran");
    assert.equal(double.state.transfers.length, 0, "the signed payment was not settled");
  });

  it("ARCH-666: a tenant without a mandate key is refused before the payment is signed: no run, no transfer", async () => {
    const events = await run(deps({ mandates: mandates(new Map()) }));
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "refused"]);
    assert.match((events.at(-1) as { reason: string }).reason, /tenant t01 has no checkout mandate key \(AP2_MANDATE_KEY_T01; desk\.ps1 -MandateKey -MandateTenant t01\); nothing was signed or paid/);
    assert.equal(state.notices.length, 0);
    assert.equal(double.state.transfers.length, 0);
  });
});
