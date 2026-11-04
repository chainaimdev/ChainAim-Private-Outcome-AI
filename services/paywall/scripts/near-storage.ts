/**
 * Register a NEAR account with the USDC contract (NEP-145 storage
 * management), once per account. A NEP-141 token refuses an ft_transfer to an
 * account that is not registered, so the paywall's NEAR_PAY_TO_<NETWORK> must
 * be registered before any USDC can be paid to it; the paywall checks this at
 * start (src/near/usdc.ts) and @x402/near's verify refuses payments to an
 * unregistered payTo (docs.near.org/primitives/ft/standard, storage).
 *
 * The signer sends storage_deposit({account_id, registration_only: true}) with
 * the contract's storage_balance_bounds().min attached, in NEAR, and waits for
 * the transaction to be final. Any funded account may register any other.
 *
 *   node scripts/near-storage.ts --account merchant.testnet --dry-run
 *   node scripts/near-storage.ts --account merchant.testnet
 *   node scripts/near-storage.ts --account merchant.testnet --signer-account ops.testnet --key-prefix NEAR_OPS_KEY
 *
 * --account          the account to register (required)
 * --contract         the token; NEAR_USDC_CONTRACT_<NETWORK> by default
 * --signer-account   who pays the deposit; NEAR_BUYER_ACCOUNT_<NETWORK> by default
 * --key-prefix       its key is read from PREFIX_<NETWORK>; NEAR_BUYER_KEY by default
 * --dry-run          show whether it is registered and the deposit; send nothing
 *
 * Exit code: 0 registered (now or already), 1 the transaction failed, 2 a set-up problem.
 */
import { parseArgs } from "node:util";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, createTransaction } from "@near-js/transactions";
import { baseDecode } from "@near-js/utils";
import { isNearAccountId, NEAR_SECRET_KEY } from "../src/config.ts";
import { createNearRpc, type NearRpc } from "../src/near/rpc.ts";
import { nearKeyVariable, nearNetworkName, nearRpcUrl, SetupError } from "./near.ts";

/** 30 TGas: storage_deposit is a small state write. */
const STORAGE_GAS = 30_000_000_000_000n;

export type StorageResult = { registered: true; already: boolean; transaction?: string; deposit?: string };

export async function isRegistered(rpc: NearRpc, contract: string, account: string): Promise<boolean> {
  return (await rpc.view(contract, "storage_balance_of", { account_id: account })) !== null;
}

/**
 * Register `account` with `contract`, paid by the signer. Returns at once when
 * it is already registered. Throws SetupError for a problem found before
 * sending, Error when the transaction failed on chain.
 */
export async function registerWithToken(options: { rpcUrl: string; contract: string; account: string; signerId: string; secretKey: string; dryRun?: boolean }): Promise<StorageResult | { registered: false; deposit: string }> {
  const rpc = createNearRpc({ urls: [options.rpcUrl], timeoutMs: 15_000 });
  if (await isRegistered(rpc, options.contract, options.account)) return { registered: true, already: true };
  const bounds = (await rpc.view(options.contract, "storage_balance_bounds", {})) as { min?: unknown };
  if (typeof bounds?.min !== "string" || !/^\d+$/.test(bounds.min)) throw new SetupError(`${options.contract} does not report storage_balance_bounds().min`);
  if (options.dryRun) return { registered: false, deposit: bounds.min };

  const signer = KeyPairSigner.fromSecretKey(options.secretKey as KeyPairString);
  const publicKey = await signer.getPublicKey();
  const provider = new JsonRpcProvider({ url: options.rpcUrl });
  const [accessKey, block] = await Promise.all([provider.viewAccessKey(options.signerId, publicKey, { finality: "final" }), provider.block({ finality: "final" })]);
  const tx = createTransaction(
    options.signerId,
    publicKey,
    options.contract,
    BigInt(accessKey.nonce) + 1n,
    [actionCreators.functionCall("storage_deposit", { account_id: options.account, registration_only: true }, STORAGE_GAS, BigInt(bounds.min))],
    baseDecode(block.header.hash),
  );
  const [, signed] = await signer.signTransaction(tx);
  const outcome = (await provider.sendTransactionUntil(signed, "FINAL")) as { status?: unknown; transaction_outcome?: { id?: string } };
  const transaction = outcome.transaction_outcome?.id;
  if (typeof outcome.status === "object" && outcome.status !== null && "Failure" in outcome.status) {
    throw new Error(`storage_deposit failed on chain (transaction ${transaction ?? "unknown"}): ${JSON.stringify((outcome.status as { Failure: unknown }).Failure)}`);
  }
  if (!(await isRegistered(rpc, options.contract, options.account))) throw new Error(`storage_deposit was final (transaction ${transaction ?? "unknown"}) but ${options.account} is still not registered`);
  return { registered: true, already: false, deposit: bounds.min, ...(transaction ? { transaction } : {}) };
}

if (process.argv[1] && import.meta.filename === (await import("node:path")).resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      contract: { type: "string" },
      "signer-account": { type: "string" },
      "key-prefix": { type: "string", default: "NEAR_BUYER_KEY" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  try {
    const env = process.env;
    const net = nearNetworkName(env).toUpperCase();
    const account = values.account;
    if (!account || !isNearAccountId(account)) throw new SetupError("--account is required: the NEAR account to register, e.g. merchant.testnet");
    const contract = values.contract ?? env[`NEAR_USDC_CONTRACT_${net}`]?.trim();
    if (!contract || !isNearAccountId(contract)) throw new SetupError(`--contract or NEAR_USDC_CONTRACT_${net} is required: the USDC contract id`);
    const signerId = values["signer-account"] ?? env[`NEAR_BUYER_ACCOUNT_${net}`]?.trim();
    if (!signerId || !isNearAccountId(signerId)) throw new SetupError(`--signer-account or NEAR_BUYER_ACCOUNT_${net} is required: the account that pays the storage deposit`);
    const keyVariable = nearKeyVariable(env, values["key-prefix"]);
    const secretKey = env[keyVariable]?.trim() ?? "";
    // The value is never quoted in a message.
    if (!values["dry-run"] && (!NEAR_SECRET_KEY.test(secretKey) || !(() => { try { KeyPair.fromString(secretKey as KeyPairString); return true; } catch { return false; } })())) {
      throw new SetupError(`${keyVariable} is required: the full-access secret key (ed25519:...) of ${signerId}`);
    }
    const result = await registerWithToken({ rpcUrl: nearRpcUrl(env), contract, account, signerId, secretKey, dryRun: values["dry-run"] });
    if (!result.registered) console.log(`${account} is not registered with ${contract}; registering costs ${result.deposit} yoctoNEAR, paid by ${signerId}. Nothing was sent.`);
    else if (result.already) console.log(`${account} is already registered with ${contract}; nothing was sent`);
    else console.log(`${account} is now registered with ${contract} (deposit ${result.deposit} yoctoNEAR, transaction ${result.transaction ?? "unknown"})`);
    process.exitCode = 0;
  } catch (e) {
    if (e instanceof SetupError) {
      console.error(e.message);
      process.exitCode = 2;
    } else {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
  }
}
