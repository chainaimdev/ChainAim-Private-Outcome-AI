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
  /** privateAI-design-40 ARCH-690: the money trail (cost, margin, overrun absorbed). Optional: older receipts verify. */
  economics?: ReceiptEconomics;
};

/**
 * privateAI-design-40 ARCH-690: what ChainAim paid out for the job and what it earned, all decimal USD with 6 decimals.
 * costBasis "catalog": the model costs are the metered calls at ChainAim's configured catalog prices, not a provider bill.
 * costUsd = nearAiCostUsd + nearGasUsd; marginUsd = priceUsd - costUsd (may be negative); overrunAbsorbedUsd =
 * max(0, actualUsd - priceUsd). callFeesUsd and analystUsd are ChainAim's own charges: shown, not counted as cost.
 */
export type ReceiptEconomics = {
  costBasis: "catalog";
  nearAiCostUsd: string;
  callFeesUsd: string;
  analystUsd: string;
  nearGasUsd: string;
  costUsd: string;
  marginUsd: string;
  overrunAbsorbedUsd: string;
};

/** The metered breakdown parts economicsOf reads (packages/crossask JobQuote["breakdown"] has these members). */
export type CostBreakdown = { modelUsd: string; callFeesUsd: string; analystUsd: string; nearGasUsd: string };

export const ECONOMICS_FIELDS = ["costBasis", "nearAiCostUsd", "callFeesUsd", "analystUsd", "nearGasUsd", "costUsd", "marginUsd", "overrunAbsorbedUsd"] as const;
/** Unsigned USD with exactly 6 decimals; marginUsd alone may carry a leading "-". */
export const USD6 = /^(0|[1-9]\d*)\.\d{6}$/;
export const SIGNED_USD6 = /^-?(0|[1-9]\d*)\.\d{6}$/;
const MICROS_DECIMALS = 6;

