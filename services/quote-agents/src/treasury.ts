/**
 * Treasury agent (privateAI-design-44 §4, §5 Treasury). Never returns the unit cost.
 *   order cost (cents)  = qty x unit cost + freightCents + overhead per order
 *   landedCents         = ceil(order cost / qty)
 *   price at margin m   = ceil(order cost / (qty x (1 - m)))          (from the exact order cost, integer maths)
 *   reallocPremiumCents = ceil((TIER2 units x unit cost x TIER2 % + TIER1 units x unit cost x TIER1 %) / qty), per unit,
 *                         to add on top of a price
 *   net30Usd            = cash + credit line headroom + receivables due within the window - payables due within it
 *   status              = DEFICIT when net30 - this order's cost (USD) is below the safety threshold, else SURPLUS
 *   advanceLever        = one margin point (policy) of relief when DEFICIT and advancePct >= minAdvancePct
 *   credit              = headroom = buyer limit - open receivable; ok when termsDays is 0 (paid before shipping) or
 *                         the financed invoice (qty x price at the target margin x (1 - advancePct)) fits the headroom
 */
import { addDays, ApiError, body, type TenantData } from "./data.ts";

export type TreasuryRequest = { sku: string; qty: number; freightCents: number; reallocUnits: { TIER1: number; TIER2: number }; termsDays: number; advancePct: number; margins: number[]; customer?: string };
export type TreasuryAnswer = {
  landedCents: number;
  pricesAtMargin: Record<string, number>;
  reallocPremiumCents: number;
  liquidity: { net30Usd: number; status: "SURPLUS" | "DEFICIT" };
  advanceLever: { minAdvancePct: number; marginRelief: number; applies: boolean };
  credit: { headroomUsd: number; ok: boolean };
};

export function parseTreasuryRequest(raw: unknown): TreasuryRequest {
  const o = body.obj(raw);
  body.str(o, "requestId");
  const r = body.obj(o.reallocUnits ?? { TIER1: 0, TIER2: 0 }, "reallocUnits");
  const margins = o.margins;
  if (!Array.isArray(margins) || margins.length === 0 || margins.length > 12 || !margins.every((m) => typeof m === "number" && m >= 0 && m < 0.9))
    throw new ApiError(400, "bad_body", "margins must be 1-12 numbers from 0 to below 0.9");
  const out: TreasuryRequest = {
    sku: body.str(o, "sku", 64),
    qty: body.int(o, "qty", 1, 10_000_000),
    freightCents: body.int(o, "freightCents", 0),
    reallocUnits: { TIER1: body.int(r, "TIER1", 0, 10_000_000), TIER2: body.int(r, "TIER2", 0, 10_000_000) },
    termsDays: body.int(o, "termsDays", 0, 365),
    advancePct: body.int(o, "advancePct", 0, 100),
    margins: margins as number[],
  };
  if (o.customer !== undefined) out.customer = body.str(o, "customer", 64);
  return out;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
/** Margin in basis points, exact for the 4-decimal margins the API takes (0.135 -> 1350). */
const bp = (m: number): bigint => BigInt(Math.round(m * 10000));

export function treasury(data: TenantData, asOf: string, req: TreasuryRequest): TreasuryAnswer {
  const product = data.products.find((p) => p.sku === req.sku);
  if (!product) throw new ApiError(422, "unknown_sku", `no product ${req.sku}`);
  const pol = data.policy;
  const customerId = req.customer ?? pol.defaultCustomer;
  const customer = data.customers.find((c) => c.id === customerId);
  if (!customer) throw new ApiError(422, "unknown_customer", `no customer ${customerId}`);

  const qty = BigInt(req.qty);
  const orderCost = qty * BigInt(product.unitCostCents) + BigInt(req.freightCents) + BigInt(Math.round(pol.overheadPerOrderUsd * 100));
  const priceAt = (m: number) => Number(ceilDiv(orderCost * 10000n, qty * (10000n - bp(m))));
  const pricesAtMargin: Record<string, number> = {};
  for (const m of req.margins) pricesAtMargin[String(m)] = priceAt(m);

  const premiumTimes100 = BigInt(req.reallocUnits.TIER2) * BigInt(product.unitCostCents) * BigInt(Math.round(pol.reallocPremiumPct.TIER2 * 100))
    + BigInt(req.reallocUnits.TIER1) * BigInt(product.unitCostCents) * BigInt(Math.round(pol.reallocPremiumPct.TIER1 * 100));
  const reallocPremiumCents = Number(ceilDiv(premiumTimes100, qty * 10000n));

  const windowEnd = addDays(asOf, pol.liquidityWindowDays);
  const inWindow = (d: string) => d <= windowEnd;
  const net30Usd = data.ledger.cashUsd + data.ledger.creditLineHeadroomUsd
    + data.ledger.receivables.filter((r) => inWindow(r.dueDate)).reduce((n, r) => n + r.amountUsd, 0)
    - data.ledger.payables.filter((p) => inWindow(p.dueDate)).reduce((n, p) => n + p.amountUsd, 0);
  const orderCostUsd = Number(orderCost) / 100;
  const status = net30Usd - orderCostUsd < pol.safetyThresholdUsd ? "DEFICIT" : "SURPLUS";

  const headroomUsd = customer.creditLimitUsd - customer.openReceivableUsd;
  const financedUsd = (req.qty * priceAt(pol.targetMargin) * (100 - req.advancePct)) / 10000;
  return {
    landedCents: Number(ceilDiv(orderCost, qty)),
    pricesAtMargin,
    reallocPremiumCents,
    liquidity: { net30Usd, status },
    advanceLever: { minAdvancePct: pol.advanceLever.minAdvancePct, marginRelief: pol.advanceLever.marginRelief, applies: status === "DEFICIT" && req.advancePct >= pol.advanceLever.minAdvancePct },
    credit: { headroomUsd, ok: req.termsDays === 0 || financedUsd <= headroomUsd },
  };
}
