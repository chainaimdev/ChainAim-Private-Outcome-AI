/**
 * Tab 03 agent mode in the test console (architecture-tab03-agent-mode.md ARCH-301, ARCH-307, ARCH-308, ARCH-309), with
 * real console processes: an api process started with --agent-service (and --paid-jobs on, which it needs) and a ui
 * process in front of it, as up.ps1 runs them. The agent service is a staged event-stream source on loopback that
 * answers GET /tenants and streams POST /run in steps the test releases one at a time, so the tests can see whether
 * each step reaches the client before the next one is sent. The page fragment's script runs in a small stand-in of
 * the browser's DOM and fetch, to see which route each mode posts to. The agent service itself, with the real paywall
 * and payments, is covered by services/paywall/test/agent-jobs.test.ts.
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER = join(ROOT, "test-console/console/server.ts");
const PAGE = join(ROOT, "test-console/console/index.html");
const FRAGMENT = join(ROOT, "test-console/console/paid-jobs.html");
const KEY = readFileSync(join(ROOT, "test-console/local-gateway-key.txt"), "utf8").trim();
const JOBS_KEY = randomBytes(24).toString("hex");
const Q_MARKER = "Zqxquestionmarker";
const R_MARKER = "Zqxresultmarker";
const JOB_ID = "ab".repeat(16);
const FEES = { "fee-per-model-call-usd": "0.001", "fee-analyst-usd": "0.002", "near-gas-fee-usd": "0.0005", "margin-pct": "20", "min-price-usd": "0.001" };
const TENANTS = [{ id: "t01", name: "Jupiter Knitting (synthetic test tenant)", accountId: "chainaim-buyer-seller.testnet" }, { id: "t02", name: "Riverside Clinic (synthetic test tenant)", accountId: "chainaim-t02-seller.testnet" }];
const FRAMES = [
  'event: masked\ndata: {"counts":{}}\n\n',
  "event: tool_called\ndata: {\"tool\":\"chainaim_ask_across_files\"}\n\n",
  `event: job_ran\ndata: {"jobId":"${JOB_ID}","expiresAt":1}\n\n`,
  `event: released\ndata: {"jobId":"${JOB_ID}","rows":1,"calls":0,"result":{"result":{"columns":["who"],"rows":[{"who":"${R_MARKER}"}]}}}\n\n`,
  "event: done\ndata: {}\n\n",
];

const dir = mkdtempSync(join(tmpdir(), "console-agent-"));
const data = join(dir, "data");
mkdirSync(data);
const dataConfig = join(dir, "data-sources.json");
writeFileSync(dataConfig, JSON.stringify({ allowedRoots: [data], defaultFolder: data, defaultMode: "whole", extensions: [".csv"] }));
const catalog = join(dir, "catalog.json");
writeFileSync(catalog, JSON.stringify({ models: [] }));

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });
type Proc = { child: ChildProcess; out: () => string };
function start(args: string[], readyText: string, env: Record<string, string> = {}): Promise<Proc> {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the console did not start: ${out}`)), 20_000);
    const check = () => { if (out.includes(readyText)) { clearTimeout(t); resolve({ child, out: () => out }); } };
    child.stdout!.on("data", check);
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`the console exited ${code}: ${out}`)); });
  });
}
const stop = (p?: Proc) => new Promise<void>((ok) => { if (!p || p.child.exitCode !== null) return ok(); p.child.once("exit", () => ok()); p.child.kill(); });
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host, ...headers } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (d) => (text += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
/** POST /agent/crossask, reading the answer chunk by chunk: `onChunk` sees the text so far each time a chunk arrives. */
function stream(port: number, body: unknown, onChunk: (soFar: string) => void) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/agent/crossask", agent: false, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" } }, (res) => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", (d) => { text += d; onChunk(text); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
const waitFor = async (cond: () => boolean, what: string, ms = 5000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((ok) => setTimeout(ok, 10)); } };

