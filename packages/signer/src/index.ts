/**
 * ChainAim's seller-side signer (privateAI-design-36 ARCH-660..668): the control plane's only job on a paid job.
 *
 * It prices a job ITSELF from sizes and limits (packages/offer, config/cost-model.json, the pricing catalog and the fee
 * settings), signs the price as an AP2 merchant authorization over a UCP checkout (ES256), verifies the buyer agent's
 * closed Checkout Mandate before the job runs, and signs the Job Evidence Receipt (Ed25519) and its settlement. It never
 * receives a file, a question, a query, a row or an answer: every request is checked against an allowlist of ids, sizes,
 * hashes and amounts, and anything else is refused naming the field (ARCH-661), so the data plane cannot hand it content
 * by mistake.
 *
 * Stateless except the set of mandate nonces already accepted (in memory), so one image runs the same on the owner's PC,
 * on Railway or on AWS (services/signer). The data plane (test-console) reaches it over HTTP with a request key; the same
 * class also serves in-process for one-process development (test-console --signer local).
 *
 * Nothing here logs. Messages name fields and codes, never a key or a value.
 */
import { createPublicKey } from "node:crypto";
import {
  AP2_CAPABILITY,
  attachedJws,
  detachCheckoutJwt,
  merchantAuthSha256,
  signMerchantAuthorization,
  UCP_VERSION,
  verifyCheckoutMandate,
  verifyMerchantAuthorization,
  type Ap2ErrorCode,
  type Ap2Signer,
  type MandateKeyEntry,
  type PublicJwk,
} from "../../ap2/src/index.ts";
import { addSettlement, checkBody, ECONOMICS_FIELDS, EGRESS_FIELDS, keyIdOf, SETTLEMENT_FLOWS, SIGNED_USD6, signReceipt, USD6, verifyReceipt, type ReceiptBody, type ReceiptSigner, type Settlement, type SettlementFlow, type SignedReceipt } from "../../receipt/src/index.ts";
import { ATTESTATION_MODES, checkBasis, LIMIT_FIELDS, limitsOf, parseLimits, quoteOffer, type AttestationMode, type CheckoutLimits, type CostModel, type OfferBasis } from "../../offer/src/index.ts";
import type { RefundBook } from "./refund-book.ts";
import { centsOfAmount, quoteJob, USDC_DECIMALS, type Fees, type JobQuote, type MeterLine, type ModelPrice, type PriceRound } from "../../crossask/src/cost.ts";

// ---- UCP checkout of a paid job (moved here from test-console/console/ap2.ts: the signer builds what it signs) ---------

export const CHECKOUT_CAPABILITY = "dev.ucp.shopping.checkout";
export const PAYMENT_HANDLER = "x402.near.exact";
export const PAYMENT_HANDLER_ID = "x402_near_exact";
export const JOB_EXTENSION = "dev.chainaim.job";
export const UCP_REFS = {
  overview: "https://ucp.dev/latest/specification/overview/",
  checkoutSchema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/checkout.json`,
  ap2Spec: "https://ucp.dev/latest/specification/payment/extensions/ap2-mandates/",
  ap2Schema: `https://ucp.dev/${UCP_VERSION}/schemas/common/payment_ap2_mandate.json`,
} as const;

/** Where the money goes, as the paywall's 402 offer names it. */
export type JobOffer = { network: string; asset: string; payTo: string; amount: string };

export type JobCheckoutInput = {
  jobId: string;
  route: string;
  amount: string;
  expiresAt: number;
  offer: JobOffer;
  termsUrl: string;
  datasetId?: string;
  filesRoot?: string;
  mode?: "estimate-first";
  /** ARCH-680: the signed limits of an estimate-first offer (packages/offer limitsOf); none for a run-hold quote. */
  limits?: CheckoutLimits;
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
      ...(i.mode !== undefined ? { mode: i.mode } : {}),
      ...(i.limits !== undefined ? { limits: i.limits } : {}),
    },
  };
}

/** GET /.well-known/ucp: the business profile (capabilities and the AP2 signing key, keys[] JWK Set). */
export function ucpProfile(publicJwk: PublicJwk): Record<string, unknown> {
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
    keys: [publicJwk],
  };
}

// ---- the allowlist (ARCH-661) -----------------------------------------------------------------------------------------

/** A request the signer refuses: 400, naming the field. Never carries a value. */
export class SignerInputError extends Error {}
/** A request that is well formed but does not match what the signer signed (another amount, job, key): 409. */
export class SignerScopeError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (path: string, want: string): never => { throw new SignerInputError(`${path} must be ${want}`); };

