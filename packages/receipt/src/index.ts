/**
 * Job Evidence Receipt (privateAI-design-32 §1.2, ARCH-613 builder, ARCH-614 signing key, ARCH-616 settlement).
 *
 * A receipt commits to one paid job with ids, sizes, SHA-256 hashes and amounts only: never a question, a row, an
 * answer or a key. The console signs it with Ed25519 (node:crypto, no dependency); the buyer's agent and any relying
 * party (lender, auditor) verify it with this same module and the console's public key.
 *
 * Binding to the payment is by ids, not the ft_transfer memo (design-32 §1.2): receipt.jobId and receipt.quoteId, the
 * invoice the paywall bound to that job (JobInvoices), and the settlement transaction hash, which is appended after
 * settlement as a second signed part (`settlement`) so the first signature never changes.
 *
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, strings and numbers as JSON.stringify writes
 * them. undefined, functions, symbols, bigints and non-finite numbers are refused, never dropped, so two parties can
 * never hash different bytes for what looks like the same receipt.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const RECEIPT_VERSION = 1 as const;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Canonical JSON of a value; throws naming the path of the first value that has no single JSON form. */
export function canonicalJson(value: unknown, path = "$"): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error(`${path} is not a plain object`);
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new Error(`${path} is ${typeof value}, which has no JSON form`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The hash a receipt carries for a result: SHA-256 of the result's canonical JSON. */
export function resultSha256(result: unknown): string {
  return sha256Hex(canonicalJson(result));
}

export type ReceiptFile = { name: string; bytes: number; sha256: string };

/** One commitment over all files: SHA-256 of the canonical JSON of the entries sorted by name (a hash list, not a Merkle tree). */
export function filesRoot(files: readonly ReceiptFile[]): string {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(canonicalJson(sorted));
}

/**
 * One model call. A call on an attested route carries the gateway's request/response hashes (ARCH-408 headers) and its
 * provider chat id when known; a call on a route without attestation has no evidence, so attestStatus is "none" and the
 * hashes are absent.
 */
export type ReceiptCall = {
  servedModel: string;
  zone?: string;
  chatId?: string;
  reqSha256?: string;
  respSha256?: string;
  /** ca-attest's verdict for this call, or "none" on a route without attestation. */
  attestStatus: "verified" | "failed" | "pending" | "none";
};

export type ReceiptPrice = {
  /** The x402 exact amount paid, whole USDC base units. */
  amountUnits: string;
  usdcDecimals: number;
  /** The firm quote shown to the buyer, decimal USD, e.g. "0.042". */
  priceUsd: string;
  /** The quote basis the run was held to (sizes and limits only). */
  quoteBasis: Record<string, string | number | boolean>;
  /** What the run actually cost by the meter; recorded, never charged (ARCH-609). */
  actualUsd?: string;
};

export type ReceiptBody = {
  v: typeof RECEIPT_VERSION;
  receiptId: string;
  jobId: string;
  quoteId: string;
  /** The quote this one countered (ARCH-625), and which limits it reduced. */
  counterOf?: string;
  reduced?: string[];
  route: string;
  datasetId: string;
  files: ReceiptFile[];
  filesRoot: string;
  templateLabel?: string;
  sqlSha256: string;
  resultSha256: string;
  calls: ReceiptCall[];
  evidenceBundleSha256?: string;
  price: ReceiptPrice;
  /** ISO 8601. */
  createdAt: string;
};

export type Signature = { alg: "ed25519"; keyId: string; value: string };

export type Settlement = { network: string; transaction: string; invoiceId: string; payer: string | null; settledAt: string };

export type SignedReceipt = {
  body: ReceiptBody;
  sig: Signature;
  /** Appended after settlement (ARCH-616); signed over {receiptSig, settlement}. */
  settlement?: Settlement;
  settlementSig?: Signature;
};

/** Field-by-field check of a body; the message names the field, never a value. */
export function checkBody(b: ReceiptBody): void {
  const fail = (field: string, want: string): never => {
    throw new Error(`receipt ${field} must be ${want}`);
  };
  if (b.v !== RECEIPT_VERSION) fail("v", String(RECEIPT_VERSION));
  for (const f of ["receiptId", "jobId", "quoteId", "route", "datasetId", "createdAt"] as const) {
    if (typeof b[f] !== "string" || b[f] === "") fail(f, "a non-empty string");
  }
  if (Number.isNaN(Date.parse(b.createdAt))) fail("createdAt", "an ISO 8601 time");
  for (const f of ["filesRoot", "sqlSha256", "resultSha256"] as const) if (!SHA256_HEX.test(b[f])) fail(f, "64 lowercase hex characters");
  if (b.evidenceBundleSha256 !== undefined && !SHA256_HEX.test(b.evidenceBundleSha256)) fail("evidenceBundleSha256", "64 lowercase hex characters");
  if (!Array.isArray(b.files) || b.files.length === 0) fail("files", "a non-empty list");
  for (const [i, f] of b.files.entries()) {
    if (typeof f.name !== "string" || f.name === "") fail(`files[${i}].name`, "a non-empty string");
    if (!Number.isInteger(f.bytes) || f.bytes < 0) fail(`files[${i}].bytes`, "a whole number");
    if (!SHA256_HEX.test(f.sha256)) fail(`files[${i}].sha256`, "64 lowercase hex characters");
  }
  if (filesRoot(b.files) !== b.filesRoot) fail("filesRoot", "the hash of files");
  if (!Array.isArray(b.calls)) fail("calls", "a list");
  for (const [i, c] of b.calls.entries()) {
    if (typeof c.servedModel !== "string" || c.servedModel === "") fail(`calls[${i}].servedModel`, "a non-empty string");
    if (!["verified", "failed", "pending", "none"].includes(c.attestStatus)) fail(`calls[${i}].attestStatus`, "verified, failed, pending or none");
    const hashes = [c.reqSha256, c.respSha256];
    if (c.attestStatus !== "none" && hashes.some((x) => x === undefined)) fail(`calls[${i}]`, "request and response SHA-256 hashes on an attested call");
    if (hashes.some((x) => x !== undefined && !SHA256_HEX.test(x))) fail(`calls[${i}]`, "64 lowercase hex characters in each hash");
  }
  if (!/^[1-9]\d*$/.test(b.price.amountUnits)) fail("price.amountUnits", "a positive whole number as a string");
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(b.price.priceUsd)) fail("price.priceUsd", "a decimal USD amount");
  if (b.price.actualUsd !== undefined && !/^(0|[1-9]\d*)(\.\d+)?$/.test(b.price.actualUsd)) fail("price.actualUsd", "a decimal USD amount");
  if ((b.counterOf === undefined) !== (b.reduced === undefined)) fail("counterOf / reduced", "both present or both absent");
}

