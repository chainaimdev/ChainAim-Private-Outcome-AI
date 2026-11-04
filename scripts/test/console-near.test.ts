/**
 * The test console's NEAR paid chat (test-console/console/server.ts, DESIGN "private-ai-NEAR" 5.3): run as a real
 * process against a stand-in paywall. Without --near-wallet nothing NEAR is served and the page's headers are as
 * before (no CSP of its own); with it, near-wallet.js and the NEAR quote are served, and a NEAR payment goes through
 * the unchanged /paid/chat relay: to the paywall, without the gateway key, with nothing of it in the log.
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../../test-console/console/server.ts", import.meta.url));
const NEAR_BUNDLE = fileURLToPath(new URL("../../services/web/public/near-wallet.js", import.meta.url));
const KEY = readFileSync(new URL("../../test-console/local-gateway-key.txt", import.meta.url), "utf8").trim();
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const NEAR = { scheme: "exact", network: "near:testnet", asset: USDC, amount: "10000", payTo: "merchant.chainaim-test.testnet", maxTimeoutSeconds: 600, extra: { invoiceId: "I1" } };
const XRPL = { scheme: "exact", network: "xrpl:1", amount: "0.01", asset: "524C555344000000000000000000000000000000", payTo: "rwaugYNb1VYhPVhV3oEa77Pa9itayatbJd", extra: { issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" } };
const QUOTE = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [XRPL, NEAR] })).toString("base64");
const TEXT = "Hi <C_PERSON_1>, a private question";

/** A stand-in paywall: 402 with both offers, or 200 with a receipt when a payment is attached. It records what reached it. */
const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
const paywall: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    seen.push({ headers: req.headers, body });
    if (!req.headers["payment-signature"]) { res.writeHead(402, { "content-type": "application/json", "payment-required": QUOTE }); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json", "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "TXHASH", network: "near:testnet" })).toString("base64") });
    res.end(JSON.stringify({ choices: [{ message: { content: "answered" } }] }));
  });
});

const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });

type Console = { port: number; child: ChildProcess; out: () => string };
async function startConsole(extra: string[]): Promise<Console> {
  const port = await freePort();
  const paywallUrl = `http://127.0.0.1:${(paywall.address() as AddressInfo).port}`;
  const child = spawn(process.execPath, [SERVER, "--port", String(port), "--paywall", paywallUrl, "--gateway", "http://127.0.0.1:9", ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the console did not start: ${out}`)), 15_000);
    child.stdout!.on("data", () => { if (out.includes(`http://127.0.0.1:${port}`)) { clearTimeout(t); resolve(); } });
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`the console exited ${code}: ${out}`)); });
  });
  return { port, child, out: () => out };
}
const stop = (c: Console) => new Promise<void>((resolve) => { if (c.child.exitCode !== null) return resolve(); c.child.once("exit", () => resolve()); c.child.kill(); });

/** A plain request with no keep-alive (a pooled socket still closing at exit can crash Node on Windows). */
function call(c: Console, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: c.port, method, path, agent: false, headers: { host: `127.0.0.1:${c.port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

before(() => new Promise<void>((resolve) => paywall.listen(0, "127.0.0.1", () => resolve())));
after(() => new Promise<void>((resolve) => paywall.close(() => resolve())));

describe("test console without --near-wallet", () => {
  let c: Console;
  before(async () => { c = await startConsole([]); });
  after(() => stop(c));

  test("NEAR-5.3 the page, its headers and the Crossmark bundle are as before; nothing NEAR is served", async () => {
    const page = await call(c, "GET", "/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], undefined, "the console page sends no CSP of its own, as before");
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.equal((await call(c, "GET", "/wallet.js")).status, 200);
    assert.equal((await call(c, "GET", "/near-wallet.js")).status, 404);
    assert.equal((await call(c, "GET", "/paid/near")).status, 404);
    assert.doesNotMatch(c.out(), /NEAR wallet/);
  });
});

describe("test console with --near-wallet intear-wallet", () => {
  let c: Console;
  before(async () => { c = await startConsole(["--near-wallet", "intear-wallet", "--near-wallet-bundle", NEAR_BUNDLE]); });
  after(() => stop(c));

  test("NEAR-5.3 serves the web page's NEAR bundle unchanged, and the page still sends no CSP", async () => {
    const r = await call(c, "GET", "/near-wallet.js");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"] ?? "", /javascript/);
    assert.equal(r.text, readFileSync(NEAR_BUNDLE, "utf8"));
    assert.equal((await call(c, "GET", "/")).headers["content-security-policy"], undefined);
    assert.match(c.out(), /NEAR wallet: intear-wallet/);
  });

  test("NEAR-5.3 /paid/near gives the paywall's NEAR offer, its dollar price and the wallet", async () => {
    const r = await call(c, "GET", "/paid/near");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { network: "near:testnet", asset: USDC, payTo: NEAR.payTo, amount: "10000", price: 0.01, wallet: "intear-wallet", walletName: "Intear Wallet" });
  });

  test("NEAR-5.3 a NEAR payment goes through /paid/chat unchanged, without the gateway key, and the log holds neither it nor the text", async () => {
    // The PAYMENT-SIGNATURE shape services/web/src/near-payment.ts nearPaymentHeader builds (x402 v2; built here, as this unit may not import services/web).
    const payload = { signedDelegateAction: Buffer.from("signed delegate bytes from the wallet").toString("base64") };
    const signature = Buffer.from(JSON.stringify({ x402Version: 2, accepted: NEAR, payload, resource: { url: "http://127.0.0.1/paid/chat" } })).toString("base64");
    const body = JSON.stringify({ model: "chainaim/auto", messages: [{ role: "user", content: TEXT }] });
    seen.length = 0;
    const r = await call(c, "POST", "/paid/chat", { "content-type": "application/json", "payment-signature": signature }, body);
    assert.equal(r.status, 200);
    assert.ok(r.headers["payment-response"], "the receipt is passed back");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers["payment-signature"], signature, "the payment reaches the paywall byte for byte");
    assert.equal(seen[0].body, body);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.ok(!JSON.stringify(seen[0].headers).includes(KEY), "the gateway key is never added");
    await new Promise((ok) => setTimeout(ok, 100));
    assert.match(c.out(), /"route":"paid-chat","status":200,"withPayment":true/);
    assert.ok(!c.out().includes(signature) && !c.out().includes(TEXT) && !c.out().includes("TXHASH"), "no payment, text or receipt in the log");
  });
});

test("NEAR-5.3 --near-wallet accepts only the wallets services/web allows", () => {
  const r = spawnSync(process.execPath, [SERVER, "--port", "0", "--near-wallet", "meteor-wallet"], { encoding: "utf8", timeout: 15_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--near-wallet must be one of intear-wallet, got meteor-wallet/);
});