/** Every member of `o` must be one of `allowed`; anything else is refused by name (the data plane cannot slip content in). */
export function onlyFields(o: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
  if (!isObj(o)) return fail(path, "a JSON object");
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new SignerInputError(`${path}.${k} is not accepted: the signer takes ids, sizes, hashes and amounts only`);
  return o;
}
const str = (v: unknown, re: RegExp, path: string, want: string): string => (typeof v === "string" && re.test(v) ? v : fail(path, want));
const int = (v: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fail(path, `a whole number from ${min} to ${max}`));

export const RE = {
  jobId: /^[0-9a-f]{32}$/,
  sha256: /^[0-9a-f]{64}$/,
  model: /^[\w.-]+\/[\w.:-]+$/,
  route: /^[\w.:/+-]{1,400}$/,
  datasetId: /^[A-Za-z0-9_.-]{1,64}$/,
  network: /^near:(testnet|mainnet)$/,
  account: /^[a-z0-9._-]{2,64}$/,
  amount: /^[1-9]\d{0,18}$/,
  decimal: /^(0|[1-9]\d*)(\.\d+)?$/,
  invoice: /^[A-Za-z0-9_-]{1,100}$/,
  tx: /^[1-9A-HJ-NP-Za-km-z]{20,100}$/,
  /** A dataset file name relative to its folder: no control characters, no "..", at most 255 characters. */
  fileName: /^(?!.*(^|\/)\.\.(\/|$))[^\x00-\x1F\x7F]{1,255}$/,
  /** config/datasets.json template labels: printable ASCII. */
  label: /^[\x20-\x7E]{1,120}$/,
  iso: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
  b64: /^[A-Za-z0-9+/]+={0,2}$/,
  keyId: /^[0-9a-f]{32}$/,
} as const;

const BASIS_FIELDS = ["kind", "model", "answerModel", "phrase", "userSql", "totalBytes", "files", "maxPromptChars", "answerMaxPromptChars", "maxTokens", "sqlRetries", "answerMaxRows"] as const;
type CrossaskBasis = Extract<OfferBasis, { kind: "crossask" }>;

/** How a quote is priced: an estimate-first offer from sizes, or a run-hold job from its metered calls. */
export type PriceRequest = { kind: "offer"; basis: CrossaskBasis } | { kind: "metered"; meter: MeterLine[] };

export function parsePriceRequest(raw: unknown, path = "$"): PriceRequest {
  const o = onlyFields(raw, ["kind", "basis", "meter"], path);
  if (o.kind === "offer") {
    if (o.meter !== undefined) fail(`${path}.meter`, "absent for an offer");
    const b = onlyFields(o.basis, BASIS_FIELDS, `${path}.basis`);
    if (b.kind !== "crossask") fail(`${path}.basis.kind`, "crossask");
    if (typeof b.userSql !== "boolean") fail(`${path}.basis.userSql`, "true or false");
    str(b.model, RE.model, `${path}.basis.model`, "a model id provider/name");
    if (b.answerModel !== undefined) str(b.answerModel, RE.model, `${path}.basis.answerModel`, "a model id provider/name");
    for (const f of ["totalBytes", "files", "maxPromptChars", "answerMaxPromptChars", "maxTokens", "sqlRetries", "answerMaxRows"] as const) int(b[f], `${path}.basis.${f}`);
    try { checkBasis(b as CrossaskBasis); } catch (e) { throw new SignerInputError(`${path}.basis: ${(e as Error).message}`); }
    return { kind: "offer", basis: b as CrossaskBasis };
  }
  if (o.kind === "metered") {
    if (o.basis !== undefined) fail(`${path}.basis`, "absent for a metered job");
    if (!Array.isArray(o.meter) || o.meter.length > 64) fail(`${path}.meter`, "a list of at most 64 model calls");
    const meter = (o.meter as unknown[]).map((l, i): MeterLine => {
      const m = onlyFields(l, ["model", "promptTokens", "completionTokens"], `${path}.meter[${i}]`);
      return {
        model: str(m.model, RE.model, `${path}.meter[${i}].model`, "a model id provider/name"),
        ...(m.promptTokens !== undefined ? { promptTokens: int(m.promptTokens, `${path}.meter[${i}].promptTokens`) } : {}),
        ...(m.completionTokens !== undefined ? { completionTokens: int(m.completionTokens, `${path}.meter[${i}].completionTokens`) } : {}),
      };
    });
    return { kind: "metered", meter };
  }
  return fail(`${path}.kind`, "offer or metered");
}

/**
 * sizeTolerancePct (ARCH-680): the console's --offer-size-tolerance-pct, signed into an offer's limits; required for an offer, absent for a metered job.
 * attestation (privateAI-design-39 ARCH-688): the console's --pay-only-attested mode, signed into an offer's limits; absent for a metered job.
 */
