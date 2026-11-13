/**
 * services/signer --refunds (privateAI-design-37 ARCH-673/676): off by default (the signer is as it was), every refund
 * flag needs --refunds on, on needs the store, accounts and the payTo key from the environment (named, never printed),
 * and the image copies packages/near-refund but no key. The refund itself is proven end to end in
 * services/paywall/test/upfront-refund-e2e.test.ts (this service as a real process).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58Encode } from "../../../packages/near-refund/src/index.ts";
import { signerServerConfig } from "../src/main.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const pem = (k: ReturnType<typeof generateKeyPairSync>["privateKey"]) => k.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, "\\n");

function nearSecret(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return `ed25519:${base58Encode(Buffer.concat([privateKey.export({ type: "pkcs8", format: "der" }).subarray(16), publicKey.export({ type: "spki", format: "der" }).subarray(12)]))}`;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "signer-refunds-"));
  const catalog = join(dir, "catalog.json");
  writeFileSync(catalog, JSON.stringify({ models: [{ id: "nearai/deepseek-v4.1-flash", pricing: { inputPerM: "0.27", outputPerM: "1.10" } }] }));
  const secret = nearSecret();
  const env = { SIGNER_REQUEST_KEY: "r".repeat(40), AP2_SIGNING_KEY: pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), RECEIPT_SIGNING_KEY: pem(generateKeyPairSync("ed25519").privateKey), SELLER_NEAR_PRIVATE_KEY: secret };
  const base = { "pricing-catalog": catalog, "fee-per-model-call-usd": "0.001", "fee-analyst-usd": "0.001", "near-gas-fee-usd": "0.001", "margin-pct": "20", "min-price-usd": "0.01", "terms-url": "https://chainaim.example/terms" };
  const refunds = { refunds: "on", "refund-store": join(dir, "refunds"), "refund-account": "chainaim-payto-seller.testnet", "refund-usdc-contract": "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", "paid-tx-sender": "chainaim-relayer-seller.testnet" };
  return { dir, env, base, refunds, secret };
}

test("ARCH-676 --refunds is off by default and its flags need it on", () => {
  const s = setup();
  assert.equal(signerServerConfig(s.base, s.env).refunds, undefined);
  assert.throws(() => signerServerConfig({ ...s.base, "refund-store": s.dir }, s.env), /--refund-store needs --refunds on/);
  assert.throws(() => signerServerConfig({ ...s.base, refunds: "yes" }, s.env), /--refunds must be on or off/);
});

test("ARCH-676 --refunds on: each missing setting is named; the key error names the variable, never the value", () => {
  const s = setup();
  const cfg = signerServerConfig({ ...s.base, ...s.refunds }, s.env);
  assert.equal(cfg.refunds?.account, "chainaim-payto-seller.testnet");
  for (const [drop, re] of [["refund-store", /--refund-store DIR is required/], ["refund-account", /--refund-account must be a NEAR account id/], ["paid-tx-sender", /--paid-tx-sender must be a NEAR account id/], ["refund-usdc-contract", /--refund-usdc-contract must be a NEAR account id/]] as const) {
    const flags: Record<string, string> = { ...s.base, ...s.refunds };
    delete flags[drop];
    assert.throws(() => signerServerConfig(flags, s.env), re, drop);
  }
  assert.throws(() => signerServerConfig({ ...s.base, ...s.refunds }, { ...s.env, SELLER_NEAR_PRIVATE_KEY: "" }), /SELLER_NEAR_PRIVATE_KEY is not set/);
  assert.throws(() => signerServerConfig({ ...s.base, ...s.refunds, "refund-key-env": "MY_KEY" }, s.env), /MY_KEY is not set/);
  try { signerServerConfig({ ...s.base, ...s.refunds }, { ...s.env, SELLER_NEAR_PRIVATE_KEY: s.secret.slice(0, -3) + "AAA" }); } catch (e) { assert.equal((e as Error).message.includes(s.secret.slice(8, 30)), false); }
  assert.throws(() => signerServerConfig({ ...s.base, ...s.refunds, "refund-network": "near:devnet" }, s.env), /--refund-network must be near:testnet or near:mainnet/);
  assert.throws(() => signerServerConfig({ ...s.base, ...s.refunds, "near-rpc-url": "ftp://x" }, s.env), /--near-rpc-url must be an http\(s\) URL/);
  assert.throws(() => signerServerConfig({ ...s.base, ...s.refunds, "refund-min-near": "lots" }, s.env), /--refund-min-near/);
});

test("ARCH-676 the image carries packages/near-refund and a refunds volume, and no key; compose passes the key by name", () => {
  const dockerfile = readFileSync(join(ROOT, "services/signer/Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY packages\/near-refund\/src packages\/near-refund\/src/);
  assert.equal(/SELLER_NEAR_PRIVATE_KEY|ed25519:/.test(dockerfile.replace(/^#.*$/gm, "")), false, "no key in the image");
  const ignore = readFileSync(join(ROOT, "services/signer/Dockerfile.dockerignore"), "utf8");
  assert.match(ignore, /^!packages\/near-refund\/src$/m);
  const compose = readFileSync(join(ROOT, "services/signer/compose.yml"), "utf8");
  assert.match(compose, /^\s+- SELLER_NEAR_PRIVATE_KEY\r?$/m, "by name only");
  assert.match(compose, /chainaim-refunds:\/data\/refunds/);
});
