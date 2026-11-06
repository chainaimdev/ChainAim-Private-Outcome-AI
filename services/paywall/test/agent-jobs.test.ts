/**
 * Tab 03 agent mode (architecture-tab03-agent-mode.md ARCH-302 to ARCH-306, ARCH-310, ARCH-311), on loopback with real
 * code: the real console (test-console/console/server.ts --paid-jobs on) and the real analyst (services/analyst) as
 * processes, the real paywall in-process (startNearPaywall: createPaywall with the NEAR rail and PAID_JOBS=on, its own
 * relayer key generated for this run), the NEAR JSON-RPC protocol double that checks every ed25519 signature and runs the
 * ft_transfer (as ARCH-108), the real tenant files (rig/tenants) with throwaway keys, and a Presidio stand-in like the
 * prompt-scan tests'. Bedrock is replaced by a scripted Strands model that records every message it is handed, so the
 * tests can check what a real model would have seen. The job is a user-typed query with no worded answer, so no
 * language model runs inside the job: its price is the configured fees only. Nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from "@strands-agents/sdk";
import { REQUIRED_PRESIDIO_ENTITIES } from "../../gateway/src/privacy/entities.ts";
import {
  AccountQueue, JOBS_TOOL_NAME, loadAgentTenants, parseRunRequest, publicTenants, refuseRelayerKey, runAgentJob, SetupError, sseFrame,
  type AgentEvent, type AgentTenant, type RunDeps, type RunRequest,
} from "../scripts/agent-jobs-core.ts";
import { presidioClient, PromptScan } from "../scripts/prompt-scan.ts";
import { addAccount, nearRpcDouble, startNearPaywall } from "./near-rpc-double.ts";
import { close, listen, stubGateway } from "./stubs.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TENANTS = join(ROOT, "rig", "tenants");
const CONSOLE = join(ROOT, "test-console", "console", "server.ts");
const ANALYST = join(ROOT, "services", "analyst", "src", "main.ts");
const AGENT = join(ROOT, "services", "paywall", "scripts", "agent-jobs.ts");
const TOKEN = "usdc.chainaim-test.testnet";
const PAY_TO = "merchant.chainaim-test.testnet";
const RELAYER = "relayer.chainaim-test.testnet";
const JOBS_KEY = randomBytes(24).toString("hex");
const MARKER = "Zqxagentmarker";
const FEES = { "fee-per-model-call-usd": "0.001", "fee-analyst-usd": "0.002", "near-gas-fee-usd": "0.0005", "margin-pct": "20", "min-price-usd": "0.001" };
/** (0.002 + 0.0005) x 1.2: the fees-only price of a job with no model call, in USDC and in base units (6 decimals). */
const PRICE_USD = "0.003000";
const PRICE_UNITS = 3000n;
const COUNT_SQL = "SELECT count(*) AS n FROM orders";

const keys = { t01: KeyPair.fromRandom("ed25519"), t02: KeyPair.fromRandom("ed25519"), t03: KeyPair.fromRandom("ed25519") };
const ACCOUNTS = { t01: "chainaim-buyer-seller.testnet", t02: "chainaim-t02-seller.testnet", t03: "chainaim-t03-seller.testnet" } as const;
const SECRET_VALUES = Object.values(keys).map((k) => k.toString());

const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });

type Proc = { child: ChildProcess; out: () => string };
function start(args: string[], ready: (out: string) => boolean, env: Record<string, string> = {}, what = "process"): Promise<Proc> {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not start: ${out}`)), 30_000);
    const check = () => { if (ready(out)) { clearTimeout(t); resolve({ child, out: () => out }); } };
    child.stdout!.on("data", check);
    child.stderr!.on("data", check);
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`${what} exited ${code}: ${out}`)); });
  });
}
const stop = (p: Proc | undefined) => new Promise<void>((resolve) => { if (!p || p.child.exitCode !== null) return resolve(); p.child.once("exit", () => resolve()); p.child.kill(); });

/** One plain request, no keep-alive (a pooled socket still closing at exit can crash Node on Windows). */
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A Presidio analyzer stand-in, as in prompt-scan.test.ts: a fixed table of values, switchable to fail (HTTP 500). */
const PRESIDIO_TABLE: readonly [string, string][] = [["Ravi Kumar", "PERSON"], ["Jane Roe", "PERSON"], ["jane.roe@example.com", "EMAIL_ADDRESS"], ["991122", "MEDICAL_RECORD"], ["12-3456-7890123-00", "BANK_ACCOUNT"], ["SAMPLEPERSON", "PERSON"], ["Rosewood", "STREET_ADDRESS"], ["14/03/1981", "DATE_OF_BIRTH"], ["<C_PERSON_1>", "PERSON"]];
function presidioStandIn(): { server: Server; state: { failing: boolean; analyzed: number } } {
  const state = { failing: false, analyzed: 0 };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    const path = new URL(req.url ?? "/", "http://presidio.local").pathname;
    if (path === "/health") return res.end("{}");
    if (path === "/supportedentities") return res.end(JSON.stringify(REQUIRED_PRESIDIO_ENTITIES));
    if (path !== "/analyze") { res.statusCode = 404; return res.end("{}"); }
    state.analyzed++;
    if (state.failing) { res.statusCode = 500; return res.end("{}"); }
    const text = String(JSON.parse(body).text);
    const out: { entity_type: string; start: number; end: number; score: number }[] = [];
    for (const [value, type] of PRESIDIO_TABLE) for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + 1)) out.push({ entity_type: type, start: i, end: i + value.length, score: 0.85 });
    res.end(JSON.stringify(out));
  });
  return { server, state };
}

/** A Strands model that calls the tool once with the question it was given, then replies with one sentence. Every message list it is handed is kept. */
class ScriptedModel extends Model<BaseModelConfig> {
  readonly seen: Message[][] = [];
  private config: BaseModelConfig = { modelId: "scripted" };
  private readonly callTool: boolean;
  constructor(callTool = true) { super(); this.callTool = callTool; }
  updateConfig(c: BaseModelConfig): void { this.config = { ...this.config, ...c }; }
  getConfig(): BaseModelConfig { return this.config; }
  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.seen.push(structuredClone(messages));
    yield { type: "modelMessageStartEvent", role: "assistant" };
    if (this.callTool && this.seen.length === 1) {
      const question = JSON.stringify(messages[0]?.content ?? "").slice(0, 200);
      yield { type: "modelContentBlockStartEvent", start: { type: "toolUseStart", name: JOBS_TOOL_NAME, toolUseId: "call-0" } };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "toolUseInputDelta", input: JSON.stringify({ question }) } };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
      return;
    }
    yield { type: "modelContentBlockStartEvent" };
    yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: "It was paid and the result is shown on the page." } };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

// ---- the stack ----------------------------------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "agent-jobs-"));
const data = join(dir, "data");
mkdirSync(data);
writeFileSync(join(data, "orders.csv"), `order_id,customer,amount\n1,${MARKER} One,10.50\n2,${MARKER} Two,20.25\n3,Third,5.00\n`);
writeFileSync(join(dir, "data-sources.json"), JSON.stringify({ allowedRoots: [data], defaultFolder: data, defaultMode: "whole", extensions: [".csv"], maxBytes: { "*": 2_000_000 }, exclude: [], maxFiles: 20, hideFolders: ["_*"] }));
writeFileSync(join(dir, "catalog.json"), JSON.stringify({ models: [] }));

const double = nearRpcDouble({ tokenId: TOKEN, decimals: 6 });
const gateway = stubGateway();
const presidio = presidioStandIn();
const relayerKey = KeyPair.fromRandom("ed25519");
const paywallLogs: string[] = [];
let rpcUrl = "";
let presidioUrl = "";
let paywall: { url: string; close: () => Promise<void> };
let analyst: Proc;
let consoleProc: Proc;
let consolePort = 0;
let env: Record<string, string> = {};
let tenants: AgentTenant[] = [];

before(async () => {
  rpcUrl = await listen(double.server);
  presidioUrl = await listen(presidio.server);
  addAccount(double.state, RELAYER, relayerKey.getPublicKey().toString());
  addAccount(double.state, PAY_TO);
  for (const id of ["t01", "t02", "t03"] as const) addAccount(double.state, ACCOUNTS[id], keys[id].getPublicKey().toString());
  env = {
    NEAR_NETWORK: "testnet", NEAR_RPC_URL_TESTNET: rpcUrl, NEAR_USDC_CONTRACT_TESTNET: TOKEN,
    NEAR_BUYER_KEY_TESTNET: keys.t01.toString(), NEAR_T02_KEY_TESTNET: keys.t02.toString(), NEAR_T03_KEY_TESTNET: keys.t03.toString(),
  };
  tenants = loadAgentTenants(TENANTS, ["t01", "t02", "t03"], env);
  const internalPort = await freePort();
  paywall = await startNearPaywall({
    PAY_RAILS: "near", NEAR_PAY_TO_TESTNET: PAY_TO, NEAR_USDC_CONTRACT_TESTNET: TOKEN, NEAR_USDC_DECIMALS_TESTNET: "6", NEAR_RPC_URL_TESTNET: rpcUrl,
    NEAR_RELAYER_ACCOUNT_TESTNET: RELAYER, NEAR_RELAYER_KEY_TESTNET: relayerKey.toString(), GATEWAY_URL: await listen(gateway.server), CHAINAIM_GATEWAY_KEY: "test-gateway-key",
    PAID_JOBS: "on", PAID_JOBS_KEY: JOBS_KEY, PAID_JOBS_RESULT_URL: `http://127.0.0.1:${internalPort}`, PAID_JOBS_TTL_SEC: "900",
  }, (line) => paywallLogs.push(line));
  const analystPort = await freePort();
  analyst = await start([ANALYST, "--port", String(analystPort), "--data-config", join(dir, "data-sources.json"), "--work-dir", join(dir, "work")], (o) => o.includes(String(analystPort)), {}, "the analyst");
  consolePort = await freePort();
  const flags: Record<string, string> = {
    port: String(consolePort), gateway: "http://127.0.0.1:9", paywall: paywall.url, analyst: `http://127.0.0.1:${analystPort}`, "data-config": join(dir, "data-sources.json"),
    "paid-jobs": "on", "near-wallet": "intear-wallet", "jobs-internal-port": String(internalPort), "pricing-catalog": join(dir, "catalog.json"), "default-model": "local/standin", "run-log": "off", ...FEES,
  };
  consoleProc = await start([CONSOLE, ...Object.entries(flags).map(([k, v]) => `--${k}=${v}`)], (o) => o.includes("internal listener"), { PAID_JOBS_KEY: JOBS_KEY }, "the console");
});
after(async () => {
  await stop(consoleProc);
  await stop(analyst);
  await paywall?.close();
  await close(double.server);
  await close(gateway.server);
  await close(presidio.server);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  const t = double.state.token;
  t.registered.clear();
  t.registered.add(PAY_TO);
  t.balances.clear();
  for (const a of Object.values(ACCOUNTS)) { t.registered.add(a); t.balances.set(a, 1_000_000n); }
  double.state.transfers.length = 0;
  double.state.failNextTransfer = undefined;
  presidio.state.failing = false;
});

