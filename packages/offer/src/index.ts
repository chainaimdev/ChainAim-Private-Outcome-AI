/**
 * Offers: one firm price per paid request, estimated from sizes only, before any work (privateAI-design-34 ARCH-634;
 * design-32 §3.1-3.2 firm quote). Shared by tab 01 (scan, mask), tab 02 (chat) and tab 03 (crossask), the agent and the
 * paywall, so the three tabs price the same way.
 *
 * Worst case, never a guess: a model call is priced at its largest prompt (bytes x tokensPerByte, from the calibrated cost
 * model) and its full max_tokens; Presidio, analyst and gateway time are priced per KB / MB from the same cost model and
 * raised by its safetyPct. Scan and mask make no model call (Presidio only: owner D2, design-34 §9). The result goes
 * through packages/crossask quoteJob (fees, margin, minimum, cents for AP2), so an offer and a metered job share one
 * arithmetic. Pure: no I/O, no clock. Without a cost model there is no offer (parseCostModel refuses; nothing defaulted).
 */
import { parseDecimal, quoteJob, type Fees, type JobQuote, type MeterLine, type ModelPrice, type PriceRound } from "../../crossask/src/cost.ts";

export const OFFER_KINDS = ["scan", "mask", "chat", "crossask"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];
/** Buyer-visible modes (design-34 D4/D5): estimate-first is the default. */
export const OFFER_MODES = ["estimate-first", "run-hold"] as const;
export type OfferMode = (typeof OFFER_MODES)[number];

/**
 * config/cost-model.json, written by desk.ps1 -Calibrate (design-32 ARCH-604). Every number is required.
 * Version 2 (ARCH-635b/c): the analyst costs analystBaseUsd per run plus analystPerMbUsd per MB, and a model call
 * gatewayBaseUsd per call plus gatewayPerKbPromptUsd per KB of prompt, each fitted over 2+ sizes. Version 1 files (per unit
 * only) still read, with both bases 0: exactly what they priced before.
 */
export type CostModel = {
  version: 1 | 2;
  calibratedAt: string;
  machine: string;
  source: string;
  /** Model tokens per UTF-8 byte of prompt, worst case for the routed models (design-32 V-P4). */
  tokensPerByte: string;
  /** UTF-8 bytes per prompt character, worst case for the prompts the console builds (maxPromptChars -> bytes). */
  bytesPerChar: string;
  units: { presidioPerKbUsd: string; analystBaseUsd: string; analystPerMbUsd: string; gatewayBaseUsd: string; gatewayPerKbPromptUsd: string };
  /** Raises the time-derived lines only (presidio, analyst, gateway), never the model tokens. */
  safetyPct: string;
};

const DEC = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new Error(`cost model ${what} must be a decimal string`);
  parseDecimal(v, `cost model ${what}`);
  return v;
};

/** The cost model from its JSON, checked field by field; the message names the field, never guesses a value. */
export function parseCostModel(raw: unknown): CostModel {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("the cost model must be a JSON object");
  if (o.version !== 1 && o.version !== 2) throw new Error("cost model version must be 1 or 2");
  for (const f of ["calibratedAt", "machine", "source"] as const) if (typeof o[f] !== "string" || o[f] === "") throw new Error(`cost model ${f} must be a non-empty string`);
  if (Number.isNaN(Date.parse(o.calibratedAt as string))) throw new Error("cost model calibratedAt must be an ISO time");
  const u = o.units as Record<string, unknown>;
  if (typeof u !== "object" || u === null) throw new Error("cost model units must be an object");
  const tpb = DEC(o.tokensPerByte, "tokensPerByte"), bpc = DEC(o.bytesPerChar, "bytesPerChar");
  if (Number(tpb) <= 0 || Number(bpc) < 1) throw new Error("cost model tokensPerByte must be above 0 and bytesPerChar at least 1");
  return {
    version: o.version, calibratedAt: o.calibratedAt as string, machine: o.machine as string, source: o.source as string,
    tokensPerByte: tpb, bytesPerChar: bpc,
    units: { presidioPerKbUsd: DEC(u.presidioPerKbUsd, "units.presidioPerKbUsd"), analystBaseUsd: o.version === 1 ? "0" : DEC(u.analystBaseUsd, "units.analystBaseUsd"), analystPerMbUsd: DEC(u.analystPerMbUsd, "units.analystPerMbUsd"), gatewayBaseUsd: o.version === 1 ? "0" : DEC(u.gatewayBaseUsd, "units.gatewayBaseUsd"), gatewayPerKbPromptUsd: DEC(u.gatewayPerKbPromptUsd, "units.gatewayPerKbPromptUsd") },
    safetyPct: DEC(o.safetyPct, "safetyPct"),
  };
}

/** What each kind is priced on: sizes and limits only, never the text. */
export type OfferBasis =
  | { kind: "scan"; textBytes: number }
  | { kind: "mask"; textBytes: number }
  | { kind: "chat"; model: string; promptBytes: number; maxTokens: number }
  /** maxPromptChars caps each query request, answerMaxPromptChars the answer request (the run enforces both: crossask). */
  | { kind: "crossask"; model: string; answerModel?: string; phrase: "llm" | "none"; userSql: boolean; totalBytes: number; files: number; maxPromptChars: number; answerMaxPromptChars: number; maxTokens: number; sqlRetries: number; answerMaxRows: number };