// ---- the staged agent service --------------------------------------------------------------------------------------
type RunSeen = { body: Record<string, unknown>; headers: IncomingHttpHeaders };
const runs: RunSeen[] = [];
let sent = 0;
/** The test releases the next frame with next(); the source never sends a frame before it is released. */
let release: (() => void) | null = null;
const next = () => { const r = release; release = null; r?.(); };
/** What the staged agent's GET /policy answers (ARCH-620); null = 404, as an agent built before the policy. */
let policyAnswer: unknown = null;
const agentSource: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    if (req.method === "GET" && req.url === "/tenants") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ network: "near:testnet", tenants: TENANTS })); return; }
    if (req.method === "GET" && req.url === "/policy" && policyAnswer !== null) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(policyAnswer)); return; }
    if (req.method === "POST" && req.url === "/run") {
      runs.push({ body: JSON.parse(raw), headers: req.headers });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      res.flushHeaders();
      sent = 0;
      for (const frame of FRAMES) {
        await new Promise<void>((ok) => (release = ok));
        res.write(frame);
        sent++;
      }
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
});
let agentUrl = "";
let apiPort = 0, internalPort = 0, uiPort = 0;
let api: Proc, ui: Proc;
const apiArgs = (port: number, iport: number, over: Record<string, string | undefined> = {}) => Object.entries({
  port: String(port), "data-config": dataConfig, gateway: "http://127.0.0.1:9", paywall: "http://127.0.0.1:9", "paid-jobs": "on", "near-wallet": "intear-wallet",
  "jobs-internal-port": String(iport), "pricing-catalog": catalog, "run-log": "off", "default-model": "local/standin", ...FEES, "agent-service": agentUrl, ...over,
}).filter(([, v]) => v !== undefined).map(([k, v]) => `--${k}=${v}`);

before(async () => {
  agentUrl = await new Promise<string>((ok) => agentSource.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(agentSource.address() as AddressInfo).port}`)));
  apiPort = await freePort(); internalPort = await freePort(); uiPort = await freePort();
  api = await start(apiArgs(apiPort, internalPort, { mode: "api" }), "internal listener", { PAID_JOBS_KEY: JOBS_KEY });
  ui = await start(["--mode", "ui", "--port", String(uiPort), "--api", `http://127.0.0.1:${apiPort}`, "--near-wallet", "intear-wallet", "--paid-jobs-page", "on"], "ui mode");
});
after(async () => {
  release = null;
  await stop(ui);
  await stop(api);
  await new Promise<void>((ok) => agentSource.close(() => ok()));
  rmSync(dir, { recursive: true, force: true });
});

const RUN = { folder: data, question: `How many orders did ${Q_MARKER} place?`, phrase: "none", sql: "SELECT count(*) AS n FROM orders", tenant: "t02" };

/** Each frame must reach the client before the source is allowed to send the next one: a buffering relay would never deliver the first. */
async function stepByStep(port: number): Promise<string> {
  let soFar = "";
  const done = stream(port, RUN, (t) => (soFar = t));
  for (let i = 0; i < FRAMES.length; i++) {
    await waitFor(() => release !== null, `the source to wait before frame ${i + 1}`);
    next();
    await waitFor(() => soFar.length === FRAMES.slice(0, i + 1).join("").length, `frame ${i + 1} to reach the client before frame ${i + 2} is sent`);
    assert.equal(sent, i + 1, "the source has not sent the next frame yet");
  }
  const r = await done;
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /^text\/event-stream/);
  return r.text;
}

