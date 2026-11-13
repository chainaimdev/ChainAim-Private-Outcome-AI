/**
 * privateAI-design-41 ARCH-697 / ARCH-698: the receipt's optional egress[] (one entry per call: host, zone, sent-bytes hash
 * and length, masked kind counts, residual, data class). packages/receipt checkBody holds it to the calls (one entry per
 * call, in call order; on an attested call sentSha256 == reqSha256); the signer's allowlist checks each member. A receipt
 * without egress still signs and verifies. Real Ed25519 key (generated per run), real packages/receipt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { checkBody, filesRoot, signReceipt, signerFromKey, verifyReceipt, type ReceiptBody } from "../../receipt/src/index.ts";
import { parseReceiptBody, SignerInputError } from "../src/index.ts";

const JOB = "0123456789abcdef0123456789abcdef";
const REQ = "d".repeat(64);
const egressOf = (call: number, over: Record<string, unknown> = {}) => ({ call, destination: "cloud-api.near.ai", zone: "private-cloud", sentSha256: REQ, sentBytes: 812, masked: { PERSON: 1 }, residual: "pass", dataClass: "PII", ...over });

function body(extra: Record<string, unknown> = {}): ReceiptBody {
  const files = [{ name: "gl.csv", bytes: 1200, sha256: "a".repeat(64) }];
  return {
    v: 1, receiptId: "f".repeat(32), jobId: JOB, quoteId: JOB, route: "nearai/deepseek-v4.1-flash", datasetId: "smb-erp-fin", files, filesRoot: filesRoot(files),
    sqlSha256: "b".repeat(64), resultSha256: "c".repeat(64),
    calls: [{ servedModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017", zone: "private-cloud", attestStatus: "verified", reqSha256: REQ, respSha256: "e".repeat(64) }, { servedModel: "qwen3-8b", zone: "local", attestStatus: "none" }],
    price: { amountUnits: "20000", usdcDecimals: 6, priceUsd: "0.020000", quoteBasis: { pricing: "estimate-first", calls: 2 } },
    createdAt: "2026-11-14T05:01:00.000Z",
    ...extra,
  } as ReceiptBody;
}
const GOOD = [egressOf(0), egressOf(1, { destination: "127.0.0.1:11434", zone: "local", sentSha256: "9".repeat(64), masked: {}, dataClass: "none" })];

test("ARCH-697 a body with egress passes the signer's allowlist and checkBody, signs and verifies; v stays 1; none is fine too", () => {
  const b = body({ egress: GOOD });
  assert.deepEqual(parseReceiptBody(JSON.parse(JSON.stringify(b))).egress, GOOD);
  const signer = signerFromKey(generateKeyPairSync("ed25519").privateKey);
  const signed = signReceipt(b, signer);
  assert.equal(signed.body.v, 1);
  assert.deepEqual(verifyReceipt(signed, signer.publicKeyPem), { ok: true, settled: false });
  assert.deepEqual(verifyReceipt(signReceipt(body(), signer), signer.publicKeyPem), { ok: true, settled: false }, "a receipt without egress, as before");
});

test("ARCH-697 the signer's allowlist names a stray or bad member", () => {
  const bad: [unknown, RegExp][] = [
    [[{ ...egressOf(0), prompt: "hello" }, GOOD[1]], /\$\.body\.egress\[0\]\.prompt is not accepted/],
    [[egressOf(0, { destination: "https://cloud-api.near.ai/v1" }), GOOD[1]], /\$\.body\.egress\[0\]\.destination must be a host name/],
    [[egressOf(0, { masked: { "jane roe": 1 } }), GOOD[1]], /masked key must be an entity kind/],
    [[egressOf(0, { residual: "refused" }), GOOD[1]], /residual must be pass or off/],
  ];
  for (const [eg, re] of bad) assert.throws(() => parseReceiptBody(JSON.parse(JSON.stringify(body({ egress: eg })))), (x: Error) => x instanceof SignerInputError && re.test(x.message), re.source);
});

test("ARCH-698 checkBody: one entry per call, in call order, and on an attested call sentSha256 == reqSha256", () => {
  assert.throws(() => checkBody(body({ egress: [GOOD[0]] })), /receipt egress must be one entry per call/);
  assert.throws(() => checkBody(body({ egress: [GOOD[1], GOOD[0]] })), /receipt egress\[0\]\.call must be 0/);
  assert.throws(() => checkBody(body({ egress: [egressOf(0, { sentSha256: "7".repeat(64) }), GOOD[1]] })), /receipt egress\[0\]\.sentSha256 must be calls\[0\]\.reqSha256/);
  assert.throws(() => checkBody(body({ egress: [egressOf(0, { sentBytes: 1.5 }), GOOD[1]] })), /egress\[0\]\.sentBytes must be a whole number/);
  // The signer refuses the same body before signing anything.
  assert.throws(() => parseReceiptBody(JSON.parse(JSON.stringify(body({ egress: [egressOf(0, { sentSha256: "7".repeat(64) }), GOOD[1]] })))), (x: Error) => x instanceof SignerInputError && /attested request hash/.test(x.message));
  const signer = signerFromKey(generateKeyPairSync("ed25519").privateKey);
  assert.throws(() => signReceipt(body({ egress: [GOOD[0]] }), signer), /one entry per call/, "nothing signs a body that breaks the rule");
});
