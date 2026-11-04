/**
 * Paywall configuration from the environment (spec sections 9 and 10). The
 * gateway key is the only secret on the XRPL rail, and it is never logged.
 *
 * PAY_RAILS picks how a paid call may be paid: xrpl (RLUSD on the XRP Ledger,
 * the default), near (USDC on NEAR, the x402 exact scheme of @x402/near), or
 * both, "xrpl,near". Unset, the configuration is the XRPL-only one it always
 * was, and no NEAR_* variable is read. With only near, no XRPL_* ledger
 * variable is read. The NEAR relayer key is a second secret, also never logged.
 */
import { isValidClassicAddress } from "ripple-address-codec";

/** XRPL_NETWORK picks one of these; the value is the CAIP-2 id used unless XRPL_CAIP2_<NETWORK> is set. */
export const NETWORKS = {
  testnet: "xrpl:1",
  mainnet: "xrpl:0",
} as const;
export type NetworkName = keyof typeof NETWORKS;

/** The t54 facilitator, used unless FACILITATOR_URL_<NETWORK> is set. */
export const DEFAULT_FACILITATORS: Record<NetworkName, string> = {
  testnet: "https://xrpl-facilitator-testnet.t54.ai",
  mainnet: "https://xrpl-facilitator-mainnet.t54.ai",
};
/** RLUSD's 160-bit currency code, the same on every network. */
export const DEFAULT_RLUSD_CURRENCY_CODE = "524C555344000000000000000000000000000000";
/** Ripple's TestNet RLUSD issuer. MainNet has no default: RLUSD_ISSUER_MAINNET is checked against Ripple's documentation at deploy time. */
export const DEFAULT_RLUSD_ISSUER_TESTNET = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
export const DEFAULT_SOURCE_TAG = 804681468;
export const DEFAULT_MAX_TIMEOUT_SECONDS = 600;

/** The payment rails a paid call may use (PAY_RAILS). */
export const RAILS = ["xrpl", "near"] as const;
export type Rail = (typeof RAILS)[number];

/**
 * NEAR_NETWORK picks one of these. The CAIP-2 ids are the ones the x402 NEAR
 * exact scheme defines (x402 specs/schemes/exact/scheme_exact_near.md) and the
 * only two @x402/near accepts, so there is no override variable.
 * See docs/NEAR-GATES.md, G4.
 */
export const NEAR_NETWORKS = {
  testnet: "near:testnet",
  mainnet: "near:mainnet",
} as const;
export type NearNetworkName = keyof typeof NEAR_NETWORKS;
/** The keyless public RPC endpoints @x402/near defaults to (FastNEAR), used unless NEAR_RPC_URL_<NETWORK> is set. */
export const DEFAULT_NEAR_RPC_URLS: Record<NearNetworkName, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};
/** @x402/near's cap on the gas a relayer sponsors for the delegated ft_transfer: 100 TGas. */
export const DEFAULT_NEAR_MAX_GAS = 100_000_000_000_000n;

/**
 * NEAR account ids (docs.near.org/protocol/accounts-contracts/account-id): 2 to 64
 * characters, lowercase letters, digits and the separators - _ ., where a separator
 * never starts, ends or doubles up. A 64-character hex implicit account matches too.
 */
const NEAR_ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function isNearAccountId(v: string): boolean {
  return v.length >= 2 && v.length <= 64 && NEAR_ACCOUNT_ID.test(v);
}
/** A NEAR secret key as near-api-js writes it: the curve, a colon and base58. */
export const NEAR_SECRET_KEY = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/;

/** Who verifies and settles NEAR payments: a remote x402 facilitator, or this paywall itself through its own relayer account. */
export type NearFacilitator =
  | { kind: "remote"; url: string }
  | {
      kind: "local";
      /** The NEAR account that submits each signed delegate action and pays its gas; never the payer. */
      relayerId: string;
      /** Its full-access secret key (ed25519:...); never logged. */
      relayerKey: string;
    };