describe("ARCH-307 console relay (api mode)", () => {
  test("ARCH-307: the run is relayed unchanged and incrementally; the source gets the tab 03 fields and the tenant, and no key", async () => {
    runs.length = 0;
    const text = await stepByStep(apiPort);
    assert.equal(text, FRAMES.join(""), "byte for byte");
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].body, { tenant: "t02", folder: data, question: RUN.question, model: "local/standin", phrase: "none", sql: RUN.sql });
    assert.equal(runs[0].headers.authorization, undefined);
    for (const k of [KEY, JOBS_KEY]) assert.equal(JSON.stringify(runs[0].headers).includes(k), false, "no key reaches the agent service");
  });

  test("ARCH-307: the log line has the tenant, the job id, the last step and the time; never the question or the result", async () => {
    await waitFor(() => api.out().includes('"route":"agent"'), "the relay's log line");
    const line = JSON.parse(api.out().split("\n").find((l) => l.includes('"route":"agent"'))!);
    assert.deepEqual(Object.keys(line).sort(), ["jobId", "ms", "route", "status", "tenant", "ts"]);
    assert.deepEqual([line.tenant, line.jobId, line.status], ["t02", JOB_ID, "done"]);
    for (const leak of [Q_MARKER, R_MARKER]) assert.equal(api.out().includes(leak), false, leak);
  });

  test("ARCH-307: unknown tenant -> 400 and no run; the same body checks as /jobs/crossask", async () => {
    runs.length = 0;
    const post = (body: unknown) => call(apiPort, "POST", "/agent/crossask", { "content-type": "application/json" }, JSON.stringify(body));
    const unknown = await post({ ...RUN, tenant: "t09" });
    assert.equal(unknown.status, 400);
    assert.match(JSON.parse(unknown.text).error, /unknown tenant t09 \(the agent pays for: t01, t02\)/);
    assert.equal((await post({ ...RUN, folder: undefined })).status, 400);
    assert.equal((await post({ ...RUN, model: "not a model" })).status, 400);
    assert.equal((await call(apiPort, "POST", "/agent/crossask", { "content-type": "text/plain" }, "x")).status, 415);
    assert.equal(runs.length, 0, "nothing reached the agent service");
  });

  test("ARCH-307: GET /agent/config lists the agent's tenants; both routes check the Host", async () => {
    const cfg = await call(apiPort, "GET", "/agent/config");
    assert.equal(cfg.status, 200);
    assert.deepEqual(JSON.parse(cfg.text), { network: "near:testnet", tenants: TENANTS });
    assert.equal((await call(apiPort, "GET", "/agent/config", {}, undefined, "evil.example:80")).status, 403);
    assert.equal((await call(apiPort, "POST", "/agent/crossask", { "content-type": "application/json" }, JSON.stringify(RUN), "evil.example:80")).status, 403);
    assert.match(api.out(), new RegExp(`agent mode on: /agent/config and /agent/crossask relayed to ${agentUrl.replace(/[.]/g, "\\.")} \\(up to 330 s per run\\)`));
  });

  test("ARCH-307: a request with Host console-api:<port> is accepted only when that host is listed", async () => {
    const port = await freePort(), iport = await freePort();
    const listed = await start(apiArgs(port, iport, { mode: "api", "allowed-hosts": `127.0.0.1:${port},localhost:${port},console-api:${port}` }), "internal listener", { PAID_JOBS_KEY: JOBS_KEY });
    try {
      assert.equal((await call(port, "GET", "/jobs/config", {}, undefined, `console-api:${port}`)).status, 200);
      assert.equal((await call(port, "GET", "/jobs/config", {}, undefined, `127.0.0.1:${port}`)).status, 200, "the PC's own address still works");
    } finally { await stop(listed); }
    assert.equal((await call(apiPort, "GET", "/jobs/config", {}, undefined, `console-api:${apiPort}`)).status, 403, "not listed: refused (the default)");
  });

  test("ARCH-307: the agent service down -> 503 with a plain reason; nothing run", async () => {
    const port = await freePort(), iport = await freePort();
    const c = await start(apiArgs(port, iport, { "agent-service": "http://127.0.0.1:9" }), "internal listener", { PAID_JOBS_KEY: JOBS_KEY });
    try {
      const r = await call(port, "POST", "/agent/crossask", { "content-type": "application/json" }, JSON.stringify(RUN));
      assert.equal(r.status, 503);
      assert.match(JSON.parse(r.text).error, /the agent service is not answering at http:\/\/127\.0\.0\.1:9.*nothing was run or paid/);
      assert.equal((await call(port, "GET", "/agent/config")).status, 503);
    } finally { await stop(c); }
  });

  test("ARCH-307: --agent-service needs --paid-jobs on, an http(s) URL, and is refused in ui mode", () => {
    const run = (args: string[]) => spawnSync(process.execPath, [SERVER, ...args], { encoding: "utf8", timeout: 20_000, env: { ...process.env, PAID_JOBS_KEY: JOBS_KEY } });
    assert.match(run(["--port", "1", "--agent-service", agentUrl]).stderr, /--agent-service needs --paid-jobs on/);
    assert.match(run(apiArgs(1, 2, { "agent-service": "ftp://x" })).stderr, /--agent-service must be an http\(s\) URL/);
    assert.match(run(["--mode", "ui", "--port", "1", "--api", "http://127.0.0.1:2", "--agent-service", agentUrl]).stderr, /--agent-service belongs to the api process/);
  });
});

describe("ARCH-308 ui streaming pass-through", () => {
  test("ARCH-308: through the ui process, the steps reach the client one by one before the stream ends", async () => {
    runs.length = 0;
    const text = await stepByStep(uiPort);
    assert.equal(text, FRAMES.join(""));
    assert.equal(runs.length, 1);
  });

  test("ARCH-308: every other route is forwarded as before (buffered, byte-identical)", async () => {
    for (const path of ["/jobs/config", "/agent/config", "/data/config"]) {
      const direct = await call(apiPort, "GET", path);
      const viaUi = await call(uiPort, "GET", path);
      assert.deepEqual([viaUi.status, viaUi.text], [direct.status, direct.text], path);
    }
    assert.equal((await call(uiPort, "POST", "/agent/crossask", { "content-type": "application/json" }, JSON.stringify(RUN), "evil.example:80")).status, 403, "the ui's own Host check");
  });
});

