/**
 * Counter-offer, one round (privateAI-design-43 ARCH-720; design-32 §1.4 / ARCH-623): the ladder of smaller jobs and the
 * pure walk that finds the first one ChainAim's signer prices at or below the buyer's ceiling.
 *
 * Rule (design-32 §1.4): the price is never discounted; only the job shrinks. Every step of the ladder makes the basis
 * smaller (fewer answer rows and a smaller answer prompt, fewer completion tokens, fewer SQL tries), and every smaller
 * basis is priced by the signer with the same fees, margin and minimum as any offer, so a counter never sells below cost.
 * Deterministic: no model is asked anything here. The steps are cumulative, in the file's order; a step the buyer does
 * not accept, or one that changes nothing the run uses, is skipped (the walk goes on from the basis before it).
 *
 * config/counter-ladder.json:
 *   { "version": 1, "steps": [ { "name": "answerMaxRows", "set": { "answerMaxRows": 20, "answerMaxPromptChars": 4000 } }, ... ] }
 */
import { checkBasis, type CrossaskBasis } from "../../packages/offer/src/index.ts";
import type { JobQuote } from "../../packages/crossask/src/cost.ts";

/** The limits a ladder step may reduce, by step name (the names the buyer's policy accepts: agent-policy REDUCIBLE). */
export const LADDER_FIELDS = {
  answerMaxRows: { answerMaxRows: 1, answerMaxPromptChars: 500 },
  maxTokens: { maxTokens: 16 },
  sqlRetries: { sqlRetries: 0 },
} as const;
export type LadderStepName = keyof typeof LADDER_FIELDS;
type LadderField = "answerMaxRows" | "answerMaxPromptChars" | "maxTokens" | "sqlRetries";
export type LadderStep = { name: LadderStepName; set: Partial<Record<LadderField, number>> };
export type Ladder = { version: 1; steps: LadderStep[] };

/** The ladder from its JSON, checked: known step names, only that step's fields, whole numbers at or above each floor, and a field set again only lower. */
export function parseLadder(raw: unknown): Ladder {
  const o = raw as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("the counter ladder must be a JSON object");
  for (const k of Object.keys(o)) if (k !== "version" && k !== "steps") throw new Error(`counter ladder: ${k} is not a ladder member`);
  if (o.version !== 1) throw new Error("counter ladder version must be 1");
  if (!Array.isArray(o.steps) || o.steps.length === 0 || o.steps.length > 20) throw new Error("counter ladder steps must be a list of 1 to 20 steps");
  const last = new Map<string, number>();
  const steps = o.steps.map((s, i): LadderStep => {
    const at = `counter ladder steps[${i}]`;
    const x = s as Record<string, unknown> | null;
    if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error(`${at} must be an object`);
    for (const k of Object.keys(x)) if (k !== "name" && k !== "set") throw new Error(`${at}.${k} is not a step member`);
    if (typeof x.name !== "string" || !Object.hasOwn(LADDER_FIELDS, x.name)) throw new Error(`${at}.name must be one of ${Object.keys(LADDER_FIELDS).join(", ")}`);
    const floors = LADDER_FIELDS[x.name as LadderStepName] as Record<string, number>;
    const set = x.set as Record<string, unknown> | null;
    if (typeof set !== "object" || set === null || Array.isArray(set) || Object.keys(set).length === 0) throw new Error(`${at}.set must name at least one limit`);
    for (const [f, v] of Object.entries(set)) {
      if (!Object.hasOwn(floors, f)) throw new Error(`${at}.set.${f} is not a limit the step ${x.name} may reduce (${Object.keys(floors).join(", ")})`);
      if (typeof v !== "number" || !Number.isInteger(v) || v < floors[f]) throw new Error(`${at}.set.${f} must be a whole number of at least ${floors[f]}`);
      const before = last.get(f);
      if (before !== undefined && v >= before) throw new Error(`${at}.set.${f} (${v}) must be lower than an earlier step's (${before}): each step only reduces`);
      last.set(f, v);
    }
    return { name: x.name as LadderStepName, set: set as LadderStep["set"] };
  });
  return { version: 1, steps };
}