export type QuoteRequest = { jobId: string; expiresAt: number; offer: JobOffer; pricing: PriceRequest; route: string; datasetId?: string; filesRoot?: string; mode?: "estimate-first"; sizeTolerancePct?: number; attestation?: AttestationMode };

export function parseQuoteRequest(raw: unknown): QuoteRequest {
  const o = onlyFields(raw, ["jobId", "expiresAt", "offer", "pricing", "route", "datasetId", "filesRoot", "mode", "sizeTolerancePct", "attestation"], "$");
  const of = onlyFields(o.offer, ["network", "asset", "payTo", "amount"], "$.offer");
  const pricing = parsePriceRequest(o.pricing, "$.pricing");
  if (pricing.kind === "offer" && o.sizeTolerancePct === undefined) fail("$.sizeTolerancePct", "a whole number from 0 to 100 for an offer (it is signed into the limits)");
  if (pricing.kind === "metered" && o.sizeTolerancePct !== undefined) fail("$.sizeTolerancePct", "absent for a metered job");
  if (pricing.kind === "metered" && o.attestation !== undefined) fail("$.attestation", "absent for a metered job");
  if (o.attestation !== undefined && !(ATTESTATION_MODES as readonly unknown[]).includes(o.attestation)) fail("$.attestation", ATTESTATION_MODES.join(", "));
  return {
    jobId: str(o.jobId, RE.jobId, "$.jobId", "32 lowercase hex characters"),
    expiresAt: int(o.expiresAt, "$.expiresAt", 1),
    offer: {
      network: str(of.network, RE.network, "$.offer.network", "near:testnet or near:mainnet"),
      asset: str(of.asset, RE.account, "$.offer.asset", "a NEAR token contract id"),
      payTo: str(of.payTo, RE.account, "$.offer.payTo", "a NEAR account id"),
      amount: str(of.amount, RE.amount, "$.offer.amount", "a positive whole number of USDC base units"),
    },
    pricing,
    route: str(o.route, RE.route, "$.route", "the job's model route"),
    ...(o.datasetId !== undefined ? { datasetId: str(o.datasetId, RE.datasetId, "$.datasetId", "a dataset id") } : {}),
    ...(o.filesRoot !== undefined ? { filesRoot: str(o.filesRoot, RE.sha256, "$.filesRoot", "64 lowercase hex characters") } : {}),
    ...(o.mode !== undefined ? { mode: o.mode === "estimate-first" ? ("estimate-first" as const) : fail("$.mode", "estimate-first") } : {}),
    ...(o.sizeTolerancePct !== undefined ? { sizeTolerancePct: int(o.sizeTolerancePct, "$.sizeTolerancePct", 0, 100) } : {}),
    ...(o.attestation !== undefined ? { attestation: o.attestation as AttestationMode } : {}),
  };
}

/** The signed quote the console holds and the buyer verifies: {checkout, merchant_authorization}. */
export type Ap2Quote = { checkout: Record<string, unknown>; merchant_authorization: string };

/** The checkout as the signer built it, checked member by member on the way back in (receipts and mandates carry it). */
function parseAp2Quote(raw: unknown, path: string): Ap2Quote {
  const o = onlyFields(raw, ["checkout", "merchant_authorization"], path);
  if (!isObj(o.checkout)) fail(`${path}.checkout`, "the signed checkout");
  if (typeof o.merchant_authorization !== "string" || o.merchant_authorization.length > 1024) fail(`${path}.merchant_authorization`, "the detached JWS");
  // Only the members jobCheckout writes: a checkout carrying anything else was not built by this signer.
  onlyFields(o.checkout, ["ucp", "id", "status", "currency", "line_items", "totals", "links", "expires_at", JOB_EXTENSION], `${path}.checkout`);
  // ARCH-681: the job extension's members, and inside limits exactly the members limitsOf writes, with their types.
  const ext = onlyFields(o.checkout[JOB_EXTENSION], ["network", "asset", "payTo", "amountUnits", "usdcDecimals", "datasetId", "filesRoot", "mode", "limits"], `${path}.checkout["${JOB_EXTENSION}"]`);
  if (ext.limits !== undefined) {
    const lp = `${path}.checkout["${JOB_EXTENSION}"].limits`;
    onlyFields(ext.limits, LIMIT_FIELDS, lp);
    try { parseLimits(ext.limits, lp); } catch (e) { throw new SignerInputError((e as Error).message); }
  }
  return { checkout: o.checkout as Record<string, unknown>, merchant_authorization: o.merchant_authorization as string };
}

