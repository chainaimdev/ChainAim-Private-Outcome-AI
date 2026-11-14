/**
 * Buyer-side spending policy (privateAI-design-32 §1.3, §1.4, §1.5; ARCH-620 loader + checks, ARCH-621 approval
 * decision, ARCH-624 counter policy).
 *
 * Deterministic: the agent's model only triggers the tool; whether to pay, counter, wait for a human or refuse is
 * decided here, so a prompt-injected model cannot raise a spend. Money is whole micro-USD (6 decimals, BigInt), never a
 * float. The policy is the "policy" block of <tenants>/<id>/tenant.json; every value is the owner's.
 */
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
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

/**
 * The limits a quote may be reduced along (counter ladder step names, ARCH-623). maxTokens: privateAI-design-43 ARCH-723
 * (the answer's completion tokens; the console's ladder, test-console/console/counter.ts LADDER_FIELDS, uses these names).
 */
export const REDUCIBLE = ["answerMaxRows", "phrase", "sqlRetries", "route", "maxTokens"] as const;
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
  /** privateAI-design-38 ARCH-683: the models a job may be signed for; absent = no check. Read from the SIGNED limits. */
  allowedModels?: string[];
  /** privateAI-design-38 ARCH-683: the largest max_tokens per model call the signed limits may allow; absent = no check. */
  maxTokensPerCall?: number;
  /**
   * privateAI-design-39 ARCH-688: the weakest NEAR AI attestation rule the SIGNED limits may carry (off < evidence <
   * verified); absent or off = no check. verified: pay only when ChainAim signed that it delivers only after ca-attest's verdict.
   */
  requireAttestation?: AttestationRule;
};

/** privateAI-design-39 ARCH-688: the attestation rules, weakest first (packages/offer ATTESTATION_MODES, the same names). */
export const ATTESTATION_RULES = ["off", "evidence", "verified"] as const;
export type AttestationRule = (typeof ATTESTATION_RULES)[number];
const ruleRank = (r: string | undefined): number => ATTESTATION_RULES.indexOf((r ?? "off") as AttestationRule);

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
  if (p.allowedModels !== undefined && (!Array.isArray(p.allowedModels) || p.allowedModels.length === 0 || p.allowedModels.some((m) => typeof m !== "string" || !/^[\w.-]+\/[\w.:-]+$/.test(m)))) {
    throw new Error(`${at("allowedModels")} must be a non-empty list of model ids provider/name`);
  }
  const mt = p.maxTokensPerCall;
  if (mt !== undefined && (typeof mt !== "number" || !Number.isInteger(mt) || mt < 1)) throw new Error(`${at("maxTokensPerCall")} must be a whole number of at least 1`);
  const ra = p.requireAttestation;
  if (ra !== undefined && !(ATTESTATION_RULES as readonly unknown[]).includes(ra)) throw new Error(`${at("requireAttestation")} must be off, evidence or verified`);
  return {
    autoApproveMicro,
    maxPerJobMicro,
    dailyCapMicro,
    requireAttestedRoute: p.requireAttestedRoute,
    requoteAutoAcceptPct: pct,
    counter: { enabled: c.enabled, maxRounds: c.maxRounds, acceptReduced: c.acceptReduced as Reducible[] },
    ...(p.allowedModels !== undefined ? { allowedModels: [...(p.allowedModels as string[])] } : {}),
    ...(mt !== undefined ? { maxTokensPerCall: mt as number } : {}),
    ...(ra !== undefined ? { requireAttestation: ra as AttestationRule } : {}),
  };
}

/** A firm quote as the console returns it (ARCH-605), plus whether its route is the attested one. */
export type Quote = { quoteId: string; route: string; priceUsd: string; attested: boolean; expiresAt: number; counterOf?: string; reduced?: string[]; limits?: SignedLimits };
/**
 * privateAI-design-38: what the signed checkout limits allow (models and max_tokens per call), when the quote has signed limits.
 * attestation (privateAI-design-39 ARCH-688): the signed attestation rule; absent in limits signed before v2.1.0.
 */
