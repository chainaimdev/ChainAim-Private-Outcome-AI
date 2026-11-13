/**
 * packages/signer (privateAI-design-36): the seller-side signer core. Real keys (generated per run), real packages/ap2,
 * packages/receipt and packages/offer arithmetic; no stand-ins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  attachedJws,
  buildCheckoutMandate,
  publicJwkOf,
  signerFromKey as ap2SignerFromKey,
  verifyCheckoutMandate,
  verifyMerchantAuthorization,
} from "../../ap2/src/index.ts";
import { filesRoot, signerFromKey as receiptSignerFromKey, verifyReceipt, type ReceiptBody } from "../../receipt/src/index.ts";
import { parseCostModel } from "../../offer/src/index.ts";
import {
  onlyFields,
  parseQuoteRequest,
  parseReceiptBody,
  parseReceiptRequest,
  SellerSigner,
  SignerInputError,
  SignerScopeError,
  type QuoteRequest,
} from "../src/index.ts";

const COST_MODEL = parseCostModel({
  version: 2, calibratedAt: "2026-11-13T00:39:00Z", machine: "test", source: "packages/signer test",
  tokensPerByte: "0.3", bytesPerChar: "1.1",
  units: { presidioPerKbUsd: "0.00001", analystBaseUsd: "0.000066", analystPerMbUsd: "0.000552", gatewayBaseUsd: "0.000325", gatewayPerKbPromptUsd: "0" },
  safetyPct: "136", safetyPctByUnit: { presidio: "136", analyst: "77", gateway: "81" },
});
const PRICES = new Map([["nearai/deepseek-v4.1-flash", { inputPerM: "0.27", outputPerM: "1.10" }]]);
const FEES = { perModelCallUsd: "0.001", analystUsd: "0.001", nearGasUsd: "0.001", marginPct: "20", minPriceUsd: "0.01" };

function newSigner(now = () => Date.parse("2026-11-13T05:00:00Z")) {
  const ap2Key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const receiptKey = generateKeyPairSync("ed25519").privateKey;
  const tenantKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const tenantJwk = publicJwkOf(tenantKey);
  const registry = [{ tenant: "t02", accountId: "chainaim-t02-seller.testnet", keys: [tenantJwk] }];
  const signer = new SellerSigner({
    ap2: ap2SignerFromKey(ap2Key), receipt: receiptSignerFromKey(receiptKey),
    pricing: { prices: PRICES, fees: FEES, round: "cent", costModel: COST_MODEL }, termsUrl: "https://chainaim.example/terms",
    mandates: { registry, aud: "chainaim", skewSec: 30, maxLifetimeSec: 900 }, now,
  });
  return { signer, tenantKey, tenantKid: tenantJwk.kid, registry, now };
}

const JOB = "0123456789abcdef0123456789abcdef";
const BASIS = { kind: "crossask" as const, model: "nearai/deepseek-v4.1-flash", phrase: "llm" as const, userSql: true, totalBytes: 2_054_495, files: 3, maxPromptChars: 16_000, answerMaxPromptChars: 12_000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50 };
const OFFER = { network: "near:testnet", asset: "usdc.fakes.testnet", payTo: "chainaim-payto-seller.testnet" };

function quoteRequest(signer: SellerSigner, over: Partial<QuoteRequest> = {}): QuoteRequest {
  const amount = signer.price({ kind: "offer", basis: BASIS }).amount;
  return { jobId: JOB, expiresAt: Date.parse("2026-11-13T05:15:00Z"), offer: { ...OFFER, amount }, pricing: { kind: "offer", basis: BASIS }, route: "nearai/deepseek-v4.1-flash", datasetId: "smb-erp-fin", mode: "estimate-first", sizeTolerancePct: 10, ...over };
}

test("ARCH-661 allowlist: a question, SQL or answer in any request is refused by field name, never signed", () => {
  const { signer } = newSigner();
  const q = quoteRequest(signer);
  assert.throws(() => parseQuoteRequest({ ...q, question: "What is our cash flow?" }), (e: Error) => e instanceof SignerInputError && /\$\.question is not accepted/.test(e.message));
  assert.throws(() => parseQuoteRequest({ ...q, pricing: { kind: "offer", basis: { ...BASIS, sql: "select 1" } } }), /\$\.pricing\.basis\.sql is not accepted/);
  assert.throws(() => parseQuoteRequest({ ...q, offer: { ...q.offer, memo: "x" } }), /\$\.offer\.memo is not accepted/);
  assert.throws(() => onlyFields({ rows: [] }, ["jobId"], "$"), /\$\.rows is not accepted: the signer takes ids, sizes, hashes and amounts only/);
});

test("ARCH-662 price: the signer computes the price itself and refuses an offer naming another amount (409)", () => {
  const { signer } = newSigner();
  const q = quoteRequest(signer);
  const signed = signer.signQuote(q);
  assert.equal(signed.quote.amount, q.offer.amount);
  assert.equal(verifyMerchantAuthorization(signed.merchant_authorization, signed.checkout, signer.keys().ap2!.keys).ok, true);
  assert.equal((signed.checkout["dev.chainaim.job"] as Record<string, unknown>).amountUnits, q.offer.amount);
  const cheaper = String(Number(q.offer.amount) - 10_000);
  assert.throws(() => signer.signQuote({ ...q, offer: { ...q.offer, amount: cheaper } }), (e: Error) => e instanceof SignerScopeError && /not the price this signer computed/.test(e.message));
});

function receiptBody(jobId: string, amountUnits: string, extra: Partial<ReceiptBody> & Record<string, unknown> = {}): ReceiptBody {
  const files = [{ name: "gl.csv", bytes: 1200, sha256: "a".repeat(64) }];
  return {
    v: 1, receiptId: "f".repeat(32), jobId, quoteId: jobId, route: "nearai/deepseek-v4.1-flash", datasetId: "smb-erp-fin", files, filesRoot: filesRoot(files),
    sqlSha256: "b".repeat(64), resultSha256: "c".repeat(64), calls: [{ servedModel: "deepseek/deepseek-v4.1-flash", attestStatus: "pending", reqSha256: "d".repeat(64), respSha256: "e".repeat(64) }],
    price: { amountUnits, usdcDecimals: 6, priceUsd: "0.02", quoteBasis: { pricing: "estimate-first", phrase: "llm", userSql: true, files: 1, totalBytes: 1200, calls: 1 } },
    createdAt: "2026-11-13T05:01:00.000Z", ...extra,
  } as ReceiptBody;
}

test("ARCH-661 allowlist: a receipt body with any member, file field or price field outside the list is refused", () => {
  const b = receiptBody(JOB, "20000");
  assert.doesNotThrow(() => parseReceiptBody(b));
  assert.throws(() => parseReceiptBody({ ...b, answer: "42" }), /\$\.body\.answer is not accepted/);
  assert.throws(() => parseReceiptBody({ ...b, files: [{ ...b.files[0], preview: "row1" }] }), /files\[0\]\.preview is not accepted/);
  assert.throws(() => parseReceiptBody({ ...b, files: [{ ...b.files[0], name: "../etc/passwd" }] }), /files\[0\]\.name must be a relative file name/);
  assert.throws(() => parseReceiptBody({ ...b, price: { ...b.price, quoteBasis: { ...b.price.quoteBasis, question: "x" } } }), /quoteBasis\.question is not accepted/);
  assert.throws(() => parseReceiptBody({ ...b, templateLabel: "line1\nline2" }), /templateLabel must be a template label/);
});

function mandateFor(t: ReturnType<typeof newSigner>, signed: { checkout: Record<string, unknown>; merchant_authorization: string }, nonce: string, over: { aud?: string; iat?: number; exp?: number } = {}) {
  const iat = over.iat ?? Math.floor(t.now() / 1000);
  return buildCheckoutMandate({ checkoutJwt: attachedJws(signed.merchant_authorization, signed.checkout), key: t.tenantKey, kid: t.tenantKid, aud: over.aud ?? "chainaim", nonce, iat, exp: over.exp ?? iat + 300 });
}

test("ARCH-665 mandate: the closed checkout mandate round-trips and every tampered part is refused with its AP2 code", () => {
  const t = newSigner();
  const signed = t.signer.signQuote(quoteRequest(t.signer));
  const m = mandateFor(t, signed, "03CE96C0A500456B8152B722CDA56B5C");
  const now = Math.floor(t.now() / 1000);
  const ok = verifyCheckoutMandate(m, { registry: t.registry, aud: "chainaim", nonce: "03CE96C0A500456B8152B722CDA56B5C", now });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.tenant, "t02");
    assert.equal(ok.checkoutJwt, attachedJws(signed.merchant_authorization, signed.checkout));
  }
  const parts = m.split("~");
  const [h, p] = parts[0].split(".");
  const code = (x: unknown, c: Parameters<typeof verifyCheckoutMandate>[1] = { registry: t.registry, aud: "chainaim", nonce: "03CE96C0A500456B8152B722CDA56B5C", now }) => { const v = verifyCheckoutMandate(x, c); return v.ok ? "ok" : v.code; };
  assert.equal(code(undefined), "mandate_required");
  assert.equal(code(m, { registry: t.registry, aud: "chainaim", nonce: "ANOTHERINVOICE", now }), "mandate_scope_mismatch");
  assert.equal(code(m, { registry: t.registry, aud: "someone-else", nonce: "03CE96C0A500456B8152B722CDA56B5C", now }), "mandate_scope_mismatch");
  assert.equal(code(m, { registry: t.registry, aud: "chainaim", now: now + 3600 }), "mandate_expired");
  assert.equal(code(m, { registry: [{ tenant: "t01", accountId: "a.testnet", keys: [publicJwkOf(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey)] }], aud: "chainaim", now }), "agent_missing_key");
  // A swapped checkout disclosure breaks _sd / sd_hash; a re-encoded payload breaks the signature.
  const other = t.signer.signQuote(quoteRequest(t.signer, { jobId: "fedcba9876543210fedcba9876543210" }));
  const otherD1 = mandateFor(t, other, "03CE96C0A500456B8152B722CDA56B5C").split("~")[2];
  assert.equal(code(`${parts[0]}~${parts[1]}~${otherD1}~`), "mandate_invalid_signature");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), nonce: "X" })).toString("base64url");
  assert.equal(code(`${h}.${forged}.${parts[0].split(".")[2]}~${parts[1]}~${parts[2]}~`), "mandate_invalid_signature");
  assert.equal(code(m.slice(0, -1)), "mandate_invalid_signature");
});

test("ARCH-667 verifyMandate: accepted once per invoice, refused for another job's quote or a quote this signer did not sign", () => {
  const t = newSigner();
  const signed = t.signer.signQuote(quoteRequest(t.signer));
  const ap2 = { checkout: signed.checkout, merchant_authorization: signed.merchant_authorization };
  const nonce = "INV0001";
  const first = t.signer.verifyMandate({ mandate: mandateFor(t, signed, nonce), jobId: JOB, nonce, ap2 });
  assert.equal(first.ok, true);
  const again = t.signer.verifyMandate({ mandate: mandateFor(t, signed, nonce), jobId: JOB, nonce, ap2 });
  assert.deepEqual(again.ok ? "ok" : again.code, "mandate_scope_mismatch");
  // A mandate for job A presented with job B's quote.
  const other = t.signer.signQuote(quoteRequest(t.signer, { jobId: "fedcba9876543210fedcba9876543210" }));
  const crossed = t.signer.verifyMandate({ mandate: mandateFor(t, signed, "INV0002"), jobId: "fedcba9876543210fedcba9876543210", nonce: "INV0002", ap2: { checkout: other.checkout, merchant_authorization: other.merchant_authorization } });
  assert.equal(crossed.ok ? "ok" : crossed.code, "mandate_scope_mismatch");
  // A quote signed by another business key.
  const stranger = newSigner().signer.signQuote(quoteRequest(t.signer));
  const foreign = t.signer.verifyMandate({ mandate: mandateFor(t, stranger, "INV0003"), jobId: JOB, nonce: "INV0003", ap2: { checkout: stranger.checkout, merchant_authorization: stranger.merchant_authorization } });
  assert.equal(foreign.ok ? "ok" : foreign.code, "mandate_scope_mismatch");
});

test("ARCH-668 receipt: binds the signed quote and the verified mandate; settlement must pay the mandate's invoice from its tenant", () => {
  const t = newSigner();
  const signed = t.signer.signQuote(quoteRequest(t.signer));
  const ap2 = { checkout: signed.checkout, merchant_authorization: signed.merchant_authorization };
  const nonce = "03CE96C0A500456B8152B722CDA56B5C";
  const mandate = mandateFor(t, signed, nonce);
  const v = t.signer.verifyMandate({ mandate, jobId: JOB, nonce, ap2 });
  assert.ok(v.ok);
  const ref = { sha256: v.sha256, kid: v.kid, tenant: v.tenant, accountId: v.accountId, nonce: v.nonce };
  const body = receiptBody(JOB, signed.quote.amount, { merchantAuthSha256: signed.merchantAuthSha256, mandate: ref });
  assert.throws(() => t.signer.signReceipt(parseReceiptRequest({ body, ap2 })), /\$\.mandate and \$\.ap2 are required/);
  assert.throws(() => t.signer.signReceipt(parseReceiptRequest({ body: { ...body, mandate: { ...ref, tenant: "t01" } }, ap2, mandate })), /not this mandate/);
  assert.throws(() => t.signer.signReceipt(parseReceiptRequest({ body: receiptBody(JOB, "990000", { merchantAuthSha256: signed.merchantAuthSha256 }), ap2 })), /amount is not this receipt's amount/);
  const r = t.signer.signReceipt(parseReceiptRequest({ body, ap2, mandate }));
  assert.equal(verifyReceipt(r, t.signer.keys().receipt!.publicKeyPem).ok, true);
  const settlement = { network: "near:testnet", transaction: "CGxBarfQAWkgXeMvUnrWyBwWv2fWtteotbXDH1ntHH3t", invoiceId: nonce, payer: "chainaim-t02-seller.testnet", settledAt: "2026-11-13T05:02:00.000Z" };
  assert.throws(() => t.signer.settle({ receipt: r, settlement: { ...settlement, invoiceId: "OTHERINVOICE" } }), /not the one the checkout mandate permitted/);
  assert.throws(() => t.signer.settle({ receipt: r, settlement: { ...settlement, payer: "someone.testnet" } }), /another account than the mandate's tenant/);
  const s = t.signer.settle({ receipt: r, settlement });
  const vv = verifyReceipt(s, t.signer.keys().receipt!.publicKeyPem);
  assert.deepEqual(vv, { ok: true, settled: true });
  // A receipt signed by another key is not settled here.
  const stranger = newSigner().signer;
  assert.throws(() => stranger.settle({ receipt: r, settlement }), /not signed by this signer/);
});
