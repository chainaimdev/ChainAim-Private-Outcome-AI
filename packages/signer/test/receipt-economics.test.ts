/**
 * packages/signer, privateAI-design-40: the money trail (price.economics, ARCH-690) and settlement.flow (ARCH-691) pass the
 * signer's allowlist and checkBody; a stray member or numbers that do not add up are refused before anything is signed.
 * Real Ed25519 key (generated per run), real packages/receipt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { economicsOf, filesRoot, signReceipt, signerFromKey, verifyReceipt, type ReceiptBody } from "../../receipt/src/index.ts";
import { parseReceiptBody, parseSettleRequest, SignerInputError } from "../src/index.ts";

const JOB = "0123456789abcdef0123456789abcdef";
const BREAKDOWN = { modelUsd: "0.004210", callFeesUsd: "0.002000", analystUsd: "0.001000", nearGasUsd: "0.001000" };

function body(extraPrice: Record<string, unknown> = {}): ReceiptBody {
  const files = [{ name: "gl.csv", bytes: 1200, sha256: "a".repeat(64) }];
  return {
    v: 1, receiptId: "f".repeat(32), jobId: JOB, quoteId: JOB, route: "nearai/deepseek-v4.1-flash", datasetId: "smb-erp-fin", files, filesRoot: filesRoot(files),
    sqlSha256: "b".repeat(64), resultSha256: "c".repeat(64), calls: [{ servedModel: "deepseek/deepseek-v4.1-flash", attestStatus: "pending", reqSha256: "d".repeat(64), respSha256: "e".repeat(64) }],
    price: { amountUnits: "20000", usdcDecimals: 6, priceUsd: "0.020000", quoteBasis: { pricing: "estimate-first", calls: 1 }, actualUsd: "0.010000", ...extraPrice },
    createdAt: "2026-11-13T05:01:00.000Z",
  } as ReceiptBody;
}

test("ARCH-690 signer accepts a body whose economics add up", () => {
  const b = body({ economics: economicsOf("0.020000", "0.010000", BREAKDOWN) });
  assert.deepEqual(parseReceiptBody(JSON.parse(JSON.stringify(b))).price.economics, b.price.economics);
});

test("ARCH-690 signer refuses a body whose economics do not add up", () => {
  const e = economicsOf("0.020000", "0.010000", BREAKDOWN);
  assert.throws(() => parseReceiptBody(body({ economics: { ...e, marginUsd: "0.019000" } })), (x: Error) => x instanceof SignerInputError && /marginUsd must be priceUsd - costUsd/.test(x.message));
  assert.throws(() => parseReceiptBody(body({ economics: { ...e, costBasis: "invoice" } })), /economics\.costBasis must be catalog/);
  assert.throws(() => parseReceiptBody(body({ economics: { ...e, nearGasUsd: "1e-3" } })), /economics\.nearGasUsd must be a USD amount with 6 decimals/);
});

test("ARCH-690 signer allowlist names a stray economics member", () => {
  const e = economicsOf("0.020000", "0.010000", BREAKDOWN);
  assert.throws(() => parseReceiptBody(body({ economics: { ...e, providerInvoice: "x" } })), /\$\.body\.price\.economics\.providerInvoice is not accepted/);
});

test("ARCH-691 signer settle request accepts settlement.flow and refuses another value", () => {
  const signer = signerFromKey(generateKeyPairSync("ed25519").privateKey);
  const receipt = signReceipt(body(), signer);
  const settlement = { network: "near:testnet", transaction: "4vv6QJSaRzKmGWAAc4vv6QJSaRzKm", invoiceId: "INV1", payer: "t01.testnet", settledAt: "2026-11-13T05:02:00.000Z" };
  assert.equal(parseSettleRequest({ receipt, settlement: { ...settlement, flow: "upfront" } }).settlement.flow, "upfront");
  assert.equal(parseSettleRequest({ receipt, settlement }).settlement.flow, undefined);
  assert.throws(() => parseSettleRequest({ receipt, settlement: { ...settlement, flow: "later" } }), /\$\.settlement\.flow must be authorization or upfront/);
  assert.deepEqual(verifyReceipt(receipt, signer.publicKeyPem), { ok: true, settled: false });
});