export type SignedLimits = { models: string[]; maxTokens: number; attestation?: string };

/** ARCH-683: why a quote breaks the policy's model / token rules, or null (rules absent = nothing to check). */
function limitsBreach(policy: Policy, q: Quote): string | null {
  const wantAttest = ruleRank(policy.requireAttestation) > 0;
  if (policy.allowedModels === undefined && policy.maxTokensPerCall === undefined && !wantAttest) return null;
  if (!q.limits) return wantAttest && policy.allowedModels === undefined && policy.maxTokensPerCall === undefined
    ? `the policy requires attestation ${policy.requireAttestation} and the quote carries no signed limits`
    : "the policy limits models or tokens and the quote carries no signed limits";
  // ARCH-688: the signed rule must be at least the policy's (an absent signed rule promises nothing).
  if (wantAttest && ruleRank(q.limits.attestation) < ruleRank(policy.requireAttestation)) return `the signed limits promise attestation ${q.limits.attestation ?? "none"}, weaker than requireAttestation ${policy.requireAttestation}`;
  const bad = policy.allowedModels ? q.limits.models.find((m) => !policy.allowedModels!.includes(m)) : undefined;
  if (bad) return `the signed limits allow ${bad}, which is not in allowedModels`;
  if (policy.maxTokensPerCall !== undefined && q.limits.maxTokens > policy.maxTokensPerCall) return `the signed limits allow ${q.limits.maxTokens} tokens per call, above maxTokensPerCall ${policy.maxTokensPerCall}`;
  return null;
}

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
  const withinLimits = usable.filter((q) => limitsBreach(policy, q) === null);
  if (withinLimits.length === 0) return { action: "refuse", reason: limitsBreach(policy, usable[0])! };
  const counterOk = (q: Quote): boolean => (q.reduced ?? []).every((s) => (policy.counter.acceptReduced as string[]).includes(s));
  const acceptable = withinLimits.filter(counterOk);
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

/**
 * One rule of the policy as applied to one quote, for display and logs (ARCH-620 "policy" event): the rule's name, the
 * policy's limit, the quote's value and whether it passed. Amounts are decimal USD strings. This explains a decision;
 * decide() is still the only thing that makes one (a test keeps the two in step).
 */
export type PolicyCheck = { check: "not_expired" | "attested_route" | "allowed_models" | "max_tokens_per_call" | "require_attestation" | "max_per_job" | "daily_cap" | "auto_approve"; limit: string; value: string; ok: boolean };

/** The checks decide() applies to one quote (no counter round, no requote), in the order it applies them. */
export function checksFor(policy: Policy, quote: Quote, ctx: Pick<DecideContext, "spentTodayMicro" | "now">): PolicyCheck[] {
  const price = usdToMicro(quote.priceUsd, `quote ${quote.quoteId} priceUsd`);
  const out: PolicyCheck[] = [{ check: "not_expired", limit: new Date(quote.expiresAt).toISOString(), value: new Date(ctx.now).toISOString(), ok: quote.expiresAt > ctx.now }];
  if (policy.requireAttestedRoute) out.push({ check: "attested_route", limit: "required", value: quote.attested ? "attested" : "not attested", ok: quote.attested });
  if (policy.allowedModels) out.push({ check: "allowed_models", limit: policy.allowedModels.join(", "), value: quote.limits ? quote.limits.models.join(", ") : "no signed limits", ok: !!quote.limits && quote.limits.models.every((m) => policy.allowedModels!.includes(m)) });
  if (policy.maxTokensPerCall !== undefined) out.push({ check: "max_tokens_per_call", limit: String(policy.maxTokensPerCall), value: quote.limits ? String(quote.limits.maxTokens) : "no signed limits", ok: !!quote.limits && quote.limits.maxTokens <= policy.maxTokensPerCall });
  if (ruleRank(policy.requireAttestation) > 0) out.push({ check: "require_attestation", limit: policy.requireAttestation!, value: quote.limits ? (quote.limits.attestation ?? "not signed") : "no signed limits", ok: !!quote.limits && ruleRank(quote.limits.attestation) >= ruleRank(policy.requireAttestation) });
  out.push({ check: "max_per_job", limit: microToUsd(policy.maxPerJobMicro), value: quote.priceUsd, ok: price <= policy.maxPerJobMicro });
  out.push({ check: "daily_cap", limit: microToUsd(policy.dailyCapMicro), value: microToUsd(ctx.spentTodayMicro + price), ok: ctx.spentTodayMicro + price <= policy.dailyCapMicro });
  out.push({ check: "auto_approve", limit: microToUsd(policy.autoApproveMicro), value: quote.priceUsd, ok: price <= policy.autoApproveMicro });
  return out;
}