const RECEIPT_FIELDS = ["v", "receiptId", "jobId", "quoteId", "counterOf", "reduced", "route", "datasetId", "files", "filesRoot", "templateLabel", "sqlSha256", "resultSha256", "calls", "egress", "evidenceBundleSha256", "merchantAuthSha256", "mandate", "price", "createdAt"] as const;
const QUOTE_BASIS_FIELDS = ["pricing", "phrase", "userSql", "sqlRetries", "answerMaxRows", "maxPromptChars", "answerMaxPromptChars", "maxTokens", "files", "totalBytes", "sizeTolerancePct", "calls"] as const;
const MANDATE_REF_FIELDS = ["sha256", "kid", "tenant", "accountId", "nonce"] as const;

/** A receipt body checked against the allowlist, down to every file, call and price member, then by checkBody. */
export function parseReceiptBody(raw: unknown, path = "$.body"): ReceiptBody {
  const b = onlyFields(raw, RECEIPT_FIELDS, path);
  for (const f of ["receiptId", "jobId", "quoteId"] as const) str(b[f], /^[0-9a-f]{32}$/, `${path}.${f}`, "32 lowercase hex characters");
  if (b.counterOf !== undefined) str(b.counterOf, RE.jobId, `${path}.counterOf`, "32 lowercase hex characters");
  if (b.reduced !== undefined && (!Array.isArray(b.reduced) || b.reduced.some((r) => typeof r !== "string" || !/^[A-Za-z]{1,40}$/.test(r)))) fail(`${path}.reduced`, "a list of limit names");
  str(b.route, RE.route, `${path}.route`, "the job's model route");
  str(b.datasetId, /^[A-Za-z0-9_.-]{1,64}$/, `${path}.datasetId`, "a dataset id");
  if (b.templateLabel !== undefined) str(b.templateLabel, RE.label, `${path}.templateLabel`, "a template label (printable ASCII, at most 120)");
  str(b.createdAt, RE.iso, `${path}.createdAt`, "an ISO 8601 UTC time");
  if (!Array.isArray(b.files) || b.files.length === 0 || b.files.length > 100_000) fail(`${path}.files`, "a non-empty list");
  (b.files as unknown[]).forEach((f, i) => {
    const x = onlyFields(f, ["name", "bytes", "sha256"], `${path}.files[${i}]`);
    str(x.name, RE.fileName, `${path}.files[${i}].name`, "a relative file name");
    int(x.bytes, `${path}.files[${i}].bytes`);
    str(x.sha256, RE.sha256, `${path}.files[${i}].sha256`, "64 lowercase hex characters");
  });
  if (!Array.isArray(b.calls) || b.calls.length > 64) fail(`${path}.calls`, "a list of at most 64 calls");
  (b.calls as unknown[]).forEach((c, i) => {
    const x = onlyFields(c, ["servedModel", "zone", "chatId", "reqSha256", "respSha256", "attestStatus"], `${path}.calls[${i}]`);
    str(x.servedModel, /^[\w.:/@+-]{1,200}$/, `${path}.calls[${i}].servedModel`, "a model id");
    if (x.zone !== undefined) str(x.zone, /^[\w.-]{1,64}$/, `${path}.calls[${i}].zone`, "a zone id");
    if (x.chatId !== undefined) str(x.chatId, /^[\w.:-]{1,200}$/, `${path}.calls[${i}].chatId`, "a provider chat id");
  });
  // privateAI-design-41 ARCH-697: egress, member by member (hosts, zones, hashes, counts only); checkBody then ties it to calls.
  if (b.egress !== undefined) {
    if (!Array.isArray(b.egress) || b.egress.length > 64) fail(`${path}.egress`, "a list of at most 64 entries");
    (b.egress as unknown[]).forEach((e, i) => {
      const x = onlyFields(e, EGRESS_FIELDS, `${path}.egress[${i}]`);
      int(x.call, `${path}.egress[${i}].call`);
      str(x.destination, /^[a-z0-9.-]{1,253}(:\d{1,5})?$/, `${path}.egress[${i}].destination`, "a host name");
      str(x.zone, /^[a-z][a-z-]{0,39}$/, `${path}.egress[${i}].zone`, "a zone name");
      str(x.sentSha256, RE.sha256, `${path}.egress[${i}].sentSha256`, "64 lowercase hex characters");
      int(x.sentBytes, `${path}.egress[${i}].sentBytes`);
      if (typeof x.masked !== "object" || x.masked === null || Array.isArray(x.masked) || Object.keys(x.masked).length > 64) fail(`${path}.egress[${i}].masked`, "an object of at most 64 entity kinds");
      for (const [k, n] of Object.entries(x.masked as Record<string, unknown>)) { str(k, /^[A-Z_]{1,40}$/, `${path}.egress[${i}].masked key`, "an entity kind"); int(n, `${path}.egress[${i}].masked.${k}`); }
      str(x.residual, /^(pass|off)$/, `${path}.egress[${i}].residual`, "pass or off");
      str(x.dataClass, /^(PHI|PCI|PII|none)$/, `${path}.egress[${i}].dataClass`, "PHI, PCI, PII or none");
    });
  }
  const p = onlyFields(b.price, ["amountUnits", "usdcDecimals", "priceUsd", "quoteBasis", "actualUsd", "economics"], `${path}.price`);
  // privateAI-design-40 ARCH-690: the money trail, amounts only; checkBody then checks that its numbers add up.
  if (p.economics !== undefined) {
    const e = onlyFields(p.economics, ECONOMICS_FIELDS, `${path}.price.economics`);
    if (e.costBasis !== "catalog") fail(`${path}.price.economics.costBasis`, "catalog");
    for (const k of ["nearAiCostUsd", "callFeesUsd", "analystUsd", "nearGasUsd", "costUsd", "overrunAbsorbedUsd"] as const) str(e[k], USD6, `${path}.price.economics.${k}`, "a USD amount with 6 decimals");
    str(e.marginUsd, SIGNED_USD6, `${path}.price.economics.marginUsd`, "a signed USD amount with 6 decimals");
  }
  const qb = onlyFields(p.quoteBasis, QUOTE_BASIS_FIELDS, `${path}.price.quoteBasis`);
  for (const [k, v] of Object.entries(qb)) {
    if (k === "pricing") str(v, /^(estimate-first|after)$/, `${path}.price.quoteBasis.pricing`, "estimate-first or after");
    else if (k === "phrase") str(v, /^(llm|none)$/, `${path}.price.quoteBasis.phrase`, "llm or none");
    else if (k === "userSql") { if (typeof v !== "boolean") fail(`${path}.price.quoteBasis.userSql`, "true or false"); }
    else int(v, `${path}.price.quoteBasis.${k}`);
  }
  if (p.usdcDecimals !== USDC_DECIMALS) fail(`${path}.price.usdcDecimals`, String(USDC_DECIMALS));
  if (b.mandate !== undefined) {
    const m = onlyFields(b.mandate, MANDATE_REF_FIELDS, `${path}.mandate`);
    str(m.sha256, RE.sha256, `${path}.mandate.sha256`, "64 lowercase hex characters");
    str(m.kid, RE.keyId, `${path}.mandate.kid`, "32 hex characters");
    str(m.tenant, /^[a-z0-9_-]{1,32}$/, `${path}.mandate.tenant`, "a tenant id");
    str(m.accountId, RE.account, `${path}.mandate.accountId`, "a NEAR account id");
    str(m.nonce, RE.invoice, `${path}.mandate.nonce`, "the payment's invoice id");
  }
  try { checkBody(b as unknown as ReceiptBody); } catch (e) { throw new SignerInputError((e as Error).message); }
  return b as unknown as ReceiptBody;
}

