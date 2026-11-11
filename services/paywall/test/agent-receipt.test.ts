/**
 * privateAI-design-32 step B: the paying agent verifies the job's signed receipt with the console's PINNED public key
 * (services/paywall/scripts/agent-receipt.ts; ARCH-613 verify side, ARCH-615 receipt route, ARCH-616 settlement).
 *
 * Part 1 drives verifyPaidReceipt against a loopback console that serves GET /jobs/<id>/receipt, with receipts signed
 * by packages/receipt (real Ed25519, real canonical JSON) under a pinned key and under a second key.
 *
 * Part 2 is the whole run on loopback with real code, as agent-policy.test.ts: the real paywall in-process (NEAR rail,
 * PAID_JOBS=on), the NEAR JSON-RPC protocol double, the real tenant files with throwaway keys, runAgentJob with a
 * scripted Strands model. The console stand-in does the console's part only: it registers the job with the paywall,
 * hands the held result over on release, and on the paywall's release notice signs the receipt of the released result
 * with packages/receipt and appends the notice's settlement, as test-console/console/receipt.ts receiptOnRelease does
 * (that code is covered by test-console/test/receipt.test.ts; services/ may not import test-console, check-deps.ts).
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
import { addSettlement, filesRoot, resultSha256, sha256Hex, signerFromKey, signReceipt, type ReceiptSigner, type SignedReceipt } from "../../../packages/receipt/src/index.ts";
import { checkReceipt, loadPinnedKey, verifyPaidReceipt, type PaidJob, type ReceiptCheck } from "../scripts/agent-receipt.ts";
import { AccountQueue, JOBS_TOOL_NAME, loadAgentTenants, plainUsd, runAgentJob, type AgentEvent, type AgentTenant, type RunDeps, type RunRequest } from "../scripts/agent-jobs-core.ts";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { close, listen, stubGateway } from "./stubs.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TENANTS = join(ROOT, "rig", "tenants");
const dir = mkdtempSync(join(tmpdir(), "agent-receipt-"));

const newSigner = (): ReceiptSigner => signerFromKey(generateKeyPairSync("ed25519").privateKey);
const pinned = newSigner();
const other = newSigner();
const TX = "8ZuzgYKyAbCdEfGhJkLmNpQrStUvWxYz1aK";
const RESULT = { result: { columns: ["n"], rows: [{ n: 3 }] }, served: [] };

/** A receipt as the console builds it for a released job (receipt.ts buildReceipt), signed by `signer`. */
function receiptFor(jobId: string, amount: string, result: unknown, signer: ReceiptSigner, transaction?: string): SignedReceipt {
  const files = [{ name: "orders.csv", bytes: 12, sha256: sha256Hex("orders file") }];
  const r = signReceipt({
    v: 1, receiptId: sha256Hex(`${jobId}:q`).slice(0, 32), jobId, quoteId: jobId, route: "nearai/standin", datasetId: "smb-fin-1",
    files, filesRoot: filesRoot(files), sqlSha256: sha256Hex("select 1"), resultSha256: resultSha256(JSON.parse(JSON.stringify(result))), calls: [],
    price: { amountUnits: amount, usdcDecimals: 6, priceUsd: "0.003", quoteBasis: { rows: 1 } }, createdAt: new Date().toISOString(),
  }, signer);
  return transaction ? addSettlement(r, { network: "near:testnet", transaction, invoiceId: "inv-1", payer: "chainaim-buyer-seller.testnet", settledAt: new Date().toISOString() }, signer) : r;
}

// ---- part 1: a console that answers GET /jobs/<id>/receipt from a script of answers ----------------------------------
type Answer = { status: number; body: unknown };
const script: { answers: Answer[]; asked: number } = { answers: [], asked: 0 };
const receiptConsole: Server = createServer((req, res) => {
  script.asked++;
  const a = script.answers.length > 1 ? script.answers.shift()! : script.answers[0];
  assert.match(req.url ?? "", /^\/jobs\/[0-9a-f]{32}\/receipt$/);
  res.writeHead(a.status, { "content-type": "application/json" });
  res.end(JSON.stringify(a.body));
});
let receiptConsoleUrl = "";
const check = (over: Partial<ReceiptCheck> = {}): ReceiptCheck => ({ publicKeyPem: pinned.publicKeyPem, keyId: pinned.keyId, keyPath: "test", pollMs: 1, pollMax: 5, fetchTimeoutMs: 2000, ...over });
const job = (): PaidJob => ({ jobId: randomBytes(16).toString("hex"), amount: "3000", transaction: TX, result: RESULT });
const served = (r: SignedReceipt, keyPem = pinned.publicKeyPem): Answer => ({ status: 200, body: { receipt: r, publicKeyPem: keyPem } });
const notYet: Answer = { status: 404, body: { error: "no receipt for this job: it is made once the job is paid and released" } };

