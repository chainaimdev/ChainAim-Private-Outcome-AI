/**
 * Paid jobs on the test console's tab 03 (architecture.md ARCH-101, ARCH-104, ARCH-105, ARCH-112, ARCH-113, ARCH-114),
 * end to end on loopback with real code: the console process (test-console/console/server.ts --paid-jobs on), the real
 * analyst process (services/analyst) on a folder of CSV files written here, the real gateway (its createGateway, through
 * the gateway tests' startTestGateway, with the stand-in Presidio) in front of an OpenAI-compatible model server on a
 * loopback port that answers like a model and reports token usage, and the real paywall with the NEAR rail and
 * PAID_JOBS=on (services/paywall/test/serve-near-paywall.ts: its createPaywall and the NEAR JSON-RPC protocol double).
 * Payment settlement itself is covered by services/paywall/test/paid-jobs.test.ts.
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStubPresidio, type StubPresidio } from "../stub-presidio.ts";
import { validateCatalog } from "../../services/gateway/src/catalog.ts";
import { startTestGateway, type TestGateway } from "../../services/gateway/test/helpers.ts";
import { pricesFromCatalog, quoteJob, type Fees } from "../../packages/crossask/src/cost.ts";
import { INGEST_KEY, nearWatchSkip, startNearWatch } from "./near-watch-server.ts";
import { verifyReceipt, type SignedReceipt } from "../../packages/receipt/src/index.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER = join(ROOT, "test-console/console/server.ts");
const PAGE = join(ROOT, "test-console/console/index.html");
const FRAGMENT = join(ROOT, "test-console/console/paid-jobs.html");
const ANALYST = join(ROOT, "services/analyst/src/main.ts");
const PAYWALL = join(ROOT, "services/paywall/test/serve-near-paywall.ts");
const KEY = readFileSync(join(ROOT, "test-console/local-gateway-key.txt"), "utf8").trim();
const JOBS_KEY = randomBytes(24).toString("hex");
const MARKER = "Zqxmarker";
const MODEL = "local/standin";
const USAGE = { prompt_tokens: 1200, completion_tokens: 40 };
const FEES = { "fee-per-model-call-usd": "0.001", "fee-analyst-usd": "0.002", "near-gas-fee-usd": "0.0005", "margin-pct": "20", "min-price-usd": "0.001" };

const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });
const listen = (s: Server) => new Promise<string>((ok) => s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const closeServer = (s: Server) => new Promise<void>((ok) => s.close(() => ok()));

/** One plain request, no keep-alive (a pooled socket still closing at exit can crash Node on Windows). */
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

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

// ---- the stack ----------------------------------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "paid-jobs-"));
const data = join(dir, "data");
mkdirSync(data);
writeFileSync(join(data, "orders.csv"), `order_id,customer,amount\n1,${MARKER} One,10.50\n2,${MARKER} Two,20.25\n3,Third,5.00\n`);
writeFileSync(join(dir, "data-sources.json"), JSON.stringify({ allowedRoots: [data], defaultFolder: data, defaultMode: "whole", extensions: [".csv"], maxBytes: { "*": 2_000_000 }, exclude: [], maxFiles: 20, hideFolders: ["_*"] }));
let modelCalls = 0;
/** An OpenAI-compatible model on loopback: a query for the SQL step, a sentence for the answer step, with usage. */
const modelServer: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url === "/health") { res.writeHead(200).end("{}"); return; }
    modelCalls++;
    const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
    const sqlStep = body.messages.some((m) => m.role === "system" && m.content.startsWith("You write DuckDB SQL"));
    const content = sqlStep ? '```sql\nSELECT count(*) AS n FROM orders\n```' : "There are 3 orders.";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "standin", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { ...USAGE, total_tokens: USAGE.prompt_tokens + USAGE.completion_tokens } }));
  });
});
let modelUrl = "";
let presidio: StubPresidio;
let gateway: TestGateway;
let analystPort = 0;
let analyst: Proc;
let paywall: Proc;
let paywallUrl = "";
let consolePort = 0, internalPort = 0;
let consoleProc: Proc;
const catalogPath = join(dir, "catalog.json");

