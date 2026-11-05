/**
 * The one total a paid tab 03 job costs (architecture.md ARCH-103): the model calls it made, priced from the catalog,
 * plus the configured fees, plus the margin, at least the minimum price, rounded UP to 6 decimals (USDC has 6).
 *
 *   total = (Σ(promptTokens × inputPerM + completionTokens × outputPerM) / 1e6 + calls × perModelCallUsd
 *            + analystUsd + nearGasUsd) × (1 + marginPct / 100), then max(…, minPriceUsd), then ceil to 1e-6
 *
 * Exact integer arithmetic on decimal strings (BigInt), never floating point. Fails closed: a call without usage or a
 * model without a price throws, so no job is quoted on a guessed price. A model id ending ":free" (the OpenRouter free
 * pool, as the gateway's routing/freepool.ts filters them) costs 0. Pure: no imports, no I/O.
 */

export type MeterLine = { model: string; promptTokens?: number; completionTokens?: number };
export type ModelPrice = { inputPerM: number | string; outputPerM: number | string };
export type Fees = { perModelCallUsd: string; analystUsd: string; nearGasUsd: string; marginPct: string; minPriceUsd: string };
export type BreakdownLine = { model: string; promptTokens: number; completionTokens: number; usd: string };
export type JobQuote = {
  /** The total in USD, exactly 6 decimals, e.g. "0.012001". */
  totalUsd: string;
  /** The same in USDC base units (6 decimals), a positive integer string. */
  amount: string;
  breakdown: {
    calls: BreakdownLine[]; modelUsd: string; callFeesUsd: string; analystUsd: string; nearGasUsd: string; marginPct: string; minPriceUsd: string; minApplied: boolean;
    /** Model cost + call fees + analyst fee + NEAR gas fee, before the margin, exact then rounded up to 6 decimals. */
    subtotalUsd: string;
    /** The subtotal with the margin, before the minimum price, rounded up to 6 decimals (the total when the minimum is not applied). */
    withMarginUsd: string;
  };
};

/** USDC decimals: the amount is in millionths of a dollar. */
export const USDC_DECIMALS = 6;

/** A non-negative decimal (string, or a JSON number such as 0.0618 or 1e-7) as n / 10^scale, exactly. */
export function parseDecimal(v: number | string, what: string): { n: bigint; scale: number } {
  let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v).trim();
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) throw new Error(`${what}: "${v}" is not a non-negative decimal`);
  const digits = m[1] + (m[2] ?? "");
  let scale = (m[2] ?? "").length - Number(m[3] ?? 0);
  let n = BigInt(digits);
  if (scale < 0) { n *= 10n ** BigInt(-scale); scale = 0; }
  return { n, scale };
}