export type ReceiptRequest = { body: ReceiptBody; ap2?: Ap2Quote; mandate?: string };
export function parseReceiptRequest(raw: unknown): ReceiptRequest {
  const o = onlyFields(raw, ["body", "ap2", "mandate"], "$");
  return {
    body: parseReceiptBody(o.body),
    ...(o.ap2 !== undefined ? { ap2: parseAp2Quote(o.ap2, "$.ap2") } : {}),
    ...(o.mandate !== undefined ? { mandate: typeof o.mandate === "string" && o.mandate.length <= 16_384 ? o.mandate : fail("$.mandate", "the checkout mandate presentation") } : {}),
  };
}

export type SettleRequest = { receipt: SignedReceipt; settlement: Settlement };
export function parseSettleRequest(raw: unknown): SettleRequest {
  const o = onlyFields(raw, ["receipt", "settlement"], "$");
  const r = onlyFields(o.receipt, ["body", "sig"], "$.receipt");
  const sig = onlyFields(r.sig, ["alg", "keyId", "value"], "$.receipt.sig");
  if (sig.alg !== "ed25519") fail("$.receipt.sig.alg", "ed25519");
  str(sig.keyId, RE.keyId, "$.receipt.sig.keyId", "32 hex characters");
  str(sig.value, RE.b64, "$.receipt.sig.value", "base64");
  const s = onlyFields(o.settlement, ["network", "transaction", "invoiceId", "payer", "settledAt", "flow"], "$.settlement");
  const settlement: Settlement = {
    network: str(s.network, RE.network, "$.settlement.network", "near:testnet or near:mainnet"),
    transaction: str(s.transaction, RE.tx, "$.settlement.transaction", "a NEAR transaction hash"),
    invoiceId: str(s.invoiceId, RE.invoice, "$.settlement.invoiceId", "the payment's invoice id"),
    payer: s.payer === null ? null : str(s.payer, RE.account, "$.settlement.payer", "a NEAR account id or null"),
    settledAt: str(s.settledAt, RE.iso, "$.settlement.settledAt", "an ISO 8601 UTC time"),
    // privateAI-design-40 ARCH-691: which x402 flow moved the money (optional).
    ...(s.flow !== undefined ? { flow: (SETTLEMENT_FLOWS as readonly unknown[]).includes(s.flow) ? (s.flow as SettlementFlow) : fail("$.settlement.flow", "authorization or upfront") } : {}),
  };
  return { receipt: { body: parseReceiptBody(r.body, "$.receipt.body"), sig: sig as SignedReceipt["sig"] }, settlement };
}

