/**
 * privateAI-design-33 ARCH-630: the paying agent verifies ChainAim's signed quote (AP2 merchant authorization over the
 * job's UCP checkout) with the PINNED AP2 key and binds it to the quote, before its policy and before signing.
 *
 * Part 1: checkSignedQuote and loadPinnedJwks, with checkouts signed by packages/ap2 (real ES256, real JCS).
 * Part 2: the whole run on loopback with real code, as agent-receipt.test.ts: the real paywall in-process (NEAR rail,
 * PAID_JOBS=on), the NEAR JSON-RPC protocol double, the real tenant files with throwaway keys, runAgentJob with a
 * scripted Strands model. The console stand-in registers the job and answers its quote with an `ap2` member built the
 * way test-console/console/ap2.ts builds it (that code is covered by test-console/test/ap2.test.ts; services/ may not
 * import test-console, check-deps.ts).
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from "@strands-agents/sdk";
import { signerFromKey, signMerchantAuthorization, type Ap2Signer } from "../../../packages/ap2/src/index.ts";
import { checkSignedQuote, loadPinnedJwks, type Ap2Check, type QuotedJob } from "../scripts/agent-ap2.ts";
import { AccountQueue, JOBS_TOOL_NAME, loadAgentTenants, runAgentJob, type AgentEvent, type AgentTenant, type RunDeps, type RunRequest } from "../scripts/agent-jobs-core.ts";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { close, listen, stubGateway } from "./stubs.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TENANTS = join(ROOT, "rig", "tenants");
const dir = mkdtempSync(join(tmpdir(), "agent-ap2-"));
const newSigner = (): Ap2Signer => signerFromKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
const pinned = newSigner();
const other = newSigner();
const TOKEN = "usdc.chainaim-test.testnet";
const PAY_TO = "merchant.chainaim-test.testnet";

/** The checkout as test-console/console/ap2.ts jobCheckout writes it. */
function checkoutFor(j: QuotedJob, cents: number): Record<string, unknown> {
  const totals = [{ type: "subtotal", amount: cents }, { type: "total", amount: cents }];
  return {
    ucp: { version: "2026-08-25", capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }], "dev.ucp.common.payment.ap2_mandate": [{ version: "2026-08-25" }] },
      payment_handlers: { "x402.near.exact": [{ id: "x402_near_exact", version: "2026-08-25" }] } },
    id: j.jobId, status: "ready_for_complete", currency: "USD",
    line_items: [{ id: "job", quantity: 1, item: { id: "chainaim.crossask.nearai/standin", title: "ChainAim private analysis job", price: cents }, totals }],
    totals, links: [{ type: "terms_of_service", url: "https://chainaim.example/terms" }], expires_at: new Date(j.expiresAt).toISOString(),
    "dev.chainaim.job": { network: j.network, asset: j.asset, payTo: j.payTo, amountUnits: j.amount, usdcDecimals: 6 },
  };
}
const signed = (j: QuotedJob, signer = pinned, edit: (c: Record<string, any>) => void = () => undefined) => {
  const checkout = checkoutFor(j, Number(BigInt(j.amount) / 10_000n));
  edit(checkout);
  return { checkout, merchant_authorization: signMerchantAuthorization(checkout, signer) };
};
const check = (over: Partial<Ap2Check> = {}): Ap2Check => ({ keys: [pinned.publicJwk], kids: [pinned.kid], keyPath: "test", skewSec: 30, ...over });
const quoted = (over: Partial<QuotedJob> = {}): QuotedJob => ({ jobId: randomBytes(16).toString("hex"), amount: "20000", network: "near:testnet", asset: TOKEN, payTo: PAY_TO, expiresAt: Date.now() + 600_000, ...over });

