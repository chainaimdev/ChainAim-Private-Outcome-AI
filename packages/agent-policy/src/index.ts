/**
 * Buyer-side spending policy (privateAI-design-32 §1.3, §1.4, §1.5; ARCH-620 loader + checks, ARCH-621 approval
 * decision, ARCH-624 counter policy).
 *
 * Deterministic: the agent's model only triggers the tool; whether to pay, counter, wait for a human or refuse is
 * decided here, so a prompt-injected model cannot raise a spend. Money is whole micro-USD (6 decimals, BigInt), never a
 * float. The policy is the "policy" block of <tenants>/<id>/tenant.json; every value is the owner's.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MICRO = 6;

/** A decimal USD amount as whole micro-USD; more than 6 decimals is refused, never rounded. */
export function usdToMicro(amount: string, field = "amount"): bigint {
  const m = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(amount);
  if (!m) throw new Error(`${field} must be a decimal USD amount with at most ${MICRO} decimals`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(MICRO, "0"));
}

export function microToUsd(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(MICRO, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The limits a quote may be reduced along (counter ladder step names, ARCH-623). */
export const REDUCIBLE = ["answerMaxRows", "phrase", "sqlRetries", "route"] as const;
export type Reducible = (typeof REDUCIBLE)[number];

export type CounterPolicy = { enabled: boolean; maxRounds: number; acceptReduced: Reducible[] };

export type Policy = {
  autoApproveMicro: bigint;
  maxPerJobMicro: bigint;
  dailyCapMicro: bigint;
  requireAttestedRoute: boolean;
  /** A requote after size drift is paid without a human only when at most this many percent above the first price. */
  requoteAutoAcceptPct: number;
  counter: CounterPolicy;
};

/** The "policy" block of a tenant.json, checked field by field; the message names the field. */
export function parsePolicy(raw: unknown, tenantId: string): Policy {
  const p = raw as Record<string, unknown> | null | undefined;
  const at = (f: string): string => `tenant ${tenantId}: policy.${f}`;
  if (typeof p !== "object" || p === null) throw new Error(`tenant ${tenantId}: tenant.json has no "policy" block`);
  const usd = (f: string): bigint => {
    if (typeof p[f] !== "string") throw new Error(`${at(f)} must be a decimal USD string such as "0.10"`);
    return usdToMicro(p[f] as string, at(f));
  };
  const autoApproveMicro = usd("autoApproveMaxUsd");
  const maxPerJobMicro = usd("maxPerJobUsd");
  const dailyCapMicro = usd("dailyCapUsd");
  if (autoApproveMicro > maxPerJobMicro) throw new Error(`${at("autoApproveMaxUsd")} must not exceed maxPerJobUsd`);
  if (maxPerJobMicro > dailyCapMicro) throw new Error(`${at("maxPerJobUsd")} must not exceed dailyCapUsd`);
  if (typeof p.requireAttestedRoute !== "boolean") throw new Error(`${at("requireAttestedRoute")} must be true or false`);
  const pct = p.requoteAutoAcceptPct ?? 0;
  if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error(`${at("requoteAutoAcceptPct")} must be a whole number from 0 to 100`);
  const c = (p.counter ?? { enabled: false, maxRounds: 0, acceptReduced: [] }) as Record<string, unknown>;
  if (typeof c.enabled !== "boolean") throw new Error(`${at("counter.enabled")} must be true or false`);
  if (typeof c.maxRounds !== "number" || !Number.isInteger(c.maxRounds) || c.maxRounds < 0 || c.maxRounds > 10) throw new Error(`${at("counter.maxRounds")} must be a whole number from 0 to 10`);
  if (!Array.isArray(c.acceptReduced) || c.acceptReduced.some((s) => !(REDUCIBLE as readonly unknown[]).includes(s))) {
    throw new Error(`${at("counter.acceptReduced")} must list only ${REDUCIBLE.join(", ")}`);
  }
  return {
    autoApproveMicro,
    maxPerJobMicro,
    dailyCapMicro,
    requireAttestedRoute: p.requireAttestedRoute,
    requoteAutoAcceptPct: pct,
    counter: { enabled: c.enabled, maxRounds: c.maxRounds, acceptReduced: c.acceptReduced as Reducible[] },
  };
}

/** A firm quote as the console returns it (ARCH-605), plus whether its route is the attested one. */
export type Quote = { quoteId: string; route: string; priceUsd: string; attested: boolean; expiresAt: number; counterOf?: string; reduced?: string[] };

export type Decision =
  | { action: "pay"; quote: Quote; reason: string }
  | { action: "approve"; quote: Quote; reason: string }
  | { action: "counter"; ceilingUsd: string; counterOf: string; reason: string }
  | { action: "refuse"; reason: string };

export type DecideContext = {
  /** micro-USD already spent today by this tenant (SpendLedger.spentToday). */
  spentTodayMicro: bigint;
  now: number;
  /** Counter rounds already made for this question. */
  counterRound?: number;
  /** For a requote after size drift: the price first accepted. */
  requoteOfUsd?: string;
};

/**
 * The decision on a set of quotes for one question: the cheapest usable quote is paid when within the auto-approve
 * limit and the daily cap; above that and within maxPerJob it waits for a human; when every usable quote is above the
 * auto-approve limit and counters are on, the seller is asked for a smaller job at the auto-approve ceiling.
 */
export function decide(policy: Policy, quotes: readonly Quote[], ctx: DecideContext): Decision {
  const live = quotes.filter((q) => q.expiresAt > ctx.now);
  if (live.length === 0) return { action: "refuse", reason: "every quote has expired" };
  const usable = live.filter((q) => !policy.requireAttestedRoute || q.attested);
  if (usable.length === 0) return { action: "refuse", reason: "the policy requires the attested route and none was quoted" };
  const counterOk = (q: Quote): boolean => (q.reduced ?? []).every((s) => (policy.counter.acceptReduced as string[]).includes(s));
  const acceptable = usable.filter(counterOk);
  if (acceptable.length === 0) return { action: "refuse", reason: "the counter offer reduces a limit the policy does not accept" };
  const priced = acceptable.map((q) => ({ q, micro: usdToMicro(q.priceUsd, `quote ${q.quoteId} priceUsd`) })).sort((a, b) => (a.micro < b.micro ? -1 : a.micro > b.micro ? 1 : 0));
  const best = priced[0];
  const left = policy.dailyCapMicro - ctx.spentTodayMicro;
  if (best.micro > policy.maxPerJobMicro) return counterOr(policy, ctx, best.q, `the cheapest quote ${best.q.priceUsd} USD is above maxPerJobUsd ${microToUsd(policy.maxPerJobMicro)}`);
  if (best.micro > left) return { action: "refuse", reason: `the daily cap would be exceeded (${microToUsd(left < 0n ? 0n : left)} USD left today)` };
  if (ctx.requoteOfUsd !== undefined) {
    const first = usdToMicro(ctx.requoteOfUsd, "requoteOfUsd");
    const limit = first + (first * BigInt(policy.requoteAutoAcceptPct)) / 100n;
    if (best.micro > limit) return { action: "approve", quote: best.q, reason: `the requote is more than ${policy.requoteAutoAcceptPct}% above the accepted price` };
  }
  if (best.micro <= policy.autoApproveMicro) return { action: "pay", quote: best.q, reason: "within the auto-approve limit and the daily cap" };
  const cheaper = counterOr(policy, ctx, best.q, "");
  if (cheaper.action === "counter") return { ...cheaper, reason: `above the auto-approve limit; asking for a smaller job at ${cheaper.ceilingUsd} USD` };
  return { action: "approve", quote: best.q, reason: "above the auto-approve limit; waiting for a human" };
}

function counterOr(policy: Policy, ctx: DecideContext, q: Quote, refuseReason: string): Decision {
  const round = ctx.counterRound ?? 0;
  if (policy.counter.enabled && round < policy.counter.maxRounds && policy.autoApproveMicro > 0n) {
    return { action: "counter", ceilingUsd: microToUsd(policy.autoApproveMicro), counterOf: q.counterOf ?? q.quoteId, reason: refuseReason };
  }
  return { action: "refuse", reason: refuseReason || "no counter round left" };
}

/**
 * Per-tenant spend ledger (ARCH-620): one JSON line per settled payment in <dir>/<tenant>/spend-YYYY-MM-DD.jsonl (UTC),
 * ids and amounts only. Only settled payments are recorded, so a voided job (nothing settled) never counts.
 */
export class SpendLedger {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  private file(tenant: string, at: number): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw new Error("tenant id must be 1-64 letters, digits, _ or -");
    return join(this.dir, tenant, `spend-${new Date(at).toISOString().slice(0, 10)}.jsonl`);
  }

  record(tenant: string, jobId: string, amountUsd: string, transaction: string): void {
    const at = this.now();
    const f = this.file(tenant, at);
    mkdirSync(join(this.dir, tenant), { recursive: true });
    appendFileSync(f, `${JSON.stringify({ ts: new Date(at).toISOString(), jobId, amountMicro: usdToMicro(amountUsd).toString(), transaction })}\n`);
  }

  spentToday(tenant: string): bigint {
    const f = this.file(tenant, this.now());
    if (!existsSync(f)) return 0n;
    let total = 0n;
    for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
      if (line.trim() === "") continue;
      let row: { amountMicro?: unknown };
      try {
        row = JSON.parse(line) as { amountMicro?: unknown };
      } catch {
        throw new Error(`${f} line ${i + 1} is not JSON; fix or move the file before paying again`);
      }
      if (typeof row.amountMicro !== "string" || !/^\d+$/.test(row.amountMicro)) throw new Error(`${f} line ${i + 1} has no amountMicro`);
      total += BigInt(row.amountMicro);
    }
    return total;
  }
}
