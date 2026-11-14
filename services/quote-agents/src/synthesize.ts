/**
 * Seller synthesis (privateAI-design-44 §4 seller/synthesize, §6 AI synthesis).
 *   --ai off            the rules proposal (rules.ts), source "rules".
 *   --ai nearai|bedrock one model call through the ChainAim gateway (masked by Presidio, residual-checked), then guards;
 *                       any refusal (422 residual), timeout, gateway error, bad JSON or guard failure -> the rules
 *                       proposal with reasonAiSkipped.
 * The model gets a compact JSON context of per-unit cents and dates: no LEI, no account, no cent total (residual guard,
 * design §4 "Data rules"). Its `reasoning` is returned to Signatory for Jupiter's own records only.
 * Attestation: with --attest on, the four x-chainaim-* headers of the reply go to ca-attest POST /verify; the verdict is
 * awaited for at most --attest-wait-ms, else "pending".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "./data.ts";
import { askFor, buyerPrice, lastSellerPrice, rulesProposal, shipmentsOf, type Proposal, type SynthesizeRequest } from "./rules.ts";

export type AiConfig = {
  ai: "off" | "nearai" | "bedrock";
  model: string;
  gatewayUrl: string;
  gatewayKey: string | undefined;
  attestUrl: string;
  attest: boolean;
  timeoutMs: number;
  attestWaitMs: number;
  temperature: number;
  prompts: { round: string; ceoBrief: string };
};
export type AttestOut = { chatId: string | null; servedModel: string | null; verdict: string } | null;
export type SynthesizeAnswer = {
  proposal: Proposal;
  messageToBuyer: string;
  reasoning: string;
  source: "ai" | "rules";
  model: string | null;
  attest: AttestOut;
  ms: number;
  reasonAiSkipped?: string;
};
export type Fetch = typeof fetch;

/** Read the two system prompts from --prompts-dir (seller-round.md, ceo-brief.md). */
export function loadPrompts(dir: string): AiConfig["prompts"] {
  const read = (f: string) => {
    const t = readFileSync(join(dir, f), "utf8").trim();
    if (!t) throw new Error(`--prompts-dir ${dir}: ${f} is empty`);
    return t;
  };
  return { round: read("seller-round.md"), ceoBrief: read("ceo-brief.md") };
}

/** The model's user content: per-unit cents, units and dates only. */
export function modelContext(r: SynthesizeRequest, policy: Policy): Record<string, unknown> {
  const t = r.answers.treasury;
  const l = r.answers.logistics;
  const inv = r.answers.inventory;
  return {
    mode: r.mode,
    round: r.round,
    maxRounds: r.authority.maxRounds,
    authorityLevel: r.authority.level,
    sku: r.inquiry.sku,
    units: r.inquiry.qty,
    deadline: r.inquiry.deadline,
    buyerPriceCents: buyerPrice(r),
    lastSellerPriceCents: lastSellerPrice(r) ?? null,
    floorCents: r.authority.floorCents,
    rulesAskCents: askFor(r, policy),
    pricesAtMarginCents: t.pricesAtMargin,
    reallocPremiumCents: t.reallocPremiumCents ?? 0,
    shipments: shipmentsOf(l).map((s) => ({ units: s.units, mode: s.mode, delivered: s.delivered })),
    meetsDeadline: l.meetsDeadline,
    lateUnits: l.lateUnits,
    liquidity: t.liquidity?.status ?? null,
    advanceLeverApplies: t.advanceLever?.applies ?? false,
    creditOk: t.credit?.ok ?? null,
    shortfallUnits: inv?.shortfall ?? null,
    gradeAlternatives: inv?.gradeAlternatives?.map((g) => g.grade) ?? [],
  };
}

type ModelAnswer = { decision: Proposal["decision"]; priceCents: number; messageToBuyer: string; reasoning: string };

/** Parse the model's JSON (a ```json fence is allowed). Returns an error string when it is not the agreed shape. */
export function parseModelAnswer(text: string): ModelAnswer | string {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  let v: unknown;
  try {
    v = JSON.parse((m ? m[1]! : text).trim());
  } catch {
    return "the model's answer is not JSON";
  }
  if (typeof v !== "object" || v === null) return "the model's answer is not a JSON object";
  const o = v as Record<string, unknown>;
  if (o.decision !== "ACCEPT" && o.decision !== "COUNTER" && o.decision !== "ESCALATE") return "decision must be ACCEPT, COUNTER or ESCALATE";
  if (typeof o.priceCents !== "number" || !Number.isInteger(o.priceCents) || o.priceCents <= 0) return "priceCents must be a positive whole number";
  if (typeof o.messageToBuyer !== "string" || !o.messageToBuyer.trim() || o.messageToBuyer.length > 800) return "messageToBuyer must be 1-800 characters";
  return { decision: o.decision, priceCents: o.priceCents, messageToBuyer: o.messageToBuyer.trim(), reasoning: typeof o.reasoning === "string" ? o.reasoning : "" };
}