describe("ARCH-630 the agent's signed-quote check (checkSignedQuote)", () => {
  it("ARCH-630: a quote signed by the pinned key and matching the quote is accepted: quote_signed with the key id and the cents", () => {
    const j = quoted();
    assert.deepEqual(checkSignedQuote(check(), signed(j), j), { ok: true, event: { type: "quote_signed", jobId: j.jobId, kid: pinned.kid, cents: 2 } });
  });

  it("ARCH-630: the key is pinned: another key, a missing ap2 and a broken signature are refused with their AP2 codes", () => {
    const j = quoted();
    const v = checkSignedQuote(check(), signed(j, other), j);
    assert.deepEqual([v.ok, (v as { code: string }).code], [false, "merchant_authorization_invalid"]);
    assert.match((v as { reason: string }).reason, /kid names no key/);
    assert.deepEqual((checkSignedQuote(check(), undefined, j) as { code: string }).code, "merchant_authorization_missing");
    const s = signed(j);
    const edited = { ...s, checkout: { ...s.checkout, status: "completed" } };
    assert.deepEqual((checkSignedQuote(check(), edited, j) as { code: string }).code, "merchant_authorization_invalid");
  });

  it("ARCH-630: a validly signed checkout that differs from the quote is mandate_scope_mismatch: job, amount, cents, network, asset, payee, expiry", () => {
    const j = quoted();
    const scope = (s: unknown, q = j) => { const v = checkSignedQuote(check(), s, q); assert.equal(v.ok, false); assert.equal((v as { code: string }).code, "mandate_scope_mismatch"); return (v as { reason: string }).reason; };
    assert.match(scope(signed(j), { ...j, jobId: "f".repeat(32) }), /another job/);
    assert.match(scope(signed(j), { ...j, amount: "30000" }), /signed amount/);
    assert.match(scope(signed(j, pinned, (c) => { c.totals[1].amount = 3; })), /signed total \(3 cents\)/);
    assert.match(scope(signed(j), { ...j, network: "near:mainnet" }), /network/);
    assert.match(scope(signed(j), { ...j, asset: "other.testnet" }), /asset/);
    assert.match(scope(signed(j), { ...j, payTo: "evil.testnet" }), /payee/);
    assert.match(scope(signed(j), { ...j, expiresAt: j.expiresAt + 1000 }), /expiry/);
    assert.match(scope(signed(j, pinned, (c) => { c.currency = "EUR"; })), /not in USD/);
  });

  it("ARCH-630: an expired signed quote is refused, with the clock skew allowed (lesson 7)", () => {
    const j = quoted({ expiresAt: Date.now() - 10_000 });
    assert.equal(checkSignedQuote(check({ skewSec: 30 }), signed(j), j).ok, true, "10 s past, 30 s skew");
    const v = checkSignedQuote(check({ skewSec: 5 }), signed(j), j);
    assert.deepEqual([v.ok, (v as { code: string }).code, (v as { reason: string }).reason], [false, "merchant_authorization_invalid", "the signed quote has expired"]);
  });

  it("ARCH-630: loadPinnedJwks reads a JWK Set and its key ids; a missing, empty or bad file names the path and desk.ps1 -Ap2Key", () => {
    const f = join(dir, "jwks.json");
    writeFileSync(f, JSON.stringify({ keys: [pinned.publicJwk] }));
    assert.deepEqual(loadPinnedJwks(f), { keys: [pinned.publicJwk], kids: [pinned.kid] });
    assert.throws(() => loadPinnedJwks(join(dir, "missing.json")), /missing\.json could not be read \(ENOENT\): export it with \.\\test-console\\desk\.ps1 -Ap2Key/);
    writeFileSync(f, "{}");
    assert.throws(() => loadPinnedJwks(f), /must be a JWK Set/);
    writeFileSync(f, JSON.stringify({ keys: [{ kty: "OKP" }] }));
    assert.throws(() => loadPinnedJwks(f), /keys\[0\]/);
  });

  it("ARCH-627 ARCH-630: the repository's pinned AP2 key (config/ap2-public-key.jwk.json, exported by desk.ps1 -Ap2Key) is 83816e6f…", () => {
    assert.deepEqual(loadPinnedJwks(join(ROOT, "config", "ap2-public-key.jwk.json")).kids, ["83816e6fd32b879fd96d0318a40cd40d"]);
  });
});

