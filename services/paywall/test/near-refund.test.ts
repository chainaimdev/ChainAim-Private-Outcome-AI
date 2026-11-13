/**
 * privateAI-design-37 ARCH-673: the refund transaction packages/near-refund builds without dependencies is exactly the one
 * the NEAR SDK builds. @near-js/transactions (installed here, at the version the paywall's facilitator uses) encodes the
 * same transaction; both byte strings must be equal, and the SDK must decode our signed bytes with our signature.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { KeyPair, PublicKey } from "@near-js/crypto";
import { actionCreators, createTransaction, decodeSignedTransaction, encodeTransaction } from "@near-js/transactions";
import { base58Decode, base58Encode, encodeFtTransfer, nearKeyOf, signFtTransfer } from "../../../packages/near-refund/src/index.ts";

function newNearSecret(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(16);
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  return `ed25519:${base58Encode(Buffer.concat([seed, pub]))}`;
}

test("ARCH-673 the refund ft_transfer is byte for byte the transaction @near-js/transactions encodes", () => {
  const secret = newNearSecret();
  const key = nearKeyOf(secret);
  assert.equal(key.publicKeyText, KeyPair.fromString(secret as never).getPublicKey().toString(), "same public key as the SDK derives");
  for (const memo of [undefined, "chainaim refund C702E26D9A1B4C5D"]) {
    const t = { signerId: "chainaim-payto-seller.testnet", nonce: 277_469_266_000_001n, blockHash: "8Hu8ankSuY2eo1NnkqXCNdYXzeAJgF9oWnzCuEGcTj7M", contract: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", receiverId: "chainaim-buyer-seller.testnet", amount: "20000", gas: 30_000_000_000_000n, ...(memo ? { memo } : {}) };
    const args = { receiver_id: t.receiverId, amount: t.amount, ...(memo ? { memo } : {}) };
    const sdkTx = createTransaction(t.signerId, PublicKey.fromString(key.publicKeyText), t.contract, t.nonce, [actionCreators.functionCall("ft_transfer", args, t.gas, 1n)], base58Decode(t.blockHash));
    assert.deepEqual(Buffer.from(encodeTransaction(sdkTx)), encodeFtTransfer({ ...t, publicKey: key.publicKey }), memo ?? "no memo");
    const signed = signFtTransfer({ ...t, key });
    const decoded = decodeSignedTransaction(Buffer.from(signed.signedTxB64, "base64"));
    assert.deepEqual(Buffer.from(encodeTransaction(decoded.transaction)), Buffer.from(encodeTransaction(sdkTx)));
    assert.ok(PublicKey.fromString(key.publicKeyText).verify(Uint8Array.from(base58Decode(signed.txHash)), Uint8Array.from(decoded.signature!.ed25519Signature!.data)), "the SDK verifies our signature over the hash");
  }
});
