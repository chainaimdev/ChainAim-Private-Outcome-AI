/**
 * The three paid routes: description and Bazaar discovery metadata (spec
 * section 9). Prices come from the configuration (PRICE_SCAN, PRICE_MASK,
 * PRICE_CHAT). Every example here is synthetic.
 */
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { xrplOf, type PaywallConfig, type Priced } from "./config.ts";
import { usdcPrices } from "./near/usdc.ts";

export type PaidRoute = { key: string; path: string; priced: Priced; description: string; discovery: Record<string, unknown> };

const EXAMPLE_TEXT = "Patient Jane Roe, MRN 991122, was diagnosed with diabetes.";
const textSchema = (verb: string) => ({
  type: "object",
  properties: { text: { type: "string", minLength: 1, maxLength: 20000, description: `Text to ${verb}, 1 to 20,000 characters` } },
  required: ["text"],
});

export const PAID_ROUTES: readonly PaidRoute[] = [
  {
    key: "POST /v1/privacy/scan",
    path: "/v1/privacy/scan",
    priced: "scan",
    description: "Finds personal, health and card data in text and returns entity types, positions and the data class. No model is called.",
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: { text: EXAMPLE_TEXT },
      inputSchema: textSchema("scan"),
      output: {
        example: {
          decisionId: "7d0c2a1e-5b7f-4c1e-9a53-2f6f0b8e41aa",
          dataClass: "PHI",
          found: ["PHI", "PII"],
          entities: [
            { type: "PERSON", start: 8, end: 16, score: 0.85 },
            { type: "MEDICAL_RECORD", start: 22, end: 28, score: 0.45 },
            { type: "HEALTH_TERM", start: 34, end: 43, score: 1 },
            { type: "HEALTH_TERM", start: 49, end: 57, score: 1 },
          ],
          counts: { PERSON: 1, MEDICAL_RECORD: 1, HEALTH_TERM: 2 },
          policy: { dataCollection: "deny", cardDataRemoved: false },
        },
      },
    }),
  },
  {
    key: "POST /v1/privacy/mask",
    path: "/v1/privacy/mask",
    priced: "mask",
    description: "Replaces personal and health identifiers with numbered placeholders and removes card numbers. Returns the masked text and the map to restore it.",
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: { text: EXAMPLE_TEXT },
      inputSchema: textSchema("mask"),
      output: {
        example: {
          decisionId: "0b9e5f3c-2d41-4a8e-b6c7-91d2e8f4a310",
          dataClass: "PHI",
          found: ["PHI", "PII"],
          maskedText: "Patient <PERSON_1>, MRN <MEDICAL_RECORD_1>, was diagnosed with diabetes.",
          map: { "<PERSON_1>": "Jane Roe", "<MEDICAL_RECORD_1>": "991122" },
          counts: { PERSON: 1, MEDICAL_RECORD: 1, HEALTH_TERM: 2 },
          cardsRemoved: 0,
        },
      },
    }),
  },
  {
    key: "POST /v1/chat/completions",
    path: "/v1/chat/completions",
    priced: "chat",
    description: "OpenAI-compatible private chat. Masks the conversation, routes it with Jev across free models under a data policy set by what it contains, and restores the answer.",
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: {
        model: "chainaim/auto",
        messages: [{ role: "user", content: "Write a two-line reminder to Jane Roe (jane.roe@example.com) about Friday's 10:00 meeting." }],
        max_tokens: 200,
      },
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            minItems: 1,
            description: "OpenAI chat messages; text only, at most 48,000 characters in total",
            items: { type: "object", properties: { role: { type: "string" }, content: { description: "a string, or an array of text parts" } }, required: ["role"] },
          },
          model: { type: "string", description: "chainaim/auto, or a free model id from GET /v1/models" },
          max_tokens: { type: "integer", minimum: 1, maximum: 1024 },
          stream: { type: "boolean" },
          tools: { type: "array" },
          response_format: { type: "object" },
        },
        required: ["messages"],
      },
      output: {
        example: {
          id: "gen-1790000000-example",
          object: "chat.completion",
          model: "qwen/qwen3.8-27b:free",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hi Jane Roe, a reminder that we meet on Friday at 10:00. Reply to jane.roe@example.com if that time doesn't work." },
              finish_reason: "stop",
            },
          ],
        },
      },
    }),
  },
];

/** An RLUSD amount as the XRP Ledger writes it: a decimal string, the currency code, and the issuer and invoice in extra. */
export type RlusdPrice = { amount: string; asset: string; extra: { issuer: string; invoiceId: string } };
/** A USDC amount on NEAR: a whole number of base units, the NEP-141 contract id, and the invoice in extra. */
export type NearUsdcPrice = { amount: string; asset: string; extra: { invoiceId: string } };

type RequestLike = { paymentHeader?: string; path?: string };

export type XrplAccept = {
  scheme: "exact";
  /** Called for every request, because each quoted price has its own invoice. */
  price: (request: RequestLike) => RlusdPrice;
  network: `${string}:${string}`;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { sourceTag: number };
};

