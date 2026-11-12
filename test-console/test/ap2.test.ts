/**
 * The console's AP2 signed quote (privateAI-design-33 ARCH-628): config flags, the job as a UCP checkout, the merchant
 * authorization verified with packages/ap2 (the same code the agent uses), and the /.well-known/ucp profile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { verifyMerchantAuthorization, merchantAuthSha256, AP2_CAPABILITY } from "../../packages/ap2/src/index.ts";
import { ap2Answer, ap2Config, CHECKOUT_CAPABILITY, JOB_EXTENSION, jobCheckout, signJobCheckout, ucpProfile } from "../console/ap2.ts";

const pem = (k: ReturnType<typeof generateKeyPairSync>["privateKey"]) => k.export({ type: "pkcs8", format: "pem" }).toString();
const EC = pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
const ED = pem(generateKeyPairSync("ed25519").privateKey);
const TERMS = "https://example.org/terms";
const JOB = "0123456789abcdef0123456789abcdef";
const OFFER = { network: "near:testnet", asset: "usdc.chainaim-test.testnet", payTo: "merchant.chainaim-test.testnet", amount: "20000" };
const INPUT = { jobId: JOB, route: "bedrock/nemotron-nano-3-30b", amount: "20000", expiresAt: Date.parse("2026-11-11T20:00:00Z"), offer: OFFER };

test("ARCH-628: --ap2 off by default; on needs --paid-jobs on, a terms URL and an EC P-256 key; the key never in a message", () => {
  assert.equal(ap2Config({}, {}, true), undefined);
  assert.equal(ap2Config({ ap2: "off" }, {}, false), undefined);
  assert.throws(() => ap2Config({ ap2: "yes" }, {}, true), /--ap2 must be on or off/);
  assert.throws(() => ap2Config({ "ap2-terms-url": TERMS }, {}, true), /--ap2-terms-url needs --ap2 on/);
  const on = { ap2: "on", "ap2-terms-url": TERMS };
  assert.throws(() => ap2Config(on, { AP2_SIGNING_KEY: EC }, false), /needs --paid-jobs on/);
  assert.throws(() => ap2Config({ ap2: "on" }, { AP2_SIGNING_KEY: EC }, true), /needs --ap2-terms-url/);
  assert.throws(() => ap2Config({ ...on, "ap2-terms-url": "ftp://x" }, { AP2_SIGNING_KEY: EC }, true), /http\(s\) URL/);
  assert.throws(() => ap2Config({ ...on, "ap2-alg": "EdDSA" }, { AP2_SIGNING_KEY: EC }, true), /--ap2-alg must be one of ES256/);
  assert.throws(() => ap2Config({ ...on, "ap2-key-env": "bad name" }, {}, true), /environment variable name/);
  assert.throws(() => ap2Config(on, {}, true), /AP2_SIGNING_KEY/);
  assert.throws(() => ap2Config(on, { AP2_SIGNING_KEY: ED }, true), (e: Error) => /P-256/.test(e.message) && !e.message.includes("PRIVATE KEY"));
  const c = ap2Config({ ...on, "ap2-key-env": "MY_AP2" }, { MY_AP2: EC }, true)!;
  assert.deepEqual([c.alg, c.keyEnv, c.termsUrl, c.signer.kid.length], ["ES256", "MY_AP2", TERMS, 32]);
});

test("ARCH-628: the job as a UCP checkout: required members, whole cents, where the money goes", () => {
  const ck = jobCheckout({ ...INPUT, termsUrl: TERMS, datasetId: "chainaim3003", filesRoot: "a".repeat(64) });
  for (const m of ["ucp", "id", "line_items", "status", "currency", "totals", "links"]) assert.ok(m in ck, m);
  assert.equal(ck.id, JOB);
  assert.equal(ck.currency, "USD");
  assert.equal(ck.status, "ready_for_complete");
  assert.deepEqual(ck.totals, [{ type: "subtotal", amount: 2 }, { type: "total", amount: 2 }]);
  assert.equal(ck.expires_at, "2026-11-11T20:00:00.000Z");
  assert.deepEqual(ck[JOB_EXTENSION], { network: "near:testnet", asset: OFFER.asset, payTo: OFFER.payTo, amountUnits: "20000", usdcDecimals: 6, datasetId: "chainaim3003", filesRoot: "a".repeat(64) });
  const ucp = ck.ucp as { capabilities: Record<string, unknown> };
  assert.deepEqual(Object.keys(ucp.capabilities).sort(), [AP2_CAPABILITY, CHECKOUT_CAPABILITY].sort());
  assert.ok(!("datasetId" in (jobCheckout({ ...INPUT, termsUrl: TERMS })[JOB_EXTENSION] as object)), "no dataset fields without receipts");
  assert.throws(() => jobCheckout({ ...INPUT, amount: "12001", offer: { ...OFFER, amount: "12001" }, termsUrl: TERMS }), /whole number of cents/);
  assert.throws(() => jobCheckout({ ...INPUT, offer: { ...OFFER, amount: "30000" }, termsUrl: TERMS }), /another amount/);
  assert.throws(() => jobCheckout({ ...INPUT, jobId: "x", termsUrl: TERMS }), /jobId/);
});

test("ARCH-628: the signed quote verifies with the published key, and any change to price, payee or id breaks it", () => {
  const cfg = ap2Config({ ap2: "on", "ap2-terms-url": TERMS }, { AP2_SIGNING_KEY: EC }, true)!;
  const h = signJobCheckout(cfg, INPUT);
  assert.equal(h.kid, cfg.signer.kid);
  assert.equal(h.merchantAuthSha256, merchantAuthSha256(h.merchantAuthorization));
  const profile = ucpProfile(cfg) as { keys: unknown[]; ucp: Record<string, unknown> };
  assert.deepEqual(verifyMerchantAuthorization(h.merchantAuthorization, h.checkout, profile.keys), { ok: true, kid: cfg.signer.kid, alg: "ES256" });
  const tamper = (f: (c: Record<string, any>) => void) => { const c = structuredClone(h.checkout) as Record<string, any>; f(c); return verifyMerchantAuthorization(h.merchantAuthorization, c, profile.keys); };
  for (const f of [(c: any) => { c.totals[1].amount = 1; }, (c: any) => { c[JOB_EXTENSION].payTo = "evil.testnet"; }, (c: any) => { c[JOB_EXTENSION].amountUnits = "10000"; }, (c: any) => { c.id = "f".repeat(32); }]) {
    const v = tamper(f);
    assert.equal(v.ok, false);
    assert.equal((v as { code: string }).code, "merchant_authorization_invalid");
  }
  assert.deepEqual(Object.keys(ap2Answer(h)).sort(), ["checkout", "merchant_authorization"]);
  for (const m of ["version", "services", "payment_handlers"]) assert.ok(m in profile.ucp, m);
  assert.deepEqual(profile.keys, [cfg.signer.publicJwk]);
});
