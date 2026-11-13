/**
 * What the scripts share for NEAR: which network, RPC and account the
 * environment names, and paying a paywall price in USDC on NEAR (x402 exact
 * scheme, @x402/near). The key is read here and never printed or saved. The
 * repository's .env is read when this file loads (through scripts/xrpl.ts).
 *
 * NEAR_NETWORK                  testnet (default) or mainnet
 * NEAR_RPC_URL_<NETWORK>        NEAR JSON-RPC over HTTPS; FastNEAR's public endpoint by default
 * NEAR_BUYER_ACCOUNT_<NETWORK>  the account that pays (e.g. buyer.testnet), unless a script names one
 * <PREFIX>_<NETWORK>            its full-access secret key (ed25519:...); PREFIX is NEAR_BUYER_KEY
 *                               unless a script names another (the rig names one per tenant)
 * NEAR_USDC_CONTRACT_<NETWORK>  optional: when set, a price in any other token is refused before signing
 *
 * payAndFetchNear mirrors payAndFetch (scripts/xrpl.ts): read the 402, pick the
 * offer for this network, refuse a price above --max-amount, have the signer
 * sign, decode and check the signed delegate against the offer, send it, read
 * the receipt. The paywall's relayer submits the transfer only when the call is
 * served, so a refused call costs nothing.
 */
import { decodeSignedDelegateB64 } from "@x402/near";
import { checkSignedDelegate, nearOffer, nearPaymentHeader, unitsToUsdc, usdcToUnits, type NearOffer } from "../../web/src/near-payment.ts";
import { DEFAULT_NEAR_RPC_URLS, NEAR_NETWORKS, NEAR_SECRET_KEY, isNearAccountId, type NearNetworkName } from "../src/config.ts";
import { createNearRpc, type NearRpc } from "../src/near/rpc.ts";
import { keySigner, type NearSigner } from "./near-signer.ts";
import { refusalReason, SetupError, type Paid, type PayStep, type StepInfo } from "./xrpl.ts";

export { SetupError };

export function nearNetworkName(env: Record<string, string | undefined>): NearNetworkName {
  const chosen = env.NEAR_NETWORK?.trim() || "testnet";
  if (!Object.hasOwn(NEAR_NETWORKS, chosen)) throw new SetupError("NEAR_NETWORK must be testnet or mainnet");
  return chosen as NearNetworkName;
}

export function nearRpcUrl(env: Record<string, string | undefined>): string {
  const name = nearNetworkName(env);
  const variable = `NEAR_RPC_URL_${name.toUpperCase()}`;
  const url = (env[variable]?.trim() || DEFAULT_NEAR_RPC_URLS[name]).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url) || !URL.canParse(url)) throw new SetupError(`${variable} must be an http(s) URL`);
  return url;
}

/** The prefix of the variable that holds a buyer's key when a script names no other. */
export const DEFAULT_NEAR_KEY_PREFIX = "NEAR_BUYER_KEY";

export function nearKeyVariable(env: Record<string, string | undefined>, keyPrefix: string = DEFAULT_NEAR_KEY_PREFIX): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(keyPrefix)) throw new SetupError(`"${keyPrefix}" is not a valid key variable prefix: use capital letters, digits and _, starting with a letter`);
  return `${keyPrefix}_${nearNetworkName(env).toUpperCase()}`;
}

/** Who pays on NEAR: the network and RPC the payment is prepared from, the signer, and the USDC contract the buyer expects (if named). */
export type NearBuyer = { networkName: NearNetworkName; network: string; rpcUrl: string; signer: NearSigner; usdcContract?: string };