export type NearConfig = {
  networkName: NearNetworkName;
  /** CAIP-2 id: near:testnet or near:mainnet. */
  network: `near:${string}`;
  /** The NEAR account every route pays; it must be registered with the USDC contract (NEP-145 storage). */
  payTo: string;
  /** The USDC NEP-141 contract account id (docs/NEAR-GATES.md, G2). */
  usdcContract: string;
  /** USDC decimals; cross-checked against the contract's ft_metadata when the paywall starts. */
  usdcDecimals: number;
  /** JSON-RPC over HTTPS; a token-bearing URL is never logged whole. */
  rpcUrl: string;
  /** Used for reads when the primary does not answer. */
  rpcFallbackUrl?: string;
  facilitator: NearFacilitator;
  /** The most gas a payer's delegated ft_transfer may ask the relayer to sponsor. */
  maxGas: bigint;
};

/** The paid routes, each priced by its own variable (PRICE_SCAN, PRICE_MASK, PRICE_CHAT). */
export const PRICED = ["scan", "mask", "chat"] as const;
export type Priced = (typeof PRICED)[number];
/** Used for any route whose PRICE_* variable is unset. */
export const DEFAULT_PRICE = "$0.01";

/** The XRPL rail's settings: present on PaywallConfig exactly when PAY_RAILS includes xrpl. */
export type XrplConfig = {
  /** CAIP-2 id, checked to be xrpl:<number>. */
  network: `xrpl:${string}`;
  networkName: NetworkName;
  /** The one XRPL account every route pays; it holds a trust line to the RLUSD issuer. */
  payTo: string;
  facilitatorUrl: string;
  /** RLUSD on the XRP Ledger is a currency code plus the account that issues it. */
  currencyCode: string;
  issuer: string;
  /** Put on every signed payment; the facilitator uses it for attribution. */
  sourceTag: number;
};

export type PaywallConfig = Partial<XrplConfig> & {
  /** The enabled rails, in PAY_RAILS order; xrpl alone when PAY_RAILS is unset. */
  rails: Rail[];
  /** The NEAR rail's settings, present exactly when rails includes near. */
  near?: NearConfig;
  /** How long a quoted payment stays payable, and how long its invoice stays open. */
  maxTimeoutSeconds: number;
  /** The private gateway, e.g. http://gateway.railway.internal:8700 */
  gatewayUrl: string;
  gatewayKey: string;
  /** How long a proxied call may take; chat can try three models. */
  gatewayTimeoutMs: number;
  port: number;
  host: string;
  /** Public origin such as https://pay.example.com: the resource URL in 402s and the Bazaar. */
  publicBaseUrl: string | undefined;
  /** USD price per call, e.g. "$0.01"; changeable without a code change. */
  prices: Record<Priced, string>;
  /**
   * PAYWALL_PHASE_LOG=on (default off): each payment_settled line also carries
   * `phases` with capacity_ms, verify_ms, gateway_ms and settle_ms (P14).
   * Names and whole milliseconds only, never text.
   */
  phaseLog?: boolean;
  /**
   * Payment log sink (live ops, Phase 2); undefined when neither PAYMENT_LOG_URL
   * nor PAYMENT_LOG_FILE is set, which keeps today's behaviour byte for byte.
   * When on, each payment_settled line also carries the call's invoiceId and is
   * handed, fire-and-forget, to ledger-watch.
   */
  paymentLog?: PaymentLogConfig;
};

/** The XRPL settings of a configuration that has the xrpl rail; throws on one that has not. */
export function xrplOf(config: PaywallConfig): XrplConfig {
  const { network, networkName, payTo, facilitatorUrl, currencyCode, issuer, sourceTag } = config;
  if (
    !config.rails.includes("xrpl") ||
    network === undefined ||
    networkName === undefined ||
    payTo === undefined ||
    facilitatorUrl === undefined ||
    currencyCode === undefined ||
    issuer === undefined ||
    sourceTag === undefined
  ) {
    throw new Error("the xrpl rail is not enabled in this configuration (PAY_RAILS)");
  }
  return { network, networkName, payTo, facilitatorUrl, currencyCode, issuer, sourceTag };
}

