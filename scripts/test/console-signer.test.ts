/**
 * privateAI-design-36 ARCH-662 / ARCH-663 / ARCH-667 / ARCH-668 / ARCH-611: the data plane and the control plane as two
 * processes, end to end on loopback with real code. The console (test-console/console/server.ts --signer remote) holds no
 * ChainAim key; ca-control-signer (services/signer/src/main.ts) holds both and prices every job itself; the real analyst,
 * the real gateway (startTestGateway with the stand-in Presidio) in front of an OpenAI-compatible model on loopback, and
 * the real paywall with the NEAR rail (serve-near-paywall.ts). The paid release is driven the way the paywall drives it
 * (POST /internal/jobs/<id>/run with the run notice, then /released with the settlement), so the order is pinned here:
 * estimate -> signed quote -> agent's mandate -> signer verifies -> run -> settlement -> receipt. Settlement itself (and
 * that a 409/422/502 from the run settles nothing) is services/paywall/test/paid-jobs.test.ts.
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStubPresidio, type StubPresidio } from "../stub-presidio.ts";
import { validateCatalog } from "../../services/gateway/src/catalog.ts";
import { startTestGateway, type TestGateway } from "../../services/gateway/test/helpers.ts";
import { attachedJws, buildCheckoutMandate, mandateSha256, publicJwkOf, verifyMerchantAuthorization } from "../../packages/ap2/src/index.ts";
import { verifyReceipt, type SignedReceipt } from "../../packages/receipt/src/index.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER = join(ROOT, "test-console/console/server.ts");
const SIGNER = join(ROOT, "services/signer/src/main.ts");
const ANALYST = join(ROOT, "services/analyst/src/main.ts");
const PAYWALL = join(ROOT, "services/paywall/test/serve-near-paywall.ts");
const VERIFY = join(ROOT, "scripts/verify-receipt.ts");
const KEY = readFileSync(join(ROOT, "test-console/local-gateway-key.txt"), "utf8").trim();
const JOBS_KEY = randomBytes(24).toString("hex");
const SIGNER_KEY = randomBytes(24).toString("hex");
const MARKER = "Zqxsignermarker";
const MODEL = "local/standin";
const QUESTION = `How many orders did ${MARKER} place?`;
const CONSOLE_FEES = { "fee-per-model-call-usd": "0.001", "fee-analyst-usd": "0.002", "near-gas-fee-usd": "0.0005", "margin-pct": "20", "min-price-usd": "0.01" };
/** The signer's own fees: a larger margin, so a price that follows the signer is told apart from the console's arithmetic. */
const SIGNER_FEES = { ...CONSOLE_FEES, "margin-pct": "300" };
const TENANT_ACCOUNT = "chainaim-t02-seller.testnet";

const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });
const listen = (s: Server) => new Promise<string>((ok) => s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const closeServer = (s: Server) => new Promise<void>((ok) => s.close(() => ok()));
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
type Proc = { child: ChildProcess; out: () => string };
function start(args: string[], ready: (out: string) => boolean, env: Record<string, string>, what: string): Promise<Proc> {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env });
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
/** A process killed by a signal has signalCode set and exitCode null: either means it is gone (the signer is stopped twice here). */
const stop = (p: Proc | undefined) => new Promise<void>((resolve) => { if (!p || p.child.exitCode !== null || p.child.signalCode !== null) return resolve(); p.child.once("exit", () => resolve()); p.child.kill(); });
/** The base environment of every process here: PATH and the DuckDB location only, so no key of this machine's shell leaks in. */
const BASE_ENV: Record<string, string> = { PATH: process.env.PATH ?? "", ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), ...(process.env.HOME ? { HOME: process.env.HOME } : {}) };

const dir = mkdtempSync(join(tmpdir(), "console-signer-"));
const data = join(dir, "data");
mkdirSync(data);
writeFileSync(join(data, "orders.csv"), `order_id,customer,amount\n1,${MARKER} One,10.50\n2,${MARKER} Two,20.25\n3,Third,5.00\n`);
writeFileSync(join(dir, "data-sources.json"), JSON.stringify({ allowedRoots: [data], defaultFolder: data, defaultMode: "whole", extensions: [".csv"], maxBytes: { "*": 2_000_000 }, exclude: [], maxFiles: 20, hideFolders: ["_*"] }));
let modelCalls = 0;
const modelServer: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url === "/health") { res.writeHead(200).end("{}"); return; }
    modelCalls++;
    const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
    const sqlStep = body.messages.some((m) => m.role === "system" && m.content.startsWith("You write DuckDB SQL"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "standin", choices: [{ index: 0, message: { role: "assistant", content: sqlStep ? "```sql\nSELECT count(*) AS n FROM orders\n```" : "There are 3 orders." }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 } }));
  });
});

