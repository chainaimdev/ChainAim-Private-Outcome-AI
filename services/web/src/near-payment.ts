/**
 * Paying a paywall price in USDC on NEAR (x402 exact scheme, @x402/near): the
 * part the web page and the paywall's buyer scripts share, as xrpl-payment.ts
 * is for RLUSD. No dependency of its own, so it runs in the browser and in Node.
 *
 * The buyer signs, and does not submit, one NEP-366 SignedDelegate holding
 * exactly one NEP-141 ft_transfer of the quoted amount to the quoted payTo on
 * the quoted USDC contract, with 1 yoctoNEAR attached (x402
 * specs/schemes/exact/scheme_exact_near.md; docs.near.org/primitives/ft/standard).
 * The paywall's relayer submits it and pays the gas, and only after the call
 * was served, so the buyer holds no NEAR.
 *
 * Whoever signs (a key in a script, a browser wallet), the signed delegate is
 * decoded by the caller and checked here against the offer before it is sent.
 */

/** One NEAR entry of a 402's accepts list. */
export type NearOffer = {
  scheme: "exact";
  network: string;
  /** The USDC NEP-141 contract id. */
  asset: string;
  /** Whole USDC base units, e.g. "10000" for $0.01 with 6 decimals. */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { invoiceId?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export const NEAR_NETWORK_IDS = { testnet: "near:testnet", mainnet: "near:mainnet" } as const;

/** 30 TGas, @x402/near's default for the delegated ft_transfer (DEFAULT_FT_TRANSFER_GAS). */
export const FT_TRANSFER_GAS = "30000000000000";
/** NEP-141 ft_transfer requires exactly one yoctoNEAR attached (docs.near.org/smart-contracts/security/one_yocto). */
export const ONE_YOCTO = "1";

export function isNearNetworkId(network: string): boolean {
  return network === NEAR_NETWORK_IDS.testnet || network === NEAR_NETWORK_IDS.mainnet;
}

/** The exact NEAR offer for a network, or undefined when the paywall quotes none. */
export function nearOffer(accepts: readonly Record<string, unknown>[], network: string): NearOffer | undefined {
  const a = accepts.find((o) => o.scheme === "exact" && o.network === network);
  if (!a) return undefined;
  if (typeof a.asset !== "string" || typeof a.payTo !== "string" || typeof a.amount !== "string" || !/^[1-9]\d*$/.test(a.amount) || typeof a.maxTimeoutSeconds !== "number") {
    throw new Error("the paywall's NEAR price is not in the expected shape");
  }
  return a as NearOffer;
}

/** The single function call the buyer delegates: what a wallet is asked to sign, in plain fields. */
export function ftTransferCall(offer: NearOffer): { receiverId: string; methodName: "ft_transfer"; args: { receiver_id: string; amount: string }; gas: string; deposit: string } {
  return { receiverId: offer.asset, methodName: "ft_transfer", args: { receiver_id: offer.payTo, amount: offer.amount }, gas: FT_TRANSFER_GAS, deposit: ONE_YOCTO };
}

/** A decoded SignedDelegate, as @x402/near's decodeSignedDelegateB64 gives it (the fields checked here). */
export type DecodedDelegate = {
  senderId: string;
  receiverId: string;
  publicKey: string;
  maxBlockHeight: bigint;
  actionCount: number;
  functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } | null;
};

/** The most gas a delegated ft_transfer may carry before the paywall's relayer refuses it (@x402/near's default cap, 100 TGas). */
const MAX_GAS = 100_000_000_000_000n;

/**
 * Throws, naming what differs, unless the signed delegate is exactly the
 * payment the offer asks for, from `accountId`, with a signature that verifies.
 * Every message ends "nothing was paid": nothing has been sent yet.
 */
export function checkSignedDelegate(d: DecodedDelegate, signatureValid: boolean, offer: NearOffer, accountId: string): void {
  const no = (what: string): never => {
    throw new Error(`${what}; nothing was paid`);
  };
  if (d.senderId !== accountId) no(`the signer signed for ${d.senderId}, not ${accountId}`);
  if (!signatureValid) no("the payment's signature does not verify");
  if (d.receiverId !== offer.asset) no(`the signed payment is for the token ${d.receiverId}, not ${offer.asset}`);
  if (d.actionCount !== 1 || !d.functionCall) no("the signed payment must hold exactly one function call");
  const call = d.functionCall!;
  if (call.methodName !== "ft_transfer") no(`the signed payment calls ${call.methodName}, not ft_transfer`);
  let args: { receiver_id?: unknown; amount?: unknown };
  try {
    args = JSON.parse(new TextDecoder().decode(call.args)) as typeof args;
  } catch {
    return no("the signed payment's ft_transfer arguments are not JSON");
  }
  if (args.receiver_id !== offer.payTo) no(`the signed payment pays ${String(args.receiver_id)}, not ${offer.payTo}`);
  if (args.amount !== offer.amount) no(`the signed payment is for ${String(args.amount)} base units, not ${offer.amount}`);
  if (call.deposit !== 1n) no("the signed payment must attach exactly 1 yoctoNEAR");
  if (call.gas > MAX_GAS) no("the signed payment asks for more gas than the paywall sponsors");
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** The PAYMENT-SIGNATURE header for a signed NEAR payment: x402 v2, the offer as accepted, the signed delegate. */
export function nearPaymentHeader(offer: NearOffer, signedDelegateAction: string, resource?: Record<string, unknown>): string {
  return base64(JSON.stringify({ x402Version: 2, accepted: offer, payload: { signedDelegateAction }, ...(resource ? { resource } : {}) }));
}

/** Whole base units as a decimal string without trailing zeros: 10000 with 6 decimals is "0.01". Integer arithmetic only. */
export function unitsToUsdc(units: bigint | string, decimals: number): string {
  const n = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const fraction = decimals === 0 ? "" : (n % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${n / scale}${fraction ? `.${fraction}` : ""}`;
}

/** A decimal USDC amount as whole base units; more decimals than the token has is an error, never rounded. */
export function usdcToUnits(amount: string, decimals: number): bigint {
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(amount);
  if (!m) throw new Error(`"${amount}" is not a decimal amount`);
  const fraction = m[2] ?? "";
  if (fraction.length > decimals) throw new Error(`"${amount}" has more than ${decimals} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}