const scan = () => new PromptScan({ scanner: "both", names: true, residual: true, presidio: presidioClient({ url: presidioUrl, threshold: 0.4, timeoutMs: 2000, extraEntities: "default" }) });
function deps(model: ScriptedModel, over: Partial<RunDeps> = {}, logs: string[] = []): RunDeps {
  return {
    tenants: new Map(tenants.map((t) => [t.id, t])), console: `http://127.0.0.1:${consolePort}`, paywall: paywall.url, scan: scan(), promptMask: true,
    makeModel: () => model, maxTurns: 6, queue: new AccountQueue(), tenantLabel: "the user's organisation", log: (l) => logs.push(l), ...over,
  };
}
const request0 = (over: Partial<RunRequest> = {}): RunRequest => ({ tenant: "t02", folder: data, question: "How many orders are there?", phrase: "none", sql: COUNT_SQL, ...over });
async function run(req: RunRequest, d: RunDeps, signal = new AbortController().signal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await runAgentJob(req, d, (e) => events.push(e), signal);
  return events;
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const find = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) => events.find((e) => e.type === type) as Extract<AgentEvent, { type: T }> | undefined;

describe("ARCH-302 tenants and keys", () => {
  it("ARCH-302: three tenants load from the real tenant files with throwaway keys; /tenants shows ids, names and accounts only", () => {
    assert.deepEqual(tenants.map((t) => [t.id, t.accountId, t.keyVariable]), [["t01", ACCOUNTS.t01, "NEAR_BUYER_KEY_TESTNET"], ["t02", ACCOUNTS.t02, "NEAR_T02_KEY_TESTNET"], ["t03", ACCOUNTS.t03, "NEAR_T03_KEY_TESTNET"]]);
    const shown = publicTenants(tenants);
    for (const t of shown) assert.deepEqual(Object.keys(t).sort(), ["accountId", "id", "name"]);
    const text = JSON.stringify(shown);
    for (const v of SECRET_VALUES) assert.equal(text.includes(v), false, "no key in /tenants");
    for (const t of tenants) assert.equal(t.buyer.signer.publicKey, keys[t.id as keyof typeof keys].getPublicKey().toString(), "each payer signs with its own tenant's key");
  });

  it("ARCH-302: a missing key stops start-up naming the tenant and the variable, never a value", () => {
    const { NEAR_T02_KEY_TESTNET: _gone, ...without } = env;
    assert.throws(() => loadAgentTenants(TENANTS, ["t01", "t02"], without), (e: Error) => e instanceof SetupError && /^tenant t02: NEAR_T02_KEY_TESTNET is required/.test(e.message) && SECRET_VALUES.every((v) => !e.message.includes(v)));
    assert.throws(() => loadAgentTenants(TENANTS, ["t09"], env), /no tenant folder for t09/);
    assert.throws(() => loadAgentTenants(TENANTS, [], env), /--agent-tenants must name at least one tenant/);
    assert.throws(() => loadAgentTenants(TENANTS, ["t01"], { ...env, NEAR_BUYER_KEY_TESTNET: "not-a-key" }), (e: Error) => /tenant t01: NEAR_BUYER_KEY_TESTNET is not a NEAR secret key/.test(e.message) && !e.message.includes("not-a-key"));
  });

  it("ARCH-302: the relayer key is refused in the agent's environment, by name", () => {
    assert.throws(() => refuseRelayerKey({ ...env, NEAR_RELAYER_KEY_TESTNET: relayerKey.toString() }), (e: Error) => /NEAR_RELAYER_KEY_TESTNET is in the agent's environment/.test(e.message) && !e.message.includes(relayerKey.toString()));
    assert.doesNotThrow(() => refuseRelayerKey({ ...env, NEAR_RELAYER_KEY_TESTNET: "" }));
  });

  it("ARCH-302 ARCH-310 ARCH-311: the service starts, /healthz and /tenants answer with no key, the log holds no key; a Host not listed gets 403", async () => {
    const port = await freePort();
    const p = await start([AGENT, "--port", String(port), "--prompt-scanner", "client", "--console", "http://127.0.0.1:9", "--paywall", "http://127.0.0.1:9"], (o) => o.includes("run timeout"), env, "the agent service");
    try {
      const health = await call(port, "GET", "/healthz");
      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(health.text), { ok: true, tenants: 3, network: "near:testnet", presidio: "not used (client patterns only)" });
      const listed = JSON.parse((await call(port, "GET", "/tenants")).text);
      assert.deepEqual(listed, { network: "near:testnet", tenants: publicTenants(tenants) });
      assert.equal((await call(port, "GET", "/tenants", { host: `agent:${port}` })).status, 403, "DNS-rebinding guard");
      const bad = await call(port, "POST", "/run", { "content-type": "application/json" }, JSON.stringify({ tenant: "t09", folder: data, question: "q" }));
      assert.equal(bad.status, 400);
      assert.match(JSON.parse(bad.text).error, /tenant must be one of t01, t02, t03/);
      assert.match(p.out(), /keys from NEAR_BUYER_KEY_TESTNET, NEAR_T02_KEY_TESTNET, NEAR_T03_KEY_TESTNET \(values not shown\)/);
      assert.match(p.out(), /auth AWS credential chain/, "the start-up line names the auth, not a value");
      for (const v of SECRET_VALUES) assert.equal(p.out().includes(v), false, "no key in the log");
    } finally { await stop(p); }
  });

  it("ARCH-311: --aws-auth bearer without AWS_BEARER_TOKEN_BEDROCK refuses to start, naming the variable", () => {
    const r = spawnSync(process.execPath, [AGENT, "--aws-auth", "bearer", "--port", "1"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, ...env, AWS_BEARER_TOKEN_BEDROCK: "" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--aws-auth bearer needs the environment variable AWS_BEARER_TOKEN_BEDROCK/);
  });

  it("ARCH-310: without the tenant keys (no env file loaded) the service refuses to start, naming the variable", () => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NEAR_/.test(k))) as Record<string, string>;
    const r = spawnSync(process.execPath, [AGENT, "--port", "1"], { encoding: "utf8", timeout: 20_000, env: clean });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /tenant t01: NEAR_BUYER_KEY_TESTNET is required/);
  });
});

