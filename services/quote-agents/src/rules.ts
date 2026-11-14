/**
 * Rules proposal (privateAI-design-44 §5 "Rules proposal"; the fallback whenever the AI is off or its answer is refused).
 *   ask in round r = the treasury price at policy.roundMargins[r] (15% in round 1, 13.5% in round 2), from round 3 on the
 *   floor Signatory sends (authority.floorCents); never below the floor, never above the seller's previous counter.
 *   ceo-brief: ask = floor + the reallocation premium; the CEO's best-and-final, never escalated further.
 *   ACCEPT when the buyer's current price >= ask (at the buyer's price); else ESCALATE once round >= maxRounds; else COUNTER.
 */
import { ApiError, body, type Policy } from "./data.ts";
import type { InventoryAnswer } from "./inventory.ts";
import type { LogisticsAnswer } from "./logistics.ts";
import type { TreasuryAnswer } from "./treasury.ts";

export type Shipment = { units: number; mode: string; etd: string; delivered: string };
export type Proposal = { decision: "ACCEPT" | "COUNTER" | "ESCALATE"; counter: { sku: string; qty: number; priceCents: number; deadline: string; shipments: Shipment[] } };
export type SynthesizeRequest = {
  mode: "round" | "ceo-brief";
  inquiry: { sku: string; qty: number; priceCents: number; deadline: string };
  round: number;
  history: { round: number; by: "buyer" | "seller"; priceCents: number }[];
  answers: { inventory: InventoryAnswer | null; logistics: LogisticsAnswer; treasury: TreasuryAnswer };
  authority: { level: string; floorCents: number; maxRounds: number; allowed: string[] };
};

export function parseSynthesizeRequest(raw: unknown): SynthesizeRequest {
  const o = body.obj(raw);
  body.str(o, "requestId");
  if (o.mode !== "round" && o.mode !== "ceo-brief") throw new ApiError(400, "bad_body", "mode must be round or ceo-brief");
  const inq = body.obj(o.inquiry, "inquiry");
  const hist = o.history ?? [];
  if (!Array.isArray(hist) || hist.length > 50) throw new ApiError(400, "bad_body", "history must be an array of at most 50 entries");
  const answers = body.obj(o.answers, "answers");
  const logistics = body.obj(answers.logistics, "answers.logistics");
  const treasury = body.obj(answers.treasury, "answers.treasury");
  if (!Array.isArray(logistics.legs)) throw new ApiError(400, "bad_body", "answers.logistics.legs must be an array");
  body.obj(treasury.pricesAtMargin, "answers.treasury.pricesAtMargin");
  const auth = body.obj(o.authority, "authority");
  const allowed = auth.allowed ?? [];
  if (!Array.isArray(allowed) || !allowed.every((a) => typeof a === "string")) throw new ApiError(400, "bad_body", "authority.allowed must be a list of strings");
  return {
    mode: o.mode,
    inquiry: { sku: body.str(inq, "sku", 64), qty: body.int(inq, "qty", 1, 10_000_000), priceCents: body.int(inq, "priceCents", 1, 1_000_000), deadline: body.date(inq, "deadline") },
    round: body.int(o, "round", 1, 50),
    history: hist.map((h, i) => {
      const e = body.obj(h, `history[${i}]`);
      if (e.by !== "buyer" && e.by !== "seller") throw new ApiError(400, "bad_body", `history[${i}].by must be buyer or seller`);
      return { round: body.int(e, "round", 0, 50), by: e.by, priceCents: body.int(e, "priceCents", 1, 1_000_000) };
    }),
    answers: { inventory: (answers.inventory ?? null) as InventoryAnswer | null, logistics: logistics as unknown as LogisticsAnswer, treasury: treasury as unknown as TreasuryAnswer },
    authority: { level: body.str(auth, "level", 40), floorCents: body.int(auth, "floorCents", 1, 1_000_000), maxRounds: body.int(auth, "maxRounds", 1, 50), allowed: allowed as string[] },
  };
}

/** The buyer's current price: the last buyer entry of the history, else the inquiry's. */
export const buyerPrice = (r: SynthesizeRequest): number => [...r.history].reverse().find((h) => h.by === "buyer")?.priceCents ?? r.inquiry.priceCents;
/** The seller's last counter, if any. */
export const lastSellerPrice = (r: SynthesizeRequest): number | undefined => [...r.history].reverse().find((h) => h.by === "seller")?.priceCents;

/** The shipments of the logistics answer, without lot ids or carriers (they go to the buyer). */
export const shipmentsOf = (l: LogisticsAnswer): Shipment[] => l.legs.map((g) => ({ units: g.units, mode: g.mode, etd: g.etd, delivered: g.delivered }));

/** This round's ask under the rules. Throws ApiError 422 when the treasury answer lacks the round's margin. */
export function askFor(r: SynthesizeRequest, policy: Policy): number {
  const floor = r.authority.floorCents;
  if (r.mode === "ceo-brief") return floor + (r.answers.treasury.reallocPremiumCents ?? 0);
  const m = policy.roundMargins[String(r.round)];
  let ask = floor;
  if (m !== undefined) {
    const p = r.answers.treasury.pricesAtMargin[String(m)];
    if (typeof p !== "number") throw new ApiError(422, "missing_margin", `answers.treasury.pricesAtMargin has no price at ${m} for round ${r.round}`);
    ask = p;
  }
  const prev = lastSellerPrice(r);
  if (prev !== undefined) ask = Math.min(ask, prev);
  return Math.max(ask, floor);
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function rulesProposal(r: SynthesizeRequest, policy: Policy): { proposal: Proposal; messageToBuyer: string; reasoning: string } {
  const ask = askFor(r, policy);
  const offer = buyerPrice(r);
  const shipments = shipmentsOf(r.answers.logistics);
  const deadline = shipments.map((s) => s.delivered).sort().at(-1) ?? r.inquiry.deadline;
  const decision: Proposal["decision"] = offer >= ask ? "ACCEPT" : r.mode === "round" && r.round >= r.authority.maxRounds ? "ESCALATE" : "COUNTER";
  const priceCents = decision === "ACCEPT" ? offer : ask;
  const qty = r.inquiry.qty.toLocaleString("en-US");
  const messageToBuyer =
    decision === "ACCEPT"
      ? `We accept ${qty} units of ${r.inquiry.sku} at ${usd(priceCents)} per unit, delivered by ${deadline}.`
      : decision === "COUNTER"
        ? `We can offer ${qty} units of ${r.inquiry.sku} at ${usd(priceCents)} per unit, delivered by ${deadline}.`
        : `Thank you. We are reviewing your offer for ${qty} units of ${r.inquiry.sku} and will come back shortly.`;
  const reasoning = `rules, ${r.mode}, round ${r.round}/${r.authority.maxRounds}, level ${r.authority.level}: buyer ${offer}c, ask ${ask}c, floor ${r.authority.floorCents}c -> ${decision} at ${priceCents}c`;
  return { proposal: { decision, counter: { sku: r.inquiry.sku, qty: r.inquiry.qty, priceCents, deadline, shipments } }, messageToBuyer, reasoning };
}