const whole = (n: unknown, what: string, min = 0): number => {
  if (typeof n !== "number" || !Number.isInteger(n) || n < min) throw new Error(`${what} must be a whole number of at least ${min}`);
  return n;
};
/** The basis, checked (a buyer's sizes come over the wire). */
export function checkBasis(b: OfferBasis): OfferBasis {
  if (!b || !(OFFER_KINDS as readonly string[]).includes((b as { kind: string }).kind)) throw new Error(`kind must be one of ${OFFER_KINDS.join(", ")}`);
  if (b.kind === "scan" || b.kind === "mask") { whole(b.textBytes, "textBytes", 1); return b; }
  if (typeof b.model !== "string" || !/^[\w.-]+\/[\w.:-]+$/.test(b.model)) throw new Error("model must look like provider/name");
  if (b.kind === "chat") { whole(b.promptBytes, "promptBytes", 1); whole(b.maxTokens, "maxTokens", 1); return b; }
  if (b.answerModel !== undefined && !/^[\w.-]+\/[\w.:-]+$/.test(b.answerModel)) throw new Error("answerModel must look like provider/name");
  if (b.phrase !== "llm" && b.phrase !== "none") throw new Error("phrase must be llm or none");
  for (const f of ["totalBytes", "files", "maxPromptChars", "answerMaxPromptChars", "maxTokens", "sqlRetries", "answerMaxRows"] as const) whole(b[f], f);
  whole(b.files, "files", 1);
  whole(b.maxPromptChars, "maxPromptChars", 1);
  whole(b.answerMaxPromptChars, "answerMaxPromptChars", 1);
  return b;
}

/** A fixed-time extra line (ARCH-635b/c): usd x count x (1 + safety); no line for a zero rate or no count. */
function baseLine(name: string, usd: string, count: number, safetyPct: string): { name: string; usd: string }[] {
  return count > 0 && parseDecimal(usd, name).n > 0n ? [{ name, usd: perUnit(usd, count, 1, safetyPct) }] : [];
}

/** Exact decimal of rate x n / per x (1 + safety/100), rounded UP to 12 decimals. */
function perUnit(rateUsd: string, n: number, per: number, safetyPct: string): string {
  const r = parseDecimal(rateUsd, "rate"), s = parseDecimal(safetyPct, "safetyPct");
  const SC = 12;
  const num = r.n * BigInt(n) * (100n * 10n ** BigInt(s.scale) + s.n) * 10n ** BigInt(SC);
  const den = 10n ** BigInt(r.scale) * BigInt(per) * 100n * 10n ** BigInt(s.scale);
  const t = ((num + den - 1n) / den).toString().padStart(SC + 1, "0");
  return `${t.slice(0, -SC)}.${t.slice(-SC)}`;
}
/** ceil(n x decimal), exactly. */
const ceilMul = (n: number, dec: string): number => {
  const d = parseDecimal(dec, "factor");
  return Number((BigInt(n) * d.n + 10n ** BigInt(d.scale) - 1n) / 10n ** BigInt(d.scale));
};

/** The worst-case meter and the extra lines of one offer. */
export function worstCase(b: OfferBasis, cm: CostModel): { meter: MeterLine[]; extras: { name: string; usd: string }[] } {
  checkBasis(b);
  const KB = 1024, MB = 1024 * 1024;
  if (b.kind === "scan" || b.kind === "mask") {
    return { meter: [], extras: [{ name: "presidio", usd: perUnit(cm.units.presidioPerKbUsd, b.textBytes, KB, cm.safetyPct) }] };
  }
  if (b.kind === "chat") {
    return {
      meter: [{ model: b.model, promptTokens: ceilMul(b.promptBytes, cm.tokensPerByte), completionTokens: b.maxTokens }],
      extras: [
        { name: "presidio", usd: perUnit(cm.units.presidioPerKbUsd, b.promptBytes, KB, cm.safetyPct) },
        { name: "gateway", usd: perUnit(cm.units.gatewayPerKbPromptUsd, b.promptBytes, KB, cm.safetyPct) },
        ...baseLine("gatewayBase", cm.units.gatewayBaseUsd, 1, cm.safetyPct),
      ],
    };
  }
  // crossask: a user's own SQL needs no query call; otherwise 1 + retries query calls at the query cap; plus, with phrase
  // llm, the answer call at the answer cap (question + result rows; crossask fits them under it).
  const queryBytes = ceilMul(b.maxPromptChars, cm.bytesPerChar), answerBytes = ceilMul(b.answerMaxPromptChars, cm.bytesPerChar);
  const call = (model: string, bytes: number): MeterLine => ({ model, promptTokens: ceilMul(bytes, cm.tokensPerByte), completionTokens: b.maxTokens });
  const queries = b.userSql ? 0 : 1 + b.sqlRetries;
  const answer = b.phrase === "llm";
  const meter = [...Array.from({ length: queries }, () => call(b.model, queryBytes)), ...(answer ? [call(b.answerModel ?? b.model, answerBytes)] : [])];
  return {
    meter,
    extras: [
      { name: "analyst", usd: perUnit(cm.units.analystPerMbUsd, b.totalBytes, MB, cm.safetyPct) },
      { name: "gateway", usd: perUnit(cm.units.gatewayPerKbPromptUsd, queryBytes * queries + (answer ? answerBytes : 0), KB, cm.safetyPct) },
      // ARCH-635b/c: the fixed time of the analyst run and of each model call, raised by the same safety; none for version 1.
      ...baseLine("analystBase", cm.units.analystBaseUsd, 1, cm.safetyPct),
      ...baseLine("gatewayBase", cm.units.gatewayBaseUsd, meter.length, cm.safetyPct),
    ],
  };
}

/** One firm price for an offer: the worst-case meter and extras through quoteJob (fees, margin, minimum, rounding). */
export function quoteOffer(b: OfferBasis, prices: ReadonlyMap<string, ModelPrice> | Record<string, ModelPrice>, fees: Fees, cm: CostModel, round: PriceRound = "cent"): JobQuote {
  const { meter, extras } = worstCase(b, cm);
  return quoteJob(meter, prices, fees, { round, extras });
}