describe("ARCH-303 the question is masked before the agent's model sees it", () => {
  it("ARCH-303: a name is masked before the model call; the masked step carries kinds and counts only", async () => {
    const model = new ScriptedModel();
    const events = await run(request0({ question: "How many orders did Ravi Kumar place?" }), deps(model));
    assert.equal(types(events).at(-1), "done", JSON.stringify(events));
    assert.deepEqual(find(events, "masked"), { type: "masked", counts: { PERSON: 1 } });
    const seen = JSON.stringify(model.seen);
    assert.equal(seen.includes("Ravi Kumar"), false, "the model never saw the name");
    assert.ok(seen.includes("<C_PERSON_1>"), "the model saw the placeholder");
    assert.equal(JSON.stringify(find(events, "masked")).includes("Ravi"), false);
  });

  it("ARCH-303 ARCH-306: Presidio down -> refused, no model call, no job, nothing paid", async () => {
    presidio.state.failing = true;
    const model = new ScriptedModel();
    const logs: string[] = [];
    const events = await run(request0(), deps(model, {}, logs));
    assert.deepEqual(types(events), ["refused"]);
    assert.match(find(events, "refused")!.reason, /Presidio scanner at .+ failed .*nothing was sent/);
    assert.equal(model.seen.length, 0, "no model call");
    assert.equal(double.state.transfers.length, 0);
    assert.match(logs[0], /"route":"agent-run","tenant":"t02","jobId":null,"status":"refused"/);
  });
});