export type MandateRequest = { mandate: string; jobId: string; nonce: string; ap2: Ap2Quote };
export function parseMandateRequest(raw: unknown): MandateRequest {
  const o = onlyFields(raw, ["mandate", "jobId", "nonce", "ap2"], "$");
  return {
    mandate: typeof o.mandate === "string" && o.mandate.length <= 16_384 ? o.mandate : fail("$.mandate", "the checkout mandate presentation"),
    jobId: str(o.jobId, RE.jobId, "$.jobId", "32 lowercase hex characters"),
    nonce: str(o.nonce, RE.invoice, "$.nonce", "the payment's invoice id"),
    ap2: parseAp2Quote(o.ap2, "$.ap2"),
  };
}

// ---- the signer ---------------------------------------------------------------------------------------------------------

export type Pricing = { prices: ReadonlyMap<string, ModelPrice>; fees: Fees; round: PriceRound; costModel?: CostModel };
export type MandateSettings = { registry: readonly MandateKeyEntry[]; aud: string; skewSec: number; maxLifetimeSec: number };
/**
 * ap2 / receipt: the two signing keys. ca-control-signer always has both; the console's in-process signer (--signer local,
 * one-process development) has the ones its flags turned on, and a request needing a missing one is refused (409).
 */
export type SignerSettings = {
  ap2?: Ap2Signer; receipt?: ReceiptSigner; pricing: Pricing; termsUrl: string; mandates?: MandateSettings; now?: () => number;
  /**
   * privateAI-design-37 ARCH-674/675 (--refunds on): the persisted refund ledger. Accepted mandates and delivered receipts
   * are recorded in it, a mandate nonce stays used across restarts, and a refunding/refunded job gets no receipt (I3).
   */
  refunds?: RefundBook;
};

export type SignedQuote = { quote: JobQuote } & Ap2Quote & { merchantAuthSha256: string; kid: string };
export type MandateRef = { sha256: string; kid: string; tenant: string; accountId: string; nonce: string };
export type MandateResult = ({ ok: true } & MandateRef) | { ok: false; code: Ap2ErrorCode; reason: string };
/** What GET /.well-known/keys answers: public keys only. */
export type PublicKeys = { ap2?: { keys: PublicJwk[] }; receipt?: { keyId: string; publicKeyPem: string }; mandateAudience?: string; mandateTenants?: string[] };

/** What the data plane calls: in-process (SellerSigner) or over HTTP (test-console/console/signer-client.ts). */
export interface SignerApi {
  keys(): Promise<PublicKeys>;
  price(r: PriceRequest): Promise<JobQuote>;
  signQuote(r: QuoteRequest): Promise<SignedQuote>;
  signReceipt(r: ReceiptRequest): Promise<SignedReceipt>;
  settle(r: SettleRequest): Promise<SignedReceipt>;
  verifyMandate(r: MandateRequest): Promise<MandateResult>;
}

export class SellerSigner {
  private readonly s: SignerSettings;
  /** Mandate nonces (invoice ids) already accepted, until their mandate expires: one mandate pays one invoice once. */
  private readonly nonces = new Map<string, number>();
  private readonly now: () => number;

  constructor(s: SignerSettings) {
    this.s = s;
    this.now = s.now ?? Date.now;
  }

  private ap2(): Ap2Signer {
    if (!this.s.ap2) throw new SignerScopeError("this signer holds no AP2 key: quotes are not signed (--ap2 off)");
    return this.s.ap2;
  }

  private receiptKey(): ReceiptSigner {
    if (!this.s.receipt) throw new SignerScopeError("this signer holds no receipt key: receipts are not signed (--receipts off)");
    return this.s.receipt;
  }

  keys(): PublicKeys {
    return {
      ...(this.s.ap2 ? { ap2: { keys: [this.s.ap2.publicJwk] } } : {}),
      ...(this.s.receipt ? { receipt: { keyId: this.s.receipt.keyId, publicKeyPem: this.s.receipt.publicKeyPem } } : {}),
      ...(this.s.mandates ? { mandateAudience: this.s.mandates.aud, mandateTenants: this.s.mandates.registry.map((t) => t.tenant) } : {}),
    };
  }