describe("ARCH-301 off by default", () => {
  test("ARCH-301: console without --agent-service has no /agent routes and no agent controls", async () => {
    const port = await freePort(), iport = await freePort();
    const c = await start(apiArgs(port, iport, { "agent-service": undefined }), "internal listener", { PAID_JOBS_KEY: JOBS_KEY });
    try {
      assert.equal((await call(port, "GET", "/agent/config")).status, 404);
      assert.equal((await call(port, "POST", "/agent/crossask", { "content-type": "application/json" }, JSON.stringify(RUN))).status, 404);
      assert.equal(c.out().includes("agent mode"), false);
      const page = (await call(port, "GET", "/")).text;
      assert.equal(page.replace(readFileSync(FRAGMENT, "utf8"), ""), readFileSync(PAGE, "utf8"), "the page is index.html plus the pay box, as before");
      const dom = runFragment(404);
      await dom.settle();
      assert.equal(dom.byId("xpayWho").hidden, true, "no Who pays? controls without the agent service");
      dom.byId("xpayNear").checked = true;
      await dom.byId("xpayNear").onchange();
      assert.equal(dom.byId("xpayWho").hidden, true, "still none when the box is ticked");
    } finally { await stop(c); }
  });
});

describe("ARCH-620 the agent's spending policy, relayed read-only", () => {
  const T01 = { id: "t01", autoApproveMaxUsd: "0.05", maxPerJobUsd: "0.05", dailyCapUsd: "1", requireAttestedRoute: true, counter: true, spentTodayUsd: "0.01" };
  test("ARCH-620: GET /agent/policy passes the limits and today's spend field by field; anything else is dropped or named unreadable", async () => {
    policyAnswer = { on: true, tenants: [{ ...T01, extra: "not passed" }, { id: "t02", autoApproveMaxUsd: "lots", maxPerJobUsd: "1", dailyCapUsd: "1", requireAttestedRoute: true, counter: false, spentTodayUsd: "0" }, { id: "t03", error: "x".repeat(300) }, { id: "../bad" }] };
    try {
      const r = await call(apiPort, "GET", "/agent/policy");
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.text), { on: true, tenants: [T01, { id: "t02", error: "the agent's policy answer could not be read" }, { id: "t03", error: "x".repeat(200) }] });
      assert.deepEqual(JSON.parse((await call(uiPort, "GET", "/agent/policy")).text), JSON.parse(r.text), "the ui process forwards it unchanged");
      assert.equal((await call(apiPort, "GET", "/agent/policy", {}, undefined, "evil.example:80")).status, 403);
      policyAnswer = { on: false };
      assert.deepEqual(JSON.parse((await call(apiPort, "GET", "/agent/policy")).text), { on: false, tenants: [] });
      policyAnswer = null;
      const old = await call(apiPort, "GET", "/agent/policy");
      assert.equal(old.status, 503, "an agent without GET /policy");
      assert.match(JSON.parse(old.text).error, /the agent service is not answering/);
    } finally { policyAnswer = null; }
  });
});