describe("ARCH-304 the tool runs the existing paid job and pays it", () => {
  it("ARCH-304 ARCH-306: quoted -> signed -> settled -> released, paid from the tenant's account by the relayer, steps in order", async () => {
    const model = new ScriptedModel();
    const logs: string[] = [];
    const events = await run(request0(), deps(model, {}, logs));
    assert.deepEqual(types(events), ["masked", "tool_called", "job_ran", "quoted", "signed", "settled", "released", "done"], JSON.stringify(events));
    const quoted = find(events, "quoted")!;
    assert.deepEqual([quoted.totalUsd, quoted.amount, quoted.network, quoted.asset, quoted.payTo], [PRICE_USD, String(PRICE_UNITS), "near:testnet", TOKEN, PAY_TO]);
    assert.deepEqual(find(events, "signed"), { type: "signed", account: ACCOUNTS.t02 });
    assert.deepEqual(double.state.transfers.map((t) => [t.sender, t.receiver, t.amount]), [[ACCOUNTS.t02, PAY_TO, PRICE_UNITS]], "one transfer, the quoted amount, from t02 to the pay-to account");
    assert.equal(find(events, "settled")!.transaction, double.state.transfers[0].txHash);
    const released = find(events, "released")!;
    assert.equal(released.jobId, quoted.jobId);
    assert.equal(released.rows, 1);
    assert.equal(Number((released.result as { result: { rows: { n: unknown }[] } }).result.rows[0].n), 3, "the released result is the job's own");
    assert.match(paywallLogs.join("\n"), /payment_settled/);
    assert.match(logs.at(-1)!, new RegExp(`"route":"agent-run","tenant":"t02","jobId":"${quoted.jobId}","status":"done"`));
  });

  it("ARCH-304: --agent-max-amount below the quote -> refused before signing, nothing signed or paid", async () => {
    const events = await run(request0(), deps(new ScriptedModel(), { maxAmount: "0.001" }));
    assert.deepEqual(types(events), ["masked", "tool_called", "job_ran", "quoted", "refused"]);
    assert.match(find(events, "refused")!.reason, /above the most this buyer may pay now \(0\.001 USDC\); nothing was paid/);
    assert.equal(double.state.transfers.length, 0);
  });

  it("ARCH-304: --agent-max-amount unset passes no maximum; at the quote it is paid", async () => {
    const events = await run(request0(), deps(new ScriptedModel(), { maxAmount: PRICE_USD }));
    assert.equal(types(events).at(-1), "done", JSON.stringify(events));
  });

  it("ARCH-304: two runs for one tenant settle in order, one payment at a time", async () => {
    const queue = new AccountQueue();
    const timeline: string[] = [];
    const one = (label: string) => runAgentJob(request0({ tenant: "t01" }), deps(new ScriptedModel(), { queue }), (e) => timeline.push(`${label}:${e.type}`), new AbortController().signal);
    const [a, b] = await Promise.all([one("A"), one("B")]);
    assert.deepEqual([a, b], ["done", "done"], timeline.join(" "));
    assert.equal(double.state.transfers.length, 2);
    assert.ok(double.state.transfers.every((t) => t.sender === ACCOUNTS.t01));
    const signed = timeline.filter((s) => s.endsWith(":signed")).map((s) => s[0]);
    const firstSettled = timeline.indexOf(`${signed[0]}:settled`);
    const secondSigned = timeline.indexOf(`${signed[1]}:signed`);
    assert.ok(firstSettled >= 0 && firstSettled < secondSigned, `the second payment is signed only after the first settled: ${timeline.join(" ")}`);
  });

  it("ARCH-306: a hang-up before signing cancels: nothing signed or paid", async () => {
    const hangUp = new AbortController();
    const events: AgentEvent[] = [];
    await runAgentJob(request0(), deps(new ScriptedModel()), (e) => { events.push(e); if (e.type === "quoted") hangUp.abort(); }, hangUp.signal);
    assert.deepEqual(types(events), ["masked", "tool_called", "job_ran", "quoted", "refused"]);
    assert.match(find(events, "refused")!.reason, /cancelled before the payment was signed; nothing was paid/);
    assert.equal(double.state.transfers.length, 0);
  });

  it("ARCH-306: the release failing after signing -> error (not refused), no result", async () => {
    double.state.failNextTransfer = "Smart contract panicked: injected failure";
    const events = await run(request0(), deps(new ScriptedModel()));
    assert.deepEqual(types(events), ["masked", "tool_called", "job_ran", "quoted", "signed", "error"], JSON.stringify(events));
    assert.match(find(events, "error")!.reason, /refused by the paywall|not released/);
    assert.equal(find(events, "released"), undefined);
  });

  it("ARCH-306: a model that does not call the tool -> error, no job, nothing paid", async () => {
    const events = await run(request0(), deps(new ScriptedModel(false)));
    assert.deepEqual(types(events), ["masked", "error"]);
    assert.match(find(events, "error")!.reason, /did not call the tool, so no job was run and nothing was paid/);
    assert.equal(double.state.transfers.length, 0);
  });
});