/**
 * A USD price such as "$0.01" as a whole number of a token's base units, with
 * integer arithmetic only. A price with more decimals than the token has is
 * refused rather than rounded.
 */
export function usdToBaseUnits(price: string, decimals: number): string {
  const m = /^\$(0|[1-9]\d*)(?:\.(\d+))?$/.exec(price);
  if (!m) throw new Error(`"${price}" is not a USD price such as $0.01`);
  const fraction = m[2] ?? "";
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) {
    throw new Error(`${price} has more decimals than the token's ${decimals}`);
  }
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + (kept === "" ? 0n : BigInt(kept))).toString();
}

export type PaymentLogConfig = {
  /** ledger-watch's POST /ingest/claim, e.g. http://127.0.0.1:8790/ingest/claim */
  url?: string;
  /** The ingest key ledger-watch takes (its LEDGER_WATCH_INGEST_KEY); never logged. */
  key?: string;
  /** A file the lines are appended to (ledger-watch --paywall-log-file). */
  file?: string;
  /** How long one POST may take before it is abandoned. */
  timeoutMs: number;
  /** Most POSTs in flight; beyond that a line is dropped and counted (the file, when set, still gets it). */
  maxInflight: number;
};

export function loadConfig(env: Record<string, string | undefined>): PaywallConfig {
  const value = (name: string): string | undefined => env[name]?.trim() || undefined;
  const required = (name: string): string => {
    const v = value(name);
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const integer = (name: string, fallback: number): number => {
    const v = value(name);
    const n = v === undefined ? fallback : Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${v}`);
    return n;
  };
  /** A USD price with at most 6 decimals, above zero. RLUSD is a dollar stablecoin, so the same number is the RLUSD amount. */
  const price = (name: string): string => {
    const v = value(name) ?? DEFAULT_PRICE;
    if (!/^\$(0|[1-9]\d*)(\.\d{1,6})?$/.test(v) || Number(v.slice(1)) <= 0) {
      throw new Error(`${name} must be a USD price above zero such as $0.01, got ${v}`);
    }
    return v;
  };

  /** An XRPL classic address; the base58 checksum is verified, so a mistyped address fails here and not at settlement. */
  const address = (name: string, v: string): string => {
    if (!isValidClassicAddress(v)) throw new Error(`${name} must be an XRPL classic address (r...) with a valid checksum`);
    return v;
  };
  const url = (name: string, v: string): string => {
    const trimmed = v.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(trimmed) || !URL.canParse(trimmed)) throw new Error(`${name} must be an http(s) URL`);
    return trimmed;
  };

  const railsValue = value("PAY_RAILS") ?? "xrpl";
  const railNames = railsValue.split(",").map((r) => r.trim());
  if (railNames.some((r) => !(RAILS as readonly string[]).includes(r)) || new Set(railNames).size !== railNames.length) {
    throw new Error(`PAY_RAILS must be xrpl, near or xrpl,near, got ${railsValue}`);
  }
  const rails = railNames as Rail[];
  const xrpl = rails.includes("xrpl") ? loadXrpl() : undefined;
  const near = rails.includes("near") ? loadNear() : undefined;
  const maxTimeoutSeconds = integer("XRPL_MAX_TIMEOUT_SECONDS", DEFAULT_MAX_TIMEOUT_SECONDS);
  if (maxTimeoutSeconds === 0) throw new Error("XRPL_MAX_TIMEOUT_SECONDS must be above zero");

  /** Read only when PAY_RAILS includes xrpl (it does when PAY_RAILS is unset). */
  function loadXrpl(): XrplConfig {
    const chosen = value("XRPL_NETWORK") ?? "testnet";
    if (!Object.hasOwn(NETWORKS, chosen)) throw new Error("XRPL_NETWORK must be testnet or mainnet");
    const networkName = chosen as NetworkName;
    // Only the chosen network's variables are read, so the other network's may stay blank.
    const suffix = networkName.toUpperCase();
    const caip2 = value(`XRPL_CAIP2_${suffix}`) ?? NETWORKS[networkName];
    if (!/^xrpl:\d+$/.test(caip2)) throw new Error(`XRPL_CAIP2_${suffix} must be a CAIP-2 id such as ${NETWORKS[networkName]}, got ${caip2}`);
    const network = caip2 as `xrpl:${string}`;
    const payTo = address(`XRPL_PAY_TO_${suffix}`, required(`XRPL_PAY_TO_${suffix}`));
    const issuerName = `RLUSD_ISSUER_${suffix}`;
    const issuer = address(issuerName, networkName === "testnet" ? (value(issuerName) ?? DEFAULT_RLUSD_ISSUER_TESTNET) : required(issuerName));
    const currencyCode = value("RLUSD_CURRENCY_CODE") ?? DEFAULT_RLUSD_CURRENCY_CODE;
    if (!/^[0-9A-F]{40}$/.test(currencyCode)) throw new Error("RLUSD_CURRENCY_CODE must be 40 uppercase hex characters");
    const facilitatorUrl = url(`FACILITATOR_URL_${suffix}`, value(`FACILITATOR_URL_${suffix}`) ?? DEFAULT_FACILITATORS[networkName]);
    const sourceTag = integer("XRPL_SOURCE_TAG", DEFAULT_SOURCE_TAG);
    if (sourceTag > 0xffffffff) throw new Error("XRPL_SOURCE_TAG must fit in 32 bits");
    return { network, networkName, payTo, facilitatorUrl, currencyCode, issuer, sourceTag };
  }

  /** Read only when PAY_RAILS includes near; only the chosen NEAR network's _TESTNET / _MAINNET variables are read. */
  function loadNear(): NearConfig {
    const chosenNear = value("NEAR_NETWORK") ?? "testnet";
    if (!Object.hasOwn(NEAR_NETWORKS, chosenNear)) throw new Error("NEAR_NETWORK must be testnet or mainnet");
    const nearName = chosenNear as NearNetworkName;
    const net = nearName.toUpperCase();
    const accountId = (name: string): string => {
      const v = required(name);
      if (!isNearAccountId(v)) throw new Error(`${name} must be a NEAR account id (2 to 64 lowercase letters, digits, - _ .), got ${v}`);
      return v;
    };
    const nearPayTo = accountId(`NEAR_PAY_TO_${net}`);
    const usdcContract = accountId(`NEAR_USDC_CONTRACT_${net}`);
    const decimalsName = `NEAR_USDC_DECIMALS_${net}`;
    required(decimalsName);
    const usdcDecimals = integer(decimalsName, 0);
    if (usdcDecimals > 24) throw new Error(`${decimalsName} must be from 0 to 24`);
    const rpcUrl = url(`NEAR_RPC_URL_${net}`, value(`NEAR_RPC_URL_${net}`) ?? DEFAULT_NEAR_RPC_URLS[nearName]);
    const fallbackRaw = value(`NEAR_RPC_FALLBACK_URL_${net}`);
    const rpcFallbackUrl = fallbackRaw === undefined ? undefined : url(`NEAR_RPC_FALLBACK_URL_${net}`, fallbackRaw);
    const facilitatorRaw = value(`NEAR_FACILITATOR_URL_${net}`);
    let facilitator: NearFacilitator;
    if (facilitatorRaw !== undefined) {
      facilitator = { kind: "remote", url: url(`NEAR_FACILITATOR_URL_${net}`, facilitatorRaw) };
    } else {
      const relayerId = accountId(`NEAR_RELAYER_ACCOUNT_${net}`);
      const keyName = `NEAR_RELAYER_KEY_${net}`;
      const relayerKey = value(keyName);
      // The key's value is never put in a message.
      if (!relayerKey) throw new Error(`${keyName} is required without NEAR_FACILITATOR_URL_${net}: the relayer's full-access key (ed25519:...)`);
      if (!NEAR_SECRET_KEY.test(relayerKey)) throw new Error(`${keyName} must be a NEAR secret key such as ed25519:<base58>`);
      if (relayerId === nearPayTo) throw new Error(`NEAR_RELAYER_ACCOUNT_${net} must differ from NEAR_PAY_TO_${net}`);
      facilitator = { kind: "local", relayerId, relayerKey };
    }
    const gasRaw = value("NEAR_MAX_GAS");
    if (gasRaw !== undefined && !/^[1-9]\d*$/.test(gasRaw)) throw new Error(`NEAR_MAX_GAS must be a whole number of gas units above zero, got ${gasRaw}`);
    const maxGas = gasRaw === undefined ? DEFAULT_NEAR_MAX_GAS : BigInt(gasRaw);
    if (maxGas > 300_000_000_000_000n) throw new Error("NEAR_MAX_GAS must be at most 300000000000000 (300 TGas, NEAR's per-transaction limit)");
    return {
      networkName: nearName,
      network: NEAR_NETWORKS[nearName],
      payTo: nearPayTo,
      usdcContract,
      usdcDecimals,
      rpcUrl,
      ...(rpcFallbackUrl !== undefined ? { rpcFallbackUrl } : {}),
      facilitator,
      maxGas,
    };
  }
  const gatewayUrl = url("GATEWAY_URL", required("GATEWAY_URL"));
  const phaseLogValue = value("PAYWALL_PHASE_LOG") ?? "off";
  if (phaseLogValue !== "on" && phaseLogValue !== "off") throw new Error(`PAYWALL_PHASE_LOG must be on or off, got ${phaseLogValue}`);
  const logUrl = value("PAYMENT_LOG_URL");
  const logFile = value("PAYMENT_LOG_FILE");
  let paymentLog: PaymentLogConfig | undefined;
  if (logUrl !== undefined || logFile !== undefined) {
    const key = value("PAYMENT_LOG_KEY");
    if (logUrl !== undefined && (key === undefined || key.length < 24)) throw new Error("PAYMENT_LOG_KEY is required with PAYMENT_LOG_URL: ledger-watch's ingest key, at least 24 characters");
    const timeoutMs = integer("PAYMENT_LOG_TIMEOUT_MS", 1500);
    if (timeoutMs < 100 || timeoutMs > 30_000) throw new Error("PAYMENT_LOG_TIMEOUT_MS must be from 100 to 30000");
    const maxInflight = integer("PAYMENT_LOG_MAX_INFLIGHT", 32);
    if (maxInflight < 1 || maxInflight > 1000) throw new Error("PAYMENT_LOG_MAX_INFLIGHT must be from 1 to 1000");
    paymentLog = { ...(logUrl !== undefined ? { url: url("PAYMENT_LOG_URL", logUrl), key } : {}), ...(logFile !== undefined ? { file: logFile } : {}), timeoutMs, maxInflight };
  }
  const publicBaseUrl = value("PUBLIC_BASE_URL")?.replace(/\/+$/, "");
  if (publicBaseUrl !== undefined && (!publicBaseUrl.startsWith("https://") || !URL.canParse(publicBaseUrl))) {
    throw new Error("PUBLIC_BASE_URL must be an https URL");
  }
  const prices = { scan: price("PRICE_SCAN"), mask: price("PRICE_MASK"), chat: price("PRICE_CHAT") };
  if (near) {
    for (const [name, p] of Object.entries(prices)) {
      try {
        usdToBaseUnits(p, near.usdcDecimals);
      } catch (e) {
        throw new Error(`PRICE_${name.toUpperCase()} cannot be paid in NEAR USDC: ${(e as Error).message}`);
      }
    }
  }
  return {
    // The XRPL fields first, as before rails existed; absent when the xrpl rail is off.
    ...(xrpl ?? {}),
    maxTimeoutSeconds,
    gatewayUrl,
    gatewayKey: required("CHAINAIM_GATEWAY_KEY"),
    gatewayTimeoutMs: integer("GATEWAY_TIMEOUT_MS", 200_000),
    port: integer("PORT", 8080),
    host: value("HOST") ?? "0.0.0.0",
    publicBaseUrl,
    prices,
    phaseLog: phaseLogValue === "on",
    ...(paymentLog ? { paymentLog } : {}),
    rails,
    ...(near ? { near } : {}),
  };
}
