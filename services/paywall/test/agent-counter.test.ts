/**
 * privateAI-design-43 ARCH-724: one-round counter-offers (--counter on) through the REAL paywall. The agent (runAgentJob,
 * scripted model, real tenant files with throwaway keys, a policy with t02's approved values: auto-approve 0.01, accepts
 * answerMaxRows and maxTokens) gets a 0.02 quote, its policy says "counter", it asks the console for a smaller job at 0.01
 * (POST /offers/<id>/counter; the real route and ladder are covered in scripts/test/console-paid-jobs.test.ts and
 * test-console/test/counter.test.ts), checks the NEW offer like any quote and pays 0.01. Pinned here: the order, that
 * no fit / a lying console / an unaccepted step / --counter off end with nothing signed or paid, and that a quote within
 * auto-approve never asks for a counter.
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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { parsePolicy, SpendLedger } from "../../../packages/agent-policy/src/index.ts";
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
  counters: [] as { id: string; body: unknown }[], counter: { status: 200, price: "10000", counterOf: "" as string | undefined, reduced: ["answerMaxRows", "maxTokens"] as unknown, error: undefined as unknown } };
let paywallUrl = "";

async function newOffer(amount: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const jobId = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 600_000;
  const reg = await fetch(`${paywallUrl}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-jobs-key": JOBS_KEY }, body: JSON.stringify({ jobId, amount, expiresAt, run: true }) });
  await reg.body?.cancel();
  const q = await fetch(`${paywallUrl}/v1/jobs/${jobId}/release`, { method: "POST" });
  await q.body?.cancel();
  const offer = (JSON.parse(Buffer.from(q.headers.get("payment-required")!, "base64").toString("utf8")) as { accepts: Record<string, string>[] }).accepts[0];
  const j: QuotedJob = { jobId, amount, network: offer.network, asset: offer.asset, payTo: offer.payTo, expiresAt };
  const checkout = checkoutFor(j);
  const signed = { checkout, merchant_authorization: signMerchantAuthorization(checkout, ap2) };
  state.offers.set(jobId, signed);
  const usd = (Number(amount) / 1e6).toFixed(6);
  return { ...j, offerId: jobId, mode: "estimate-first", totalUsd: usd, route: "nearai/standin", attested: true, ap2: signed, ...extra };
}
const consoleServer: Server = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const path = new URL(req.url ?? "/", "http://console").pathname;
  const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
  if (req.method === "POST" && path === "/offers") return send(200, await newOffer("20000"));
  // ARCH-721 stand-in: the console's answer is set per test (state.counter); every ask is recorded with its body.
  const co = /^\/offers\/([0-9a-f]{32})\/counter$/.exec(path);
  if (co && req.method === "POST") {
    state.counters.push({ id: co[1], body: JSON.parse(raw) });
    const c = state.counter;
    if (c.status !== 200) return send(c.status, c.error);
    return send(200, await newOffer(c.price, { counterOf: c.counterOf === "" ? co[1] : c.counterOf, reduced: c.reduced, basis: { files: 1, totalBytes: 100, modelCalls: 1, maxPromptChars: 2000, answerMaxPromptChars: 4000, maxTokens: 1024, sqlRetries: 0, answerMaxRows: 20 } }));
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

/** t02's approved policy (privateAI-design-43 §6): auto-approve 0.01, counter on, accepts answer rows and tokens. */
const T02_LIKE = { autoApproveMaxUsd: "0.01", maxPerJobUsd: "0.50", dailyCapUsd: "2.00", requireAttestedRoute: true, requoteAutoAcceptPct: 10, counter: { enabled: true, maxRounds: 2, acceptReduced: ["answerMaxRows", "phrase", "maxTokens"] } };