describe("ARCH-305 the agent's model never sees the result", () => {
  it("ARCH-305: a marker in the result rows never reaches the model and does reach the released step", async () => {
    const model = new ScriptedModel();
    const events = await run(request0({ question: "Who are the customers?", sql: "SELECT customer FROM orders" }), deps(model));
    assert.equal(types(events).at(-1), "done", JSON.stringify(events));
    assert.ok(JSON.stringify(find(events, "released")).includes(MARKER), "the result goes to the stream");
    assert.equal(JSON.stringify(model.seen).includes(MARKER), false, "never to the model");
    // The tool's reply, wherever the SDK puts it in the last turn's messages (a JSON block, or JSON text).
    const replies: Record<string, unknown>[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string" && v.startsWith("{")) { try { walk(JSON.parse(v)); } catch { /* plain text, not JSON */ } return; }
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        if ((v as Record<string, unknown>).status === "paid") replies.push(v as Record<string, unknown>);
        Object.values(v).forEach(walk);
      }
    };
    walk(model.seen.at(-1));
    assert.equal(replies.length, 1, `the model got the tool's reply once: ${JSON.stringify(model.seen.at(-1)).slice(-600)}`);
    assert.deepEqual(Object.keys(replies[0]).sort(), ["amountUsdc", "rows", "status", "transaction"]);
    assert.deepEqual([replies[0].amountUsdc, replies[0].rows], [PRICE_USD, 3]);
    assert.equal(consoleProc.out().includes(MARKER), false, "nor the console's log");
  });
});