/** A buyer whose payments are signed with a full-access key from the environment. */
export function nearBuyer(env: Record<string, string | undefined>, options: { accountId?: string; keyPrefix?: string } = {}): NearBuyer {
  const name = nearNetworkName(env);
  const net = name.toUpperCase();
  const accountVariable = `NEAR_BUYER_ACCOUNT_${net}`;
  const accountId = options.accountId ?? env[accountVariable]?.trim();
  if (!accountId) throw new SetupError(`${accountVariable} is required: the NEAR account that pays (e.g. buyer.${name})`);
  if (!isNearAccountId(accountId)) throw new SetupError(`"${accountId}" is not a NEAR account id`);
  const keyVariable = nearKeyVariable(env, options.keyPrefix);
  const secretKey = env[keyVariable]?.trim();
  if (!secretKey) throw new SetupError(`${keyVariable} is required: the full-access secret key (ed25519:...) of ${accountId}`);
  // The value is never quoted in a message.
  if (!NEAR_SECRET_KEY.test(secretKey)) throw new SetupError(`${keyVariable} is not a NEAR secret key (ed25519:<base58>)`);
  const rpcUrl = nearRpcUrl(env);
  let signer: NearSigner;
  try {
    signer = keySigner({ accountId, secretKey, network: NEAR_NETWORKS[name], rpcUrl });
  } catch {
    throw new SetupError(`${keyVariable} is not a valid NEAR secret key`);
  }
  const usdcContract = env[`NEAR_USDC_CONTRACT_${net}`]?.trim() || undefined;
  return { networkName: name, network: NEAR_NETWORKS[name], rpcUrl, signer, ...(usdcContract ? { usdcContract } : {}) };
}

/** A token's decimals from its NEP-148 ft_metadata. */
export async function tokenDecimals(rpc: NearRpc, contract: string): Promise<number> {
  const meta = (await rpc.view(contract, "ft_metadata", {})) as { decimals?: unknown };
  if (typeof meta?.decimals !== "number" || !Number.isInteger(meta.decimals)) throw new SetupError(`${contract} does not report its decimals in ft_metadata`);
  return meta.decimals;
}

export type NearPayOptions = {
  /** Refuse, before signing, a price above this USDC amount (a decimal such as 0.05). */
  maxAmount?: string;
  /** Reads for the decimals check; by default the buyer's RPC. */
  rpc?: NearRpc;
  /** Called at each buyer-side step of a call whose price carried an invoice id; must not throw. */
  onStep?: (step: PayStep, info: StepInfo) => void;
  /**
   * privateAI-design-33 ARCH-630: refuse, before signing, an offer whose payee, asset or amount (base units) is not this
   * one (the agent passes what the console signed). The message carries mandate_scope_mismatch.
   */
  requireOffer?: { payTo: string; asset: string; amount: string };
  /**
   * privateAI-design-36 ARCH-666: headers for the paid request, made from the offer right before the payment is signed (the
   * agent's AP2 checkout mandate, bound to the offer's invoice id). A throw stops the payment: nothing is signed or paid.
   */
  headersFor?: (offer: { invoiceId?: string; amount: string; payTo: string; asset: string }) => Record<string, string>;
};

/** What payAndFetchNear returned: Paid, with amount the USDC decimal signed for (as RLUSD is on the XRPL rail), and units the same in base units. */
export type NearPaid = Paid & { units?: string };

/**
 * Call a paywall route and pay its NEAR USDC price. A route that asks for no
 * payment is returned as is.
 */