/** A decimal USD string as micro-USD, rounded UP past 6 decimals (a price is never read as lower than it is). */
export function usdMicroCeil(v: string, what = "amount"): bigint {
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(v);
  if (!m) throw new Error(`${what} must be a decimal USD amount, got ${v}`);
  const frac = m[2] ?? "";
  const head = BigInt(m[1]) * 1_000_000n + BigInt(frac.slice(0, 6).padEnd(6, "0"));
  return /[1-9]/.test(frac.slice(6)) ? head + 1n : head;
}
/** A buyer's ceiling: decimal USD with at most 6 decimals, above zero (a ceiling is never rounded). */
export function ceilingMicro(v: unknown): bigint {
  if (typeof v !== "string" || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(v)) throw new Error("maxPriceUsd must be a decimal USD string with at most 6 decimals, such as \"0.01\"");
  const n = usdMicroCeil(v, "maxPriceUsd");
  if (n <= 0n) throw new Error("maxPriceUsd must be above 0");
  return n;
}
export function microUsd(n: bigint): string {
  const f = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return f ? `${n / 1_000_000n}.${f}` : `${n / 1_000_000n}`;
}

/** The basis after one step: each field at the smaller of now and the step's value; null when the step changes nothing the run uses. */
export function applyStep(b: CrossaskBasis, step: LadderStep): CrossaskBasis | null {
  // A step on a limit the job does not use: answer limits without an answer call, SQL tries with the buyer's own SQL.
  if (step.name === "answerMaxRows" && b.phrase !== "llm") return null;
  if (step.name === "sqlRetries" && b.userSql) return null;
  if (step.name === "maxTokens" && b.userSql && b.phrase !== "llm") return null;
  const next = { ...b };
  let changed = false;
  for (const [f, v] of Object.entries(step.set) as [LadderField, number][]) {
    if (v < next[f]) { next[f] = v; changed = true; }
  }
  if (!changed) return null;
  checkBasis(next);
  return next;
}

export type CounterFit = { fit: { basis: CrossaskBasis; reduced: LadderStepName[]; quote: JobQuote } } | { noFit: { cheapestUsd: string | null; tried: number } };

/**
 * ARCH-720: walk the ladder from `basis`; the first smaller basis whose signer price is at or below `maxPriceMicro` wins.
 * `accept`: the step names the buyer takes (its policy's acceptReduced); `allowed`: whether this console may sell a basis
 * (e.g. --pay-only-attested verified needs an attested route). reduced = the names of the steps applied, in order, once each.
 */
export async function fitCounter(
  basis: CrossaskBasis, ladder: Ladder,
  opts: { maxPriceMicro: bigint; accept: ReadonlySet<string>; price: (b: CrossaskBasis) => Promise<JobQuote>; allowed: (b: CrossaskBasis) => boolean },
): Promise<CounterFit> {
  let cur = basis;
  const applied: LadderStepName[] = [];
  let cheapest: bigint | undefined;
  let tried = 0;
  for (const step of ladder.steps) {
    if (!opts.accept.has(step.name)) continue;
    const next = applyStep(cur, step);
    if (!next) continue;
    cur = next;
    if (!applied.includes(step.name)) applied.push(step.name);
    if (!opts.allowed(cur)) continue;
    const quote = await opts.price(cur);
    tried++;
    const micro = usdMicroCeil(quote.totalUsd, "the signer's price");
    if (cheapest === undefined || micro < cheapest) cheapest = micro;
    if (micro <= opts.maxPriceMicro) return { fit: { basis: cur, reduced: [...applied], quote } };
  }
  return { noFit: { cheapestUsd: cheapest === undefined ? null : microUsd(cheapest), tried } };
}

/** Console settings for counters (--counter, --counter-ladder, --counter-max-rounds); undefined when off. */
export type CounterConfig = { ladder: Ladder; maxRounds: number; file: string };
export function counterConfig(flags: { counter?: string; "counter-ladder"?: string; "counter-max-rounds"?: string }, offersOn: boolean, readText: (p: string) => string): CounterConfig | undefined {
  const on = flags.counter ?? "off";
  if (on !== "on" && on !== "off") throw new Error(`--counter must be on or off, got ${on}`);
  if (on === "off") {
    if (flags["counter-ladder"] !== undefined || flags["counter-max-rounds"] !== undefined) throw new Error("--counter-ladder / --counter-max-rounds need --counter on");
    return undefined;
  }
  if (!offersOn) throw new Error("--counter on needs estimate-first offers (--paid-jobs on and config/cost-model.json): a counter is a smaller offer");
  const r = flags["counter-max-rounds"] ?? "1";
  const maxRounds = Number(r);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 1) throw new Error(`--counter-max-rounds must be 1 (one round: privateAI-design-43), got ${r}`);
  const file = flags["counter-ladder"] ?? "config/counter-ladder.json";
  let text: string;
  try { text = readText(file); } catch { throw new Error(`--counter on needs the ladder ${file} (see config/counter-ladder.json in the repo)`); }
  let ladder: Ladder;
  try { ladder = parseLadder(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)); }
  catch (e) { throw new Error(`the counter ladder ${file} is not valid: ${(e as Error).message}`); }
  return { ladder, maxRounds, file };
}
