/**
 * AP2 merchant authorization of a paid job's quote (privateAI-design-33 ARCH-628, Phase 1).
 *
 * When a paid job is quoted (server.ts POST /jobs/crossask, after the paywall registered it and quoted the same amount),
 * the console, as the UCP "business", writes the job as a UCP checkout (schema 2026-08-25: ucp, id, line_items, status,
 * currency, totals, links) and signs it with packages/ap2 signMerchantAuthorization: a detached JWS, ES256, over JCS of
 * the checkout. The checkout also carries `dev.chainaim.job` (network, asset, payTo, x402 amount in USDC base units), so
 * the signature commits to where the money goes, not only to the cents total. The buyer's agent verifies it with the
 * pinned public key before its spending policy (ARCH-630); the receipt points at it by hash (ARCH-631).
 *
 * GET /.well-known/ucp (ucpProfile) publishes the capability and the public key (JWK Set `keys[]`). This console offers no
 * UCP REST service (no create/update/complete checkout endpoints), so `services` is empty, as the overview allows.
 *
 * Ids, sizes, hashes and amounts only: never a question, SQL, row, answer or key. Nothing here logs.
 */
import {
  AP2_ALGS,
  AP2_CAPABILITY,
  merchantAuthSha256,
  signerFromEnv,
  signMerchantAuthorization,
  UCP_VERSION,
  type Ap2Alg,
  type Ap2Signer,
} from "../../packages/ap2/src/index.ts";
import { centsOfAmount, USDC_DECIMALS } from "../../packages/crossask/src/cost.ts";
import type { JobOffer } from "./jobs.ts";

export type Ap2Flags = { ap2?: string; "ap2-key-env"?: string; "ap2-alg"?: string; "ap2-terms-url"?: string };
export type Ap2Config = { signer: Ap2Signer; keyEnv: string; alg: Ap2Alg; termsUrl: string };

/** The UCP checkout capability the AP2 extension extends. */
export const CHECKOUT_CAPABILITY = "dev.ucp.shopping.checkout";
/** The payment handler a job is paid with (x402 "exact" on NEAR). Reverse-domain name of ours (design-33 section 2). */
export const PAYMENT_HANDLER = "x402.near.exact";
export const PAYMENT_HANDLER_ID = "x402_near_exact";
/** The extension member carrying where the money goes (additionalProperties of the checkout schema). */
export const JOB_EXTENSION = "dev.chainaim.job";
/** Pages and schemas the profile points at: the ones read for design-33 section 0. */
export const UCP_REFS = {
  overview: "https://ucp.dev/latest/specification/overview/",
  checkoutSchema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/checkout.json`,
  ap2Spec: "https://ucp.dev/latest/specification/payment/extensions/ap2-mandates/",
  ap2Schema: `https://ucp.dev/${UCP_VERSION}/schemas/common/payment_ap2_mandate.json`,
} as const;

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * undefined with --ap2 off (the default); otherwise the signer and terms link, or an Error naming what to set.
 * --ap2 on needs --paid-jobs on and --ap2-terms-url (a UCP checkout requires links; no link is made up here).
 */
export function ap2Config(flags: Ap2Flags, env: Record<string, string | undefined>, paidJobsOn: boolean): Ap2Config | undefined {
  const mode = flags.ap2 ?? "off";
  if (mode !== "on" && mode !== "off") throw new Error(`--ap2 must be on or off, got ${mode}`);
  if (mode === "off") {
    for (const f of ["ap2-key-env", "ap2-alg", "ap2-terms-url"] as const) if (flags[f] !== undefined) throw new Error(`--${f} needs --ap2 on`);
    return undefined;
  }
  if (!paidJobsOn) throw new Error("--ap2 on needs --paid-jobs on (the signed quote is a paid job's quote)");
  const alg = flags["ap2-alg"] ?? "ES256";
  if (!(AP2_ALGS as readonly string[]).includes(alg)) throw new Error(`--ap2-alg must be one of ${AP2_ALGS.join(", ")} (AP2 merchant authorization is ECDSA; design-33 D1), got ${alg}`);
  const keyEnv = flags["ap2-key-env"] ?? "AP2_SIGNING_KEY";
  if (!ENV_NAME.test(keyEnv)) throw new Error(`--ap2-key-env must be an environment variable name, got ${keyEnv}`);
  const termsUrl = flags["ap2-terms-url"];
  if (!termsUrl) throw new Error("--ap2 on needs --ap2-terms-url URL (the checkout's terms_of_service link)");
  if (!URL.canParse(termsUrl) || !/^https?:$/.test(new URL(termsUrl).protocol)) throw new Error(`--ap2-terms-url must be an http(s) URL, got ${termsUrl}`);
  // signerFromEnv names the variable, never its value, when it is missing or not an EC P-256 key.
  const signer = signerFromEnv(env, keyEnv);
  if (signer.alg !== alg) throw new Error(`${keyEnv} signs with ${signer.alg}, not --ap2-alg ${alg}`);
  return { signer, keyEnv, alg: alg as Ap2Alg, termsUrl };
}