// ---- part 2: the whole run ------------------------------------------------------------------------------------------
const RELAYER = "relayer.chainaim-test.testnet";
const JOBS_KEY = randomBytes(24).toString("hex");
const T01 = "chainaim-buyer-seller.testnet";
const t01Key = KeyPair.fromRandom("ed25519");
const RESULT = { result: { columns: ["n"], rows: [{ n: 3 }] }, served: [] };

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

/** How the console stand-in answers: signer, and what it claims (and signs) as the payee. */
const state: { signer: Ap2Signer; payTo?: string; noAp2: boolean; held: Map<string, unknown>; offers: Map<string, unknown>; runs: string[]; paths: string[]; limits?: Record<string, unknown>; answerBasis?: Record<string, unknown>; route?: string } = { signer: pinned, noAp2: false, held: new Map(), offers: new Map(), runs: [], paths: [] };
let paywallUrl = "";
const consoleServer: Server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const path = new URL(req.url ?? "/", "http://console").pathname;
  const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
  state.paths.push(`${req.method} ${path}`);
  // privateAI-design-34 ARCH-636 stand-in: an estimate, registered run: true; nothing runs until the paid release asks.
  if (req.method === "POST" && path === "/offers") {
    const jobId = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 600_000;
    state.offers.set(jobId, RESULT);
    const reg = await fetch(`${paywallUrl}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-jobs-key": JOBS_KEY }, body: JSON.stringify({ jobId, amount: "20000", expiresAt, run: true }) });
    await reg.body?.cancel();
    const q = await fetch(`${paywallUrl}/v1/jobs/${jobId}/release`, { method: "POST" });
    await q.body?.cancel();
    const offer = (JSON.parse(Buffer.from(q.headers.get("payment-required")!, "base64").toString("utf8")) as { accepts: Record<string, string>[] }).accepts[0];
    const j: QuotedJob = { jobId, amount: "20000", network: offer.network, asset: offer.asset, payTo: offer.payTo, expiresAt };
    // privateAI-design-38: with state.limits, the signed checkout carries them (as packages/signer writes them) and the answer its basis.
    const ap2 = signed(j, state.signer, (c) => { if (state.limits) c["dev.chainaim.job"].limits = state.limits; });
    return send(200, { ...j, offerId: jobId, mode: "estimate-first", totalUsd: "0.020000", route: state.route ?? "nearai/standin", attested: false, ap2, ...(state.answerBasis ? { basis: state.answerBasis } : {}) });
  }
  if (req.method === "POST" && path === "/jobs/crossask") {
    const jobId = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 600_000;
    state.held.set(jobId, RESULT);
    const reg = await fetch(`${paywallUrl}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-jobs-key": JOBS_KEY }, body: JSON.stringify({ jobId, amount: "20000", expiresAt }) });
    await reg.body?.cancel();
    const q = await fetch(`${paywallUrl}/v1/jobs/${jobId}/release`, { method: "POST" });
    await q.body?.cancel();
    const offer = (JSON.parse(Buffer.from(q.headers.get("payment-required")!, "base64").toString("utf8")) as { accepts: Record<string, string>[] }).accepts[0];
    const j: QuotedJob = { jobId, amount: "20000", network: offer.network, asset: offer.asset, payTo: state.payTo ?? offer.payTo, expiresAt };
    return send(200, { ...j, totalUsd: "0.020000", route: "nearai/standin", attested: true, ...(state.noAp2 ? {} : { ap2: signed(j, state.signer) }) });
  }
  if (req.headers["x-jobs-key"] !== JOBS_KEY) return send(401, { error: "key" });
  const run = /^\/internal\/jobs\/([0-9a-f]{32})\/run$/.exec(path);
  if (run && req.method === "POST" && state.offers.has(run[1])) { state.runs.push(run[1]); state.held.set(run[1], state.offers.get(run[1])); state.offers.delete(run[1]); return send(200, { jobId: run[1], result: RESULT }); }
  const m = /^\/internal\/jobs\/([0-9a-f]{32})(\/released)?$/.exec(path);
  if (m && req.method === "GET" && state.held.has(m[1])) return send(200, { jobId: m[1], result: state.held.get(m[1]) });
  if (m && req.method === "POST" && m[2]) return send(200, {});
  send(404, { error: "not found" });
});

