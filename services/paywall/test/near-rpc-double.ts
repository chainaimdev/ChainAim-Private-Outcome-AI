/**
 * A NEAR JSON-RPC protocol double for the tests (the NEAR counterpart of the
 * rippled double ledger-watch uses): an HTTP server that answers the methods
 * the paywall and @x402/near call, in nearcore's wire shapes
 * (docs.near.org/api/rpc): block, query (view_account, view_access_key,
 * call_function), send_tx, tx and EXPERIMENTAL_tx_status. Like nearcore it
 * takes one JSON-RPC object per POST and answers a batch with HTTP 400.
 *
 * It executes what it is sent. send_tx decodes the Borsh SignedTransaction,
 * checks the relayer's ed25519 signature over sha256(Transaction), the
 * relayer's access-key nonce, then the NEP-366 SignedDelegate inside it: its
 * signature over sha256(NEP-366 prefix + DelegateAction), its nonce against
 * the sender's access key, max_block_height against the current height, and
 * the single ft_transfer's 1 yoctoNEAR, then moves the token balance. Every
 * signature it sees is made by the real near-js signing code with keys
 * generated for one test run; the double holds public keys only.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import { SCHEMA, encodeDelegateAction } from "@near-js/transactions";
import { baseEncode } from "@near-js/utils";
import { deserialize, serialize } from "borsh";
import type { PaywallDeps } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { loadNearRail } from "../src/near/rail.ts";
import { startPaywall } from "./stubs.ts";

type Permission = "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
type Key = { nonce: bigint; permission: Permission };
type Account = { keys: Map<string, Key>; codeHash: string };

export type FtTransfer = { sender: string; receiver: string; amount: bigint; memo?: string; txHash: string };

export type NearDoubleState = {
  height: bigint;
  blockHash: string;
  accounts: Map<string, Account>;
  token: { id: string; decimals: number; symbol: string; balances: Map<string, bigint>; registered: Set<string> };
  transfers: FtTransfer[];
  /** Every JSON-RPC method called, in order. */
  calls: string[];
  /** When set, the next ft_transfer panics inside the contract (the receipt fails). */
  failNextTransfer?: string;
  outcomes: Map<string, unknown>;
};

const EMPTY_CODE_HASH = "11111111111111111111111111111111";
/** The token's storage_balance_bounds().min, in yoctoNEAR (0.00125 NEAR, the usual NEP-145 registration cost). */
export const STORAGE_MIN = "1250000000000000000000";
/** A code hash for an account with a contract deployed: any non-zero 32 bytes in base58. */
const SOME_CODE_HASH = baseEncode(createHash("sha256").update("ft contract").digest());
/** DER header of an Ed25519 SubjectPublicKeyInfo: prepended to the 32 raw key bytes so node:crypto can verify with them. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type BorshKey = { ed25519Key?: { data: number[] | Uint8Array }; secp256k1Key?: { data: number[] | Uint8Array } };
type BorshSig = { ed25519Signature?: { data: number[] | Uint8Array }; secp256k1Signature?: { data: number[] | Uint8Array } };
type BorshFunctionCall = { methodName: string; args: Uint8Array | number[]; gas: bigint; deposit: bigint };
type BorshDelegate = { senderId: string; receiverId: string; actions: { functionCall?: BorshFunctionCall }[]; nonce: bigint; maxBlockHeight: bigint; publicKey: BorshKey };
type BorshSignedTx = {
  transaction: {
    signerId: string;
    publicKey: BorshKey;
    nonce: bigint;
    receiverId: string;
    blockHash: Uint8Array | number[];
    actions: { signedDelegate?: { delegateAction: BorshDelegate; signature: BorshSig }; functionCall?: BorshFunctionCall }[];
  };
  signature: BorshSig;
};

function keyString(k: BorshKey): string {
  if (!k.ed25519Key) throw new Error("only ed25519 keys are used in these tests");
  return `ed25519:${baseEncode(Uint8Array.from(k.ed25519Key.data))}`;
}

function verifyEd25519(message: Uint8Array, signature: BorshSig, publicKey: BorshKey): boolean {
  if (!signature.ed25519Signature || !publicKey.ed25519Key) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(Uint8Array.from(publicKey.ed25519Key.data))]), format: "der", type: "spki" });
  return verify(null, message, key, Buffer.from(Uint8Array.from(signature.ed25519Signature.data)));
}

const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();

/** A nearcore handler error: its cause name (UNKNOWN_ACCOUNT, ...) and the message nearcore puts in `data`. */
export class DoubleRpcError extends Error {
  readonly kind: string;
  readonly data: string;
  constructor(kind: string, data: string) {
    super(data);
    this.kind = kind;
    this.data = data;
  }
}

