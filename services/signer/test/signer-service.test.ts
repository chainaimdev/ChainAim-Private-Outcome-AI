/**
 * services/signer (privateAI-design-36 ARCH-660/661): the HTTP service on a loopback port, with real keys made per run and
 * the repository's pricing catalog and cost model. Also the process itself: it refuses to start without its keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachedJws, buildCheckoutMandate, publicJwkOf } from "../../../packages/ap2/src/index.ts";
import { signerHandler, signerServerConfig } from "../src/main.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAIN = join(ROOT, "services/signer/src/main.ts");
const pem = (k: ReturnType<typeof generateKeyPairSync>["privateKey"]) => k.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, "\\n");
const REQUEST_KEY = "r".repeat(40);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "signer-"));
  const tenant = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const mk = join(dir, "mandate-keys.json");
  writeFileSync(mk, JSON.stringify({ tenants: [{ tenant: "t02", accountId: "chainaim-t02-seller.testnet", keys: [publicJwkOf(tenant)] }] }));
  const catalog = join(dir, "catalog.json");
  writeFileSync(catalog, JSON.stringify({ models: [{ id: "nearai/deepseek-v4.1-flash", pricing: { inputPerM: "0.27", outputPerM: "1.10" } }] }));
  const env = {
    SIGNER_REQUEST_KEY: REQUEST_KEY,
    AP2_SIGNING_KEY: pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey),
    RECEIPT_SIGNING_KEY: pem(generateKeyPairSync("ed25519").privateKey),
  };
  const flags = {
    "pricing-catalog": catalog, "fee-per-model-call-usd": "0.001", "fee-analyst-usd": "0.001", "near-gas-fee-usd": "0.001", "margin-pct": "20", "min-price-usd": "0.01",
    "cost-model": join(ROOT, "config/cost-model.json"), "terms-url": "https://chainaim.example/terms", "mandate-keys": mk, port: "0",
  };
  return { dir, tenant, env, flags };
}

async function serve(cfg: ReturnType<typeof signerServerConfig>) {
  const lines: string[] = [];
  const server = createServer(signerHandler(cfg, (l) => lines.push(l)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, lines, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const post = (url: string, body: unknown, key: string | null = REQUEST_KEY) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(key !== null ? { "x-signer-key": key } : {}) }, body: JSON.stringify(body) });

const BASIS = { kind: "crossask", model: "nearai/deepseek-v4.1-flash", phrase: "llm", userSql: true, totalBytes: 5395, files: 2, maxPromptChars: 16000, answerMaxPromptChars: 12000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50 };

test("ARCH-660 service: public keys without a request key; every signing route needs X-Signer-Key; logs carry no body", async () => {
  const s = setup();
  const svc = await serve(signerServerConfig(s.flags, s.env));
  try {
    const h = await (await fetch(`${svc.url}/healthz`)).json();
    assert.equal(h.ok, true);
    assert.match(h.ap2Kid, /^[0-9a-f]{32}$/);
    const keys = await (await fetch(`${svc.url}/.well-known/keys`)).json();
    assert.equal(keys.ap2.keys.length, 1);
    assert.equal("d" in keys.ap2.keys[0], false, "a public key only");
    assert.match(keys.receipt.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.deepEqual(keys.mandateTenants, ["t02"]);
    for (const path of ["/v1/price", "/v1/quotes", "/v1/receipts", "/v1/receipts/settle", "/v1/mandates/verify"]) {
      assert.equal((await post(`${svc.url}${path}`, {}, null)).status, 401, path);
      assert.equal((await post(`${svc.url}${path}`, {}, "w".repeat(40))).status, 401, path);
    }
    const price = await post(`${svc.url}/v1/price`, { kind: "offer", basis: BASIS });
    assert.equal(price.status, 200);
    const q = await price.json();
    assert.match(q.amount, /^[1-9]\d*0000$/, "whole cents (AP2 totals)");
    const signed = await post(`${svc.url}/v1/quotes`, { jobId: "0123456789abcdef0123456789abcdef", expiresAt: Date.now() + 600_000, offer: { network: "near:testnet", asset: "usdc.fakes.testnet", payTo: "chainaim-payto-seller.testnet", amount: q.amount }, pricing: { kind: "offer", basis: BASIS }, sizeTolerancePct: 10, route: "nearai/deepseek-v4.1-flash", mode: "estimate-first" });
    assert.equal(signed.status, 200);
    const sq = await signed.json();
    assert.match(sq.merchant_authorization, /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/);
    // Logged: route, status, ms, job id. Never the request body, a key or a token.
    const all = svc.lines.join("\n");
    assert.ok(svc.lines.some((l) => JSON.parse(l).route === "/v1/quotes" && JSON.parse(l).jobId === "0123456789abcdef0123456789abcdef"));
    for (const secret of [REQUEST_KEY, sq.merchant_authorization, "usdc.fakes.testnet", "chainaim-payto-seller.testnet"]) assert.equal(all.includes(secret), false);
  } finally { await svc.close(); }
});

test("ARCH-661 service: a body carrying content is 400 naming the field; an amount the signer did not compute is 409", async () => {
  const s = setup();
  const svc = await serve(signerServerConfig(s.flags, s.env));
  try {
    const r = await post(`${svc.url}/v1/price`, { kind: "offer", basis: { ...BASIS, question: "Which customers are over their credit limit?" } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /\$\.basis\.question is not accepted/);
    const big = await post(`${svc.url}/v1/receipts`, { body: { rows: [[1, 2]] } });
    assert.equal(big.status, 400);
    const q = await (await post(`${svc.url}/v1/price`, { kind: "offer", basis: BASIS })).json();
    const wrong = await post(`${svc.url}/v1/quotes`, { jobId: "0123456789abcdef0123456789abcdef", expiresAt: Date.now() + 600_000, offer: { network: "near:testnet", asset: "usdc.fakes.testnet", payTo: "p.testnet", amount: String(Number(q.amount) + 10_000) }, pricing: { kind: "offer", basis: BASIS }, sizeTolerancePct: 10, route: "nearai/deepseek-v4.1-flash" });
    assert.equal(wrong.status, 409);
  } finally { await svc.close(); }
});

test("ARCH-667 service: a mandate verifies once (200), a replay or a wrong nonce is 422 with the AP2 code", async () => {
  const s = setup();
  const svc = await serve(signerServerConfig(s.flags, s.env));
  try {
    const q = await (await post(`${svc.url}/v1/price`, { kind: "offer", basis: BASIS })).json();
    const jobId = "0123456789abcdef0123456789abcdef";
    const sq = await (await post(`${svc.url}/v1/quotes`, { jobId, expiresAt: Date.now() + 600_000, offer: { network: "near:testnet", asset: "usdc.fakes.testnet", payTo: "p.testnet", amount: q.amount }, pricing: { kind: "offer", basis: BASIS }, sizeTolerancePct: 10, route: "nearai/deepseek-v4.1-flash" })).json();
    const ap2 = { checkout: sq.checkout, merchant_authorization: sq.merchant_authorization };
    const iat = Math.floor(Date.now() / 1000);
    const mandate = buildCheckoutMandate({ checkoutJwt: attachedJws(sq.merchant_authorization, sq.checkout), key: s.tenant, kid: publicJwkOf(s.tenant).kid, aud: "chainaim", nonce: "INV42", iat, exp: iat + 300 });
    const ok = await post(`${svc.url}/v1/mandates/verify`, { mandate, jobId, nonce: "INV42", ap2 });
    assert.equal(ok.status, 200);
    const v = await ok.json();
    assert.equal(v.tenant, "t02");
    assert.equal(v.accountId, "chainaim-t02-seller.testnet");
    const replay = await post(`${svc.url}/v1/mandates/verify`, { mandate, jobId, nonce: "INV42", ap2 });
    assert.equal(replay.status, 422);
    assert.equal((await replay.json()).code, "mandate_scope_mismatch");
    const otherNonce = await post(`${svc.url}/v1/mandates/verify`, { mandate, jobId, nonce: "INV43", ap2 });
    assert.equal((await otherNonce.json()).code, "mandate_scope_mismatch");
  } finally { await svc.close(); }
});

test("ARCH-660 process: refuses to start without the request key, the AP2 key or the receipt key, naming only the variable", () => {
  const s = setup();
  const args = [MAIN, ...Object.entries(s.flags).flatMap(([k, v]) => [`--${k}`, v])];
  const run = (env: Record<string, string>) => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "", ...env } });
  const noReq = run({ ...s.env, SIGNER_REQUEST_KEY: "short" });
  assert.equal(noReq.status, 2);
  assert.match(noReq.stderr, /SIGNER_REQUEST_KEY must hold the request key/);
  const noAp2 = run({ ...s.env, AP2_SIGNING_KEY: "" });
  assert.equal(noAp2.status, 2);
  assert.match(noAp2.stderr, /AP2_SIGNING_KEY is not set/);
  const noRcpt = run({ ...s.env, RECEIPT_SIGNING_KEY: "" });
  assert.match(noRcpt.stderr, /RECEIPT_SIGNING_KEY is not set/);
  for (const r of [noReq, noAp2, noRcpt]) for (const v of Object.values(s.env)) if (v.length > 10) assert.equal(r.stderr.includes(v), false, "no key value in a message");
});
