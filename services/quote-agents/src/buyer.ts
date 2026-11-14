/**
 * Buyer tenant (Tommy) in quote-agents: the buyer's private data and its two endpoints.
 *   POST /v1/tenants/{buyer}/agents/treasury   (TommyTreasuryAgent)  can we buy at this price, who must approve, is cash there?
 *   POST /v1/tenants/{buyer}/buyer/synthesize  (tommyBuyerAgent)     accept or counter the seller's ask (rules)
 * Data under --data-root/<dataDir>: buyer-policy.json, purchase-requisitions.json, treasury-ledger.json.
 * The buyer's maximum price per RFQ lives here only (never in Signatory): answers say whether a price is within budget,
 * never the budget itself.
 *
 * Rules (the same as Signatory's quote-buyer.mjs rule buyer, so outcomes match it exactly):
 *   phase "round":      round 1 always counters; from round 2 accepts an ask <= budget; otherwise counters at
 *                       min(budget, roundHalfEven(last + concession x (ask - last))), never below its own last offer.
 *   phase "escalation": accepts an officer's ask <= budget, otherwise answers with its budget (best and final).
 * AI for the buyer side is not implemented: every answer has source "rules".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, body } from "./data.ts";

export type Requisition = { rfq: string; sku: string; qty: number; maxPriceCents: number; concession: number };
export type BuyerData = {
  kind: "buyer";
  policy: { agentMaxUsd: number; cpoMaxUsd: number; safetyThresholdUsd: number };
  requisitions: Map<string, Requisition>;
  ledger: { cashUsd: number; committedUsd: number };
};

const read = (dir: string, f: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(dir, f), "utf8"));
  } catch (e) {
    throw new Error(`${f}: ${(e as Error).message}`);
  }
};
const need = (f: string, cond: boolean, msg: string) => {
  if (!cond) throw new Error(`${f}: ${msg}`);
};
const isInt = (v: unknown, min = 0) => typeof v === "number" && Number.isInteger(v) && v >= min;

export const isBuyerDir = (dir: string) => existsSync(join(dir, "buyer-policy.json"));

export function loadBuyerData(dir: string): BuyerData {
  const P = "buyer-policy.json", R = "purchase-requisitions.json", L = "treasury-ledger.json";
  const p = read(dir, P);
  for (const k of ["agentMaxUsd", "cpoMaxUsd", "safetyThresholdUsd"]) need(P, isInt(p[k]), `${k} must be a whole number of USD`);
  need(P, (p.agentMaxUsd as number) < (p.cpoMaxUsd as number), "agentMaxUsd must be below cpoMaxUsd");
  const list = read(dir, R).requisitions;
  need(R, Array.isArray(list) && list.length > 0, "requisitions must be a non-empty array");
  const requisitions = new Map<string, Requisition>();
  (list as Record<string, unknown>[]).forEach((r, i) => {
    const w = `requisitions[${i}]`;
    need(R, typeof r.rfq === "string" && !!r.rfq, `${w}.rfq must be an RFQ id`);
    need(R, typeof r.sku === "string" && !!r.sku, `${w}.sku is required`);
    need(R, isInt(r.qty, 1), `${w}.qty must be a positive whole number`);
    need(R, isInt(r.maxPriceCents, 1), `${w}.maxPriceCents must be a positive whole number of cents`);
    need(R, typeof r.concession === "number" && r.concession > 0 && r.concession <= 1, `${w}.concession must be in (0, 1]`);
    need(R, !requisitions.has(r.rfq as string), `${w}: duplicate rfq ${r.rfq}`);
    requisitions.set(r.rfq as string, { rfq: r.rfq as string, sku: r.sku as string, qty: r.qty as number, maxPriceCents: r.maxPriceCents as number, concession: r.concession as number });
  });
  const l = read(dir, L);
  need(L, isInt(l.cashUsd) && isInt(l.committedUsd), "cashUsd and committedUsd must be whole numbers of USD");
  return {
    kind: "buyer",
    policy: { agentMaxUsd: p.agentMaxUsd as number, cpoMaxUsd: p.cpoMaxUsd as number, safetyThresholdUsd: p.safetyThresholdUsd as number },
    requisitions,
    ledger: { cashUsd: l.cashUsd as number, committedUsd: l.committedUsd as number },
  };
}

function requisitionOf(d: BuyerData, rfqId: string, sku?: string): Requisition {
  const r = d.requisitions.get(rfqId);
  if (!r) throw new ApiError(422, "unknown_requisition", `no purchase requisition for ${rfqId}`);
  // the seller may offer a better grade of the same family (e.g. FAB-JERSEY-140-A for -B): same family prefix is accepted
  if (sku && sku !== r.sku && sku.replace(/-[A-Z]$/, "") !== r.sku.replace(/-[A-Z]$/, "")) throw new ApiError(422, "sku_mismatch", `${rfqId} is for ${r.sku}, not ${sku}`);
  return r;
}

// ---- POST agents/treasury (buyer)
export type BuyerTreasuryRequest = { rfqId: string; sku: string; qty: number; priceCents: number; advancePct: number };
export function parseBuyerTreasuryRequest(raw: unknown): BuyerTreasuryRequest {
  const o = body.obj(raw);
  body.str(o, "requestId");
  return { rfqId: body.str(o, "rfqId", 64), sku: body.str(o, "sku", 64), qty: body.int(o, "qty", 1, 10_000_000), priceCents: body.int(o, "priceCents", 1, 100_000_000), advancePct: body.int(o, "advancePct", 0, 100) };
}
export function buyerTreasury(d: BuyerData, q: BuyerTreasuryRequest) {
  const r = requisitionOf(d, q.rfqId, q.sku);
  const totalUsd = (q.qty * q.priceCents) / 100;
  const approval = totalUsd <= d.policy.agentMaxUsd ? "AGENT" : totalUsd <= d.policy.cpoMaxUsd ? "CPO" : "OVER_AUTHORITY";
  const availableUsd = d.ledger.cashUsd - d.ledger.committedUsd;
  const advanceDueUsd = Math.round(totalUsd * q.advancePct) / 100;
  return {
    withinBudget: q.priceCents <= r.maxPriceCents,
    totalUsd,
    approval,
    approver: approval === "AGENT" ? "tommyBuyerAgent" : approval === "CPO" ? "Tommy_Chief_Procurement_Officer" : null,
    cash: { availableUsd, advanceDueUsd, status: availableUsd - totalUsd >= d.policy.safetyThresholdUsd ? "OK" : "SHORT" },
  };
}

// ---- POST buyer/synthesize
export type BuyerSynthesizeRequest = { rfqId: string; sku: string; phase: "round" | "escalation"; round: number; askCents: number; lastOfferCents: number };
export function parseBuyerSynthesizeRequest(raw: unknown): BuyerSynthesizeRequest {
  const o = body.obj(raw);
  body.str(o, "requestId");
  const phase = o.phase;
  if (phase !== "round" && phase !== "escalation") throw new ApiError(400, "bad_body", "phase must be round or escalation");
  return { rfqId: body.str(o, "rfqId", 64), sku: body.str(o, "sku", 64), phase, round: body.int(o, "round", 1, 20), askCents: body.int(o, "askCents", 1, 100_000_000), lastOfferCents: body.int(o, "lastOfferCents", 1, 100_000_000) };
}
/** Round half to even (Python round()), for x >= 0 — the same as quote-buyer.mjs. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
export function buyerSynthesize(d: BuyerData, q: BuyerSynthesizeRequest) {
  const r = requisitionOf(d, q.rfqId, q.sku);
  const budget = r.maxPriceCents;
  let decision: "ACCEPT" | "COUNTER";
  let priceCents: number;
  let reasoning: string;
  if (q.phase === "escalation") {
    if (q.askCents <= budget) [decision, priceCents, reasoning] = ["ACCEPT", q.askCents, "officer's price is within our budget"];
    else [decision, priceCents, reasoning] = ["COUNTER", budget, "best and final offer"];
  } else if (q.round >= 2 && q.askCents <= budget) {
    [decision, priceCents, reasoning] = ["ACCEPT", q.askCents, `round ${q.round}: the ask is within our budget`];
  } else {
    const next = Math.min(budget, roundHalfEven(q.lastOfferCents + r.concession * (q.askCents - q.lastOfferCents)));
    [decision, priceCents, reasoning] = ["COUNTER", Math.max(q.lastOfferCents, next), `round ${q.round}: counter`];
  }
  const messageToSeller = decision === "ACCEPT" ? `${q.rfqId}: we accept ${usd(priceCents)} per unit.` : `${q.rfqId}: we can do ${usd(priceCents)} per unit.`;
  return { decision, priceCents, messageToSeller, reasoning, source: "rules", model: null };
}