export type JobCheckoutInput = {
  jobId: string;
  /** The job's route (receipt.ts routeOf), e.g. "bedrock/nemotron-nano-3-30b". */
  route: string;
  /** x402 amount, USDC base units; must be whole cents (--price-round cent). */
  amount: string;
  /** ms since the epoch. */
  expiresAt: number;
  offer: JobOffer;
  termsUrl: string;
  /** With --receipts on: the dataset id and the hash of its files, as the receipt will carry them. */
  datasetId?: string;
  filesRoot?: string;
};

/** The paid job as a UCP checkout (design-33 section 2). Throws when the amount is not whole cents or the offer differs. */
export function jobCheckout(i: JobCheckoutInput): Record<string, unknown> {
  if (!/^[0-9a-f]{32}$/.test(i.jobId)) throw new Error("jobId must be 32 lowercase hex characters");
  if (i.offer.amount !== i.amount) throw new Error("the paywall's offer names another amount than the quote");
  if (!Number.isFinite(i.expiresAt)) throw new Error("expiresAt must be a time");
  const cents = centsOfAmount(i.amount);
  const totals = [{ type: "subtotal", amount: cents }, { type: "total", amount: cents }];
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: { [CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }], [AP2_CAPABILITY]: [{ version: UCP_VERSION }] },
      payment_handlers: { [PAYMENT_HANDLER]: [{ id: PAYMENT_HANDLER_ID, version: UCP_VERSION }] },
    },
    id: i.jobId,
    status: "ready_for_complete",
    currency: "USD",
    line_items: [{ id: "job", quantity: 1, item: { id: `chainaim.crossask.${i.route}`, title: "ChainAim private analysis job", price: cents }, totals }],
    totals,
    links: [{ type: "terms_of_service", url: i.termsUrl }],
    expires_at: new Date(i.expiresAt).toISOString(),
    [JOB_EXTENSION]: {
      network: i.offer.network, asset: i.offer.asset, payTo: i.offer.payTo, amountUnits: i.amount, usdcDecimals: USDC_DECIMALS,
      ...(i.datasetId !== undefined ? { datasetId: i.datasetId } : {}),
      ...(i.filesRoot !== undefined ? { filesRoot: i.filesRoot } : {}),
    },
  };
}

/** What the console holds beside the job (jobs.ts HeldJob.ap2) and answers to the buyer. */
export type Ap2Hold = { checkout: Record<string, unknown>; merchantAuthorization: string; merchantAuthSha256: string; kid: string };

export function signJobCheckout(cfg: Ap2Config, input: Omit<JobCheckoutInput, "termsUrl">): Ap2Hold {
  const checkout = jobCheckout({ ...input, termsUrl: cfg.termsUrl });
  const merchantAuthorization = signMerchantAuthorization(checkout, cfg.signer);
  return { checkout, merchantAuthorization, merchantAuthSha256: merchantAuthSha256(merchantAuthorization), kid: cfg.signer.kid };
}

/** The `ap2` member of the POST /jobs/crossask answer (wire names as UCP writes them). */
export function ap2Answer(h: Ap2Hold): { checkout: Record<string, unknown>; merchant_authorization: string } {
  return { checkout: h.checkout, merchant_authorization: h.merchantAuthorization };
}

/** GET /.well-known/ucp: the business profile (required ucp.version, ucp.services, ucp.payment_handlers; keys[] JWK Set). */
export function ucpProfile(cfg: Ap2Config): Record<string, unknown> {
  return {
    ucp: {
      version: UCP_VERSION,
      services: {},
      capabilities: {
        [CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION, spec: UCP_REFS.overview, schema: UCP_REFS.checkoutSchema }],
        [AP2_CAPABILITY]: [{ version: UCP_VERSION, spec: UCP_REFS.ap2Spec, schema: UCP_REFS.ap2Schema, extends: CHECKOUT_CAPABILITY }],
      },
      payment_handlers: { [PAYMENT_HANDLER]: [{ id: PAYMENT_HANDLER_ID, version: UCP_VERSION }] },
    },
    keys: [cfg.signer.publicJwk],
  };
}