export async function payAndFetchNear(url: string, init: { method: string; headers: Record<string, string>; body: string }, buyer: NearBuyer, options: NearPayOptions = {}): Promise<NearPaid> {
  const first = await fetch(url, init);
  const header = first.headers.get("payment-required");
  if (first.status !== 402 || !header) return { response: first };
  let required: { accepts?: unknown; resource?: unknown };
  try {
    required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as typeof required;
  } catch {
    throw new SetupError("the paywall's PAYMENT-REQUIRED header could not be read; nothing was paid");
  }
  const accepts = Array.isArray(required.accepts) ? (required.accepts as Record<string, unknown>[]) : [];
  let offer: NearOffer | undefined;
  try {
    offer = nearOffer(accepts, buyer.network);
  } catch (e) {
    throw new SetupError(`${(e as Error).message}; nothing was paid`);
  }
  if (!offer) {
    const asked = accepts.map((a) => `${String(a.scheme)} on ${String(a.network)}`).join(", ");
    throw new SetupError(`the paywall asks for ${asked || "nothing this script can pay"}, but NEAR_NETWORK is ${buyer.networkName} (${buyer.network}); nothing was paid`);
  }
  if (buyer.usdcContract && offer.asset !== buyer.usdcContract) {
    throw new SetupError(`the paywall asks to be paid in ${offer.asset}, not the USDC contract ${buyer.usdcContract} this buyer is set up for; nothing was paid`);
  }
  if (options.requireOffer) {
    const want = options.requireOffer;
    for (const [field, got, exp] of [["payee", offer.payTo, want.payTo], ["asset", offer.asset, want.asset], ["amount", offer.amount, want.amount]] as const) {
      if (got !== exp) throw new SetupError(`mandate_scope_mismatch: the paywall's ${field} (${String(got)}) is not the one ChainAim signed (${exp}); nothing was paid`);
    }
  }
  const rpc = options.rpc ?? createNearRpc({ urls: [buyer.rpcUrl], timeoutMs: 10_000 });
  const decimals = await tokenDecimals(rpc, offer.asset);
  const usdc = unitsToUsdc(offer.amount, decimals);
  if (options.maxAmount !== undefined) {
    // The ceiling may carry more decimals than the token (the rig's remaining budget has up to 15): it is cut down
    // to the token's precision, never rounded up, so it can only allow less.
    const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(options.maxAmount);
    if (!m) throw new SetupError(`--max-amount: "${options.maxAmount}" is not a decimal amount`);
    const ceiling = usdcToUnits(`${m[1]}${m[2] ? `.${m[2].slice(0, decimals)}` : ""}`.replace(/\.$/, ""), decimals);
    if (BigInt(offer.amount) > ceiling) throw new SetupError(`the price ${usdc} USDC is above the most this buyer may pay now (${options.maxAmount} USDC); nothing was paid`);
  }
  const invoiceId = typeof offer.extra?.invoiceId === "string" && offer.extra.invoiceId !== "" ? offer.extra.invoiceId : undefined;
  const step = (s: PayStep, extra: { status?: number; transaction?: string } = {}): void => {
    if (invoiceId !== undefined) options.onStep?.(s, { invoiceId, amount: usdc, network: offer.network, ...extra });
  };
  step("quoted");
  let extra: Record<string, string> = {};
  if (options.headersFor) {
    try { extra = options.headersFor({ ...(invoiceId !== undefined ? { invoiceId } : {}), amount: offer.amount, payTo: offer.payTo, asset: offer.asset }); }
    catch (e) { throw new SetupError((e as Error).message); }
  }
  const signedDelegateAction = await buyer.signer.createSignedDelegateAction({ x402Version: 2, paymentRequirements: offer as never });
  let decoded;
  try {
    decoded = decodeSignedDelegateB64(signedDelegateAction);
  } catch {
    throw new SetupError("the signer returned something that is not a signed NEAR delegate action; nothing was paid");
  }
  try {
    checkSignedDelegate(decoded.delegate, decoded.verifySignature(), offer, buyer.signer.accountId);
    if (decoded.delegate.publicKey !== buyer.signer.publicKey) throw new Error("the signer used another key than its own; nothing was paid");
  } catch (e) {
    throw new SetupError((e as Error).message);
  }
  step("signed");
  const resource = typeof required.resource === "object" && required.resource !== null ? (required.resource as Record<string, unknown>) : undefined;
  step("sent");
  const response = await fetch(url, { ...init, headers: { ...init.headers, ...extra, "PAYMENT-SIGNATURE": nearPaymentHeader(offer, signedDelegateAction, resource) } });
  const receiptHeader = response.headers.get("payment-response");
  let receipt: Paid["receipt"];
  if (receiptHeader) {
    try {
      receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as Paid["receipt"];
    } catch {
      receipt = undefined;
    }
  }
  step("answered", { status: response.status, ...(receipt?.transaction ? { transaction: receipt.transaction } : {}) });
  const refusal = response.status === 402 ? (refusalReason(response) ?? "the paywall asked for payment again and gave no reason") : undefined;
  return { response, amount: usdc, units: offer.amount, ...(invoiceId !== undefined ? { invoiceId } : {}), ...(refusal ? { refusal } : {}), receipt };
}