describe("privateAI-design-43 ARCH-724 one-round counter-offer by the agent (--counter on), through the real paywall", () => {
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
    state.counters.length = 0;
    state.counter = { status: 200, price: "10000", counterOf: "", reduced: ["answerMaxRows", "maxTokens"], error: undefined };
  });

  const mandates = (): MandateSigner => ({ keys: new Map([["t01", { key: tenantMandateKey, kid: publicJwkOf(tenantMandateKey).kid }]]), aud: "chainaim", lifetimeSec: 300 });
  const policyOf = (raw: Record<string, unknown>) => ({ policies: new Map([["t01", parsePolicy(raw, "t01")]]), ledger: new SpendLedger(mkdtempSync(join(tmpdir(), "agent-counter-"))) });
  const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
    tenants: new Map(tenants.map((t) => [t.id, t])), console: consoleUrl, paywall: paywall.url, promptMask: false,
    makeModel: () => new ScriptedModel(), maxTurns: 6, queue: new AccountQueue(), tenantLabel: "the user's organisation",
    ap2Check: { keys: [ap2.publicJwk], kids: [ap2.kid], keyPath: "test", skewSec: 30 }, mandates: mandates(), defaultOfferMode: "estimate-first",
    policy: policyOf(T02_LIKE), counter: true, ...over,
  });
  const req: RunRequest = { tenant: "t01", folder: "/data/orders", question: "How many orders?", phrase: "llm", offerMode: "estimate-first" };
  async function run(d: RunDeps): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    await runAgentJob(req, d, (e) => events.push(e), new AbortController().signal);
    return events;
  }
  const paidUnits = () => 1_000_000n - (double.state.token.balances.get(T01) ?? 0n);
  const nothingPaid = (events: AgentEvent[]) => {
    assert.equal(events.some((e) => e.type === "signed" || e.type === "mandate_signed"), false, JSON.stringify(events));
    assert.equal(state.notices.length, 0, "the paid release was never asked for");
    assert.equal(state.runs.length, 0);
    assert.equal(double.state.transfers.length, 0);
  };

  it("ARCH-724: 0.02 above auto-approve 0.01 -> counter -> a smaller job at 0.01, checked like any quote, then paid 0.01; the NEW job runs", async () => {
    const events = await run(deps());
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "policy", "countered", "quoted", "quote_signed", "policy", "mandate_signed", "signed", "settled", "released", "done"], JSON.stringify(events));
    const first = (events.find((e) => e.type === "estimated") as { jobId: string }).jobId;
    const [p1, p2] = events.filter((e) => e.type === "policy") as { decision: string }[];
    assert.equal(p1.decision, "counter");
    assert.equal(p2.decision, "pay");
    const c = events.find((e) => e.type === "countered") as Extract<AgentEvent, { type: "countered" }>;
    assert.equal(c.counterOf, first);
    assert.notEqual(c.jobId, first);
    assert.deepEqual({ ceiling: c.ceilingUsd, price: c.priceUsd, reduced: c.reduced, basis: c.basis }, { ceiling: "0.01", price: "0.01", reduced: ["answerMaxRows", "maxTokens"], basis: { answerMaxRows: 20, maxTokens: 1024, sqlRetries: 0 } });
    // The console was asked once, for the first offer, with the policy's ceiling and accepted steps.
    assert.deepEqual(state.counters, [{ id: first, body: { maxPriceUsd: "0.01", accept: ["answerMaxRows", "phrase", "maxTokens"] } }]);
    // The mandate and the payment are for the NEW offer only; 0.01 USDC moved.
    assert.equal((events.find((e) => e.type === "mandate_signed") as { jobId: string }).jobId, c.jobId);
    assert.deepEqual(state.runs, [c.jobId]);
    assert.equal(paidUnits(), 10_000n);
  });

  it("ARCH-724: no smaller job fits (422 no_fit) -> refused counter_no_fit with the cheapest price: nothing signed, run or paid", async () => {
    state.counter = { ...state.counter, status: 422, error: { error: "the smallest job the buyer accepts still costs 0.02 USD, above 0.01", code: "no_fit", cheapestUsd: "0.02" } };
    const events = await run(deps());
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "policy", "refused"], JSON.stringify(events));
    const r = events.at(-1) as { reason: string; code?: string };
    assert.equal(r.code, "counter_no_fit");
    assert.match(r.reason, /asked ChainAim for a smaller job at 0\.01 USD; none it accepts fits \(the smallest costs 0\.02 USD\), so nothing was signed or paid/);
    nothingPaid(events);
  });

  it("ARCH-724: the agent does not take the console's word: above the ceiling, another first offer, an unaccepted step, a console error -> counter_failed, nothing paid", async () => {
    for (const [over, why] of [
      [{ price: "15000" }, /costs 0\.015 USD, above the ceiling/],
      [{ counterOf: "e".repeat(32) }, /does not name the first offer/],
      [{ reduced: ["sqlRetries"] }, /reduces a limit the policy does not accept/],
      [{ reduced: [] }, /reduces a limit the policy does not accept/],
      [{ status: 409, error: { error: "this offer was already countered (one counter per offer)", code: "round_used" } }, /the console answered this offer was already countered/],
    ] as const) {
      state.counter = { ...state.counter, ...over };
      const events = await run(deps());
      const r = events.at(-1) as { type: string; reason: string; code?: string };
      assert.equal(r.type, "refused", JSON.stringify(events));
      assert.equal(r.code, "counter_failed");
      assert.match(r.reason, why);
      nothingPaid(events);
      state.counter = { status: 200, price: "10000", counterOf: "", reduced: ["answerMaxRows", "maxTokens"], error: undefined };
    }
  });

  it("ARCH-724: --counter off (the default): a policy counter stops the run as before; the console is never asked", async () => {
    const events = await run(deps({ counter: false }));
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "policy", "refused"]);
    assert.match((events.at(-1) as { reason: string }).reason, /would ask for a smaller job at 0\.01 USD .*counter-offers are off on this agent \(--counter off\), so nothing was signed or paid/);
    assert.equal(state.counters.length, 0);
    nothingPaid(events);
  });

  it("ARCH-724: a quote within auto-approve (t01's 0.05) is paid as before: no counter asked", async () => {
    const events = await run(deps({ policy: policyOf({ ...T02_LIKE, autoApproveMaxUsd: "0.05" }) }));
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "policy", "mandate_signed", "signed", "settled", "released", "done"], JSON.stringify(events));
    assert.equal(state.counters.length, 0);
    assert.equal(paidUnits(), 20_000n);
  });
});
