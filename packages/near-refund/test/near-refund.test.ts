/**
 * packages/near-refund (privateAI-design-37 ARCH-673): reading a settled payment from a RECORDED testnet answer (the 05:47Z
 * live paid job, fixtures/paid-tx-4vv6QJSa.json), base58, keys, and the refund transaction's signature. The borsh bytes
 * are checked against @near-js/transactions in services/paywall/test/near-refund.test.ts (that is where the library is
 * installed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { base58Decode, base58Encode, encodeFtTransfer, nearKeyOf, signFtTransfer, transfersOf } from "../src/index.ts";

const recorded = JSON.parse(readFileSync(new URL("./fixtures/paid-tx-4vv6QJSa.json", import.meta.url), "utf8")).result;
const USDC_TESTNET = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

/** A fresh ed25519 key in NEAR's text form (seed + public key, base58). */
function newNearSecret(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(16);
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  return `ed25519:${base58Encode(Buffer.concat([seed, pub]))}`;
}

test("ARCH-673 the recorded testnet payment: one successful ft_transfer, payer = the buyer (receipt predecessor), not the relayer", () => {
  const p = transfersOf(recorded);
  assert.equal(p.final, true);
  assert.equal(p.success, true);
  assert.equal(p.signerId, "chainaim-relayer-seller.testnet");
  assert.equal(p.blockHash, "8Hu8ankSuY2eo1NnkqXCNdYXzeAJgF9oWnzCuEGcTj7M");
  assert.deepEqual(p.transfers, [{ payer: "chainaim-buyer-seller.testnet", contract: USDC_TESTNET, receiverId: "chainaim-payto-seller.testnet", amount: "20000" }]);
});

test("ARCH-673 a failed ft_transfer receipt is not money moved", () => {
  const failed = structuredClone(recorded);
  for (const o of failed.receipts_outcome) if (o.outcome.status.SuccessValue !== undefined && o.outcome.executor_id === USDC_TESTNET) o.outcome.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked" } } } } };
  assert.deepEqual(transfersOf(failed).transfers, []);
});

test("ARCH-673 base58 round trip, leading zero bytes kept", () => {
  for (const hex of ["", "00", "0000ff", "61", "ffffffffffffffffffffffffffffffff"]) {
    const b = Buffer.from(hex, "hex");
    assert.deepEqual(Buffer.from(base58Decode(base58Encode(b))), b, hex);
  }
  assert.equal(base58Encode(Buffer.from("hello world")), "StV1DL6CwTryKyV");
  assert.throws(() => base58Decode("0OIl"), /not base58/);
});

test("ARCH-673 nearKeyOf: 64-byte and 32-byte secrets, a mismatched public half refused", () => {
  const secret = newNearSecret();
  const k = nearKeyOf(secret);
  const raw = base58Decode(secret.slice(8));
  assert.deepEqual(Buffer.from(k.publicKey), Buffer.from(raw.subarray(32)));
  assert.equal(nearKeyOf(`ed25519:${base58Encode(raw.subarray(0, 32))}`).publicKeyText, k.publicKeyText);
  const bad = Buffer.from(raw); bad[40] ^= 1;
  assert.throws(() => nearKeyOf(`ed25519:${base58Encode(bad)}`), /does not match/);
  assert.throws(() => nearKeyOf("secp256k1:abc"), /ed25519 NEAR secret key/);
});

test("ARCH-673 signFtTransfer: hash = sha256(tx bytes), the signature verifies with the key, the transfer names payer and amount", () => {
  const key = nearKeyOf(newNearSecret());
  const t = { signerId: "chainaim-payto-seller.testnet", nonce: 7n, blockHash: "8Hu8ankSuY2eo1NnkqXCNdYXzeAJgF9oWnzCuEGcTj7M", contract: USDC_TESTNET, receiverId: "chainaim-buyer-seller.testnet", amount: "20000", memo: "chainaim refund C702E26D", gas: 30_000_000_000_000n };
  const s = signFtTransfer({ ...t, key });
  const bytes = Buffer.from(s.signedTxB64, "base64");
  const txBytes = encodeFtTransfer({ ...t, publicKey: key.publicKey });
  assert.deepEqual(bytes.subarray(0, txBytes.length), txBytes);
  const hash = createHash("sha256").update(txBytes).digest();
  assert.equal(s.txHash, base58Encode(hash));
  assert.equal(bytes[txBytes.length], 0, "ed25519 signature type");
  assert.ok(verify(null, hash, { key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.publicKey]), format: "der", type: "spki" }, bytes.subarray(txBytes.length + 1)));
  assert.ok(txBytes.includes(Buffer.from('{"receiver_id":"chainaim-buyer-seller.testnet","amount":"20000","memo":"chainaim refund C702E26D"}')));
  assert.throws(() => encodeFtTransfer({ ...t, amount: "0", publicKey: key.publicKey }), /amount/);
});