describe("step B the agent's receipt check (verifyPaidReceipt)", () => {
  before(async () => { receiptConsoleUrl = await listen(receiptConsole); });
  after(async () => { await close(receiptConsole); });
  beforeEach(() => { script.answers = []; script.asked = 0; });

  it("ARCH-613 ARCH-616: a settled receipt signed by the pinned key, over the released result, for this job, amount and transaction is verified", async () => {
    const p = job();
    const r = receiptFor(p.jobId, p.amount, p.result, pinned, TX);
    script.answers = [served(r)];
    assert.deepEqual(await verifyPaidReceipt(check(), receiptConsoleUrl, p), { type: "receipt_verified", jobId: p.jobId, receiptId: r.body.receiptId, keyId: pinned.keyId, settled: true, transaction: TX });
    assert.equal(script.asked, 1);
  });

  it("ARCH-613: the key is pinned: a receipt signed by another key fails even though the console sends that key beside it", async () => {
    const p = job();
    script.answers = [served(receiptFor(p.jobId, p.amount, p.result, other, TX), other.publicKeyPem)];
    assert.deepEqual(await verifyPaidReceipt(check(), receiptConsoleUrl, p), { type: "receipt_failed", jobId: p.jobId, reason: "the receipt was signed by another key" });
  });

  it("ARCH-613: a released result other than the one committed fails (sha256 of the canonical result)", async () => {
    const p = job();
    script.answers = [served(receiptFor(p.jobId, p.amount, { result: { columns: ["n"], rows: [{ n: 4 }] }, served: [] }, pinned, TX))];
    const e = await verifyPaidReceipt(check(), receiptConsoleUrl, p);
    assert.deepEqual(e, { type: "receipt_failed", jobId: p.jobId, reason: "the result is not the one the receipt commits to" });
  });

  it("ARCH-613 ARCH-616: the receipt is bound to what the agent saw itself: the job id, the amount it paid and its transaction", () => {
    const p = job();
    assert.deepEqual(checkReceipt(receiptFor(randomBytes(16).toString("hex"), p.amount, p.result, pinned, TX), check(), p), { ok: false, reason: "the receipt is for another job" });
    assert.deepEqual(checkReceipt(receiptFor(p.jobId, "4000", p.result, pinned, TX), check(), p), { ok: false, reason: "the receipt's amount (4000 units) is not the amount paid (3000 units)" });
    assert.deepEqual(checkReceipt(receiptFor(p.jobId, p.amount, p.result, pinned, "3abcdefghijkmnopqrstuvwxyzABCDEFG"), check(), p), { ok: false, reason: "the receipt's settlement names another transaction than the one the agent paid with" });
    const forged = receiptFor(p.jobId, p.amount, p.result, pinned, TX);
    assert.equal(checkReceipt({ ...forged, body: { ...forged.body, datasetId: "another" } }, check(), p).ok, false, "an edited body no longer verifies");
  });

  it("ARCH-615: the receipt is made just after the release, so the agent asks again until it is there", async () => {
    const p = job();
    script.answers = [notYet, notYet, served(receiptFor(p.jobId, p.amount, p.result, pinned, TX))];
    const e = await verifyPaidReceipt(check(), receiptConsoleUrl, p);
    assert.equal(e.type, "receipt_verified");
    assert.equal(script.asked, 3);
  });

  it("ARCH-616: a receipt without its settlement is asked for again; still none after the last try is verified with settled false", async () => {
    const p = job();
    script.answers = [served(receiptFor(p.jobId, p.amount, p.result, pinned))];
    const e = await verifyPaidReceipt(check({ pollMax: 3 }), receiptConsoleUrl, p);
    assert.deepEqual(e, { type: "receipt_verified", jobId: p.jobId, receiptId: (script.answers[0].body as { receipt: SignedReceipt }).receipt.body.receiptId, keyId: pinned.keyId, settled: false });
    assert.equal(script.asked, 3);
  });

  it("ARCH-615: receipts off on the console stops at the first answer; no receipt after every try is a failure that says so", async () => {
    const p = job();
    script.answers = [{ status: 404, body: { error: "receipts are off: start the console with --receipts on" } }];
    const off = await verifyPaidReceipt(check(), receiptConsoleUrl, p);
    assert.equal(off.type, "receipt_failed");
    assert.match((off as { reason: string }).reason, /^the console has receipts off/);
    assert.equal(script.asked, 1);
    script.asked = 0;
    script.answers = [notYet];
    const none = await verifyPaidReceipt(check({ pollMax: 4 }), receiptConsoleUrl, p);
    assert.match((none as { reason: string }).reason, /^no receipt after 4 tries 1 ms apart \(last: the console answered HTTP 404: no receipt for this job/);
    assert.equal(script.asked, 4);
  });

  it("ARCH-615: an unreachable console is retried and then reported, never thrown", async () => {
    const p = job();
    const e = await verifyPaidReceipt(check({ pollMax: 2 }), "http://127.0.0.1:9", p);
    assert.equal(e.type, "receipt_failed");
    assert.match((e as { reason: string }).reason, /could not be reached at http:\/\/127\.0\.0\.1:9/);
  });

  it("ARCH-613 step B: loadPinnedKey reads an Ed25519 public key PEM and its key id; a missing, non-key or non-Ed25519 file names the path and desk.ps1 -ReceiptKey", () => {
    const f = join(dir, "pub.pem");
    writeFileSync(f, pinned.publicKeyPem);
    assert.deepEqual(loadPinnedKey(f), { publicKeyPem: pinned.publicKeyPem, keyId: pinned.keyId });
    assert.throws(() => loadPinnedKey(join(dir, "missing.pem")), /missing\.pem could not be read \(ENOENT\): export it with \.\\test-console\\desk\.ps1 -ReceiptKey/);
    writeFileSync(f, "not a key");
    assert.throws(() => loadPinnedKey(f), /is not a PEM public key/);
    writeFileSync(f, generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }));
    assert.throws(() => loadPinnedKey(f), /is not an Ed25519 public key/);
  });

  it("ARCH-614 step B: the repository's pinned key (config/receipt-public-key.pem, exported by desk.ps1 -ReceiptKey) is the console's signing key d27d1e9f…", () => {
    assert.equal(loadPinnedKey(join(ROOT, "config", "receipt-public-key.pem")).keyId, "d27d1e9f17a0104e34c46cf3e5233f23");
  });

  it("ARCH-620 step B: prices read as the page shows them (plainUsd)", () => {
    assert.deepEqual(["0.010000", "1.000", "0.003", "2", "0.0105"].map(plainUsd), ["0.01", "1", "0.003", "2", "0.0105"]);
  });
});