const catalogPath = join(dir, "catalog.json");
const mandateKeysPath = join(dir, "ap2-mandate-keys.json");
const tenantKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
const tenantKid = publicJwkOf(tenantKey).kid;
const pem = (k: ReturnType<typeof generateKeyPairSync>["privateKey"]) => k.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, "\\n");
const SELLER_ENV = { SIGNER_REQUEST_KEY: SIGNER_KEY, AP2_SIGNING_KEY: pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), RECEIPT_SIGNING_KEY: pem(generateKeyPairSync("ed25519").privateKey) };

let presidio: StubPresidio, gateway: TestGateway, analyst: Proc, paywall: Proc, signer: Proc, consoleProc: Proc;
let analystPort = 0, signerPort = 0, consolePort = 0, internalPort = 0, paywallUrl = "";

function signerArgs(port: number): string[] {
  const f = { port: String(port), "pricing-catalog": catalogPath, ...SIGNER_FEES, "cost-model": join(ROOT, "config/cost-model.json"), "terms-url": "https://chainaim.example/terms", "mandate-keys": mandateKeysPath };
  return [SIGNER, ...Object.entries(f).map(([k, v]) => `--${k}=${v}`)];
}
function consoleArgs(port: number, iport: number, over: Record<string, string | undefined> = {}): string[] {
  const f: Record<string, string | undefined> = {
    port: String(port), gateway: gateway.url, paywall: paywallUrl, analyst: `http://127.0.0.1:${analystPort}`, "data-config": join(dir, "data-sources.json"),
    "paid-jobs": "on", "near-wallet": "intear-wallet", "jobs-internal-port": String(iport), "pricing-catalog": catalogPath, "default-model": MODEL, ...CONSOLE_FEES,
    signer: "remote", "signer-url": `http://127.0.0.1:${signerPort}`, "signer-start-wait-sec": "5", ap2: "on", "price-round": "cent", receipts: "on", "receipt-dir": join(dir, "receipts"), ...over,
  };
  return [SERVER, ...Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => `--${k}=${v}`)];
}
/** The data plane's environment: the paid-jobs key and the signer's REQUEST key only; no AP2 or receipt key. */
const DATA_ENV = { ...BASE_ENV, PAID_JOBS_KEY: JOBS_KEY, SIGNER_REQUEST_KEY: SIGNER_KEY };
const consoleReady = (port: number) => (out: string) => out.includes(`http://127.0.0.1:${port}`) && out.includes("internal listener") && out.includes("receipts on");