function consoleArgs(port: number, iport: number, over: Record<string, string | undefined> = {}, paywallAt = paywallUrl): string[] {
  const f: Record<string, string | undefined> = {
    port: String(port), gateway: gateway.url, paywall: paywallAt, analyst: `http://127.0.0.1:${analystPort}`, "data-config": join(dir, "data-sources.json"),
    "paid-jobs": "on", "near-wallet": "intear-wallet", "jobs-internal-port": String(iport), "pricing-catalog": catalogPath, "default-model": MODEL, ...FEES, ...over,
  };
  return [SERVER, ...Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => `--${k}=${v}`)];
}
const consoleReady = (port: number) => (out: string) => out.includes(`http://127.0.0.1:${port}`) && out.includes("internal listener");

before(async () => {
  modelUrl = await listen(modelServer);
  presidio = await startStubPresidio();
  const caps = { contextWindow: 8192, maxOutputTokens: 2048, supportsTools: true, supportsVision: false };
  const raw = {
    version: "paid-jobs-test",
    models: [{ id: MODEL, zone: "local", capabilities: caps, pricing: { inputPerM: 0.5, outputPerM: 1.5 }, deployments: [{ id: "standin@0", adapter: "openai", baseUrl: `${modelUrl}/v1`, servedModel: "standin", healthUrl: `${modelUrl}/health` }] }],
    profiles: Object.fromEntries(["auto", "eco", "premium"].map((p) => [p, { SIMPLE: [MODEL], MEDIUM: [MODEL], COMPLEX: [MODEL], REASONING: [MODEL] }])),
  };
  writeFileSync(catalogPath, JSON.stringify(raw));
  gateway = await startTestGateway({ presidioUrl: presidio.url, catalog: validateCatalog(raw), gatewayKey: KEY });
  analystPort = await freePort();
  analyst = await start([ANALYST, "--port", String(analystPort), "--data-config", join(dir, "data-sources.json"), "--work-dir", join(dir, "work")], (o) => o.includes(String(analystPort)), {}, "the analyst");
  internalPort = await freePort();
  paywall = await start([PAYWALL], (o) => o.includes('"url"'), {
    GATEWAY_URL: gateway.url, CHAINAIM_GATEWAY_KEY: KEY, PAID_JOBS: "on", PAID_JOBS_KEY: JOBS_KEY, PAID_JOBS_RESULT_URL: `http://127.0.0.1:${internalPort}`, PAID_JOBS_TTL_SEC: "900",
  }, "the paywall");
  paywallUrl = JSON.parse(paywall.out().split("\n").find((l) => l.includes('"url"'))!).url;
  consolePort = await freePort();
  consoleProc = await start(consoleArgs(consolePort, internalPort), consoleReady(consolePort), { PAID_JOBS_KEY: JOBS_KEY }, "the console");
});
after(async () => {
  await stop(consoleProc);
  await stop(paywall);
  await stop(analyst);
  await gateway?.close();
  await presidio?.close();
  await closeServer(modelServer);
  rmSync(dir, { recursive: true, force: true });
});

const ask = (body: Record<string, unknown>, port = consolePort) => call(port, "POST", "/jobs/crossask", { "content-type": "application/json" }, JSON.stringify(body));
const internal = (method: string, path: string, key?: string) => call(internalPort, method, path, key === undefined ? {} : { "x-jobs-key": key });
const QUESTION = `How many orders did ${MARKER} place?`;

