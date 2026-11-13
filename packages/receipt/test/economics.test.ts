import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  addSettlement,
  checkBody,
  economicsOf,
  filesRoot,
  resultSha256,
  sha256Hex,
  signReceipt,
  signRefund,
  signerFromKey,
  verifyReceipt,
  verifyRefund,
  type ReceiptBody,
} from "../src/index.ts";

const h = (s: string): string => sha256Hex(s);
const breakdown = { modelUsd: "0.004210", callFeesUsd: "0.002000", analystUsd: "0.001000", nearGasUsd: "0.000500" };

function body(price: ReceiptBody["price"]): ReceiptBody {
  const files = [{ name: "ledger.csv", bytes: 1200, sha256: h("ledger") }];
  return {
    v: 1, receiptId: "r-1", jobId: "0123456789abcdef0123456789abcdef", quoteId: "q-1", route: "nearai", datasetId: "smb-fin-1",
    files, filesRoot: filesRoot(files), sqlSha256: h("select 1"), resultSha256: resultSha256({ rows: [] }),
    calls: [{ servedModel: "m", reqSha256: h("req"), respSha256: h("resp"), attestStatus: "verified" }],
    price, createdAt: "2026-11-13T10:00:00.000Z",
  };
}

test("ARCH-690 economicsOf: exact decimals in micros, cost = model + gas, margin = price - cost", () => {
  const e = economicsOf("0.020000", "0.010000", breakdown);
  assert.deepEqual(e, {
    costBasis: "catalog", nearAiCostUsd: "0.004210", callFeesUsd: "0.002000", analystUsd: "0.001000", nearGasUsd: "0.000500",
    costUsd: "0.004710", marginUsd: "0.015290", overrunAbsorbedUsd: "0.000000",
  });
  // A price with fewer decimals is read exactly ("0.02" = 20000 micros).
  assert.equal(economicsOf("0.02", "0.01", breakdown).marginUsd, "0.015290");
});

test("ARCH-690 economicsOf: negative margin and the overrun the firm quote absorbed", () => {
  const e = economicsOf("0.001000", "0.012000", breakdown);
  assert.equal(e.costUsd, "0.004710");
  assert.equal(e.marginUsd, "-0.003710");
  assert.equal(e.overrunAbsorbedUsd, "0.011000");
  assert.throws(() => economicsOf("0.0000001", "0.01", breakdown), /priceUsd must be a decimal USD amount with at most 6 decimals/);
  assert.throws(() => economicsOf("0.02", "0.01", { ...breakdown, modelUsd: "-0.000001" }), /breakdown.modelUsd must not be negative/);
});

test("ARCH-690 checkBody enforces the identities: a body whose numbers do not add up is refused", () => {
  const price = { amountUnits: "20000", usdcDecimals: 6, priceUsd: "0.020000", quoteBasis: { calls: 1 }, actualUsd: "0.010000" };
  const good = body({ ...price, economics: economicsOf("0.020000", "0.010000", breakdown) });
  checkBody(good);
  const e = good.price.economics!;
  assert.throws(() => checkBody(body({ ...price, economics: { ...e, marginUsd: "0.020000" } })), /price.economics.marginUsd must be priceUsd - costUsd/);
  assert.throws(() => checkBody(body({ ...price, economics: { ...e, costUsd: "0.000001" } })), /price.economics.costUsd must be nearAiCostUsd \+ nearGasUsd/);
  assert.throws(() => checkBody(body({ ...price, economics: { ...e, overrunAbsorbedUsd: "0.000001" } })), /overrunAbsorbedUsd must be max\(0, actualUsd - priceUsd\)/);
  assert.throws(() => checkBody(body({ ...price, economics: { ...e, nearAiCostUsd: "0.0042" } })), /nearAiCostUsd must be a USD amount with 6 decimals/);
  assert.throws(() => checkBody(body({ ...price, economics: { ...e, extra: "1" } as typeof e })), /price.economics.extra must be absent/);
  assert.throws(() => checkBody(body({ ...price, amountUnits: "30000", economics: e })), /priced at the paid amount/);
  const { actualUsd: _a, ...noActual } = price;
  assert.throws(() => checkBody(body({ ...noActual, economics: e })), /accompanied by price.actualUsd/);
  // Without economics, as every receipt before v2.1.0: still valid.
  checkBody(body(price));
});

test("ARCH-691 settlement.flow is signed and verified; a settlement without it still verifies", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = signerFromKey(privateKey);
  const price = { amountUnits: "20000", usdcDecimals: 6, priceUsd: "0.020000", quoteBasis: { calls: 1 } };
  const r = signReceipt(body(price), signer);
  const base = { network: "near:testnet", transaction: "4vv6QJSaRzKmGWAAc4vv6QJSaRzKm", invoiceId: "INV1", payer: "t01.testnet", settledAt: "2026-11-13T10:01:00.000Z" };
  const up = addSettlement(r, { ...base, flow: "upfront" }, signer);
  assert.deepEqual(verifyReceipt(up, signer.publicKeyPem), { ok: true, settled: true });
  const changed = { ...up, settlement: { ...up.settlement!, flow: "authorization" as const } };
  assert.deepEqual(verifyReceipt(changed, signer.publicKeyPem), { ok: false, reason: "the settlement signature does not verify" });
  assert.deepEqual(verifyReceipt(addSettlement(r, base, signer), signer.publicKeyPem), { ok: true, settled: true });
  assert.throws(() => addSettlement(r, { ...base, flow: "later" as "upfront" }, signer), /settlement.flow must be authorization or upfront/);
});

test("ARCH-694 a refund record signed with the receipt key verifies; a tampered one does not", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = signerFromKey(privateKey);
  const rec = signRefund({
    status: "refunded", invoiceId: "INV1", jobId: "0123456789abcdef0123456789abcdef", paidTx: "4vv6QJSaRzKmGWAAc4vv6QJSaRzKm",
    refundTx: "9xRfndTxHash2222ABCDEFGHJK", payer: "t01.testnet", amountUnits: "20000", network: "near:testnet", reason: "over_estimate",
    at: "2026-11-13T10:02:00.000Z",
  }, signer);
  const ok = verifyRefund(JSON.parse(JSON.stringify(rec)), signer.publicKeyPem);
  assert.equal(ok.ok, true);
  assert.deepEqual(verifyRefund({ ...rec, amountUnits: "200000" }, signer.publicKeyPem), { ok: false, reason: "the refund signature does not verify" });
  assert.deepEqual(verifyRefund({ ...rec, note: "x" }, signer.publicKeyPem), { ok: false, reason: "refund note is not a refund record member" });
  const other = signerFromKey(generateKeyPairSync("ed25519").privateKey);
  assert.deepEqual(verifyRefund(rec, other.publicKeyPem), { ok: false, reason: "the refund was signed by another key" });
});