before(async () => {
  const modelUrl = await listen(modelServer);
  presidio = await startStubPresidio();
  const raw = {
    version: "console-signer-test",
    models: [{ id: MODEL, zone: "local", capabilities: { contextWindow: 8192, maxOutputTokens: 2048, supportsTools: true, supportsVision: false }, pricing: { inputPerM: 0.5, outputPerM: 1.5 }, deployments: [{ id: "standin@0", adapter: "openai", baseUrl: `${modelUrl}/v1`, servedModel: "standin", healthUrl: `${modelUrl}/health` }] }],
    profiles: Object.fromEntries(["auto", "eco", "premium"].map((p) => [p, { SIMPLE: [MODEL], MEDIUM: [MODEL], COMPLEX: [MODEL], REASONING: [MODEL] }])),
  };
  writeFileSync(catalogPath, JSON.stringify(raw));
  writeFileSync(mandateKeysPath, JSON.stringify({ tenants: [{ tenant: "t02", accountId: TENANT_ACCOUNT, keys: [publicJwkOf(tenantKey)] }] }));
  gateway = await startTestGateway({ presidioUrl: presidio.url, catalog: validateCatalog(raw), gatewayKey: KEY });
  analystPort = await freePort();
  analyst = await start([ANALYST, "--port", String(analystPort), "--data-config", join(dir, "data-sources.json"), "--work-dir", join(dir, "work")], (o) => o.includes(String(analystPort)), BASE_ENV, "the analyst");
  internalPort = await freePort();
  paywall = await start([PAYWALL], (o) => o.includes('"url"'), { ...BASE_ENV, GATEWAY_URL: gateway.url, CHAINAIM_GATEWAY_KEY: KEY, PAID_JOBS: "on", PAID_JOBS_KEY: JOBS_KEY, PAID_JOBS_RESULT_URL: `http://127.0.0.1:${internalPort}`, PAID_JOBS_TTL_SEC: "900" }, "the paywall");
  paywallUrl = JSON.parse(paywall.out().split("\n").find((l) => l.includes('"url"'))!).url;
  signerPort = await freePort();
  signer = await start(signerArgs(signerPort), (o) => o.includes("[ca-control-signer] listening"), { ...BASE_ENV, ...SELLER_ENV }, "ca-control-signer");
  consolePort = await freePort();
  consoleProc = await start(consoleArgs(consolePort, internalPort), consoleReady(consolePort), DATA_ENV, "the console");
});
after(async () => {
  await stop(consoleProc);
  await stop(signer);
  await stop(paywall);
  await stop(analyst);
  await gateway?.close();
  await presidio?.close();
  await closeServer(modelServer);
  rmSync(dir, { recursive: true, force: true });
});

const offer = (port = consolePort) => call(port, "POST", "/offers", { "content-type": "application/json" }, JSON.stringify({ folder: data, question: QUESTION, model: MODEL, answerModel: MODEL, phrase: "llm", datasetId: "orders-demo" }));
const run = (jobId: string, notice: Record<string, string> | undefined, iport = internalPort) =>
  call(iport, "POST", `/internal/jobs/${jobId}/run`, { "x-jobs-key": JOBS_KEY, ...(notice ? { "content-type": "application/json" } : {}) }, notice ? JSON.stringify(notice) : undefined);
function mandateFor(ap2: { checkout: Record<string, unknown>; merchant_authorization: string }, nonce: string, over: { aud?: string } = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  return buildCheckoutMandate({ checkoutJwt: attachedJws(ap2.merchant_authorization, ap2.checkout), key: tenantKey, kid: tenantKid, aud: over.aud ?? "chainaim", nonce, iat, exp: iat + 300 });
}

