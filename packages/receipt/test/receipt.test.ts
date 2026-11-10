import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  addSettlement,
  canonicalJson,
  filesRoot,
  resultSha256,
  sha256Hex,
  signReceipt,
  signerFromEnv,
  signerFromKey,
  verifyReceipt,
  type ReceiptBody,
} from "../src/index.ts";

const h = (s: string): string => sha256Hex(s);

function body(result: unknown): ReceiptBody {
  const files = [
    { name: "ledger.csv", bytes: 1200, sha256: h("ledger") },
    { name: "bank.csv", bytes: 800, sha256: h("bank") },
  ];
  return {
    v: 1,
    receiptId: "r-1",
    jobId: "0123456789abcdef0123456789abcdef",
    quoteId: "q-1",
    route: "nearai",
    datasetId: "smb-fin-1",
    files,
    filesRoot: filesRoot(files),
    templateLabel: "Unpaid invoices",
    sqlSha256: h("select 1"),
    resultSha256: resultSha256(result),
    calls: [{ servedModel: "m", chatId: "c-1", reqSha256: h("req"), respSha256: h("resp"), attestStatus: "verified" }],
    price: { amountUnits: "42000", usdcDecimals: 6, priceUsd: "0.042", quoteBasis: { answerMaxRows: 50, maxTokens: 2048 } },
    createdAt: "2026-11-10T10:00:00.000Z",
  };
}

test("ARCH-613 canonical JSON sorts keys and refuses values with no single JSON form", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonicalJson({ a: undefined }), /\$\.a is undefined/);
  assert.throws(() => canonicalJson({ a: Number.NaN }), /not a finite number/);
  assert.throws(() => canonicalJson({ a: 1n }), /bigint/);
});

test("ARCH-613 filesRoot does not depend on file order", () => {
  const a = { name: "a", bytes: 1, sha256: h("a") };
  const b = { name: "b", bytes: 2, sha256: h("b") };
  assert.equal(filesRoot([a, b]), filesRoot([b, a]));
});

test("ARCH-613 a signed receipt verifies, and the released result must match it byte for byte", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = signerFromKey(privateKey);
  const result = { rows: [{ total: 10 }], answer: "10" };
  const r = signReceipt(body(result), signer);
  assert.deepEqual(verifyReceipt(r, signer.publicKeyPem, result), { ok: true, settled: false });
  const other = verifyReceipt(r, signer.publicKeyPem, { rows: [{ total: 11 }], answer: "10" });
  assert.equal(other.ok, false);
});

test("ARCH-613 a changed body or another key fails verification", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = signerFromKey(privateKey);
  const r = signReceipt(body({ x: 1 }), signer);
  const tampered = { ...r, body: { ...r.body, price: { ...r.body.price, amountUnits: "1" } } };
  assert.deepEqual(verifyReceipt(tampered, signer.publicKeyPem), { ok: false, reason: "the receipt signature does not verify" });
  const otherKey = signerFromKey(generateKeyPairSync("ed25519").privateKey);
  assert.deepEqual(verifyReceipt(r, otherKey.publicKeyPem), { ok: false, reason: "the receipt was signed by another key" });
});

test("ARCH-613 the body is checked field by field before signing", () => {
  const signer = signerFromKey(generateKeyPairSync("ed25519").privateKey);
  const bad = { ...body({ x: 1 }), filesRoot: h("wrong") };
  assert.throws(() => signReceipt(bad, signer), /filesRoot must be the hash of files/);
  const half = { ...body({ x: 1 }), counterOf: "q-0" };
  assert.throws(() => signReceipt(half, signer), /counterOf \/ reduced must be both present or both absent/);
});

test("ARCH-616 the settlement is appended and signed without changing the body signature", () => {
  const signer = signerFromKey(generateKeyPairSync("ed25519").privateKey);
  const r = signReceipt(body({ x: 1 }), signer);
  const s = addSettlement(r, { network: "near:testnet", transaction: "9xYtx", invoiceId: "inv-1", payer: "t02.testnet", settledAt: "2026-11-10T10:01:00.000Z" }, signer);
  assert.equal(s.sig.value, r.sig.value);
  assert.deepEqual(verifyReceipt(s, signer.publicKeyPem), { ok: true, settled: true });
  const forged = { ...s, settlement: { ...s.settlement!, transaction: "other" } };
  assert.deepEqual(verifyReceipt(forged, signer.publicKeyPem), { ok: false, reason: "the settlement signature does not verify" });
  assert.throws(() => addSettlement(s, s.settlement!, signer), /already carries a settlement/);
});

test("ARCH-614 the signing key comes from the named variable and its value never appears in an error", () => {
  assert.throws(() => signerFromEnv({}, "RECEIPT_SIGNING_KEY"), /RECEIPT_SIGNING_KEY is not set/);
  assert.throws(() => signerFromEnv({ RECEIPT_SIGNING_KEY: "not-a-key-value" }, "RECEIPT_SIGNING_KEY"), (e: Error) => !e.message.includes("not-a-key-value"));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => signerFromEnv({ K: rsa }, "K"), /must be an Ed25519 key/);
  const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const s = signerFromEnv({ K: ed.replace(/\n/g, "\\n") }, "K");
  assert.match(s.keyId, /^[0-9a-f]{32}$/);
});
