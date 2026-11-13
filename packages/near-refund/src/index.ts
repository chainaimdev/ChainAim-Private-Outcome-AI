/**
 * NEAR side of ChainAim's automatic refund (privateAI-design-37 ARCH-673/674), with no npm dependency so ca-control-signer
 * stays a zero-dependency image (ARCH-660):
 *
 *   - paidTransfer(): reads a settled x402 payment with EXPERIMENTAL_tx_status and returns every successful NEP-141
 *     ft_transfer receipt in it (who paid = the receipt's predecessor, to whom, how much, on which token contract).
 *     An x402 NEAR payment is a relayer transaction carrying the buyer's signed delegate: the outer signer is the relayer,
 *     the ft_transfer receipt's predecessor is the buyer (checked on testnet, design-37 A2).
 *   - signFtTransfer(): a NEAR transaction with one FunctionCall ft_transfer (1 yoctoNEAR deposit), borsh-encoded and
 *     signed with an ed25519 key; its hash is sha256 of the encoded transaction, as nearcore computes it.
 *   - sendSigned() / txOutcome(): send it and classify the outcome; re-sending the same bytes cannot execute twice, because
 *     its access-key nonce is spent by the first (design-37 A3).
 *
 * Only ids and amounts pass through here. A secret key is held in a KeyObject and never logged or returned.
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

// ---- base58 (Bitcoin alphabet, as NEAR uses) --------------------------------------------------------------------------

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error("not base58");
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

// ---- keys ---------------------------------------------------------------------------------------------------------------

/** An ed25519 NEAR key: "ed25519:" + base58 of the 64-byte secret (seed + public key) or of the 32-byte seed. */
export type NearKey = { publicKey: Uint8Array; publicKeyText: string; privateKey: KeyObject };

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function nearKeyOf(secret: string): NearKey {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(secret.trim());
  if (!m) throw new Error("the key must be an ed25519 NEAR secret key (ed25519:<base58>)");
  const raw = base58Decode(m[1]);
  if (raw.length !== 64 && raw.length !== 32) throw new Error("the ed25519 secret key must be 32 or 64 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(raw.subarray(0, 32))]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  if (raw.length === 64 && !Buffer.from(raw.subarray(32)).equals(Buffer.from(publicKey))) throw new Error("the ed25519 secret key's public half does not match its seed");
  return { publicKey, publicKeyText: `ed25519:${base58Encode(publicKey)}`, privateKey };
}

// ---- borsh encoding of a NEAR transaction with one FunctionCall ---------------------------------------------------------

class Writer {
  private readonly parts: Buffer[] = [];
  u8(v: number): this { this.parts.push(Buffer.from([v])); return this; }
  u32(v: number): this { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  u64(v: bigint): this { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
  u128(v: bigint): this { const b = Buffer.alloc(16); b.writeBigUInt64LE(v & 0xffffffffffffffffn); b.writeBigUInt64LE(v >> 64n, 8); this.parts.push(b); return this; }
  fixed(bytes: Uint8Array): this { this.parts.push(Buffer.from(bytes)); return this; }
  bytes(bytes: Uint8Array): this { return this.u32(bytes.length).fixed(bytes); }
  str(s: string): this { return this.bytes(Buffer.from(s, "utf8")); }
  done(): Buffer { return Buffer.concat(this.parts); }
}

/** NEAR's Action enum index of FunctionCall (CreateAccount 0, DeployContract 1, FunctionCall 2, ...). */
const ACTION_FUNCTION_CALL = 2;
const KEY_TYPE_ED25519 = 0;

export type FtTransferTx = {
  signerId: string;
  key: NearKey;
  nonce: bigint;
  /** A recent final block hash (base58), e.g. the one view_access_key answered with. */
  blockHash: string;
  /** The NEP-141 token contract. */
  contract: string;
  receiverId: string;
  amount: string;
  memo?: string;
  gas: bigint;
};

/** The borsh bytes of the Transaction (what is hashed and signed). */
export function encodeFtTransfer(t: Omit<FtTransferTx, "key"> & { publicKey: Uint8Array }): Buffer {
  const blockHash = base58Decode(t.blockHash);
  if (blockHash.length !== 32) throw new Error("blockHash must be 32 bytes");
  if (!/^[1-9]\d{0,38}$/.test(t.amount)) throw new Error("amount must be a positive whole number of token base units");
  const args = Buffer.from(JSON.stringify({ receiver_id: t.receiverId, amount: t.amount, ...(t.memo !== undefined ? { memo: t.memo } : {}) }), "utf8");
  return new Writer()
    .str(t.signerId)
    .u8(KEY_TYPE_ED25519).fixed(t.publicKey)
    .u64(t.nonce)
    .str(t.contract)
    .fixed(blockHash)
    .u32(1)
    .u8(ACTION_FUNCTION_CALL).str("ft_transfer").bytes(args).u64(t.gas).u128(1n)
    .done();
}

export type SignedTx = { signedTxB64: string; txHash: string };

/** Signs the transaction: hash = sha256(borsh(tx)), signature = ed25519 over that hash; SignedTransaction = tx + signature. */
export function signFtTransfer(t: FtTransferTx): SignedTx {
  const txBytes = encodeFtTransfer({ ...t, publicKey: t.key.publicKey });
  const hash = createHash("sha256").update(txBytes).digest();
  const signature = sign(null, hash, t.key.privateKey);
  const signed = Buffer.concat([txBytes, Buffer.from([KEY_TYPE_ED25519]), signature]);
  return { signedTxB64: signed.toString("base64"), txHash: base58Encode(hash) };
}

// ---- JSON-RPC ------------------------------------------------------------------------------------------------------------

/** An RPC error with nearcore's cause name (UNKNOWN_TRANSACTION, INVALID_TRANSACTION, TIMEOUT_ERROR, ...). */
export class NearRpcError extends Error {
  readonly cause_name: string;
  constructor(causeName: string, message: string) {
    super(message);
    this.cause_name = causeName;
  }
}

export async function rpc(url: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "chainaim-refund", method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) { await r.body?.cancel(); throw new NearRpcError("HTTP", `NEAR RPC ${method}: HTTP ${r.status}`); }
  const body = (await r.json()) as { result?: unknown; error?: { cause?: { name?: string }; name?: string; message?: string; data?: unknown } };
  if (body.error) {
    const name = body.error.cause?.name ?? body.error.name ?? "RPC_ERROR";
    const data = typeof body.error.data === "string" ? body.error.data : JSON.stringify(body.error.data ?? "");
    throw new NearRpcError(name, `NEAR RPC ${method}: ${name} ${data}`.slice(0, 300));
  }
  return body.result;
}

/** The access key's current nonce and the final block hash it was read at. */
export async function accessKey(url: string, accountId: string, publicKeyText: string, timeoutMs: number): Promise<{ nonce: bigint; blockHash: string }> {
  const r = (await rpc(url, "query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKeyText }, timeoutMs)) as { nonce?: number | string; block_hash?: string };
  if (r?.nonce === undefined || typeof r.block_hash !== "string") throw new NearRpcError("BAD_ANSWER", "view_access_key answered no nonce or block hash");
  return { nonce: BigInt(r.nonce), blockHash: r.block_hash };
}

/** The account's NEAR balance in yoctoNEAR (gas money for refunds). */
export async function nearBalance(url: string, accountId: string, timeoutMs: number): Promise<bigint> {
  const r = (await rpc(url, "query", { request_type: "view_account", finality: "final", account_id: accountId }, timeoutMs)) as { amount?: string };
  if (typeof r?.amount !== "string") throw new NearRpcError("BAD_ANSWER", "view_account answered no amount");
  return BigInt(r.amount);
}

/** A block's time in milliseconds since 1970. */
export async function blockTimeMs(url: string, blockHash: string, timeoutMs: number): Promise<number> {
  const r = (await rpc(url, "block", { block_id: blockHash }, timeoutMs)) as { header?: { timestamp_nanosec?: string; timestamp?: number } };
  const ns = r?.header?.timestamp_nanosec;
  if (typeof ns === "string" && /^\d+$/.test(ns)) return Number(BigInt(ns) / 1_000_000n);
  if (typeof r?.header?.timestamp === "number") return Math.floor(r.header.timestamp / 1_000_000);
  throw new NearRpcError("BAD_ANSWER", "block answered no timestamp");
}

// ---- reading a settled payment ------------------------------------------------------------------------------------------

/** One successful ft_transfer receipt inside a transaction. */
export type FtTransferSeen = { payer: string; contract: string; receiverId: string; amount: string; memo?: string };
export type PaidTransfer = { final: boolean; success: boolean; signerId: string; blockHash: string; transfers: FtTransferSeen[] };

type TxStatus = {
  final_execution_status?: string;
  status?: Record<string, unknown>;
  transaction?: { signer_id?: string; hash?: string };
  transaction_outcome?: { block_hash?: string };
  receipts?: { receipt_id?: string; predecessor_id?: string; receiver_id?: string; receipt?: { Action?: { actions?: Record<string, unknown>[] } } }[];
  receipts_outcome?: { id?: string; outcome?: { status?: Record<string, unknown> } }[];
};

/** The ft_transfer receipts of a tx status answer whose own outcome succeeded (a failed transfer is not money moved). */
export function transfersOf(s: TxStatus): PaidTransfer {
  const ok = new Set((s.receipts_outcome ?? []).filter((o) => o.outcome?.status && "SuccessValue" in o.outcome.status).map((o) => o.id));
  const transfers: FtTransferSeen[] = [];
  for (const r of s.receipts ?? []) {
    if (!r.receipt_id || !ok.has(r.receipt_id) || typeof r.predecessor_id !== "string" || typeof r.receiver_id !== "string") continue;
    for (const a of r.receipt?.Action?.actions ?? []) {
      const fc = a.FunctionCall as { method_name?: string; args?: string; deposit?: string } | undefined;
      if (!fc || fc.method_name !== "ft_transfer" || typeof fc.args !== "string") continue;
      let args: { receiver_id?: unknown; amount?: unknown; memo?: unknown };
      try { args = JSON.parse(Buffer.from(fc.args, "base64").toString("utf8")); } catch { continue; }
      if (typeof args.receiver_id !== "string" || typeof args.amount !== "string") continue;
      transfers.push({ payer: r.predecessor_id, contract: r.receiver_id, receiverId: args.receiver_id, amount: args.amount, ...(typeof args.memo === "string" ? { memo: args.memo } : {}) });
    }
  }
  return {
    final: s.final_execution_status === "FINAL",
    success: s.status !== undefined && "SuccessValue" in s.status,
    signerId: s.transaction?.signer_id ?? "",
    blockHash: s.transaction_outcome?.block_hash ?? "",
    transfers,
  };
}

/** EXPERIMENTAL_tx_status of txHash sent by senderId, as transfersOf reads it; undefined when the chain does not know it. */
export async function paidTransfer(url: string, txHash: string, senderId: string, timeoutMs: number): Promise<PaidTransfer | undefined> {
  try {
    return transfersOf((await rpc(url, "EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" }, timeoutMs)) as TxStatus);
  } catch (e) {
    if (e instanceof NearRpcError && e.cause_name === "UNKNOWN_TRANSACTION") return undefined;
    throw e;
  }
}

// ---- sending -------------------------------------------------------------------------------------------------------------

/** success = final with SuccessValue; failed = final failure or refused by the node (reason given); pending = not known yet. */
export type SendOutcome = { kind: "success" } | { kind: "failed"; reason: string } | { kind: "pending"; reason: string };

function outcomeOf(s: TxStatus): SendOutcome {
  if (s.status && "SuccessValue" in s.status) return s.final_execution_status === "FINAL" || s.final_execution_status === undefined ? { kind: "success" } : { kind: "pending", reason: "not final yet" };
  if (s.status && "Failure" in s.status) return { kind: "failed", reason: JSON.stringify(s.status.Failure).slice(0, 200) };
  return { kind: "pending", reason: `status ${s.final_execution_status ?? "unknown"}` };
}

/** send_tx waiting for FINAL, bounded by timeoutMs. A node refusal (bad nonce, no balance, expired) is failed. */
export async function sendSigned(url: string, signedTxB64: string, timeoutMs: number): Promise<SendOutcome> {
  try {
    return outcomeOf((await rpc(url, "send_tx", { signed_tx_base64: signedTxB64, wait_until: "FINAL" }, timeoutMs)) as TxStatus);
  } catch (e) {
    if ((e as Error).name === "TimeoutError") return { kind: "pending", reason: "timeout" };
    if (e instanceof NearRpcError && e.cause_name === "INVALID_TRANSACTION") return { kind: "failed", reason: e.message };
    return { kind: "pending", reason: (e as Error).message.slice(0, 200) };
  }
}

/** The outcome of a sent transaction, or undefined when the chain does not know it (never included). */
export async function txOutcome(url: string, txHash: string, senderId: string, timeoutMs: number): Promise<SendOutcome | undefined> {
  try {
    return outcomeOf((await rpc(url, "EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: senderId, wait_until: "NONE" }, timeoutMs)) as TxStatus);
  } catch (e) {
    if (e instanceof NearRpcError && e.cause_name === "UNKNOWN_TRANSACTION") return undefined;
    throw e;
  }
}