describe("ARCH-663 two runtimes: the console holds no ChainAim key; ca-control-signer signs", () => {
  test("ARCH-663: the console starts with no AP2 or receipt key; its published keys are the signer's; the signer never sees the data", async () => {
    assert.match(consoleProc.out(), /signer remote: ChainAim's keys and prices at http:\/\/127\.0\.0\.1:\d+ \(ca-control-signer\); this console holds no signing key/);
    assert.equal("AP2_SIGNING_KEY" in DATA_ENV || "RECEIPT_SIGNING_KEY" in DATA_ENV, false);
    const keys = JSON.parse((await call(signerPort, "GET", "/.well-known/keys")).text);
    const ucp = JSON.parse((await call(consolePort, "GET", "/.well-known/ucp")).text);
    assert.deepEqual(ucp.keys, keys.ap2.keys, "the console publishes the signer's AP2 key");
    const r = await offer();
    assert.equal(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.equal(verifyMerchantAuthorization(j.ap2.merchant_authorization, j.ap2.checkout, keys.ap2.keys).ok, true);
    const cfg = JSON.parse((await call(consolePort, "GET", "/jobs/config")).text);
    assert.deepEqual([cfg.signer.mode, cfg.signer.url, cfg.mandates], ["remote", `http://127.0.0.1:${signerPort}`, "optional"]);
    // The control plane saw sizes, ids and amounts: no question, file name, folder or row.
    for (const leak of [MARKER, QUESTION, data, "orders.csv", "count(*)"]) assert.equal(signer.out().includes(leak), false, leak);
  });

  test("ARCH-662: the price is the signer's own (its margin), not the console's arithmetic", async () => {
    const j = JSON.parse((await offer()).text);
    const basis = { kind: "crossask", model: MODEL, answerModel: MODEL, phrase: "llm", userSql: false, totalBytes: j.basis.totalBytes, files: j.basis.files, maxPromptChars: j.basis.maxPromptChars, answerMaxPromptChars: j.basis.answerMaxPromptChars, maxTokens: j.basis.maxTokens, sqlRetries: j.basis.sqlRetries, answerMaxRows: 50 };
    const priced = await call(signerPort, "POST", "/v1/price", { "content-type": "application/json", "x-signer-key": SIGNER_KEY }, JSON.stringify({ kind: "offer", basis }));
    assert.equal(priced.status, 200, priced.text);
    assert.equal(j.amount, JSON.parse(priced.text).amount, "the offer is what the signer computed");
    assert.equal(JSON.parse(priced.text).breakdown.marginPct, "300", "with the signer's margin, not the console's 20 %");
  });
});

describe("ARCH-667 ARCH-668 the two-sided AP2 deal, estimate first", () => {
  test("ARCH-667 ARCH-668: estimate -> signed quote -> mandate -> signer verifies -> run -> settle -> receipt binding quote, mandate and payment", async () => {
    modelCalls = 0;
    const j = JSON.parse((await offer()).text);
    assert.equal(modelCalls, 0, "nothing runs before payment");
    const invoice = "INVSIGNER0001";
    const mandate = mandateFor(j.ap2, invoice);
    const r = await run(j.jobId, { invoiceId: invoice, checkoutMandate: mandate });
    assert.equal(r.status, 200, r.text);
    assert.equal(modelCalls, 2, "the query and the answer, after the mandate was verified");
    assert.match(consoleProc.out(), new RegExp(`"event":"mandate_verified","offerId":"${j.jobId}","kid":"${tenantKid}","tenant":"t02"`));
    const settlement = { transaction: "CGxBarfQAWkgXeMvUnrWyBwWv2fWtteotbXDH1ntHH3t", network: "near:testnet", payer: TENANT_ACCOUNT, invoiceId: invoice };
    assert.equal((await call(internalPort, "POST", `/internal/jobs/${j.jobId}/released`, { "x-jobs-key": JOBS_KEY, "content-type": "application/json" }, JSON.stringify(settlement))).status, 200);
    let got = { status: 0, text: "" };
    for (let i = 0; i < 50 && !(got.status === 200 && JSON.parse(got.text).receipt.settlement); i++) { got = await call(consolePort, "GET", `/jobs/${j.jobId}/receipt`); await new Promise((ok) => setTimeout(ok, 100)); }
    assert.equal(got.status, 200, got.text);
    const file = JSON.parse(got.text) as { receipt: SignedReceipt; publicKeyPem: string; ap2: unknown; mandate: string };
    const keys = JSON.parse((await call(signerPort, "GET", "/.well-known/keys")).text);
    assert.deepEqual(verifyReceipt(file.receipt, keys.receipt.publicKeyPem), { ok: true, settled: true }, "signed and settled by ca-control-signer's key");
    assert.deepEqual(file.receipt.body.mandate, { sha256: mandateSha256(mandate), kid: tenantKid, tenant: "t02", accountId: TENANT_ACCOUNT, nonce: invoice });
    assert.equal(file.mandate, mandate, "the receipt download carries the mandate it records");
    // Offline, with pinned keys only: verify-receipt checks the receipt, the signed quote and the buyer's mandate.
    const saved = join(dir, `chainaim-receipt-${j.jobId}.json`);
    writeFileSync(saved, got.text);
    const receiptPem = join(dir, "receipt-public-key.pem"), ap2Jwk = join(dir, "ap2-public-key.jwk.json");
    writeFileSync(receiptPem, keys.receipt.publicKeyPem);
    writeFileSync(ap2Jwk, JSON.stringify({ keys: keys.ap2.keys }));
    const v = spawnSync(process.execPath, [VERIFY, "--file", saved, "--public-key", receiptPem, "--ap2-public-key", ap2Jwk, "--mandate-keys", mandateKeysPath, "--result", "none"], { encoding: "utf8", env: BASE_ENV });
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /mandate +sha256 [0-9a-f]{64} · signed by tenant t02 \(chainaim-t02-seller\.testnet\)/);
    assert.match(v.stdout, /signed quote matches, checkout mandate matches/);
  });

  test("ARCH-667 ARCH-611: a refused mandate runs nothing and holds nothing (the paywall then settles nothing)", async () => {
    const j = JSON.parse((await offer()).text);
    modelCalls = 0;
    const wrongNonce = await run(j.jobId, { invoiceId: "INVSIGNER0002", checkoutMandate: mandateFor(j.ap2, "SOMEOTHERINVOICE") });
    assert.equal(wrongNonce.status, 422);
    assert.equal(JSON.parse(wrongNonce.text).code, "mandate_scope_mismatch");
    const wrongAud = await run(j.jobId, { invoiceId: "INVSIGNER0003", checkoutMandate: mandateFor(j.ap2, "INVSIGNER0003", { aud: "another-business" }) });
    assert.equal(JSON.parse(wrongAud.text).code, "mandate_scope_mismatch");
    // A mandate for another job's quote.
    const k = JSON.parse((await offer()).text);
    const crossed = await run(j.jobId, { invoiceId: "INVSIGNER0004", checkoutMandate: mandateFor(k.ap2, "INVSIGNER0004") });
    assert.equal(crossed.status, 422);
    const noInvoice = await run(j.jobId, { checkoutMandate: mandateFor(j.ap2, "INVSIGNER0005") });
    assert.equal(noInvoice.status, 422);
    assert.equal(modelCalls, 0, "no model call for a refused mandate");
    assert.equal((await call(internalPort, "GET", `/internal/jobs/${j.jobId}`, { "x-jobs-key": JOBS_KEY })).status, 404, "nothing held");
    assert.match(consoleProc.out(), /"event":"mandate_refused"/);
  });

  test("ARCH-667: --ap2-mandate required refuses a paid release that carries no mandate, before any model call", async () => {
    const port = await freePort(), iport = await freePort();
    const c = await start(consoleArgs(port, iport, { "ap2-mandate": "required", "receipt-dir": join(dir, "receipts-required") }), consoleReady(port), DATA_ENV, "the console (mandate required)");
    try {
      assert.match(c.out(), /checkout mandates required/);
      const j = JSON.parse((await offer(port)).text);
      modelCalls = 0;
      const r = await run(j.jobId, { invoiceId: "INVSIGNER0010" }, iport);
      assert.equal(r.status, 422);
      assert.equal(JSON.parse(r.text).code, "mandate_required");
      assert.equal(modelCalls, 0);
    } finally { await stop(c); }
  });
});

describe("ARCH-663 ARCH-611 start-up and an unreachable signer", () => {
  test("ARCH-663: --signer remote refuses seller-key flags and a signer that never answers, naming the URL", async () => {
    const withKey = spawnSync(process.execPath, consoleArgs(await freePort(), await freePort(), { "ap2-key-env": "AP2_SIGNING_KEY" }), { encoding: "utf8", timeout: 20_000, env: DATA_ENV });
    assert.notEqual(withKey.status, 0);
    assert.match(withKey.stderr, /--ap2-key-env is for --signer local/);
    const dead = await freePort();
    const down = spawnSync(process.execPath, consoleArgs(await freePort(), await freePort(), { "signer-url": `http://127.0.0.1:${dead}`, "signer-start-wait-sec": "0" }), { encoding: "utf8", timeout: 20_000, env: DATA_ENV });
    assert.notEqual(down.status, 0);
    assert.match(down.stderr, new RegExp(`--signer remote: http://127.0.0.1:${dead}/.well-known/keys did not answer`));
    const noReqKey = spawnSync(process.execPath, consoleArgs(await freePort(), await freePort()), { encoding: "utf8", timeout: 20_000, env: { ...DATA_ENV, SIGNER_REQUEST_KEY: "" } });
    assert.match(noReqKey.stderr, /--signer remote needs SIGNER_REQUEST_KEY/);
  });

  test("ARCH-611: with the signer down, nothing is quoted and a paid release runs nothing (502)", async () => {
    const j = JSON.parse((await offer()).text);
    await stop(signer);
    modelCalls = 0;
    const q = await offer();
    assert.equal(q.status, 502, q.text);
    assert.match(JSON.parse(q.text).error, /ChainAim's signer cannot be reached; nothing was signed/);
    const r = await run(j.jobId, { invoiceId: "INVSIGNER0020", checkoutMandate: mandateFor(j.ap2, "INVSIGNER0020") });
    assert.equal(r.status, 502, r.text);
    assert.equal(modelCalls, 0, "nothing ran");
  });
});