  /** ARCH-662: the price, computed here from sizes (offer) or metered calls, never taken from the caller. */
  price(r: PriceRequest): JobQuote {
    const p = this.s.pricing;
    try {
      if (r.kind === "offer") {
        if (!p.costModel) throw new Error("this signer has no cost model (--cost-model): it cannot price an estimate-first offer");
        return quoteOffer(r.basis, p.prices, p.fees, p.costModel, p.round);
      }
      return quoteJob(r.meter, p.prices, p.fees, { round: p.round });
    } catch (e) {
      throw e instanceof SignerInputError ? e : new SignerScopeError(`no price for this job: ${(e as Error).message}`);
    }
  }

  /** ARCH-662: prices the job itself, then signs the checkout only when the paywall's offer names that same amount. */
  signQuote(r: QuoteRequest): SignedQuote {
    const quote = this.price(r.pricing);
    if (r.offer.amount !== quote.amount) throw new SignerScopeError("the offer's amount is not the price this signer computed for the job");
    // ARCH-680: the limits come from the same parsed basis that was priced, so the signed price and the signed limits cannot differ.
    let limits: CheckoutLimits | undefined;
    if (r.pricing.kind === "offer") {
      if (r.sizeTolerancePct === undefined) throw new SignerInputError("$.sizeTolerancePct is required for an offer (it is signed into the limits)");
      try { limits = limitsOf(r.pricing.basis, r.sizeTolerancePct, r.attestation); } catch (e) { throw new SignerInputError(`$.pricing.basis: ${(e as Error).message}`); }
    }
    const checkout = jobCheckout({ jobId: r.jobId, route: r.route, amount: quote.amount, expiresAt: r.expiresAt, offer: r.offer, termsUrl: this.s.termsUrl, ...(r.datasetId ? { datasetId: r.datasetId } : {}), ...(r.filesRoot ? { filesRoot: r.filesRoot } : {}), ...(r.mode ? { mode: r.mode } : {}), ...(limits ? { limits } : {}) });
    const key = this.ap2();
    const merchant_authorization = signMerchantAuthorization(checkout, key);
    return { quote, checkout, merchant_authorization, merchantAuthSha256: merchantAuthSha256(merchant_authorization), kid: key.kid };
  }

  /** The signed quote, verified with this signer's own key and bound to the job id and amount. */
  private ownQuote(q: Ap2Quote, jobId: string, amountUnits?: string): void {
    const v = verifyMerchantAuthorization(q.merchant_authorization, q.checkout, [this.ap2().publicJwk]);
    if (!v.ok) throw new SignerScopeError(`the quote was not signed by this signer (${v.code})`);
    if (q.checkout.id !== jobId) throw new SignerScopeError("the signed quote is for another job");
    const ext = q.checkout[JOB_EXTENSION] as Record<string, unknown> | undefined;
    if (amountUnits !== undefined && ext?.amountUnits !== amountUnits) throw new SignerScopeError("the signed quote's amount is not this receipt's amount");
  }

  /**
   * ARCH-667: the buyer agent's closed Checkout Mandate, checked before the job runs: the tenant's registered key, this
   * signer's audience, the payment's invoice id as nonce, the times, the checkout it commits to being exactly the quote
   * this signer signed for this job, and the nonce not used before. Never throws on a bad mandate: a verdict with the AP2
   * error code, which the console turns into a refusal (nothing runs, nothing settles).
   */
  verifyMandate(r: MandateRequest): MandateResult {
    if (!this.s.mandates) return { ok: false, code: "agent_missing_key", reason: "this signer has no mandate key registry (--mandate-keys): it cannot verify checkout mandates" };
    const m = this.s.mandates;
    const nowMs = this.now();
    for (const [n, until] of this.nonces) if (until <= nowMs) this.nonces.delete(n);
    if (this.nonces.has(r.nonce) || this.s.refunds?.mandateFor(r.nonce)) return { ok: false, code: "mandate_scope_mismatch", reason: "a mandate for this invoice was already accepted" };
    const v = verifyCheckoutMandate(r.mandate, { registry: m.registry, aud: m.aud, nonce: r.nonce, now: Math.floor(nowMs / 1000), skewSec: m.skewSec, maxLifetimeSec: m.maxLifetimeSec });
    if (!v.ok) return v;
    try { this.ownQuote(r.ap2, r.jobId); } catch (e) { return { ok: false, code: "mandate_scope_mismatch", reason: (e as Error).message }; }
    if (v.checkoutJwt !== attachedJws(r.ap2.merchant_authorization, r.ap2.checkout)) return { ok: false, code: "mandate_scope_mismatch", reason: "the mandate permits another checkout than this job's signed quote" };
    this.nonces.set(r.nonce, (v.exp + m.skewSec) * 1000);
    this.s.refunds?.append({ kind: "mandate_accepted", invoiceId: r.nonce, jobId: r.jobId, accountId: v.accountId, exp: v.exp });
    return { ok: true, sha256: v.sha256, kid: v.kid, tenant: v.tenant, accountId: v.accountId, nonce: v.nonce };
  }