// ---- the page fragment's script in a stand-in DOM -----------------------------------------------------------------
type Node0 = { id?: string; tagName?: string; children: unknown[]; hidden: boolean; disabled: boolean; checked: boolean; value: string; textContent: string; className: string; [k: string]: any };
function runFragment(agentConfigStatus: number, initiallyTicked = false, policy?: { answer: unknown; frame: string }, stream?: (text: string) => string, offers?: { mode: string; modes: string[] }) {
  const agentBodies: Record<string, unknown>[] = [];
  const all: Node0[] = [];
  const el = (tag: string): Node0 => {
    const n: Node0 = {
      tagName: tag, children: [], hidden: false, disabled: false, checked: false, textContent: "", className: "",
      get value() { return this._value ?? (this.tagName === "select" ? (this.children[0] as Node0 | undefined)?.value ?? "" : ""); },
      set value(v: string) { this._value = v; },
      append(...c: unknown[]) { this.children.push(...c.map((x) => (typeof x === "string" ? { textContent: x } : x))); },
      replaceChildren(...c: unknown[]) { this.children = []; this.append(...c); },
      after(...c: unknown[]) { all.push(...(c as Node0[])); },
      closest() { return this; },
      get lastChild() { return this.children.at(-1); },
    };
    all.push(n);
    return n;
  };
  const ask = el("button"); ask.id = "xaskGo";
  const out = el("div"); out.id = "xaskOut";
  const posted: string[] = [];
  const settledFrame = 'event: quoted\ndata: {"totalUsd":"0.003","network":"near:testnet","payTo":"m.testnet"}\n\nevent: signed\ndata: {"account":"chainaim-t02-seller.testnet"}\n\nevent: settled\ndata: {"transaction":"TXHASH1234567","network":"near:testnet"}\n\n';
  const body = (text: string) => { let done = false; return { getReader: () => ({ read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: new TextEncoder().encode(text) })) }) }; };
  const fetchStub = async (url: string, init?: { body?: string }) => {
    posted.push(url);
    const jsonRes = (status: number, j: unknown) => ({ ok: status < 300, status, headers: { get: () => "application/json" }, json: async () => j });
    if (url === "/agent/config") return agentConfigStatus === 200 ? jsonRes(200, { network: "near:testnet", tenants: TENANTS }) : jsonRes(agentConfigStatus, { error: "not found" });
    if (url === "/jobs/config") return jsonRes(200, { wallet: "intear-wallet", walletName: "Intear Wallet", ttlMin: 15, ...(offers ? { offers } : {}) });
    if (url === "/agent/policy") return policy ? jsonRes(200, policy.answer) : jsonRes(404, { error: "not found" });
    if (url === "/agent/crossask") {
      const sentBody = JSON.parse(init!.body!);
      agentBodies.push(sentBody);
      posted.push(`tenant=${sentBody.tenant}`);
      const withPolicy = policy ? settledFrame.replace("event: signed", policy.frame + "event: signed") : settledFrame;
      const full = FRAMES.join("").replace("event: released", withPolicy + "event: released");
      const text = stream ? stream(full) : full;
      return { ok: true, status: 200, headers: { get: () => "text/event-stream; charset=utf-8" }, body: body(text) };
    }
    return jsonRes(404, { error: "no route" });
  };
  const freeCalls: string[] = [];
  const ctx: Record<string, unknown> = {
    document: { getElementById: (id: string) => all.find((n) => n.id === id) ?? null, createElement: el },
    window: { addEventListener: () => undefined },
    fetch: fetchStub, console, TextDecoder, TextEncoder, Promise, JSON, Number, String, Object, Array, Error, Date,
    postData: async (url: string) => { freeCalls.push(url); return url === "/jobs/crossask" || url === "/offers" ? { ...(url === "/offers" ? { mode: "estimate-first", basis: { files: 3, modelCalls: 3 } } : {}), jobId: JOB_ID, totalUsd: "0.003", expiresAt: Date.now() + 60_000, network: "near:testnet", payTo: "m.testnet", asset: "usdc", amount: "3000" } : { free: true }; },
  };
  const fragment = readFileSync(FRAGMENT, "utf8");
  const script = fragment.slice(fragment.indexOf("<script>") + 8, fragment.lastIndexOf("</script>"));
  vm.createContext(ctx);
  if (initiallyTicked) {
    // The browser restored the box as ticked: the checkbox exists ticked when the script reads it.
    const create = el;
    (ctx.document as { createElement: (t: string) => Node0 }).createElement = (t: string) => { const n = create(t); if (t === "input") n.checked = true; return n; };
  }
  vm.runInContext(script, ctx);
  return {
    byId: (id: string) => all.find((n) => n.id === id)!,
    posted, freeCalls, agentBodies,
    postData: ctx.postData as (url: string, body: unknown) => Promise<unknown>,
    settle: () => new Promise((ok) => setTimeout(ok, 20)),
  };
}