describe("ARCH-104 the console creates a paid job and returns only its cost", () => {
  test("ARCH-104: the response has no result, answer, sql or rows; the total is cost.ts's for the metered calls", async () => {
    modelCalls = 0;
    const r = await ask({ folder: data, question: QUESTION, model: MODEL, answerModel: MODEL, phrase: "llm" });
    assert.equal(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.deepEqual(Object.keys(j).sort(), ["amount", "asset", "expiresAt", "jobId", "network", "payTo", "totalUsd"]);
    for (const leak of ["result", "answer", "sql", "rows", MARKER, "There are 3", "count(*)"]) assert.equal(r.text.includes(leak), false, leak);
    assert.match(j.jobId, /^[0-9a-f]{32}$/);
    assert.equal(modelCalls, 2, "the query and the worded answer");
    const fees: Fees = { perModelCallUsd: FEES["fee-per-model-call-usd"], analystUsd: FEES["fee-analyst-usd"], nearGasUsd: FEES["near-gas-fee-usd"], marginPct: FEES["margin-pct"], minPriceUsd: FEES["min-price-usd"] };
    const line = { model: MODEL, promptTokens: USAGE.prompt_tokens, completionTokens: USAGE.completion_tokens };
    const want = quoteJob([line, line], pricesFromCatalog(JSON.parse(readFileSync(catalogPath, "utf8"))), fees);
    assert.deepEqual([j.totalUsd, j.amount], [want.totalUsd, want.amount], "the gateway's usage reached the meter");
    assert.deepEqual([j.network, j.asset, j.payTo], ["near:testnet", "usdc.chainaim-test.testnet", "merchant.chainaim-test.testnet"]);
    // The real paywall quotes the release at exactly that amount, NEAR only.
    const q = await fetch(`${paywallUrl}/v1/jobs/${j.jobId}/release`, { method: "POST" });
    assert.equal(q.status, 402);
    const offer = JSON.parse(Buffer.from(q.headers.get("payment-required")!, "base64").toString("utf8")).accepts;
    assert.deepEqual(offer.map((o: Record<string, string>) => [o.network, o.amount]), [["near:testnet", want.amount]]);
  });

  test("ARCH-104: the held job is retrievable only via ARCH-105", async () => {
    const j = JSON.parse((await ask({ folder: data, question: QUESTION, model: MODEL, phrase: "none" })).text);
    assert.equal((await call(consolePort, "GET", `/internal/jobs/${j.jobId}`)).status, 404, "not on the browser listener");
    const held = await internal("GET", `/internal/jobs/${j.jobId}`, JOBS_KEY);
    assert.equal(held.status, 200);
    const body = JSON.parse(held.text);
    assert.equal(body.jobId, j.jobId);
    assert.equal(body.result.result.rows.length, 1, "the held result is the job's own: one count row");
    assert.equal(Number(body.result.result.rows[0].n), 3);
    assert.equal(body.result.question, QUESTION);
  });

  test("ARCH-104: user-typed SQL and no worded answer: no model call, fees only", async () => {
    modelCalls = 0;
    const r = await ask({ folder: data, question: "count", sql: "SELECT count(*) AS n FROM orders", phrase: "none" });
    assert.equal(r.status, 200, r.text);
    assert.equal(modelCalls, 0);
    assert.equal(JSON.parse(r.text).totalUsd, "0.003000"); // (0.002 + 0.0005) × 1.2
  });

  test("ARCH-104: registration failure → error and no held job; /crossask is unchanged", async () => {
    const port = await freePort(), iport = await freePort();
    const c = await start(consoleArgs(port, iport, {}, "http://127.0.0.1:9"), consoleReady(port), { PAID_JOBS_KEY: JOBS_KEY }, "the console");
    try {
      const r = await ask({ folder: data, question: QUESTION, model: MODEL, phrase: "none" }, port);
      assert.equal(r.status, 502);
      assert.match(JSON.parse(r.text).error, /not reachable to register the job; nothing was charged/);
      assert.equal(c.out().includes("job_quoted"), false, "nothing was held");
      const free = await call(port, "POST", "/crossask", { "content-type": "application/json" }, JSON.stringify({ folder: data, question: QUESTION, model: MODEL, phrase: "none" }));
      assert.equal(free.status, 200);
      assert.equal(Number(JSON.parse(free.text).result.rows[0].n), 3);
      assert.ok("answer" in JSON.parse(free.text), "/crossask still returns the whole result");
    } finally { await stop(c); }
  });

  test("ARCH-104: an unpriced model is never quoted or held", async () => {
    const port = await freePort(), iport = await freePort();
    const empty = join(dir, "empty-catalog.json");
    writeFileSync(empty, JSON.stringify({ models: [] }));
    const c = await start(consoleArgs(port, iport, { "pricing-catalog": empty }), consoleReady(port), { PAID_JOBS_KEY: JOBS_KEY }, "the console");
    try {
      const r = await ask({ folder: data, question: QUESTION, model: MODEL, phrase: "none" }, port);
      assert.equal(r.status, 422);
      assert.match(JSON.parse(r.text).error, /has no price/);
      assert.equal(c.out().includes("job_quoted"), false);
    } finally { await stop(c); }
  });
});

describe("ARCH-105 the console's internal listener", () => {
  test("ARCH-105: 401 without key, 401 wrong key, 404 unknown, 200 with result, released → later GET 404", async () => {
    const j = JSON.parse((await ask({ folder: data, question: QUESTION, model: MODEL, phrase: "none" })).text);
    assert.equal((await internal("GET", `/internal/jobs/${j.jobId}`)).status, 401);
    assert.equal((await internal("GET", `/internal/jobs/${j.jobId}`, JOBS_KEY.replace(/.$/, "0") === JOBS_KEY ? JOBS_KEY.replace(/.$/, "1") : JOBS_KEY.replace(/.$/, "0"))).status, 401);
    assert.equal((await internal("GET", `/internal/jobs/${randomBytes(16).toString("hex")}`, JOBS_KEY)).status, 404);
    assert.equal((await internal("GET", `/internal/jobs/${j.jobId}`, JOBS_KEY)).status, 200);
    assert.equal((await internal("POST", `/internal/jobs/${j.jobId}/released`, JOBS_KEY)).status, 200);
    assert.equal((await internal("GET", `/internal/jobs/${j.jobId}`, JOBS_KEY)).status, 404);
  });

  test("ARCH-105: start-up error text when the key env is unset or short", () => {
    const run = (env: Record<string, string>) => spawnSync(process.execPath, consoleArgs(0, 0), { encoding: "utf8", timeout: 20_000, env: { ...process.env, PAID_JOBS_KEY: "", ...env } });
    for (const env of [{}, { PAID_JOBS_KEY: "too-short" }] as Record<string, string>[]) {
      const r = run(env);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /needs the environment variable PAID_JOBS_KEY: the key shared with the paywall/);
      assert.equal(r.stderr.includes("too-short"), false, "the key's value is never printed");
    }
  });
});