/** A decimal USD string (at most 6 decimals, optional "-") as whole micro-dollars; throws naming `what` otherwise. */
export function usdToMicros(usd: string, what: string): bigint {
  const m = typeof usd === "string" ? /^(-?)(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(usd) : null;
  if (!m) throw new Error(`${what} must be a decimal USD amount with at most ${MICROS_DECIMALS} decimals`);
  const micros = BigInt(m[2]) * 10n ** BigInt(MICROS_DECIMALS) + BigInt((m[3] ?? "").padEnd(MICROS_DECIMALS, "0"));
  return m[1] === "-" ? -micros : micros;
}

/** Whole micro-dollars as decimal USD with exactly 6 decimals ("-" only for a negative amount). */
export function microsToUsd6(micros: bigint): string {
  const neg = micros < 0n;
  const s = (neg ? -micros : micros).toString().padStart(MICROS_DECIMALS + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -MICROS_DECIMALS)}.${s.slice(-MICROS_DECIMALS)}`;
}

/**
 * ARCH-690: the one function that builds the money trail, from the price the buyer paid, the metered cost at the quote's
 * fees and margin (actualUsd) and the metered breakdown. Integer micros throughout, no floats.
 */
export function economicsOf(priceUsd: string, actualUsd: string, b: CostBreakdown): ReceiptEconomics {
  const price = usdToMicros(priceUsd, "priceUsd");
  const actual = usdToMicros(actualUsd, "actualUsd");
  const model = usdToMicros(b.modelUsd, "breakdown.modelUsd");
  const gas = usdToMicros(b.nearGasUsd, "breakdown.nearGasUsd");
  const fees = usdToMicros(b.callFeesUsd, "breakdown.callFeesUsd");
  const analyst = usdToMicros(b.analystUsd, "breakdown.analystUsd");
  for (const [v, what] of [[price, "priceUsd"], [actual, "actualUsd"], [model, "breakdown.modelUsd"], [gas, "breakdown.nearGasUsd"], [fees, "breakdown.callFeesUsd"], [analyst, "breakdown.analystUsd"]] as const) {
    if (v < 0n) throw new Error(`${what} must not be negative`);
  }
  const cost = model + gas;
  return {
    costBasis: "catalog",
    nearAiCostUsd: microsToUsd6(model),
    callFeesUsd: microsToUsd6(fees),
    analystUsd: microsToUsd6(analyst),
    nearGasUsd: microsToUsd6(gas),
    costUsd: microsToUsd6(cost),
    marginUsd: microsToUsd6(price - cost),
    overrunAbsorbedUsd: microsToUsd6(actual > price ? actual - price : 0n),
  };
}

/** ARCH-690/693: shape and identities of a price's economics; the message names the member, never a value. */
export function checkEconomics(p: ReceiptPrice): void {
  const e = p.economics;
  if (e === undefined) return;
  const fail = (field: string, want: string): never => {
    throw new Error(`receipt price.economics${field} must be ${want}`);
  };
  if (typeof e !== "object" || e === null || Array.isArray(e)) fail("", "an object");
  for (const k of Object.keys(e)) if (!(ECONOMICS_FIELDS as readonly string[]).includes(k)) fail(`.${k}`, "absent (not a money-trail member)");
  if (e.costBasis !== "catalog") fail(".costBasis", "catalog");
  for (const k of ["nearAiCostUsd", "callFeesUsd", "analystUsd", "nearGasUsd", "costUsd", "overrunAbsorbedUsd"] as const) {
    if (typeof e[k] !== "string" || !USD6.test(e[k])) fail(`.${k}`, "a USD amount with 6 decimals");
  }
  if (typeof e.marginUsd !== "string" || !SIGNED_USD6.test(e.marginUsd) || e.marginUsd === "-0.000000") fail(".marginUsd", "a signed USD amount with 6 decimals");
  if (p.actualUsd === undefined) fail("", "accompanied by price.actualUsd");
  const price = usdToMicros(p.priceUsd, "price.priceUsd");
  if (price !== BigInt(p.amountUnits) * 10n ** BigInt(MICROS_DECIMALS) / 10n ** BigInt(p.usdcDecimals)) fail("", "priced at the paid amount (priceUsd = amountUnits)");
  const want = economicsOf(p.priceUsd, p.actualUsd!, { modelUsd: e.nearAiCostUsd, nearGasUsd: e.nearGasUsd, callFeesUsd: e.callFeesUsd, analystUsd: e.analystUsd });
  if (e.costUsd !== want.costUsd) fail(".costUsd", "nearAiCostUsd + nearGasUsd");
  if (e.marginUsd !== want.marginUsd) fail(".marginUsd", "priceUsd - costUsd");
  if (e.overrunAbsorbedUsd !== want.overrunAbsorbedUsd) fail(".overrunAbsorbedUsd", "max(0, actualUsd - priceUsd)");
}

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
  /**
   * privateAI-design-33 ARCH-631: SHA-256 hex of the AP2 merchant_authorization string of the job's signed quote, so the
   * receipt points at the signed quote. Optional: absent when the console runs with --ap2 off, and old receipts verify.
   */
  merchantAuthSha256?: string;
  /**
   * privateAI-design-36 ARCH-668: the buyer agent's closed AP2 Checkout Mandate, verified by ChainAim's signer before the
   * run: SHA-256 hex of the presentation, the tenant key id, the tenant and its NEAR account, and the nonce (the payment's
   * invoice id). Optional: absent without a mandate, and older receipts verify.
   */
  mandate?: ReceiptMandate;
  price: ReceiptPrice;
  /** ISO 8601. */
  createdAt: string;
};

export type ReceiptMandate = { sha256: string; kid: string; tenant: string; accountId: string; nonce: string };

export type Signature = { alg: "ed25519"; keyId: string; value: string };

/**
 * flow (privateAI-design-40 ARCH-691, optional): which x402 flow moved the money: "authorization" (settled after the
 * release handler) or "upfront" (privateAI-design-37: settled before the run). Covered by the settlement signature.
 */
export const SETTLEMENT_FLOWS = ["authorization", "upfront"] as const;
export type SettlementFlow = (typeof SETTLEMENT_FLOWS)[number];
export type Settlement = { network: string; transaction: string; invoiceId: string; payer: string | null; settledAt: string; flow?: SettlementFlow };

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
  if (b.merchantAuthSha256 !== undefined && !SHA256_HEX.test(b.merchantAuthSha256)) fail("merchantAuthSha256", "64 lowercase hex characters");
  if (b.mandate !== undefined) {
    const m = b.mandate;
    if (typeof m !== "object" || m === null) fail("mandate", "an object");
    if (!SHA256_HEX.test(m.sha256)) fail("mandate.sha256", "64 lowercase hex characters");
    if (typeof m.kid !== "string" || !/^[0-9a-f]{32}$/.test(m.kid)) fail("mandate.kid", "32 lowercase hex characters");
    for (const f of ["tenant", "accountId", "nonce"] as const) if (typeof m[f] !== "string" || m[f] === "") fail(`mandate.${f}`, "a non-empty string");
  }
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
  checkEconomics(b.price);
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
  if (settlement.flow !== undefined && !SETTLEMENT_FLOWS.includes(settlement.flow)) throw new Error("settlement.flow must be authorization or upfront");
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
    if (receipt.settlement.flow !== undefined && !SETTLEMENT_FLOWS.includes(receipt.settlement.flow)) return { ok: false, reason: "settlement.flow must be authorization or upfront" };
    const data = canonicalJson({ receiptSig: receipt.sig.value, settlement: receipt.settlement });
    if (!verify(null, Buffer.from(data, "utf8"), pub, Buffer.from(receipt.settlementSig.value, "base64"))) {
      return { ok: false, reason: "the settlement signature does not verify" };
    }
  }
  if (result !== undefined && resultSha256(result) !== receipt.body.resultSha256) return { ok: false, reason: "the result is not the one the receipt commits to" };
  return { ok: true, settled: receipt.settlement !== undefined };
}

/**
 * privateAI-design-37 §5.5 / design-40 ARCH-694: the signed record of a refunded upfront payment. A refunded job never
 * gets a receipt (design-37 I3), so the refund carries its own signature: Ed25519 with the RECEIPT key over the canonical
 * JSON of the record without `sig`. Ids, amounts and hashes only.
 */
export const REFUND_FIELDS = ["status", "invoiceId", "jobId", "paidTx", "refundTx", "payer", "amountUnits", "network", "reason", "at", "sig"] as const;
export type RefundRecord = {
  status: string; invoiceId: string; jobId: string; paidTx: string; refundTx: string | null; payer: string;
  amountUnits: string; network: string; reason: string; at: string; sig: Signature;
};

/** Signs a refund record with the receipt key (the signer's side of ARCH-694). */
export function signRefund(record: Omit<RefundRecord, "sig">, signer: ReceiptSigner): RefundRecord {
  return { ...record, sig: { alg: "ed25519", keyId: signer.keyId, value: signer.signBytes(canonicalJson(record)) } };
}

/** ARCH-694: checks a refund record's members and its signature against the pinned receipt public key (PEM). */
export function verifyRefund(record: unknown, publicKeyPem: string): { ok: true; record: RefundRecord } | { ok: false; reason: string } {
  let pub: KeyObject;
  try {
    pub = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "the public key is not a PEM public key" };
  }
  if (pub.asymmetricKeyType !== "ed25519") return { ok: false, reason: "the public key is not Ed25519" };
  if (typeof record !== "object" || record === null || Array.isArray(record)) return { ok: false, reason: "the refund record is not a JSON object" };
  const r = record as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!(REFUND_FIELDS as readonly string[]).includes(k)) return { ok: false, reason: `refund ${k} is not a refund record member` };
  const bad = (field: string, want: string) => ({ ok: false as const, reason: `refund ${field} must be ${want}` });
  for (const f of ["status", "invoiceId", "jobId", "paidTx", "payer", "network", "reason", "at"] as const) {
    if (typeof r[f] !== "string" || r[f] === "") return bad(f, "a non-empty string");
  }
  if (r.refundTx !== null && (typeof r.refundTx !== "string" || r.refundTx === "")) return bad("refundTx", "a transaction hash or null");
  if (typeof r.amountUnits !== "string" || !/^[1-9]\d*$/.test(r.amountUnits)) return bad("amountUnits", "a positive whole number as a string");
  if (Number.isNaN(Date.parse(r.at as string))) return bad("at", "an ISO 8601 time");
  const sig = r.sig as Signature | undefined;
  if (typeof sig !== "object" || sig === null || sig.alg !== "ed25519" || typeof sig.value !== "string") return bad("sig", "an ed25519 signature");
  if (sig.keyId !== keyIdOf(pub)) return { ok: false, reason: "the refund was signed by another key" };
  const unsigned = Object.fromEntries(Object.entries(r).filter(([k]) => k !== "sig"));
  if (!verify(null, Buffer.from(canonicalJson(unsigned), "utf8"), pub, Buffer.from(sig.value, "base64"))) return { ok: false, reason: "the refund signature does not verify" };
  return { ok: true, record: r as unknown as RefundRecord };
}