/** What a page or a log may show of a tenant's policy: the owner's limits and today's spend, decimal USD. */
export type PolicyView = { autoApproveMaxUsd: string; maxPerJobUsd: string; dailyCapUsd: string; requireAttestedRoute: boolean; counter: boolean; spentTodayUsd: string };

export function policyView(policy: Policy, spentTodayMicro: bigint): PolicyView {
  return {
    autoApproveMaxUsd: microToUsd(policy.autoApproveMicro),
    maxPerJobUsd: microToUsd(policy.maxPerJobMicro),
    dailyCapUsd: microToUsd(policy.dailyCapMicro),
    requireAttestedRoute: policy.requireAttestedRoute,
    counter: policy.counter.enabled,
    spentTodayUsd: microToUsd(spentTodayMicro),
  };
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

  /** Start-up check (fail early, not after a payment): the ledger folder exists or can be made, and can be written. */
  ensureWritable(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      accessSync(this.dir, constants.W_OK);
    } catch (e) {
      throw new Error(`the spend ledger folder ${this.dir} cannot be written (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }

  record(tenant: string, jobId: string, amountUsd: string, transaction: string): void {
    const at = this.now();
    const f = this.file(tenant, at);
    mkdirSync(join(this.dir, tenant), { recursive: true });
    appendFileSync(f, `${JSON.stringify({ ts: new Date(at).toISOString(), jobId, amountMicro: usdToMicro(amountUsd).toString(), transaction })}\n`);
  }

  /**
   * privateAI-design-37 ARCH-677: a refund ChainAim signed and the agent verified gives the amount back to today's cap
   * (a line with kind "refund"; the payment's own line stays, so the file still shows both movements).
   */
  refund(tenant: string, jobId: string, amountUsd: string, refundTx: string): void {
    const at = this.now();
    const f = this.file(tenant, at);
    mkdirSync(join(this.dir, tenant), { recursive: true });
    appendFileSync(f, `${JSON.stringify({ ts: new Date(at).toISOString(), kind: "refund", jobId, amountMicro: usdToMicro(amountUsd).toString(), refundTx })}\n`);
  }

  spentToday(tenant: string): bigint {
    const f = this.file(tenant, this.now());
    if (!existsSync(f)) return 0n;
    let total = 0n;
    for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
      if (line.trim() === "") continue;
      let row: { amountMicro?: unknown; kind?: unknown };
      try {
        row = JSON.parse(line) as { amountMicro?: unknown; kind?: unknown };
      } catch {
        throw new Error(`${f} line ${i + 1} is not JSON; fix or move the file before paying again`);
      }
      if (typeof row.amountMicro !== "string" || !/^\d+$/.test(row.amountMicro)) throw new Error(`${f} line ${i + 1} has no amountMicro`);
      total += row.kind === "refund" ? -BigInt(row.amountMicro) : BigInt(row.amountMicro);
    }
    return total < 0n ? 0n : total;
  }
}