/** The id of an Ed25519 public key: the first 16 bytes (hex) of SHA-256 over its SPKI DER encoding. */
export function keyIdOf(publicKey: KeyObject): string {
  return sha256Hex(publicKey.export({ type: "spki", format: "der" })).slice(0, 32);
}

export type ReceiptSigner = { keyId: string; publicKeyPem: string; signBytes: (data: string) => string };

/**
 * The console's signer from a PKCS#8 PEM Ed25519 private key held in the environment variable `variable`
 * (--receipt-key-env, ARCH-614). Refuses, naming the variable only, when it is missing or not an Ed25519 key.
 */
export function signerFromEnv(env: Record<string, string | undefined>, variable: string): ReceiptSigner {
  const raw = env[variable]?.trim();
  if (!raw) throw new Error(`${variable} is not set: the receipt signing key (PKCS#8 PEM, Ed25519); see MANUAL_SETUP.md`);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: raw.replace(/\\n/g, "\n"), format: "pem" });
  } catch {
    throw new Error(`${variable} is not a PEM private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${variable} must be an Ed25519 key`);
  return signerFromKey(key);
}

export function signerFromKey(privateKey: KeyObject): ReceiptSigner {
  const pub = createPublicKey(privateKey);
  return {
    keyId: keyIdOf(pub),
    publicKeyPem: pub.export({ type: "spki", format: "pem" }).toString(),
    signBytes: (data) => sign(null, Buffer.from(data, "utf8"), privateKey).toString("base64"),
  };
}

export function signReceipt(body: ReceiptBody, signer: ReceiptSigner): SignedReceipt {
  checkBody(body);
  return { body, sig: { alg: "ed25519", keyId: signer.keyId, value: signer.signBytes(canonicalJson(body)) } };
}

/** Appends the settlement (ARCH-616); the body's signature is not touched. */
export function addSettlement(receipt: SignedReceipt, settlement: Settlement, signer: ReceiptSigner): SignedReceipt {
  if (receipt.settlement) throw new Error("this receipt already carries a settlement");
  if (receipt.sig.keyId !== signer.keyId) throw new Error("the settlement must be signed by the key that signed the receipt");
  if (typeof settlement.transaction !== "string" || settlement.transaction === "") throw new Error("settlement.transaction must be the transaction hash");
  const value = signer.signBytes(canonicalJson({ receiptSig: receipt.sig.value, settlement }));
  return { ...receipt, settlement, settlementSig: { alg: "ed25519", keyId: signer.keyId, value } };
}

export type Verdict = { ok: true; settled: boolean } | { ok: false; reason: string };

/**
 * Checks a receipt against the console's public key (PEM): body shape, the body signature, and the settlement
 * signature when present. With `result`, also that the released result is byte-for-byte the one committed.
 */
export function verifyReceipt(receipt: SignedReceipt, publicKeyPem: string, result?: unknown): Verdict {
  let pub: KeyObject;
  try {
    pub = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "the public key is not a PEM public key" };
  }
  if (pub.asymmetricKeyType !== "ed25519") return { ok: false, reason: "the public key is not Ed25519" };
  const keyId = keyIdOf(pub);
  try {
    checkBody(receipt.body);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (receipt.sig?.alg !== "ed25519" || receipt.sig.keyId !== keyId) return { ok: false, reason: "the receipt was signed by another key" };
  if (!verify(null, Buffer.from(canonicalJson(receipt.body), "utf8"), pub, Buffer.from(receipt.sig.value, "base64"))) {
    return { ok: false, reason: "the receipt signature does not verify" };
  }
  if ((receipt.settlement === undefined) !== (receipt.settlementSig === undefined)) return { ok: false, reason: "settlement and its signature must come together" };
  if (receipt.settlement && receipt.settlementSig) {
    if (receipt.settlementSig.keyId !== keyId) return { ok: false, reason: "the settlement was signed by another key" };
    const data = canonicalJson({ receiptSig: receipt.sig.value, settlement: receipt.settlement });
    if (!verify(null, Buffer.from(data, "utf8"), pub, Buffer.from(receipt.settlementSig.value, "base64"))) {
      return { ok: false, reason: "the settlement signature does not verify" };
    }
  }
  if (result !== undefined && resultSha256(result) !== receipt.body.resultSha256) return { ok: false, reason: "the result is not the one the receipt commits to" };
  return { ok: true, settled: receipt.settlement !== undefined };
}