/** The NEAR offer carries no scheme extra: @x402/near keeps the relayer facilitator-side (x402 NEAR exact spec, section 3). */
export type NearAccept = {
  scheme: "exact";
  price: (request: RequestLike) => NearUsdcPrice;
  network: `${string}:${string}`;
  payTo: string;
  maxTimeoutSeconds: number;
};

export type RouteEntry = {
  /** One offer per enabled rail, in PAY_RAILS order; all of one quote carry the same invoice. */
  accepts: (XrplAccept | NearAccept)[];
  description: string;
  mimeType: "application/json";
  resource?: string;
  extensions: Record<string, unknown>;
};

/**
 * The route table for paymentMiddleware: one exact price per route and enabled
 * rail (RLUSD on the XRP Ledger, USDC on NEAR; amounts from the configuration),
 * the invoice the payment must commit to, and the Bazaar
 * metadata. invoiceFor gives the invoice id for a request from its payment
 * header (undefined when the request carries no payment).
 */
/**
 * Paid jobs (ARCH-107): the release route's price comes from the job named in the path, and its invoice is bound to
 * that job. Given only with PAID_JOBS=on.
 */
export type JobPricing = {
  amountOf: (jobId: string) => string | undefined;
  invoiceFor: (jobId: string, paymentHeader: string | undefined) => string;
  jobIdOf: (path: string | undefined) => string | undefined;
};

export const JOB_RELEASE_DESCRIPTION = "Releases the held result of one paid job (test console tab 03), priced at the total it was quoted. Paid in USDC on NEAR only.";

export function routesConfig(config: PaywallConfig, invoiceFor: (paymentHeader: string | undefined) => string, jobs?: JobPricing): Record<string, RouteEntry> {
  // With more than one rail, every offer of one quote names the same invoice: the middleware prices all offers
  // with the same request object, so the first offer's invoice is kept for it. Claiming that invoice once
  // (app.ts onBeforeVerify) means one call cannot be paid on two rails. With one rail, nothing changes.
  const shared = new WeakMap<object, string>();
  const invoice =
    config.rails.length > 1
      ? (request: RequestLike): string => {
          const known = shared.get(request);
          if (known !== undefined) return known;
          const id = invoiceFor(request.paymentHeader);
          shared.set(request, id);
          return id;
        }
      : (request: RequestLike): string => invoiceFor(request.paymentHeader);
  const xrpl = config.rails.includes("xrpl") ? xrplOf(config) : undefined;
  const near = config.near;
  const nearPrices = near ? usdcPrices(config.prices, near) : undefined;
  const table: Record<string, RouteEntry> = Object.fromEntries(
    PAID_ROUTES.map((r): [string, RouteEntry] => [
      r.key,
      {
        accepts: config.rails.map((rail): XrplAccept | NearAccept => {
          if (rail === "near" && near && nearPrices) {
            return {
              scheme: "exact",
              // "$0.01" with 6 decimals is "10000": NEP-141 amounts are whole base units.
              price: (request) => ({ amount: nearPrices[r.priced], asset: near.usdcContract, extra: { invoiceId: invoice(request) } }),
              network: near.network,
              payTo: near.payTo,
              maxTimeoutSeconds: config.maxTimeoutSeconds,
            };
          }
          if (rail === "xrpl" && xrpl) {
            return {
              scheme: "exact",
              // "$0.01" is 0.01 RLUSD: the issued-currency amount is the decimal itself, never a count of micro-units.
              price: (request) => ({
                amount: config.prices[r.priced].slice(1),
                asset: xrpl.currencyCode,
                extra: { issuer: xrpl.issuer, invoiceId: invoice(request) },
              }),
              network: xrpl.network,
              payTo: xrpl.payTo,
              maxTimeoutSeconds: config.maxTimeoutSeconds,
              extra: { sourceTag: xrpl.sourceTag },
            };
          }
          throw new Error(`the ${rail} rail is enabled but not configured`);
        }),
        description: r.description,
        mimeType: "application/json",
        ...(config.publicBaseUrl ? { resource: `${config.publicBaseUrl}${r.path}` } : {}),
        extensions: r.discovery,
      },
    ]),
  );
  if (config.paidJobs && jobs && near) {
    // One offer only, NEAR USDC, whatever PAY_RAILS also has: the amount is the job's, never a configured price.
    table["POST /v1/jobs/:id/release"] = {
      accepts: [
        {
          scheme: "exact",
          price: (request) => {
            const jobId = jobs.jobIdOf(request.path);
            const amount = jobId === undefined ? undefined : jobs.amountOf(jobId);
            if (jobId === undefined || amount === undefined) throw new Error("the job is not open");
            return { amount, asset: near.usdcContract, extra: { invoiceId: jobs.invoiceFor(jobId, request.paymentHeader) } };
          },
          network: near.network,
          payTo: near.payTo,
          maxTimeoutSeconds: config.maxTimeoutSeconds,
        },
      ],
      description: JOB_RELEASE_DESCRIPTION,
      mimeType: "application/json",
      extensions: {},
    };
  }
  return table;
}