describe("ARCH-306 the stream's frames and request checks", () => {
  it("ARCH-306: one event per frame, the type as the event name", () => {
    assert.equal(sseFrame({ type: "settled", transaction: "TX", network: "near:testnet" }), 'event: settled\ndata: {"transaction":"TX","network":"near:testnet"}\n\n');
    assert.equal(sseFrame({ type: "done" }), "event: done\ndata: {}\n\n");
  });
  it("ARCH-307: the run body has the same checks as /jobs/crossask, plus the tenant", () => {
    const ids = new Set(["t01", "t02"]);
    assert.deepEqual(parseRunRequest({ tenant: "t02", folder: "/d", question: "q" }, ids), { tenant: "t02", folder: "/d", question: "q", phrase: "llm" });
    for (const [body, re] of [
      [{ folder: "/d", question: "q" }, /tenant must be one of t01, t02/],
      [{ tenant: "t02", question: "q" }, /folder and question are required/],
      [{ tenant: "t02", folder: "/d", question: "  " }, /folder and question are required/],
      [{ tenant: "t02", folder: "/d", question: "q", model: "no slash" }, /model must look like provider\/name/],
      [{ tenant: "t02", folder: "/d", question: "q", phrase: "yes" }, /phrase must be llm or none/],
      [[], /JSON object/],
    ] as [unknown, RegExp][]) {
      const r = parseRunRequest(body, ids);
      assert.ok("error" in r && re.test(r.error), JSON.stringify(r));
    }
  });
});