describe("ARCH-114 fees are configured, never defaulted", () => {
  for (const flag of ["pricing-catalog", "fee-per-model-call-usd", "fee-analyst-usd", "near-gas-fee-usd", "margin-pct", "min-price-usd"]) {
    test(`ARCH-114: start-up refuses without --${flag}`, () => {
      const r = spawnSync(process.execPath, consoleArgs(0, 0, { [flag]: undefined }), { encoding: "utf8", timeout: 20_000, env: { ...process.env, PAID_JOBS_KEY: JOBS_KEY } });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(`--paid-jobs on needs --${flag}`));
    });
  }
  test("ARCH-114: a negative fee is refused, and MANUAL_SETUP.md says how --near-gas-fee-usd is derived", () => {
    const r = spawnSync(process.execPath, consoleArgs(0, 0, { "margin-pct": "-1" }), { encoding: "utf8", timeout: 20_000, env: { ...process.env, PAID_JOBS_KEY: JOBS_KEY } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--margin-pct: "-1" is not a non-negative decimal/);
    const manual = readFileSync(join(ROOT, "MANUAL_SETUP.md"), "utf8");
    assert.match(manual, /--near-gas-fee-usd/);
    assert.match(manual, /0\.000332587 NEAR/);
  });
});

describe("ARCH-615 ARCH-616 Job Evidence Receipts on the real console", () => {
  test("ARCH-615 ARCH-616: --receipts on: after release the receipt is served, verifies against the released result and carries the settlement", async () => {
    const port = await freePort(), iport = await freePort();
    const signing = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    // Ready only once the receipts line is out too: it is logged after the internal-listener line and may arrive in a later chunk.
    const c = await start(consoleArgs(port, iport, { receipts: "on", "receipt-dir": join(dir, "receipts") }), (o) => consoleReady(port)(o) && o.includes("receipts on: signing key id"), { PAID_JOBS_KEY: JOBS_KEY, RECEIPT_SIGNING_KEY: signing }, "the console");
    try {
      assert.equal(c.out().includes("PRIVATE KEY"), false, "the key is never printed");
      assert.equal(JSON.parse((await call(port, "GET", "/jobs/config")).text).receipts, true);
      const r = await ask({ folder: data, question: QUESTION, model: MODEL, phrase: "none", datasetId: "orders-demo", templateLabel: "Count orders" }, port);
      assert.equal(r.status, 200, r.text);
      const { jobId } = JSON.parse(r.text);
      assert.equal((await call(port, "GET", `/jobs/${jobId}/receipt`)).status, 404, "no receipt before the job is released");
      const held = JSON.parse((await call(iport, "GET", `/internal/jobs/${jobId}`, { "x-jobs-key": JOBS_KEY })).text);
      const notice = { transaction: "4ZqX9vYbT8cTq2b7hS3dK1mN6pR5sU8wXyZaBcDeFgH", network: "near:testnet", payer: "t02.testnet", invoiceId: "ABCDEF0123456789ABCDEF0123456789" };
      const rel = await call(iport, "POST", `/internal/jobs/${jobId}/released`, { "x-jobs-key": JOBS_KEY, "content-type": "application/json" }, JSON.stringify(notice));
      assert.equal(rel.status, 200);
      // The receipt is made after the release answer (never awaited by it): wait for it.
      let got: { status: number; text: string } = { status: 0, text: "" };
      for (let i = 0; i < 50 && got.status !== 200; i++) { got = await call(port, "GET", `/jobs/${jobId}/receipt`); if (got.status !== 200) await new Promise((ok) => setTimeout(ok, 100)); }
      assert.equal(got.status, 200, got.text + c.out());
      const { receipt, publicKeyPem } = JSON.parse(got.text) as { receipt: SignedReceipt; publicKeyPem: string };
      // held.result is exactly what the paywall sends the buyer (app.ts release: c.json(held.result)).
      assert.deepEqual(verifyReceipt(receipt, publicKeyPem, held.result), { ok: true, settled: true });
      assert.equal(receipt.settlement?.transaction, notice.transaction);
      assert.equal(receipt.body.jobId, jobId);
      assert.equal(receipt.body.datasetId, "orders-demo");
      assert.equal(receipt.body.templateLabel, "Count orders");
      assert.ok(receipt.body.files.some((f) => f.name === "orders.csv"));
      assert.equal(receipt.body.price.amountUnits, JSON.parse(r.text).amount);
      for (const leak of [MARKER, "count(*)", data, QUESTION]) assert.equal(got.text.includes(leak), false, leak);
      assert.ok(/"event":"job_receipt"/.test(c.out()));
      assert.equal(c.out().includes(MARKER), false, "no data in the console log");
      assert.equal((await call(port, "GET", `/jobs/${"0".repeat(32)}/receipt`)).status, 404);
    } finally { await stop(c); }
  });

  test("ARCH-614: --receipts on refuses to start without the signing key, naming the variable only", async () => {
    // Valid ports and key: the only thing missing is the receipt key, so that is what start-up must name.
    const r = spawnSync(process.execPath, consoleArgs(await freePort(), await freePort(), { receipts: "on" }), { encoding: "utf8", timeout: 20_000, env: { ...process.env, PAID_JOBS_KEY: JOBS_KEY, RECEIPT_SIGNING_KEY: "" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /RECEIPT_SIGNING_KEY is not set/);
  });
});

describe("ARCH-101 / ARCH-112 the page and the relay", () => {
  test("ARCH-101: console page without --paid-jobs has no pay box in tab 03", async () => {
    const port = await freePort();
    const c = await start([SERVER, "--port", String(port), "--gateway", gateway.url, "--paywall", "http://127.0.0.1:9"], (o) => o.includes(`http://127.0.0.1:${port}`), {}, "the console");
    try {
      const page = await call(port, "GET", "/");
      assert.equal(page.text, readFileSync(PAGE, "utf8"), "the page is index.html byte for byte");
      assert.equal(page.text.includes("xpayNear"), false);
      for (const path of ["/jobs/crossask", "/jobs/config", `/paid/jobs/${"a".repeat(32)}/release`]) {
        assert.equal((await call(port, path === "/jobs/config" ? "GET" : "POST", path, { "content-type": "application/json" }, "{}")).status, 404, path);
      }
      assert.equal(c.out().includes("internal listener"), false, "no second listener");
    } finally { await stop(c); }
  });

  test("ARCH-112: with the flags the page gains the pay box; its script calls /jobs/crossask only when ticked", async () => {
    const page = (await call(consolePort, "GET", "/")).text;
    const fragment = readFileSync(FRAGMENT, "utf8");
    assert.ok(page.includes(fragment), "the fragment is added");
    assert.equal(page.replace(fragment, ""), readFileSync(PAGE, "utf8"), "nothing else changes");
    assert.ok(page.includes('id = "xpayNear"'));
    const script = fragment.slice(fragment.indexOf("<script>") + 8, fragment.lastIndexOf("</script>"));
    const checked = spawnSync(process.execPath, ["--check", "-"], { input: script, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(script, /if \(url !== "\/crossask" \|\| !tick\.checked\) return free\(url, body\);/);
    assert.equal(script.match(/\/jobs\/crossask/g)?.length, 1);
    const cfg = await call(consolePort, "GET", "/jobs/config");
    // defaultPayer (owner 2026-11-07): "me" unless the console runs with --default-payer agent
    // receipts (privateAI-design-32 ARCH-615): false unless the console runs with --receipts on
    assert.deepEqual(JSON.parse(cfg.text), { wallet: "intear-wallet", walletName: "Intear Wallet", ttlMin: 15, defaultPayer: "me", attest: null, receipts: false });
  });

  test("ARCH-112: the release relay adds no gateway key and logs neither the payment nor the result", async () => {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const recorder: Server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push({ url: req.url!, headers: req.headers });
        res.writeHead(200, { "content-type": "application/json", "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "TXHASH" })).toString("base64") });
        res.end(JSON.stringify({ answer: MARKER }));
      });
    });
    const recUrl = await listen(recorder);
    const port = await freePort(), iport = await freePort();
    const c = await start(consoleArgs(port, iport, {}, recUrl), consoleReady(port), { PAID_JOBS_KEY: JOBS_KEY }, "the console");
    try {
      const jobId = randomBytes(16).toString("hex");
      const signature = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signedDelegateAction: "c2lnbmVk" } })).toString("base64");
      const r = await call(port, "POST", `/paid/jobs/${jobId}/release`, { "payment-signature": signature });
      assert.equal(r.status, 200);
      assert.ok(r.headers["payment-response"]);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, `/v1/jobs/${jobId}/release`);
      assert.equal(seen[0].headers["payment-signature"], signature, "the payment reaches the paywall byte for byte");
      assert.equal(seen[0].headers.authorization, undefined);
      assert.equal(JSON.stringify(seen[0].headers).includes(KEY), false, "the gateway key is never added");
      assert.equal(JSON.stringify(seen[0].headers).includes(JOBS_KEY), false, "nor the jobs key");
      assert.equal((await call(port, "POST", "/paid/jobs/not-an-id/release")).status, 404);
      await new Promise((ok) => setTimeout(ok, 100));
      assert.match(c.out(), new RegExp(`"route":"paid-job-release","jobId":"${jobId}","status":200,"withPayment":true`));
      for (const leak of [signature, MARKER, "TXHASH"]) assert.equal(c.out().includes(leak), false, leak);
    } finally { await stop(c); await closeServer(recorder); }
  });
});

