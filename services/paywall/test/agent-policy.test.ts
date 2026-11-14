/**
 * Agent spending policy in the tab 03 agent run (privateAI-design-32 ARCH-620), on loopback with real code: the real
 * paywall in-process (startNearPaywall, NEAR rail, PAID_JOBS=on), the NEAR JSON-RPC protocol double that checks every
 * ed25519 signature and runs the ft_transfer, the real tenant files (rig/tenants, their "policy" blocks) with
 * throwaway keys, the real SpendLedger on a temporary folder, and runAgentJob with a scripted Strands model.
 *
 * The console is a small loopback stand-in that does exactly the console's part of the protocol and nothing else: on
 * POST /jobs/crossask it registers {jobId, amount, expiresAt} with the real paywall (POST /internal/jobs, then the 402
 * quote, as test-console/console/jobs.ts registerJob does) and answers the quote with route / attested as the console does; on its
 * internal routes it hands the paywall the held result and takes the release notice. Each test sets the price, the
 * attested flag and, for one test, a registered amount above the quote. The real console's quote fields are covered
 * by scripts/test/console-paid-jobs.test.ts.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from "@strands-agents/sdk";
import { SpendLedger } from "../../../packages/agent-policy/src/index.ts";
import {
  AccountQueue, JOBS_TOOL_NAME, loadAgentTenants, loadPolicies, policyViews, runAgentJob, SetupError,
  type AgentEvent, type AgentPolicy, type AgentTenant, type RunDeps, type RunRequest,
} from "../scripts/agent-jobs-core.ts";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { close, listen, stubGateway } from "./stubs.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TENANTS = join(ROOT, "rig", "tenants");
const TOKEN = "usdc.chainaim-test.testnet";
const PAY_TO = "merchant.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";
const JOBS_KEY = randomBytes(24).toString("hex");
const keys = { t01: KeyPair.fromRandom("ed25519"), t02: KeyPair.fromRandom("ed25519"), t03: KeyPair.fromRandom("ed25519") };
const ACCOUNTS = { t01: "chainaim-buyer-seller.testnet", t02: "chainaim-t02-seller.testnet", t03: "chainaim-t03-seller.testnet" } as const;

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

// ---- the console's part of the protocol, on loopback --------------------------------------------------------------
/** Registers a job with the paywall and reads its NEAR offer from the 402, the two calls the console's registerJob makes. */
async function register(job: { jobId: string; amount: string; expiresAt: number }): Promise<{ network: string; asset: string; payTo: string }> {
  const r = await fetch(`${paywallUrl}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-jobs-key": JOBS_KEY }, body: JSON.stringify(job) });
  await r.body?.cancel();
  if (r.status !== 201) throw new Error(`the paywall refused the job (HTTP ${r.status})`);
  const q = await fetch(`${paywallUrl}/v1/jobs/${job.jobId}/release`, { method: "POST" });
  await q.body?.cancel();
  const header = q.headers.get("payment-required");
  if (q.status !== 402 || !header) throw new Error(`the paywall did not quote the job (HTTP ${q.status})`);
  const offer = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts: Record<string, string>[] }).accepts[0];
  return { network: offer.network, asset: offer.asset, payTo: offer.payTo };
}
type Next = { totalUsd: string; amount: string; registerAmount?: string; attested: boolean };
const consoleState: { next: Next; held: Map<string, unknown>; released: string[] } = { next: { totalUsd: "0.003000", amount: "3000", attested: true }, held: new Map(), released: [] };
let paywallUrl = "";
const consoleServer: Server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const path = new URL(req.url ?? "/", "http://console").pathname;
  const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
  if (req.method === "POST" && path === "/jobs/crossask") {
    const n = consoleState.next;
    const jobId = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 600_000;
    consoleState.held.set(jobId, { result: { columns: ["n"], rows: [{ n: 3 }] }, served: [] });
    try {
      const offer = await register({ jobId, amount: n.registerAmount ?? n.amount, expiresAt });
      return send(200, { jobId, totalUsd: n.totalUsd, amount: n.amount, network: offer.network, asset: offer.asset, payTo: offer.payTo, expiresAt, route: "nearai/standin", attested: n.attested });
    } catch (e) {
      return send(502, { error: (e as Error).message });
    }
  }
  if (req.headers["x-jobs-key"] !== JOBS_KEY) return send(401, { error: "key" });
  const m = /^\/internal\/jobs\/([0-9a-f]{32})(\/released)?$/.exec(path);
  if (m && req.method === "GET" && consoleState.held.has(m[1])) return send(200, { jobId: m[1], result: consoleState.held.get(m[1]) });
  if (m && req.method === "POST" && m[2]) { consoleState.released.push(m[1]); return send(200, {}); }
  send(404, { error: "not found" });
});

const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
const gateway = stubGateway();
const relayerKey = KeyPair.fromRandom("ed25519");
const dir = mkdtempSync(join(tmpdir(), "agent-policy-"));
let paywall: { url: string; close: () => Promise<void> };
let consoleUrl = "";
let tenants: AgentTenant[] = [];
let spendDir = "";

before(async () => {
  const rpcUrl = await listen(double.server);
  consoleUrl = await listen(consoleServer);
  addAccount(double.state, RELAYER, relayerKey.getPublicKey().toString());
  addAccount(double.state, PAY_TO);
  for (const id of ["t01", "t02", "t03"] as const) addAccount(double.state, ACCOUNTS[id], keys[id].getPublicKey().toString());
  const env = {
    NEAR_NETWORK: "testnet", NEAR_RPC_URL_TESTNET: rpcUrl, NEAR_USDC_CONTRACT_TESTNET: TOKEN,
    NEAR_BUYER_KEY_TESTNET: keys.t01.toString(), NEAR_T02_KEY_TESTNET: keys.t02.toString(), NEAR_T03_KEY_TESTNET: keys.t03.toString(),
  };
  tenants = loadAgentTenants(TENANTS, ["t01", "t02", "t03"], env);
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
  for (const a of Object.values(ACCOUNTS)) { t.registered.add(a); t.balances.set(a, 1_000_000n); }
  double.state.transfers.length = 0;
  consoleState.next = { totalUsd: "0.003000", amount: "3000", attested: true };
  spendDir = mkdtempSync(join(dir, "spend-"));
});

const policyOf = (): AgentPolicy => ({ policies: loadPolicies(TENANTS, ["t01", "t02", "t03"]), ledger: new SpendLedger(spendDir) });
function deps(over: Partial<RunDeps> = {}, logs: string[] = []): RunDeps {
  return {
    tenants: new Map(tenants.map((t) => [t.id, t])), console: consoleUrl, paywall: paywall.url, promptMask: false,
    makeModel: () => new ScriptedModel(), maxTurns: 6, queue: new AccountQueue(), tenantLabel: "the user's organisation", log: (l) => logs.push(l), policy: policyOf(), ...over,
  };
}
const request0 = (tenant: string): RunRequest => ({ tenant, folder: "/data/orders", question: "How many orders?", phrase: "none" });
async function run(req: RunRequest, d: RunDeps): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await runAgentJob(req, d, (e) => events.push(e), new AbortController().signal);
  return events;
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const policyStep = (events: AgentEvent[]) => events.find((e) => e.type === "policy") as Extract<AgentEvent, { type: "policy" }> | undefined;
const ledgerLines = (tenant: string) => {
  const f = join(spendDir, tenant, `spend-${new Date().toISOString().slice(0, 10)}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>) : [];
};