const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
const gateway = stubGateway();
const relayerKey = KeyPair.fromRandom("ed25519");
let paywall: { url: string; close: () => Promise<void> };
let consoleUrl = "";
let tenants: AgentTenant[] = [];

describe("ARCH-630 in the agent run: quoted -> quote_signed -> signed, or refused with the AP2 code and nothing paid", () => {
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
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    const t = double.state.token;
    t.registered.clear();
    t.registered.add(PAY_TO);
    t.balances.clear();
    t.registered.add(T01);
    t.balances.set(T01, 1_000_000n);
    double.state.transfers.length = 0;
    state.signer = pinned;
    state.payTo = undefined;
    state.noAp2 = false;
    state.limits = undefined;
    state.answerBasis = undefined;
    state.route = undefined;
    state.runs.length = 0;
    state.paths.length = 0;
  });

  const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
    tenants: new Map(tenants.map((t) => [t.id, t])), console: consoleUrl, paywall: paywall.url, promptMask: false,
    makeModel: () => new ScriptedModel(), maxTurns: 6, queue: new AccountQueue(), tenantLabel: "the user's organisation", ap2Check: check(), ...over,
  });
  const req: RunRequest = { tenant: "t01", folder: "/data/orders", question: "How many orders?", phrase: "none" };
  async function run(d: RunDeps): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    await runAgentJob(req, d, (e) => events.push(e), new AbortController().signal);
    return events;
  }

  it("privateAI-design-34 ARCH-642: offerMode estimate-first: POST /offers, estimated (nothing run), signed quote, paid, and the job runs once inside the paid release", async () => {
    const events: AgentEvent[] = [];
    await runAgentJob({ ...req, offerMode: "estimate-first" }, deps(), (e) => events.push(e), new AbortController().signal);
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "signed", "settled", "released", "done"], JSON.stringify(events));
    assert.ok(state.paths.includes("POST /offers") && !state.paths.includes("POST /jobs/crossask"));
    assert.equal(state.runs.length, 1, "run once, by the paywall's paid release");
    assert.ok(state.paths.indexOf(`POST /internal/jobs/${state.runs[0]}/run`) > state.paths.indexOf("POST /offers"));
    assert.deepEqual(double.state.transfers.map((t) => [t.sender, t.amount]), [[T01, 20000n]]);
  });

  it("privateAI-design-34 ARCH-642: estimate-first refused before signing (agent ceiling) runs nothing; the service default applies when the run names no mode", async () => {
    const events: AgentEvent[] = [];
    await runAgentJob(req, deps({ maxAmount: "0.001", defaultOfferMode: "estimate-first" }), (e) => events.push(e), new AbortController().signal);
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "refused"]);
    assert.equal(state.runs.length, 0, "no work before the go-ahead");
    assert.equal(double.state.transfers.length, 0);
  });

  it("ARCH-630: a signed quote that holds: quote_signed between quoted and signed, then paid once", async () => {
    const events = await run(deps());
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "job_ran", "quoted", "quote_signed", "signed", "settled", "released", "done"]);
    const qs = events.find((e) => e.type === "quote_signed") as Extract<AgentEvent, { type: "quote_signed" }>;
    assert.deepEqual([qs.kid, qs.cents], [pinned.kid, 2]);
    assert.deepEqual(double.state.transfers.map((t) => [t.sender, t.amount]), [[T01, 20000n]]);
  });

  it("ARCH-630: a console signing with another key, or sending no signed quote: refused with the AP2 code, nothing signed or paid", async () => {
    state.signer = other;
    const a = await run(deps());
    assert.deepEqual(a.map((e) => e.type), ["masked", "tool_called", "job_ran", "quoted", "refused"]);
    assert.equal((a.at(-1) as { code: string }).code, "merchant_authorization_invalid");
    assert.match((a.at(-1) as { reason: string }).reason, /^ChainAim's signed quote was refused \(merchant_authorization_invalid\).*nothing was signed or paid$/);
    state.signer = pinned;
    state.noAp2 = true;
    const b = await run(deps());
    assert.equal((b.at(-1) as { code: string }).code, "merchant_authorization_missing");
    assert.equal(double.state.transfers.length, 0);
  });

  it("ARCH-630: a quote signed for another payee than the paywall's 402 offer: the agent refuses before signing (mandate_scope_mismatch)", async () => {
    state.payTo = "evil.chainaim-test.testnet";
    const events = await run(deps());
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "job_ran", "quoted", "quote_signed", "refused"]);
    assert.match((events.at(-1) as { reason: string }).reason, /mandate_scope_mismatch: the paywall's payee/);
    assert.equal(double.state.transfers.length, 0);
  });

  // privateAI-design-38 ARCH-683: the signed limits, as packages/offer limitsOf writes them, against the estimate's basis and route.
  const LIMITS = { model: "nearai/standin", answerModel: "nearai/standin", phrase: "none", userSql: false, files: 1, totalBytes: 2048, sizeTolerancePct: 10, maxPromptChars: 16000, answerMaxPromptChars: 8000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50, modelCalls: 2 };
  const BASIS = { files: 1, totalBytes: 2048, modelCalls: 2, maxPromptChars: 16000, answerMaxPromptChars: 8000, maxTokens: 2048, sqlRetries: 1 };
  const ef = async (d: RunDeps): Promise<AgentEvent[]> => { const events: AgentEvent[] = []; await runAgentJob({ ...req, offerMode: "estimate-first" }, d, (e) => events.push(e), new AbortController().signal); return events; };

  it("ARCH-683: signed limits equal to the estimate: quote_signed shows them (sizes and model ids), then paid once", async () => {
    state.limits = LIMITS;
    state.answerBasis = BASIS;
    const events = await ef(deps());
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "quote_signed", "signed", "settled", "released", "done"], JSON.stringify(events));
    const qs = events.find((e) => e.type === "quote_signed") as Extract<AgentEvent, { type: "quote_signed" }>;
    assert.deepEqual(qs.limits, { models: ["nearai/standin"], modelCalls: 2, maxTokens: 2048, files: 1, totalBytes: 2048 });
    assert.equal(state.runs.length, 1);
  });

  it("ARCH-683: signed limits that differ from the estimate, or a route outside them: refused limits_mismatch, nothing signed, run or paid", async () => {
    for (const [what, set] of [
      ["maxTokens", () => { state.answerBasis = { ...BASIS, maxTokens: 1024 }; }],
      ["modelCalls", () => { state.answerBasis = { ...BASIS, modelCalls: 1 }; }],
      ["route", () => { state.answerBasis = BASIS; state.route = "nearai/standin+nearai/bigger"; }],
      ["shape", () => { state.answerBasis = BASIS; state.limits = { ...LIMITS, extra: 1 }; }],
    ] as const) {
      state.limits = LIMITS;
      state.route = undefined;
      set();
      const events = await ef(deps());
      assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "estimated", "quoted", "refused"], what);
      const last = events.at(-1) as { code: string; reason: string };
      assert.equal(last.code, "limits_mismatch", what);
      assert.match(last.reason, /^ChainAim's signed limits do not match the estimate \(limits_mismatch\).*nothing was signed or paid$/, what);
    }
    assert.equal(state.runs.length, 0, "nothing ran");
    assert.equal(double.state.transfers.length, 0, "nothing paid");
  });

  it("ARCH-683: a signed estimate without limits (a signer before v2.1.0) passes the agent with no limits shown; the console's run step refuses it", async () => {
    const events = await ef(deps());
    const qs = events.find((e) => e.type === "quote_signed") as Extract<AgentEvent, { type: "quote_signed" }>;
    assert.equal(qs.limits, undefined);
  });

  it("ARCH-630: without the check (--ap2-verify off) there is no quote_signed step and the ap2 member is ignored", async () => {
    const events = await run(deps({ ap2Check: undefined }));
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "job_ran", "quoted", "signed", "settled", "released", "done"]);
  });
});