describe("ARCH-113 nothing sensitive leaves through logs", () => {
  test("ARCH-113: a full job with a marker in the question and the rows leaves the marker in no log of console or paywall", async () => {
    const j = JSON.parse((await ask({ folder: data, question: QUESTION, model: MODEL, answerModel: MODEL, phrase: "llm" })).text);
    await internal("GET", `/internal/jobs/${j.jobId}`, JOBS_KEY);
    await call(consolePort, "POST", `/paid/jobs/${j.jobId}/release`);
    const failing = await ask({ folder: join(data, "missing"), question: QUESTION, model: MODEL, phrase: "none" });
    assert.notEqual(failing.status, 200);
    assert.equal(failing.text.includes(MARKER), false, "an error body names no question");
    await new Promise((ok) => setTimeout(ok, 200));
    for (const [name, out] of [["console", consoleProc.out()], ["paywall", paywall.out()]] as const) {
      assert.equal(out.includes(MARKER), false, `${name} log`);
      assert.equal(out.includes(JOBS_KEY), false, `${name} log has the jobs key`);
      assert.equal(out.includes(KEY), false, `${name} log has the gateway key`);
    }
    assert.match(consoleProc.out(), /"event":"job_quoted"/);
  });
});

describe("ARCH-205 (chainaim-adminUI-NEAR architecture-adminui-jobs.md) the job feed to near-watch", () => {
  test("ARCH-205: with --job-feed-url the job's events reach the real near-watch once: quoted with its steps and breakdown, then released", { skip: nearWatchSkip() }, async () => {
    const nw = await startNearWatch();
    const port = await freePort(), iport = await freePort();
    const c = await start(consoleArgs(port, iport, { "job-feed-url": nw.ingestUrl }), consoleReady(port), { PAID_JOBS_KEY: JOBS_KEY, NEAR_WATCH_INGEST_KEY: INGEST_KEY }, "the console");
    try {
      for (let i = 0; i < 100 && !c.out().includes("job feed on"); i++) await new Promise((ok) => setTimeout(ok, 20));
      assert.match(c.out(), /job feed on: http:\/\/127\.0\.0\.1:\d+\/ingest\/job  key from NEAR_WATCH_INGEST_KEY/);
      const r = await ask({ folder: data, question: QUESTION, model: MODEL, answerModel: MODEL, phrase: "llm" }, port);
      assert.equal(r.status, 200, r.text);
      const j = JSON.parse(r.text);
      assert.deepEqual(Object.keys(j).sort(), ["amount", "asset", "expiresAt", "jobId", "network", "payTo", "totalUsd"], "the response is as without the feed");
      for (let i = 0; i < 100 && !nw.store.getJob(j.jobId); i++) await new Promise((ok) => setTimeout(ok, 20));
      const job = nw.store.getJob(j.jobId)!;
      assert.ok(job, "near-watch has the job");
      assert.deepEqual([job.state, job.amount, job.totalUsd], ["quoted", j.amount, j.totalUsd]);
      const steps = job.steps as { name: string; model?: string; promptTokens?: number; completionTokens?: number; ms: number }[];
      assert.deepEqual(steps.map((s) => s.name), ["analyst", "query", "sql", "answer"]);
      for (const s of steps.filter((x) => x.model)) assert.deepEqual([s.model, s.promptTokens, s.completionTokens], [MODEL, USAGE.prompt_tokens, USAGE.completion_tokens]);
      assert.ok(steps.every((s) => Number.isInteger(s.ms) && s.ms >= 0));
      assert.equal((job.breakdown as { calls: unknown[] }).calls.length, 2);
      assert.equal(JSON.stringify(job).includes(MARKER), false, "no question or row reached near-watch");
      // What the paywall calls once it settled the job's payment (ARCH-105).
      assert.equal((await call(iport, "POST", `/internal/jobs/${j.jobId}/released`, { "x-jobs-key": JOBS_KEY })).status, 200);
      for (let i = 0; i < 100 && nw.store.getJob(j.jobId)?.state !== "released"; i++) await new Promise((ok) => setTimeout(ok, 20));
      assert.equal(nw.store.getJob(j.jobId)?.state, "released");
      assert.deepEqual([nw.liveOps.jobs.counters.events, nw.liveOps.jobs.counters.repeats, nw.liveOps.counters.refused], [2, 0, 0], "each event once, none refused");
      assert.equal(c.out().includes("job_feed_failed"), false);
      for (const leak of [MARKER, INGEST_KEY]) assert.equal(c.out().includes(leak), false, leak);
    } finally { await stop(c); await nw.close(); }
  });

  test("ARCH-205: a near-watch that is down does not change the /jobs/crossask response; the failure is logged once with the job id", async () => {
    const port = await freePort(), iport = await freePort();
    const c = await start(consoleArgs(port, iport, { "job-feed-url": "http://127.0.0.1:9/ingest/job" }), consoleReady(port), { PAID_JOBS_KEY: JOBS_KEY, NEAR_WATCH_INGEST_KEY: INGEST_KEY }, "the console");
    try {
      const body = { folder: data, question: QUESTION, model: MODEL, answerModel: MODEL, phrase: "llm" };
      const withFeed = await ask(body, port);
      const without = await ask(body);
      assert.equal(withFeed.status, 200, withFeed.text);
      assert.equal(without.status, 200, `the suite's own console (no feed) answered: ${without.text}`);
      const a = JSON.parse(withFeed.text), b = JSON.parse(without.text);
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
      assert.deepEqual([a.totalUsd, a.amount, a.network, a.asset, a.payTo], [b.totalUsd, b.amount, b.network, b.asset, b.payTo]);
      const held = JSON.parse((await call(iport, "GET", `/internal/jobs/${a.jobId}`, { "x-jobs-key": JOBS_KEY })).text);
      assert.equal("timings" in held.result, false, "the held result is as without the feed");
      for (let i = 0; i < 100 && !c.out().includes("job_feed_failed"); i++) await new Promise((ok) => setTimeout(ok, 20));
      const failed = c.out().split("\n").filter((l) => l.includes("job_feed_failed")).map((l) => JSON.parse(l));
      assert.deepEqual(failed.map((l) => [l.jobId, l.reason]), [[a.jobId, "unreachable"]]);
      for (const leak of [MARKER, INGEST_KEY]) assert.equal(c.out().includes(leak), false, leak);
    } finally { await stop(c); }
  });

  test("ARCH-201: without --job-feed-url the console says nothing about a job feed and posts nothing", () => {
    assert.equal(consoleProc.out().includes("job feed"), false);
    assert.equal(consoleProc.out().includes("job_feed_failed"), false);
  });

  test("ARCH-205: --job-feed-url needs --paid-jobs on and the ingest key", () => {
    const off = spawnSync(process.execPath, [SERVER, "--port", "0", "--job-feed-url", "http://127.0.0.1:8790/ingest/job"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, NEAR_WATCH_INGEST_KEY: INGEST_KEY } });
    assert.notEqual(off.status, 0);
    assert.match(off.stderr, /--job-feed-url needs --paid-jobs on/);
    const nokey = spawnSync(process.execPath, consoleArgs(1, 2, { "job-feed-url": "http://127.0.0.1:8790/ingest/job" }), { encoding: "utf8", timeout: 20_000, env: { ...process.env, PAID_JOBS_KEY: JOBS_KEY, NEAR_WATCH_INGEST_KEY: "short" } });
    assert.notEqual(nokey.status, 0);
    assert.match(nokey.stderr, /needs the environment variable NEAR_WATCH_INGEST_KEY/);
    assert.equal(nokey.stderr.includes("short"), false);
  });
});