export function nearRpcDouble(options: { tokenId: string; decimals?: number; symbol?: string; height?: bigint }): { server: Server; state: NearDoubleState } {
  const state: NearDoubleState = {
    height: options.height ?? 200_000_000n,
    blockHash: baseEncode(sha256(Buffer.from("block"))),
    accounts: new Map(),
    token: { id: options.tokenId, decimals: options.decimals ?? 6, symbol: options.symbol ?? "USDC", balances: new Map(), registered: new Set() },
    transfers: [],
    calls: [],
    outcomes: new Map(),
  };
  state.accounts.set(options.tokenId, { keys: new Map(), codeHash: SOME_CODE_HASH });

  const account = (id: string): Account => {
    const a = state.accounts.get(id);
    if (!a) throw new DoubleRpcError("UNKNOWN_ACCOUNT", `account ${id} does not exist while viewing`);
    return a;
  };
  const blockRef = () => ({ block_height: Number(state.height), block_hash: state.blockHash });

  function view(method: string, args: Record<string, unknown>): unknown {
    const t = state.token;
    if (method === "ft_metadata") return { spec: "ft-1.0.0", name: "USD Coin", symbol: t.symbol, decimals: t.decimals, icon: null, reference: null, reference_hash: null };
    if (method === "ft_balance_of") return (t.balances.get(String(args.account_id)) ?? 0n).toString();
    if (method === "storage_balance_of") return t.registered.has(String(args.account_id)) ? { total: STORAGE_MIN, available: "0" } : null;
    if (method === "storage_balance_bounds") return { min: STORAGE_MIN, max: STORAGE_MIN };
    throw new DoubleRpcError("CONTRACT_EXECUTION_ERROR", `wasm execution failed with error: MethodResolveError(MethodNotFound)`);
  }

  function query(p: Record<string, unknown>): unknown {
    const id = String(p.account_id);
    if (p.request_type === "view_account") {
      const a = account(id);
      return { amount: "1000000000000000000000000", locked: "0", code_hash: a.codeHash, storage_usage: 182, storage_paid_at: 0, ...blockRef() };
    }
    if (p.request_type === "view_access_key") {
      const key = account(id).keys.get(String(p.public_key));
      if (!key) throw new DoubleRpcError("UNKNOWN_ACCESS_KEY", `access key ${String(p.public_key)} does not exist while viewing`);
      return { nonce: Number(key.nonce), permission: key.permission, ...blockRef() };
    }
    if (p.request_type === "call_function") {
      if (id !== state.token.id) throw new DoubleRpcError("NO_CONTRACT_CODE", `contract code for account ${id} does not exist`);
      const args = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString("utf8") || "{}") as Record<string, unknown>;
      const result = Buffer.from(JSON.stringify(view(String(p.method_name), args)), "utf8");
      return { result: [...result], logs: [], ...blockRef() };
    }
    throw new DoubleRpcError("UNSUPPORTED", `request_type ${String(p.request_type)} is not served by this double`);
  }

  function sendTx(p: Record<string, unknown>): unknown {
    const bytes = Buffer.from(String(p.signed_tx_base64), "base64");
    const signed = deserialize(SCHEMA.SignedTransaction, bytes) as BorshSignedTx;
    const tx = signed.transaction;
    const txBytes = serialize(SCHEMA.Transaction, tx);
    const txHash = baseEncode(sha256(txBytes));
    if (!verifyEd25519(sha256(txBytes), signed.signature, tx.publicKey)) throw new DoubleRpcError("INVALID_TRANSACTION", "Transaction is not signed with the given public key");
    const relayerKey = account(tx.signerId).keys.get(keyString(tx.publicKey));
    if (!relayerKey) throw new DoubleRpcError("INVALID_TRANSACTION", "Signer access key does not exist");
    if (tx.nonce <= relayerKey.nonce) throw new DoubleRpcError("INVALID_TRANSACTION", `Transaction nonce ${tx.nonce} must be larger than nonce of the used access key ${relayerKey.nonce}`);
    relayerKey.nonce = tx.nonce;

    const outcome = (executor: string, status: Record<string, unknown>) => ({
      id: baseEncode(sha256(Buffer.from(`${txHash}:${executor}`))),
      outcome: { executor_id: executor, status, logs: [], receipt_ids: [], gas_burnt: 2_428_000_000_000, tokens_burnt: "242800000000000000000" },
    });
    // privateAI-design-37: the ft_transfer receipt as EXPERIMENTAL_tx_status shows it on testnet (predecessor = who paid),
    // with the id of the token's outcome, so a reader can match the transfer to its success.
    const ftReceipt = (predecessor: string, args: unknown) => ({
      receipt_id: outcome(state.token.id, {}).id,
      predecessor_id: predecessor,
      receiver_id: state.token.id,
      receipt: { Action: { actions: [{ FunctionCall: { method_name: "ft_transfer", args: Buffer.from(JSON.stringify(args)).toString("base64"), gas: 30_000_000_000_000, deposit: "1" } }] } },
    });
    const finish = (receipts: ReturnType<typeof outcome>[], status: Record<string, unknown>, actionReceipts: ReturnType<typeof ftReceipt>[] = []) => {
      const result = {
        final_execution_status: "FINAL",
        status,
        transaction: { signer_id: tx.signerId, receiver_id: tx.receiverId, nonce: Number(tx.nonce), hash: txHash },
        transaction_outcome: { id: txHash, block_hash: state.blockHash, outcome: { executor_id: tx.signerId, status: { SuccessReceiptId: "receipt" }, logs: [], receipt_ids: [], gas_burnt: 0, tokens_burnt: "0" } },
        receipts: actionReceipts,
        receipts_outcome: receipts,
      };
      state.outcomes.set(txHash, result);
      return result;
    };
    const fail = (executor: string, kind: Record<string, unknown>) => finish([outcome(executor, { Failure: { ActionError: { index: 0, kind } } })], { Failure: { ActionError: { index: 0, kind } } });

    // A direct call from a full-access key: the only one the token serves here is NEP-145 storage_deposit.
    const direct = tx.actions.length === 1 ? tx.actions[0].functionCall : undefined;
    if (direct) {
      // privateAI-design-37: a direct ft_transfer from a full-access key (ChainAim's signer refunding from payTo).
      if (tx.receiverId === state.token.id && direct.methodName === "ft_transfer") {
        if (direct.deposit !== 1n) return fail(state.token.id, { FunctionCallError: { ExecutionError: "Smart contract panicked: Requires attached deposit of exactly 1 yoctoNEAR" } });
        const a = JSON.parse(Buffer.from(Uint8Array.from(direct.args)).toString("utf8")) as { receiver_id: string; amount: string; memo?: string };
        const amt = BigInt(a.amount);
        const bal = state.token.balances;
        if (!state.token.registered.has(a.receiver_id)) return fail(state.token.id, { FunctionCallError: { ExecutionError: `Smart contract panicked: The account ${a.receiver_id} is not registered` } });
        if ((bal.get(tx.signerId) ?? 0n) < amt) return fail(state.token.id, { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } });
        bal.set(tx.signerId, (bal.get(tx.signerId) ?? 0n) - amt);
        bal.set(a.receiver_id, (bal.get(a.receiver_id) ?? 0n) + amt);
        state.transfers.push({ sender: tx.signerId, receiver: a.receiver_id, amount: amt, ...(a.memo !== undefined ? { memo: a.memo } : {}), txHash });
        return finish([outcome(state.token.id, { SuccessValue: "" })], { SuccessValue: "" }, [ftReceipt(tx.signerId, a)]);
      }
      if (tx.receiverId !== state.token.id || direct.methodName !== "storage_deposit") return fail(tx.receiverId, { FunctionCallError: { MethodResolveError: "MethodNotFound" } });
      if (direct.deposit < BigInt(STORAGE_MIN)) return fail(tx.receiverId, { FunctionCallError: { ExecutionError: "Smart contract panicked: The attached deposit is less than the minimum storage balance" } });
      const args = JSON.parse(Buffer.from(Uint8Array.from(direct.args)).toString("utf8")) as { account_id?: string };
      state.token.registered.add(args.account_id ?? tx.signerId);
      return finish([outcome(state.token.id, { SuccessValue: "" })], { SuccessValue: "" });
    }
    if (tx.actions.length !== 1 || !tx.actions[0].signedDelegate) return fail(tx.receiverId, { DelegateActionInvalid: "expected one Delegate action" });
    const { delegateAction: d, signature } = tx.actions[0].signedDelegate;
    if (d.senderId !== tx.receiverId) return fail(tx.receiverId, { DelegateActionSenderDoesNotMatchTxReceiver: { sender_id: d.senderId, receiver_id: tx.receiverId } });
    if (!verifyEd25519(sha256(encodeDelegateAction(d as never)), signature, d.publicKey)) return fail(d.senderId, { DelegateActionInvalidSignature: null });
    if (state.height > d.maxBlockHeight) return fail(d.senderId, { DelegateActionExpired: null });
    const senderKey = state.accounts.get(d.senderId)?.keys.get(keyString(d.publicKey));
    if (!senderKey) return fail(d.senderId, { DelegateActionAccessKeyError: { AccessKeyNotFound: { account_id: d.senderId } } });
    if (d.nonce <= senderKey.nonce) return fail(d.senderId, { DelegateActionInvalidNonce: { delegate_nonce: Number(d.nonce), ak_nonce: Number(senderKey.nonce) } });
    senderKey.nonce = d.nonce;

    const call = d.actions[0]?.functionCall;
    if (d.actions.length !== 1 || !call || d.receiverId !== state.token.id || call.methodName !== "ft_transfer") {
      return fail(d.receiverId, { FunctionCallError: { MethodResolveError: "MethodNotFound" } });
    }
    const panic = (message: string) => fail(state.token.id, { FunctionCallError: { ExecutionError: `Smart contract panicked: ${message}` } });
    if (call.deposit !== 1n) return panic("Requires attached deposit of exactly 1 yoctoNEAR");
    if (state.failNextTransfer) {
      const message = state.failNextTransfer;
      state.failNextTransfer = undefined;
      return panic(message);
    }
    const args = JSON.parse(Buffer.from(Uint8Array.from(call.args)).toString("utf8")) as { receiver_id: string; amount: string; memo?: string };
    const amount = BigInt(args.amount);
    const balances = state.token.balances;
    if (!state.token.registered.has(args.receiver_id)) return panic(`The account ${args.receiver_id} is not registered`);
    if ((balances.get(d.senderId) ?? 0n) < amount) return panic("The account doesn't have enough balance");
    balances.set(d.senderId, (balances.get(d.senderId) ?? 0n) - amount);
    balances.set(args.receiver_id, (balances.get(args.receiver_id) ?? 0n) + amount);
    state.transfers.push({ sender: d.senderId, receiver: args.receiver_id, amount, ...(args.memo !== undefined ? { memo: args.memo } : {}), txHash });
    return finish([outcome(d.senderId, { SuccessReceiptId: "inner" }), outcome(state.token.id, { SuccessValue: "" })], { SuccessValue: "" }, [ftReceipt(d.senderId, args)]);
  }

  function handle(method: string, params: Record<string, unknown>): unknown {
    // The chain moves on: each block read sees the next final block, as on a live network (about one a second).
    if (method === "block") state.height += 1n;
    if (method === "block") return { author: "validator.testnet", header: { height: Number(state.height), hash: state.blockHash, timestamp: 0, timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) }, chunks: [] };
    if (method === "status") return { chain_id: "testnet", version: { version: "double" }, sync_info: { latest_block_height: Number(state.height) } };
    if (method === "query") return query(params);
    if (method === "send_tx") return sendTx(params);
    if (method === "tx" || method === "EXPERIMENTAL_tx_status") {
      const found = state.outcomes.get(String(params.tx_hash));
      if (!found) throw new DoubleRpcError("UNKNOWN_TRANSACTION", `Transaction ${String(params.tx_hash)} doesn't exist`);
      return found;
    }
    throw new DoubleRpcError("METHOD_NOT_FOUND", `Method not found: ${method}`);
  }

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    let body: { id?: unknown; method?: unknown; params?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid JSON" }));
      return;
    }
    if (Array.isArray(body)) {
      res.statusCode = 400; // nearcore rejects JSON-RPC batches
      res.end(JSON.stringify({ error: "batch requests are not supported" }));
      return;
    }
    const method = String(body.method);
    state.calls.push(method);
    try {
      const result = handle(method, (body.params ?? {}) as Record<string, unknown>);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
    } catch (e) {
      const err = e instanceof DoubleRpcError ? e : new DoubleRpcError("INTERNAL_ERROR", (e as Error).message);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { name: "HANDLER_ERROR", cause: { name: err.kind, info: {} }, code: -32000, message: "Server error", data: err.data } }));
    }
  });
  return { server, state };
}

/** Add an account with one full-access key (the public key string ed25519:...). */
export function addAccount(state: NearDoubleState, accountId: string, publicKey?: string, permission: Permission = "FullAccess"): void {
  const keys = new Map<string, Key>();
  if (publicKey) keys.set(publicKey, { nonce: 1_000n, permission });
  state.accounts.set(accountId, { keys, codeHash: EMPTY_CODE_HASH });
}

/** A paywall on a loopback port with the NEAR rail loaded first, as src/main.ts does (stubs.ts startPaywall otherwise). */
export async function startNearPaywall(
  env: Record<string, string>,
  log?: (line: string) => void,
  deps: Omit<PaywallDeps, "log" | "nearRail"> = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const near = loadConfig(env).near;
  if (!near) throw new Error("startNearPaywall needs PAY_RAILS with near");
  return startPaywall(env, log, { ...deps, nearRail: await loadNearRail(near) });
}
