/**
 * privateAI-design-38 ARCH-680 / ARCH-681: the signer writes the limits it priced into the signed checkout, and checks
 * them member by member wherever a checkout comes back in. Real keys (generated per run), real packages/ap2 and
 * packages/offer; no stand-ins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { attachedJws, buildCheckoutMandate, publicJwkOf, signerFromKey as ap2SignerFromKey, verifyMerchantAuthorization } from "../../ap2/src/index.ts";
import { signerFromKey as receiptSignerFromKey } from "../../receipt/src/index.ts";
import { limitsOf, parseCostModel } from "../../offer/src/index.ts";
import { parseMandateRequest, parseQuoteRequest, SellerSigner, SignerInputError, type QuoteRequest } from "../src/index.ts";

const COST_MODEL = parseCostModel({
  version: 2, calibratedAt: "2026-11-13T00:39:00Z", machine: "test", source: "packages/signer limits test",
  tokensPerByte: "0.3", bytesPerChar: "1.1",
  units: { presidioPerKbUsd: "0.00001", analystBaseUsd: "0.000066", analystPerMbUsd: "0.000552", gatewayBaseUsd: "0.000325", gatewayPerKbPromptUsd: "0" },
  safetyPct: "136", safetyPctByUnit: { presidio: "136", analyst: "77", gateway: "81" },
});
const MODEL = "nearai/deepseek-v4.1-flash";
const PRICES = new Map([[MODEL, { inputPerM: "0.27", outputPerM: "1.10" }]]);
const FEES = { perModelCallUsd: "0.001", analystUsd: "0.001", nearGasUsd: "0.001", marginPct: "20", minPriceUsd: "0.01" };
const NOW = Date.parse("2026-11-13T05:00:00Z");
const JOB = "0123456789abcdef0123456789abcdef";
const BASIS = { kind: "crossask" as const, model: MODEL, phrase: "llm" as const, userSql: false, totalBytes: 2_054_495, files: 1, maxPromptChars: 16_000, answerMaxPromptChars: 8_000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50 };
const OFFER = { network: "near:testnet", asset: "usdc.fakes.testnet", payTo: "chainaim-payto-seller.testnet" };

function setup() {
  const tenantKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const registry = [{ tenant: "t02", accountId: "chainaim-t02-seller.testnet", keys: [publicJwkOf(tenantKey)] }];
  const signer = new SellerSigner({
    ap2: ap2SignerFromKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), receipt: receiptSignerFromKey(generateKeyPairSync("ed25519").privateKey),
    pricing: { prices: PRICES, fees: FEES, round: "cent", costModel: COST_MODEL }, termsUrl: "https://chainaim.example/terms",
    mandates: { registry, aud: "chainaim", skewSec: 30, maxLifetimeSec: 900 }, now: () => NOW,
  });
  return { signer, tenantKey };
}
function request(signer: SellerSigner, over: Record<string, unknown> = {}): Record<string, unknown> {
  const amount = signer.price({ kind: "offer", basis: BASIS }).amount;
  return { jobId: JOB, expiresAt: NOW + 900_000, offer: { ...OFFER, amount }, pricing: { kind: "offer", basis: BASIS }, route: MODEL, datasetId: "smb-erp-fin", mode: "estimate-first", sizeTolerancePct: 5, ...over };
}
const ext = (checkout: Record<string, unknown>) => checkout["dev.chainaim.job"] as Record<string, unknown>;

test("ARCH-680: an offer's signed checkout carries limits equal to the priced basis + modelCalls + the size tolerance", () => {
  const { signer } = setup();
  const signed = signer.signQuote(parseQuoteRequest(request(signer)));
  assert.deepEqual(ext(signed.checkout).limits, {
    model: MODEL, answerModel: MODEL, phrase: "llm", userSql: false, files: 1, totalBytes: 2_054_495, sizeTolerancePct: 5,
    maxPromptChars: 16_000, answerMaxPromptChars: 8_000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50, modelCalls: 3,
  });
  assert.equal((ext(signed.checkout).limits as { modelCalls: number }).modelCalls, signed.quote.breakdown.calls.length, "modelCalls is the priced call count");
  assert.deepEqual(ext(signed.checkout).limits, limitsOf(BASIS, 5));
  assert.equal(verifyMerchantAuthorization(signed.merchant_authorization, signed.checkout, [publicJwkOf(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey)]).ok, false);
});

test("ARCH-680: a metered (run-hold) quote carries no limits; sizeTolerancePct is required for an offer and refused for a metered job", () => {
  const { signer } = setup();
  const meter = [{ model: MODEL, promptTokens: 1200, completionTokens: 40 }];
  const amount = signer.price({ kind: "metered", meter }).amount;
  const metered = signer.signQuote(parseQuoteRequest({ jobId: JOB, expiresAt: NOW + 900_000, offer: { ...OFFER, amount }, pricing: { kind: "metered", meter }, route: MODEL }));
  assert.equal("limits" in ext(metered.checkout), false);
  const { sizeTolerancePct: _t, ...noTol } = request(signer);
  assert.throws(() => parseQuoteRequest(noTol), (e: Error) => e instanceof SignerInputError && /\$\.sizeTolerancePct must be a whole number from 0 to 100 for an offer/.test(e.message));
  assert.throws(() => parseQuoteRequest({ jobId: JOB, expiresAt: NOW + 900_000, offer: { ...OFFER, amount }, pricing: { kind: "metered", meter }, route: MODEL, sizeTolerancePct: 5 }), /\$\.sizeTolerancePct must be absent for a metered job/);
  assert.throws(() => parseQuoteRequest(request(signer, { sizeTolerancePct: 101 })), /\$\.sizeTolerancePct must be a whole number from 0 to 100/);
  // Called directly (not over the wire) without the tolerance: still refused, never signed without limits.
  assert.throws(() => signer.signQuote({ ...(parseQuoteRequest(request(signer)) as QuoteRequest), sizeTolerancePct: undefined }), /sizeTolerancePct is required for an offer/);
});

test("ARCH-681: limits coming back in are checked member by member; an extra member is 400 by name", () => {
  const { signer } = setup();
  const signed = signer.signQuote(parseQuoteRequest(request(signer)));
  const back = (limits: unknown, extExtra: Record<string, unknown> = {}) => ({
    mandate: "x", jobId: JOB, nonce: "INV1",
    ap2: { checkout: { ...signed.checkout, "dev.chainaim.job": { ...ext(signed.checkout), limits, ...extExtra } }, merchant_authorization: signed.merchant_authorization },
  });
  const L = ext(signed.checkout).limits as Record<string, unknown>;
  assert.doesNotThrow(() => parseMandateRequest(back(L)));
  assert.throws(() => parseMandateRequest(back({ ...L, question: "Which customers?" })), (e: Error) => e instanceof SignerInputError && /limits\.question is not accepted/.test(e.message));
  assert.throws(() => parseMandateRequest(back({ ...L, maxTokens: "2048" })), (e: Error) => e instanceof SignerInputError && /limits\.maxTokens must be a whole number/.test(e.message));
  assert.throws(() => parseMandateRequest(back({ ...L, model: "not a model" })), (e: Error) => e instanceof SignerInputError && /limits\.model must be a model id/.test(e.message));
  assert.throws(() => parseMandateRequest(back({ ...L, phrase: "long" })), /limits\.phrase must be llm or none/);
  assert.throws(() => parseMandateRequest(back(L, { rows: [[1]] })), (e: Error) => e instanceof SignerInputError && /\["dev\.chainaim\.job"\]\.rows is not accepted/.test(e.message));
});

test("ARCH-681 (design-38 §6): limits altered after signing fail the merchant authorization and the buyer's mandate", () => {
  const { signer, tenantKey } = setup();
  const signed = signer.signQuote(parseQuoteRequest(request(signer)));
  const L = ext(signed.checkout).limits as Record<string, unknown>;
  const altered = { ...signed.checkout, "dev.chainaim.job": { ...ext(signed.checkout), limits: { ...L, maxTokens: 65_536, modelCalls: 9 } } };
  assert.equal(verifyMerchantAuthorization(signed.merchant_authorization, altered, [signer.keys().ap2!.keys[0]]).ok, false, "the merchant authorization covers the limits");
  const iat = Math.floor(NOW / 1000);
  const mandate = buildCheckoutMandate({ checkoutJwt: attachedJws(signed.merchant_authorization, signed.checkout), key: tenantKey, kid: publicJwkOf(tenantKey).kid, aud: "chainaim", nonce: "INV7", iat, exp: iat + 300 });
  const v = signer.verifyMandate(parseMandateRequest({ mandate, jobId: JOB, nonce: "INV7", ap2: { checkout: altered, merchant_authorization: signed.merchant_authorization } }));
  assert.equal(v.ok ? "ok" : v.code, "mandate_scope_mismatch");
  const good = signer.verifyMandate(parseMandateRequest({ mandate, jobId: JOB, nonce: "INV7", ap2: { checkout: signed.checkout, merchant_authorization: signed.merchant_authorization } }));
  assert.equal(good.ok, true, "the unaltered signed limits pass");
});

test("ARCH-688: the console's --pay-only-attested mode is signed into an offer's limits; refused for a metered job or an unknown mode", () => {
  const { signer } = setup();
  const signed = signer.signQuote(parseQuoteRequest(request(signer, { attestation: "verified" })));
  assert.equal((ext(signed.checkout).limits as { attestation?: string }).attestation, "verified");
  assert.deepEqual(ext(signed.checkout).limits, limitsOf(BASIS, 5, "verified"));
  assert.equal("attestation" in (ext(signer.signQuote(parseQuoteRequest(request(signer))).checkout).limits as object), false, "not sent: not signed");
  assert.throws(() => parseQuoteRequest(request(signer, { attestation: "always" })), (e: Error) => e instanceof SignerInputError && /\$\.attestation must be off, evidence, verified/.test(e.message));
  const meter = [{ model: MODEL, promptTokens: 1200, completionTokens: 40 }];
  const amount = signer.price({ kind: "metered", meter }).amount;
  assert.throws(() => parseQuoteRequest({ jobId: JOB, expiresAt: NOW + 900_000, offer: { ...OFFER, amount }, pricing: { kind: "metered", meter }, route: MODEL, attestation: "verified" }), /\$\.attestation must be absent for a metered job/);
});