describe("ARCH-620 the tenant's policy between quoted and signed", () => {
  it("ARCH-620: within t01's policy the agent pays: quoted -> policy (pay, every check passed) -> signed -> settled; the ledger records the settled payment", async () => {
    const events = await run(request0("t01"), deps());
    assert.deepEqual(types(events), ["masked", "tool_called", "job_ran", "quoted", "policy", "signed", "settled", "released", "done"]);
    const p = policyStep(events)!;
    assert.equal(p.decision, "pay");
    assert.equal(p.tenant, "t01");
    assert.deepEqual(p.checks.map((c) => [c.check, c.limit, c.value, c.ok]).slice(1), [
      ["attested_route", "required", "attested", true], ["max_per_job", "0.05", "0.003", true], ["daily_cap", "1", "0.003", true], ["auto_approve", "0.05", "0.003", true],
    ]);
    assert.equal(p.spentTodayUsd, "0");
    assert.deepEqual(double.state.transfers.map((t) => [t.sender, t.amount]), [[ACCOUNTS.t01, 3000n]]);
    const settled = events.find((e) => e.type === "settled") as Extract<AgentEvent, { type: "settled" }>;
    const jobId = (events.find((e) => e.type === "quoted") as Extract<AgentEvent, { type: "quoted" }>).jobId;
    assert.deepEqual(ledgerLines("t01").map((l) => [l.jobId, l.amountMicro, l.transaction]), [[jobId, "3000", settled.transaction]]);
    assert.deepEqual(Object.keys(ledgerLines("t01")[0]).sort(), ["amountMicro", "jobId", "transaction", "ts"], "ids and amounts only");
  });

  it("ARCH-620: above t03's 0.005 per job a 0.01 job is refused by the policy: nothing signed, nothing transferred, nothing recorded", async () => {
    consoleState.next = { totalUsd: "0.010000", amount: "10000", attested: false };
    const logs: string[] = [];
    const events = await run(request0("t03"), deps({}, logs));
    assert.deepEqual(types(events), ["masked", "tool_called", "job_ran", "quoted", "policy", "refused"]);
    const p = policyStep(events)!;
    assert.equal(p.decision, "refuse");
    assert.deepEqual(p.checks.filter((c) => !c.ok).map((c) => [c.check, c.limit, c.value]), [["max_per_job", "0.005", "0.01"], ["auto_approve", "0.005", "0.01"]], "plain decimals, as the page shows prices (owner run: raw 0.010000)");
    assert.equal(p.checks.some((c) => c.check === "attested_route"), false, "t03 does not require the attested route");
    const refused = events.at(-1) as Extract<AgentEvent, { type: "refused" }>;
    assert.match(refused.reason, /^refused by t03's spending policy: .*above maxPerJobUsd 0\.005.*nothing was signed or paid$/);
    assert.ok(refused.reason.includes("0.01 USD") && !refused.reason.includes("0.010000"), "the quote reads 0.01, not the raw 0.010000");
    assert.deepEqual(double.state.transfers, []);
    assert.deepEqual(ledgerLines("t03"), []);
    assert.match(logs.at(-1)!, /"tenant":"t03",.*"status":"refused"/);
  });

  it("ARCH-620: t01 requires the attested route: a job the console does not report as attested is refused before signing", async () => {
    consoleState.next = { totalUsd: "0.003000", amount: "3000", attested: false };
    const events = await run(request0("t01"), deps());
    assert.deepEqual(types(events).slice(-2), ["policy", "refused"]);
    assert.deepEqual(policyStep(events)!.checks.find((c) => c.check === "attested_route"), { check: "attested_route", limit: "required", value: "not attested", ok: false });
    assert.match((events.at(-1) as { reason: string }).reason, /requires the attested route/);
    assert.deepEqual(double.state.transfers, []);
  });

  it("ARCH-620: the daily cap counts today's settled spend from the ledger: t01 with 0.995 spent cannot pay 0.01", async () => {
    new SpendLedger(spendDir).record("t01", "f".repeat(32), "0.995", "earlier-tx");
    consoleState.next = { totalUsd: "0.010000", amount: "10000", attested: true };
    const events = await run(request0("t01"), deps());
    const p = policyStep(events)!;
    assert.equal(p.spentTodayUsd, "0.995");
    assert.deepEqual(p.checks.find((c) => c.check === "daily_cap"), { check: "daily_cap", limit: "1", value: "1.005", ok: false });
    assert.match((events.at(-1) as { reason: string }).reason, /daily cap would be exceeded \(0\.005 USD left today\)/);
    assert.deepEqual(double.state.transfers, []);
  });

  it("ARCH-620: two runs of one tenant at once cannot both pass the cap: the check, payment and ledger entry share the tenant's queue slot", async () => {
    new SpendLedger(spendDir).record("t01", "e".repeat(32), "0.985", "earlier-tx");
    consoleState.next = { totalUsd: "0.010000", amount: "10000", attested: true };
    const d = deps();
    const [a, b] = await Promise.all([run(request0("t01"), d), run(request0("t01"), d)]);
    const ends = [a, b].map((e) => e.at(-1)!.type).sort();
    assert.deepEqual(ends, ["done", "refused"]);
    assert.equal(double.state.transfers.length, 1);
    assert.equal(ledgerLines("t01").length, 2, "the earlier entry and one new one");
  });

  it("ARCH-620: above auto-approve with counters on in the policy, the decision is a counter-offer; with the agent's --counter off (the default) the run stops and says so (privateAI-design-43: on is agent-counter.test.ts)", async () => {
    consoleState.next = { totalUsd: "0.100000", amount: "100000", attested: true };
    const events = await run(request0("t02"), deps());
    assert.equal(policyStep(events)!.decision, "counter");
    // t02's auto-approve is 0.01 since the owner's 2026-11-14 decision (privateAI-design-43 §6).
    assert.match((events.at(-1) as { reason: string }).reason, /t02's spending policy would ask for a smaller job at 0\.01 USD .*counter-offers are off on this agent \(--counter off\), so nothing was signed or paid/);
    assert.deepEqual(double.state.transfers, []);
  });

  it("ARCH-620: the signer is capped at the price the policy approved: a paywall asking more than the quote is refused, nothing signed", async () => {
    consoleState.next = { totalUsd: "0.003000", amount: "3000", registerAmount: "4000", attested: true };
    const events = await run(request0("t01"), deps());
    assert.equal(policyStep(events)!.decision, "pay");
    assert.equal(events.some((e) => e.type === "signed"), false);
    assert.equal(events.at(-1)!.type, "refused");
    assert.match((events.at(-1) as { reason: string }).reason, /above the most this buyer may pay now \(0\.003000 USDC\)/);
    assert.deepEqual(double.state.transfers, []);
    assert.deepEqual(ledgerLines("t01"), []);
  });

  it("ARCH-620: an unreadable ledger refuses (fail closed) before anything is signed", async () => {
    mkdirSync(join(spendDir, "t01"), { recursive: true });
    writeFileSync(join(spendDir, "t01", `spend-${new Date().toISOString().slice(0, 10)}.jsonl`), "not json\n");
    const events = await run(request0("t01"), deps());
    assert.deepEqual(types(events).slice(-2), ["quoted", "refused"]);
    assert.match((events.at(-1) as { reason: string }).reason, /the spend ledger could not be read .* line 1 is not JSON/);
    assert.deepEqual(double.state.transfers, []);
  });

  it("ARCH-620: without a policy (--agent-policy off) there is no policy step and the run is as before", async () => {
    const events = await run(request0("t03"), deps({ policy: undefined }));
    assert.deepEqual(types(events), ["masked", "tool_called", "job_ran", "quoted", "signed", "settled", "released", "done"]);
  });
});

describe("ARCH-620 policies from tenant.json", () => {
  it("ARCH-620: the owner's values load from rig/tenants (t01 0.05 a job and 1.00 a day; t03 0.005 a job, no counter-offers)", () => {
    const views = policyViews(tenants.filter((t) => t.id !== "t02"), policyOf());
    assert.deepEqual(views, [
      { id: "t01", autoApproveMaxUsd: "0.05", maxPerJobUsd: "0.05", dailyCapUsd: "1", requireAttestedRoute: true, counter: true, spentTodayUsd: "0" },
      { id: "t03", autoApproveMaxUsd: "0.005", maxPerJobUsd: "0.005", dailyCapUsd: "2", requireAttestedRoute: false, counter: false, spentTodayUsd: "0" },
    ]);
  });

  it("ARCH-620: a tenant without a valid policy block stops start-up, naming the tenant and the field", () => {
    const d = mkdtempSync(join(dir, "tenants-"));
    mkdirSync(join(d, "t09"));
    writeFileSync(join(d, "t09", "tenant.json"), JSON.stringify({ id: "t09", name: "x" }));
    assert.throws(() => loadPolicies(d, ["t09"]), (e: Error) => e instanceof SetupError && /tenant t09: tenant.json has no "policy" block/.test(e.message));
    writeFileSync(join(d, "t09", "tenant.json"), JSON.stringify({ id: "t09", policy: { autoApproveMaxUsd: "0.10", maxPerJobUsd: "0.05", dailyCapUsd: "1", requireAttestedRoute: false } }));
    assert.throws(() => loadPolicies(d, ["t09"]), /tenant t09: policy.autoApproveMaxUsd must not exceed maxPerJobUsd/);
    assert.throws(() => loadPolicies(d, ["t10"]), /tenant t10: t10\/tenant.json could not be read \(ENOENT\)/);
  });
});