describe("ARCH-309 tab 03 controls", () => {
  test("ARCH-309: with /agent/config answering, ticking shows Who pays? and the tenants with their NEAR accounts", async () => {
    const dom = runFragment(200);
    await dom.settle();
    assert.equal(dom.byId("xpayWho").hidden, true, "hidden until the box is ticked");
    dom.byId("xpayNear").checked = true;
    await dom.byId("xpayNear").onchange();
    assert.equal(dom.byId("xpayWho").hidden, false);
    assert.deepEqual(dom.byId("xpayTenant").children.map((o: any) => [o.value, o.textContent]), TENANTS.map((t) => [t.id, `${t.id} · ${t.accountId}`]));
    assert.equal(dom.byId("xpayWhoMe").checked, true, "Me is the default");
  });

  test("ARCH-309: agent mode posts to /agent/crossask with the tenant and returns the released result; the steps and the receipt are shown", async () => {
    const dom = runFragment(200);
    await dom.settle();
    dom.byId("xpayNear").checked = true;
    await dom.byId("xpayNear").onchange();
    dom.byId("xpayWhoAgent").checked = true;
    dom.byId("xpayWhoAgent").onchange();
    dom.byId("xpayTenant").value = "t02";
    const result = await dom.postData("/crossask", { folder: data, question: "q" });
    assert.deepEqual(result, { result: { columns: ["who"], rows: [{ who: R_MARKER }] } }, "the released result goes to tab 03's own renderer");
    assert.ok(dom.posted.includes("/agent/crossask") && dom.posted.includes("tenant=t02"));
    assert.deepEqual(dom.freeCalls, [], "nothing went to /jobs/crossask or the free route");
    const steps = dom.byId("xagentSteps").children.map((li: any) => li.children.map((c: any) => c.textContent).join(""));
    assert.equal(steps.length, 8);
    assert.match(steps.join("|"), /Quoted 0\.003 USDC on near:testnet.*Payment signed by chainaim-t02-seller\.testnet.*Settled on NEAR · TXHASH12…234567 ↗.*Result released: 1 row\(s\)\|Done/);
  });

  test("ARCH-309: manual mode (Me) still posts to /jobs/crossask; unticked still runs free", async () => {
    const dom = runFragment(200);
    await dom.settle();
    assert.deepEqual(await dom.postData("/crossask", {}), { free: true }, "unticked: the free route");
    dom.byId("xpayNear").checked = true;
    await dom.byId("xpayNear").onchange();
    void dom.postData("/crossask", { folder: data, question: "q" });
    await dom.settle();
    assert.deepEqual(dom.freeCalls, ["/crossask", "/jobs/crossask"]);
    assert.equal(dom.posted.includes("/agent/crossask"), false);
    assert.ok(dom.byId("xpayGo"), "the Pay button of the Intear flow is shown");
  });

  test("ARCH-309: the wallet config is loaded when the page opens with the box already ticked (the known bug)", async () => {
    const dom = runFragment(404, true);
    await dom.settle();
    assert.ok(dom.posted.includes("/jobs/config"), "loaded without a click");
    assert.match(dom.byId("xpayInfo").textContent, /nothing is shown or charged until you press Pay in Intear Wallet/);
  });

  test("ARCH-309: through the ui process the page carries the fragment and /agent/config answers", async () => {
    const page = (await call(uiPort, "GET", "/")).text;
    assert.ok(page.includes(readFileSync(FRAGMENT, "utf8")));
    assert.equal(JSON.parse((await call(uiPort, "GET", "/agent/config")).text).tenants.length, 2);
  });
});

describe("ARCH-620 tab 03: the policy line under Who pays? and the agent's policy step", () => {
  const POLICIES = { on: true, tenants: [
    { id: "t01", autoApproveMaxUsd: "0.05", maxPerJobUsd: "0.05", dailyCapUsd: "1", requireAttestedRoute: true, counter: true, spentTodayUsd: "0.01" },
    { id: "t02", autoApproveMaxUsd: "0.05", maxPerJobUsd: "0.5", dailyCapUsd: "2", requireAttestedRoute: false, counter: true, spentTodayUsd: "0" },
  ] };
  const POLICY_FRAME = `event: policy\ndata: ${JSON.stringify({ tenant: "t02", decision: "pay", reason: "within the auto-approve limit and the daily cap", spentTodayUsd: "0", checks: [
    { check: "not_expired", limit: "2026-11-10T00:15:00.000Z", value: "2026-11-10T00:00:00.000Z", ok: true },
    { check: "max_per_job", limit: "0.5", value: "0.003", ok: true }, { check: "daily_cap", limit: "2", value: "0.003", ok: true }, { check: "auto_approve", limit: "0.05", value: "0.003", ok: true },
  ] })}\n\n`;

  test("ARCH-620: picking the AI agent shows the tenant's limits and today's spend read-only; Me hides the line", async () => {
    const dom = runFragment(200, false, { answer: POLICIES, frame: POLICY_FRAME });
    await dom.settle();
    dom.byId("xpayNear").checked = true;
    await dom.byId("xpayNear").onchange();
    assert.equal(dom.byId("xpayPolicy").hidden, true, "Me pays: no policy line");
    dom.byId("xpayWhoAgent").checked = true;
    dom.byId("xpayWhoMe").checked = false;
    dom.byId("xpayTenant").value = "t01";
    dom.byId("xpayWhoAgent").onchange();
    assert.equal(dom.byId("xpayPolicy").hidden, false);
    assert.equal(dom.byId("xpayPolicy").textContent, "Spending policy for t01 (its tenant.json, enforced by the agent): pays by itself up to 0.05 USDC a job · never above 0.05 USDC a job · 1 USDC a day (0.01 USDC spent today, UTC) · attested NEAR AI route only");
  });

  test("ARCH-620: the run shows the policy step with each check between Quoted and Payment signed; every step names who did it", async () => {
    const dom = runFragment(200, false, { answer: POLICIES, frame: POLICY_FRAME });
    await dom.settle();
    dom.byId("xpayNear").checked = true;
    await dom.byId("xpayNear").onchange();
    dom.byId("xpayWhoAgent").checked = true;
    dom.byId("xpayWhoAgent").onchange();
    dom.byId("xpayTenant").value = "t02";
    await dom.postData("/crossask", { folder: data, question: "q" });
    const steps = dom.byId("xagentSteps").children.map((li: any) => li.children.map((c: any) => c.textContent).join(""));
    assert.equal(steps.length, 9);
    const i = steps.findIndex((x: string) => x.includes("Spending policy"));
    assert.equal(steps[i], "[Agent t02] Spending policy: pay ✓ · quote still valid ✓ · at most 0.5 a job (quote 0.003) ✓ · 2 a day (with this job 0.003) ✓ · pays by itself up to 0.05 ✓");
    assert.match(steps[i - 1], /^\[ChainAim\] Quoted 0\.003 USDC/);
    assert.match(steps[i + 1], /^\[Agent t02\] Payment signed by chainaim-t02-seller\.testnet/);
    assert.match(steps.join("|"), /^\[Agent t02\] Question .*\|\[Agent t02\] The agent asked ChainAim.*\|\[ChainAim\] Job run and held.*\|\[NEAR\] Settled on NEAR · .*\|\[ChainAim\] Result released: 1 row\(s\)\|Done$/);
  });
});