  /**
   * ARCH-668: signs a receipt body that passed the allowlist. A body pointing at a signed quote must come with it (signed
   * by this signer, same job and amount); a body naming a mandate must come with the presentation, which must verify
   * (signature, checkout, nonce = the recorded invoice; its times were checked before the run) and match the record.
   */
  signReceipt(r: ReceiptRequest): SignedReceipt {
    const b = r.body;
    // privateAI-design-37 ARCH-675 (I3): a job whose upfront payment is being or was refunded never gets a receipt.
    const book = this.s.refunds;
    const nonce = (b as ReceiptBody & { mandate?: MandateRef }).mandate?.nonce;
    if (book && (book.refundOfJob(b.jobId) || (nonce !== undefined && book.refundOf(nonce)))) throw new SignerScopeError("this job was refunded; no receipt");
    if (b.merchantAuthSha256 !== undefined) {
      if (!r.ap2) throw new SignerInputError("$.ap2 is required: the body points at a signed quote (merchantAuthSha256)");
      if (merchantAuthSha256(r.ap2.merchant_authorization) !== b.merchantAuthSha256) throw new SignerScopeError("merchantAuthSha256 is not the hash of this signed quote");
      this.ownQuote(r.ap2, b.jobId, b.price.amountUnits);
    }
    const ref = (b as ReceiptBody & { mandate?: MandateRef }).mandate;
    if (ref !== undefined) {
      if (!r.mandate || !r.ap2) throw new SignerInputError("$.mandate and $.ap2 are required: the body records a checkout mandate");
      if (!this.s.mandates) throw new SignerScopeError("this signer has no mandate key registry: it cannot sign a receipt that records a mandate");
      const v = verifyCheckoutMandate(r.mandate, { registry: this.s.mandates.registry, aud: this.s.mandates.aud, nonce: ref.nonce });
      if (!v.ok) throw new SignerScopeError(`the recorded mandate does not verify (${v.code})`);
      if (v.sha256 !== ref.sha256 || v.kid !== ref.kid || v.tenant !== ref.tenant || v.accountId !== ref.accountId) throw new SignerScopeError("the body's mandate record is not this mandate");
      if (v.checkoutJwt !== attachedJws(r.ap2.merchant_authorization, r.ap2.checkout)) throw new SignerScopeError("the mandate permits another checkout than the receipt's signed quote");
    }
    const signed = signReceipt(b, this.receiptKey());
    // Recorded before it is returned: from here on the job can no longer be refunded (I3).
    book?.append({ kind: "delivered", jobId: b.jobId, ...(nonce !== undefined ? { invoiceId: nonce } : {}) });
    return signed;
  }

  /** ARCH-668: appends the settlement to a receipt this signer signed; with a mandate, the invoice must be the mandate's nonce. */
  settle(r: SettleRequest): SignedReceipt {
    const key = this.receiptKey();
    const v = verifyReceipt(r.receipt, key.publicKeyPem);
    if (!v.ok) throw new SignerScopeError(`the receipt was not signed by this signer: ${v.reason}`);
    const ref = (r.receipt.body as ReceiptBody & { mandate?: MandateRef }).mandate;
    if (ref && ref.nonce !== r.settlement.invoiceId) throw new SignerScopeError("the payment's invoice is not the one the checkout mandate permitted");
    if (ref && r.settlement.payer !== null && r.settlement.payer !== ref.accountId) throw new SignerScopeError("the payment came from another account than the mandate's tenant");
    return addSettlement(r.receipt, r.settlement, key);
  }

  /** The same signer as the async SignerApi the console uses (in-process: --signer local). */
  api(): SignerApi {
    return {
      keys: async () => this.keys(),
      price: async (r) => this.price(parsePriceRequest(r)),
      signQuote: async (r) => this.signQuote(parseQuoteRequest(r)),
      signReceipt: async (r) => this.signReceipt(parseReceiptRequest(r)),
      settle: async (r) => this.settle(parseSettleRequest(r)),
      verifyMandate: async (r) => this.verifyMandate(parseMandateRequest(r)),
    };
  }
}

/** The receipt key id of a PEM public key (for a client pinning what /.well-known/keys answered). */
export function receiptKeyIdOfPem(pem: string): string {
  return keyIdOf(createPublicKey(pem));
}

export { detachCheckoutJwt };