/** The guards an AI proposal must pass (design §6 step 4); returns the first failure or null. */
export function guardFailure(a: ModelAnswer, r: SynthesizeRequest): string | null {
  const floor = r.authority.floorCents;
  const offer = buyerPrice(r);
  const prev = lastSellerPrice(r);
  if (a.priceCents < floor) return `price ${a.priceCents}c is below the floor`;
  if (a.decision === "ACCEPT" && a.priceCents !== offer) return "an ACCEPT must be at the buyer's price";
  if (a.decision === "COUNTER" && prev !== undefined && a.priceCents > prev) return "a counter above the previous counter";
  if (a.decision === "COUNTER" && a.priceCents <= offer) return "a counter at or below the buyer's own price (accept instead)";
  if (r.mode === "ceo-brief" && a.decision === "ESCALATE") return "a CEO brief cannot escalate further";
  const leaks = [String(floor), ...Object.values(r.answers.treasury.pricesAtMargin ?? {}).filter((p) => p !== a.priceCents && p !== offer).map(String)];
  if (typeof r.answers.treasury.landedCents === "number") leaks.push(String(r.answers.treasury.landedCents));
  const msg = a.messageToBuyer;
  if (/\b(cost|margin|floor|landed)\b/i.test(msg)) return "messageToBuyer mentions cost, margin, floor or landed";
  for (const n of leaks) if (n !== String(a.priceCents) && new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(msg)) return "messageToBuyer contains an internal price figure";
  return null;
}

async function verdictOf(cfg: AiConfig, f: Fetch, h: Headers, calledAt: string, model: string): Promise<AttestOut> {
  const chatId = h.get("x-chainaim-provider-id");
  const servedModel = h.get("x-chainaim-served-model");
  const requestSha256 = h.get("x-chainaim-req-sha256");
  const responseSha256 = h.get("x-chainaim-resp-sha256");
  if (!servedModel || !requestSha256 || !responseSha256) return { chatId, servedModel: servedModel ?? model, verdict: "no-evidence" };
  const call = { ...(chatId ? { chatId } : {}), servedModel, requestSha256, responseSha256, calledAt };
  const verify = f(`${cfg.attestUrl}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ calls: [call] }), signal: AbortSignal.timeout(cfg.timeoutMs) })
    .then(async (res) => {
      if (!res.ok) return `error: attest answered ${res.status}`;
      const j = (await res.json()) as { results?: { status?: string }[] };
      return typeof j.results?.[0]?.status === "string" ? j.results[0].status : "error: attest answered without a status";
    })
    .catch((e: Error) => `error: ${e.name === "TimeoutError" ? "attest timed out" : e.message}`);
  let timer: NodeJS.Timeout | undefined;
  const wait = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("pending"), cfg.attestWaitMs);
  });
  const verdict = await Promise.race([verify, wait]);
  clearTimeout(timer);
  return { chatId, servedModel, verdict };
}

export async function synthesize(cfg: AiConfig, policy: Policy, r: SynthesizeRequest, f: Fetch = fetch, now: () => number = Date.now): Promise<SynthesizeAnswer> {
  const started = now();
  const rules = (reasonAiSkipped?: string, attest: AttestOut = null): SynthesizeAnswer => ({
    ...rulesProposal(r, policy),
    source: "rules",
    model: null,
    attest,
    ms: now() - started,
    ...(reasonAiSkipped ? { reasonAiSkipped } : {}),
  });
  if (cfg.ai === "off") return rules();

  const context = modelContext(r, policy);
  const calledAt = new Date(now()).toISOString();
  let res: Response;
  try {
    res = await f(`${cfg.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.gatewayKey ? { authorization: `Bearer ${cfg.gatewayKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        stream: false,
        messages: [
          { role: "system", content: r.mode === "ceo-brief" ? cfg.prompts.ceoBrief : cfg.prompts.round },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    return rules((e as Error).name === "TimeoutError" ? `the gateway did not answer within ${cfg.timeoutMs} ms` : `gateway unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string } | string };
      detail = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
    } catch {
      detail = "";
    }
    return rules(`gateway ${res.status}${res.status === 422 ? " (residual guard refused the request)" : ""}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const attest = cfg.attest ? await verdictOf(cfg, f, res.headers, calledAt, cfg.model) : null;
  let completion: { model?: string; choices?: { message?: { content?: unknown; reasoning?: unknown } }[] };
  try {
    completion = (await res.json()) as typeof completion;
  } catch {
    return rules("the gateway's reply is not JSON", attest);
  }
  const message = completion.choices?.[0]?.message;
  if (typeof message?.content !== "string") return rules("the reply has no message content", attest);
  const parsed = parseModelAnswer(message.content);
  if (typeof parsed === "string") return rules(parsed, attest);
  const bad = guardFailure(parsed, r);
  if (bad) return rules(`guard: ${bad}`, attest);
  const rulesShape = rulesProposal(r, policy).proposal.counter;
  const modelReasoning = typeof message.reasoning === "string" ? message.reasoning : "";
  return {
    proposal: { decision: parsed.decision, counter: { ...rulesShape, priceCents: parsed.priceCents } },
    messageToBuyer: parsed.messageToBuyer,
    reasoning: [parsed.reasoning, modelReasoning].filter(Boolean).join("\n\n"),
    source: "ai",
    model: typeof completion.model === "string" ? completion.model : cfg.model,
    attest,
    ms: now() - started,
  };
}