describe("step B tab 03: the agent's own receipt check, and the status line after a stopped run", () => {
  const pickAgent = async (dom: ReturnType<typeof runFragment>, tenant: string) => {
    await dom.settle();
    dom.byId("xpayNear").checked = true;
    await dom.byId("xpayNear").onchange();
    dom.byId("xpayWhoAgent").checked = true;
    dom.byId("xpayWhoMe").checked = false;
    dom.byId("xpayWhoAgent").onchange();
    dom.byId("xpayTenant").value = tenant;
  };
  const stepsOf = (dom: ReturnType<typeof runFragment>) => dom.byId("xagentSteps").children.map((li: any) => li.children.map((c: any) => c.textContent).join(""));

  test("ARCH-613 ARCH-616: receipt_verified is shown as the agent's step after Result released, naming the pinned key", async () => {
    const frame = `event: receipt_verified\ndata: ${JSON.stringify({ jobId: JOB_ID, receiptId: "r".repeat(32), keyId: "d27d1e9f17a0104e34c46cf3e5233f23", settled: true, transaction: "TXHASH1234567" })}\n\n`;
    const dom = runFragment(200, false, undefined, (t) => t.replace("event: done", frame + "event: done"));
    await pickAgent(dom, "t02");
    await dom.postData("/crossask", { folder: data, question: "q" });
    const steps = stepsOf(dom);
    assert.equal(steps.at(-2), "[Agent t02] Agent verified the receipt ✓ · signed by the pinned key d27d1e9f… · result, job and amount and transaction match");
    assert.match(steps.at(-3)!, /^\[ChainAim\] Result released/);
  });

  test("ARCH-613: receipt_failed is a step with the reason; the released result is still returned (the payment stands)", async () => {
    const frame = `event: receipt_failed\ndata: ${JSON.stringify({ jobId: JOB_ID, reason: "the receipt was signed by another key" })}\n\n`;
    const dom = runFragment(200, false, undefined, (t) => t.replace("event: done", frame + "event: done"));
    await pickAgent(dom, "t02");
    const result = await dom.postData("/crossask", { folder: data, question: "q" });
    assert.deepEqual(result, { result: { columns: ["who"], rows: [{ who: R_MARKER }] } });
    assert.equal(stepsOf(dom).at(-2), "[Agent t02] Receipt check failed ✗: the receipt was signed by another key (the payment stands)");
  });

  test("ARCH-620: after a refusal the status line no longer says the agent is running and paying", async () => {
    const refused = `event: refused\ndata: ${JSON.stringify({ reason: "refused by t03's spending policy: the cheapest quote 0.01 USD is above maxPerJobUsd 0.005; nothing was signed or paid" })}\n\n`;
    const dom = runFragment(200, false, undefined, (t) => t.slice(0, t.indexOf("event: quoted")) + refused);
    await pickAgent(dom, "t02");
    await assert.rejects(dom.postData("/crossask", { folder: data, question: "q" }), /^Error: Not paid: refused by t03's spending policy/);
    const line = dom.byId("xpayInfo").textContent;
    assert.ok(!/is running and paying the job/.test(line), line);
    assert.match(line, /^On, AI agent: Ask runs the job/);
  });
});

describe("privateAI-design-34 ARCH-642 tab 03 pricing: estimate first or run first", () => {
  const BOTH = { mode: "estimate-first", modes: ["estimate-first", "run-hold"] };
  test("ARCH-642: with both modes the Pricing choice shows, estimate first picked; Me posts /offers and the button is Pay and run", async () => {
    const dom = runFragment(200, false, undefined, undefined, BOTH);
    await dom.settle();
    dom.byId("xpayNear").checked = true;
    await dom.byId("xpayNear").onchange();
    assert.equal(dom.byId("xpayMode").hidden, false);
    assert.equal(dom.byId("xpayModeEstimate").checked, true, "the console's default");
    assert.equal(dom.byId("xpayModeRun").checked, false);
    assert.match(dom.byId("xpayInfo").textContent, /estimate first: Ask shows a firm price from the job's sizes; nothing has run yet/);
    void dom.postData("/crossask", { folder: data, question: "q" });
    await dom.settle();
    assert.deepEqual(dom.freeCalls, ["/offers"], "no work: an estimate, not /jobs/crossask");
    assert.equal(dom.byId("xpayGo").textContent, "Pay and run");
    assert.match(dom.byId("xpayTotal").textContent, /estimated before any work \(3 file\(s\), at most 3 model call\(s\);[\s\S]*Nothing has run yet/);
  });

  test("ARCH-642: Run first still posts /jobs/crossask with Pay", async () => {
    const dom = runFragment(200, false, undefined, undefined, BOTH);
    await dom.settle();
    dom.byId("xpayNear").checked = true;
    await dom.byId("xpayNear").onchange();
    dom.byId("xpayModeRun").checked = true; dom.byId("xpayModeEstimate").checked = false;
    dom.byId("xpayModeRun").onchange();
    void dom.postData("/crossask", { folder: data, question: "q" });
    await dom.settle();
    assert.deepEqual(dom.freeCalls, ["/jobs/crossask"]);
    assert.equal(dom.byId("xpayGo").textContent, "Pay");
  });

  test("ARCH-642: estimate-first only hides the choice; a console without offers is run first, as before", async () => {
    const only = runFragment(200, false, undefined, undefined, { mode: "estimate-first", modes: ["estimate-first"] });
    await only.settle();
    only.byId("xpayNear").checked = true;
    await only.byId("xpayNear").onchange();
    assert.equal(only.byId("xpayMode").hidden, true);
    void only.postData("/crossask", { folder: data, question: "q" });
    await only.settle();
    assert.deepEqual(only.freeCalls, ["/offers"]);
    const old = runFragment(200);
    await old.settle();
    old.byId("xpayNear").checked = true;
    await old.byId("xpayNear").onchange();
    assert.equal(old.byId("xpayMode").hidden, true);
    void old.postData("/crossask", { folder: data, question: "q" });
    await old.settle();
    assert.deepEqual(old.freeCalls, ["/jobs/crossask"]);
  });

  test("ARCH-642: the AI agent gets offerMode with its run, and its estimated step is shown", async () => {
    const dom = runFragment(200, false, undefined, (t) => t.replace("event: quoted", 'event: estimated\ndata: {"jobId":"' + "c".repeat(32) + '"}\n\nevent: quoted'), BOTH);
    await dom.settle();
    dom.byId("xpayNear").checked = true;
    await dom.byId("xpayNear").onchange();
    dom.byId("xpayWhoAgent").checked = true; dom.byId("xpayWhoMe").checked = false;
    dom.byId("xpayWhoAgent").onchange();
    await dom.postData("/crossask", { folder: data, question: "q" }).catch(() => undefined);
    await dom.settle();
    assert.equal(dom.agentBodies[0].offerMode, "estimate-first");
    const steps = dom.byId("xagentSteps");
    const text = JSON.stringify(steps.children.map((li: { children: { textContent?: string }[]; textContent?: string }) => li.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("")));
    assert.match(text, /Estimated from the job's sizes \(id cccccccc…\): nothing has run yet; it runs only after the payment/);
  });
});