/** n / 10^scale brought to a common scale. */
const at = (d: { n: bigint; scale: number }, scale: number): bigint => d.n * 10n ** BigInt(scale - d.scale);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
/** A non-negative integer count of millionths as a 6-decimal USD string. */
export function microsToUsd(micros: bigint): string {
  const s = micros.toString().padStart(USDC_DECIMALS + 1, "0");
  return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`;
}
const tokens = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`${what}: no token usage`);
  return v;
};

/** The price of one model id: catalog entry, or 0 for an OpenRouter ":free" model. Throws when unpriced. */
function priceOf(model: string, prices: ReadonlyMap<string, ModelPrice> | Record<string, ModelPrice>): ModelPrice {
  if (model.endsWith(":free")) return { inputPerM: 0, outputPerM: 0 };
  const p = prices instanceof Map ? prices.get(model) : Object.hasOwn(prices, model) ? (prices as Record<string, ModelPrice>)[model] : undefined;
  if (!p) throw new Error(`model ${model} has no price in the pricing catalog`);
  return p;
}

export function quoteJob(meter: readonly MeterLine[], prices: ReadonlyMap<string, ModelPrice> | Record<string, ModelPrice>, fees: Fees): JobQuote {
  // Common scale for everything: enough for the catalog's prices and the fees as given.
  const f = {
    perCall: parseDecimal(fees.perModelCallUsd, "perModelCallUsd"), analyst: parseDecimal(fees.analystUsd, "analystUsd"),
    gas: parseDecimal(fees.nearGasUsd, "nearGasUsd"), margin: parseDecimal(fees.marginPct, "marginPct"), min: parseDecimal(fees.minPriceUsd, "minPriceUsd"),
  };
  const lines = meter.map((l, i) => {
    if (typeof l?.model !== "string" || !l.model) throw new Error(`model call ${i + 1}: no model id`);
    const pt = tokens(l.promptTokens, `model call ${i + 1} (${l.model})`), ct = tokens(l.completionTokens, `model call ${i + 1} (${l.model})`);
    const p = priceOf(l.model, prices);
    return { model: l.model, pt, ct, inP: parseDecimal(p.inputPerM, `${l.model} inputPerM`), outP: parseDecimal(p.outputPerM, `${l.model} outputPerM`) };
  });
  const S = Math.max(USDC_DECIMALS, f.perCall.scale, f.analyst.scale, f.gas.scale, f.min.scale, ...lines.flatMap((l) => [l.inP.scale, l.outP.scale]));
  // Model cost: Σ tokens × price-per-million, at scale S, still "per million" (divide by 1e6 once, at the end).
  const callUsdPerM = lines.map((l) => BigInt(l.pt) * at(l.inP, S) + BigInt(l.ct) * at(l.outP, S));
  const modelPerM = callUsdPerM.reduce((a, b) => a + b, 0n);
  const callFees = BigInt(lines.length) * at(f.perCall, S);
  // base = USD × 10^(S+6)
  const base = modelPerM + (callFees + at(f.analyst, S) + at(f.gas, S)) * 1_000_000n;
  // with margin: USD = base × (100·10^mk + M) / (100·10^mk · 10^(S+6))
  const mk = BigInt(f.margin.scale);
  const num = base * (100n * 10n ** mk + f.margin.n);
  const den = 100n * 10n ** mk * 10n ** BigInt(S + 6);
  // in millionths, rounded up; then the minimum (itself rounded up to millionths)
  const withMargin = ceilDiv(num * 1_000_000n, den);
  const minMicros = ceilDiv(at(f.min, S) * 1_000_000n, 10n ** BigInt(S));
  const minApplied = minMicros > withMargin;
  const micros = minApplied ? minMicros : withMargin;
  if (micros <= 0n) throw new Error("the job's total is 0: set a minimum price (minPriceUsd) above 0");
  const perMToMicrosUp = (v: bigint) => ceilDiv(v, 10n ** BigInt(S));
  const usd = (v: bigint, scale: number) => microsToUsd(ceilDiv(v * 1_000_000n, 10n ** BigInt(scale)));
  return {
    totalUsd: microsToUsd(micros),
    amount: micros.toString(),
    breakdown: {
      calls: lines.map((l, i) => ({ model: l.model, promptTokens: l.pt, completionTokens: l.ct, usd: microsToUsd(perMToMicrosUp(callUsdPerM[i])) })),
      modelUsd: microsToUsd(perMToMicrosUp(modelPerM)),
      callFeesUsd: usd(callFees, S), analystUsd: usd(at(f.analyst, S), S), nearGasUsd: usd(at(f.gas, S), S),
      marginPct: fees.marginPct, minPriceUsd: fees.minPriceUsd, minApplied,
      subtotalUsd: microsToUsd(perMToMicrosUp(base)), withMarginUsd: microsToUsd(withMargin),
    },
  };
}

/** Model id → price from a catalog file's JSON ({models: [{id, pricing: {inputPerM, outputPerM}}]}). */
export function pricesFromCatalog(catalog: unknown): Map<string, ModelPrice> {
  const models = (catalog as { models?: unknown })?.models;
  if (!Array.isArray(models)) throw new Error("the pricing catalog has no models list");
  const out = new Map<string, ModelPrice>();
  for (const m of models as { id?: unknown; pricing?: { inputPerM?: unknown; outputPerM?: unknown } }[]) {
    if (typeof m?.id !== "string" || !m.pricing) continue;
    const { inputPerM, outputPerM } = m.pricing;
    if ((typeof inputPerM === "number" || typeof inputPerM === "string") && (typeof outputPerM === "number" || typeof outputPerM === "string")) {
      parseDecimal(inputPerM, `${m.id} inputPerM`); parseDecimal(outputPerM, `${m.id} outputPerM`);
      out.set(m.id, { inputPerM, outputPerM });
    }
  }
  return out;
}