// ---- part 2: the whole run ------------------------------------------------------------------------------------------
const TOKEN = "usdc.chainaim-test.testnet";
const PAY_TO = "merchant.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";
const JOBS_KEY = randomBytes(24).toString("hex");
const T01 = "chainaim-buyer-seller.testnet";
const t01Key = KeyPair.fromRandom("ed25519");

/** A Strands model that calls the tool once, then replies with one sentence (as in agent-jobs.test.ts). */
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

const state: { signer: ReceiptSigner; held: Map<string, { amount: string; result: unknown }>; receipts: Map<string, SignedReceipt>; receiptsOn: boolean } =
  { signer: pinned, held: new Map(), receipts: new Map(), receiptsOn: true };
let paywallUrl = "";
const consoleServer: Server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const path = new URL(req.url ?? "/", "http://console").pathname;
  const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
  if (req.method === "POST" && path === "/jobs/crossask") {
    const jobId = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 600_000;
    state.held.set(jobId, { amount: "3000", result: RESULT });
    const reg = await fetch(`${paywallUrl}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-jobs-key": JOBS_KEY }, body: JSON.stringify({ jobId, amount: "3000", expiresAt }) });
    await reg.body?.cancel();
    const q = await fetch(`${paywallUrl}/v1/jobs/${jobId}/release`, { method: "POST" });
    await q.body?.cancel();
    const offer = (JSON.parse(Buffer.from(q.headers.get("payment-required")!, "base64").toString("utf8")) as { accepts: Record<string, string>[] }).accepts[0];
    return send(200, { jobId, totalUsd: "0.003000", amount: "3000", network: offer.network, asset: offer.asset, payTo: offer.payTo, expiresAt, route: "nearai/standin", attested: true });
  }
  const rm = /^\/jobs\/([0-9a-f]{32})\/receipt$/.exec(path);
  if (req.method === "GET" && rm) {
    if (!state.receiptsOn) return send(404, { error: "receipts are off: start the console with --receipts on" });
    const r = state.receipts.get(rm[1]);
    return r ? send(200, { receipt: r, publicKeyPem: state.signer.publicKeyPem }) : send(404, { error: "no receipt for this job: it is made once the job is paid and released" });
  }
  if (req.headers["x-jobs-key"] !== JOBS_KEY) return send(401, { error: "key" });
  const m = /^\/internal\/jobs\/([0-9a-f]{32})(\/released)?$/.exec(path);
  if (m && req.method === "GET" && state.held.has(m[1])) return send(200, { jobId: m[1], result: state.held.get(m[1])!.result });
  if (m && req.method === "POST" && m[2]) {
    // The release notice: receipt of the released result, then the settlement from the notice (receiptOnRelease).
    const notice = JSON.parse(body) as { transaction: string };
    const h = state.held.get(m[1])!;
    state.receipts.set(m[1], receiptFor(m[1], h.amount, h.result, state.signer, notice.transaction));
    return send(200, {});
  }
  send(404, { error: "not found" });
});

const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
const gateway = stubGateway();
const relayerKey = KeyPair.fromRandom("ed25519");
let paywall: { url: string; close: () => Promise<void> };
let consoleUrl = "";
let tenants: AgentTenant[] = [];

describe("step B in the agent run: released -> receipt_verified -> done", () => {
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
    state.receiptsOn = true;
  });

  const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
    tenants: new Map(tenants.map((t) => [t.id, t])), console: consoleUrl, paywall: paywall.url, promptMask: false,
    makeModel: () => new ScriptedModel(), maxTurns: 6, queue: new AccountQueue(), tenantLabel: "the user's organisation", receiptCheck: check({ pollMs: 50, pollMax: 20 }), ...over,
  });
  const req: RunRequest = { tenant: "t01", folder: "/data/orders", question: "How many orders?", phrase: "none" };
  async function run(d: RunDeps): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    await runAgentJob(req, d, (e) => events.push(e), new AbortController().signal);
    return events;
  }

  it("ARCH-613 ARCH-615 ARCH-616: after a paid release the agent fetches the receipt and verifies it with the pinned key: signature, settlement, result, job, amount, transaction", async () => {
    const events = await run(deps());
    assert.deepEqual(events.map((e) => e.type), ["masked", "tool_called", "job_ran", "quoted", "signed", "settled", "released", "receipt_verified", "done"]);
    const settled = events.find((e) => e.type === "settled") as Extract<AgentEvent, { type: "settled" }>;
    const v = events.find((e) => e.type === "receipt_verified") as Extract<AgentEvent, { type: "receipt_verified" }>;
    assert.equal(v.keyId, pinned.keyId);
    assert.equal(v.settled, true);
    assert.equal(v.transaction, settled.transaction, "the receipt's settlement is the transaction the agent paid with");
    assert.equal(v.jobId, (events.find((e) => e.type === "quoted") as { jobId: string }).jobId);
    assert.deepEqual(double.state.transfers.map((t) => [t.sender, t.amount]), [[T01, 3000n]]);
  });

  it("ARCH-613: a console signing with another key than the pinned one: receipt_failed with the reason, and the run still ends done (the payment stands)", async () => {
    state.signer = other;
    const events = await run(deps());
    assert.deepEqual(events.map((e) => e.type).slice(-3), ["released", "receipt_failed", "done"]);
    assert.equal((events.at(-2) as { reason: string }).reason, "the receipt was signed by another key");
    assert.equal(double.state.transfers.length, 1, "paid once");
  });

  it("ARCH-615: receipts off on the console: receipt_failed says so at once; without a receipt check (--receipt-verify off) there is no receipt step", async () => {
    state.receiptsOn = false;
    const started = Date.now();
    const off = await run(deps());
    assert.match((off.at(-2) as { reason: string }).reason, /^the console has receipts off/);
    assert.ok(Date.now() - started < 5000, "no polling when the console says receipts are off");
    const none = await run(deps({ receiptCheck: undefined }));
    assert.deepEqual(none.map((e) => e.type).slice(-2), ["released", "done"]);
  });
});
