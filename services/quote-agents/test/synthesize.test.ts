import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { logistics } from "../src/logistics.ts";
import { rulesProposal, type SynthesizeRequest } from "../src/rules.ts";
import { loadPrompts, synthesize, type AiConfig } from "../src/synthesize.ts";
import { treasury } from "../src/treasury.ts";
import { AS_OF, jupiter, JUPITER_LEI, listen, PROMPTS } from "./helpers.ts";

const data = jupiter();
const pol = data.policy;
const MARGINS = [0.15, 0.135, 0.12, 0.11, 0.1, 0.09, 0.08];
const SKU = "FAB-COT-180-A";

/** A request built from the real agent answers for qty units of free stock delivered by deadline. */
function request(qty: number, buyerCents: number, round: number, extra: Partial<SynthesizeRequest> = {}): SynthesizeRequest {
  const l = logistics(data, { sku: SKU, lots: [{ lot: "L-180A-01", units: qty, readyDate: "2026-11-16", warehouse: "MADRAS-WH-1" }], deadline: "2027-01-08", allowAir: false });
  const t = treasury(data, AS_OF, { sku: SKU, qty, freightCents: l.freightCents, reallocUnits: { TIER1: 0, TIER2: 0 }, termsDays: 30, advancePct: 0, margins: MARGINS });
  return {
    mode: "round",
    inquiry: { sku: SKU, qty, priceCents: buyerCents, deadline: "2027-01-08" },
    round,
    history: [],
    answers: { inventory: null, logistics: l, treasury: t },
    authority: { level: "AGENT", floorCents: t.pricesAtMargin["0.12"]!, maxRounds: 3, allowed: [] },
    ...extra,
  };
}

test("ARCH-734 T01 round 1: buyer 425 >= ask 415 (15%) -> ACCEPT at 425", () => {
  const r = rulesProposal(request(20000, 425, 1), pol);
  assert.equal(r.proposal.decision, "ACCEPT");
  assert.equal(r.proposal.counter.priceCents, 425);
  assert.deepEqual(r.proposal.counter.shipments, [{ units: 20000, mode: "SEA_STD", etd: "2026-11-20", delivered: "2026-12-22" }]);
});

test("ARCH-734 T02: round 1 counter at 15% (418), round 2 ask 13.5% (411) and the buyer's 411 is accepted", () => {
  const r1 = rulesProposal(request(18000, 390, 1), pol);
  assert.deepEqual([r1.proposal.decision, r1.proposal.counter.priceCents], ["COUNTER", 418]);
  const r2 = rulesProposal(request(18000, 390, 2, { history: [{ round: 1, by: "seller", priceCents: 418 }, { round: 1, by: "buyer", priceCents: 411 }] }), pol);
  assert.deepEqual([r2.proposal.decision, r2.proposal.counter.priceCents], ["ACCEPT", 411]);
});

test("ARCH-734 round 3 asks the floor; below it at the last round -> ESCALATE; never above the previous counter", () => {
  const r3 = rulesProposal(request(18000, 380, 3, { history: [{ round: 2, by: "seller", priceCents: 411 }, { round: 2, by: "buyer", priceCents: 395 }] }), pol);
  assert.equal(r3.proposal.decision, "ESCALATE");
  assert.equal(r3.proposal.counter.priceCents, 404);
  const low = rulesProposal(request(18000, 380, 1, { history: [{ round: 0, by: "seller", priceCents: 410 }] }), pol);
  assert.equal(low.proposal.counter.priceCents, 410);
});

test("ARCH-734 ceo-brief: ask = floor + reallocation premium, a best-and-final counter, never escalated", () => {
  const base = request(20000, 380, 4);
  const r = rulesProposal({ ...base, mode: "ceo-brief", answers: { ...base.answers, treasury: { ...base.answers.treasury, reallocPremiumCents: 10 } }, authority: { ...base.authority, level: "CEO", floorCents: 384 } }, pol);
  assert.deepEqual([r.proposal.decision, r.proposal.counter.priceCents], ["COUNTER", 394]);
  assert.ok(!/cost|margin|floor/i.test(r.messageToBuyer));
});

// ---- AI branch against a real local HTTP server in the gateway's place, and one in ca-attest's place ----------
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
let reply: { status: number; body: unknown; headers?: Record<string, string>; delayMs?: number };
let attestDelayMs = 0;
let gw: Awaited<ReturnType<typeof listen>>;
let at: Awaited<ReturnType<typeof listen>>;
before(async () => {
  gw = await listen(async (_s, res) => {
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  at = await listen(async (_s, res) => {
    if (attestDelayMs) await new Promise((r) => setTimeout(r, attestDelayMs));
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [{ chatId: "chat-1", status: "verified", reason: null }] }));
  });
});
after(async () => {
  await gw.close();
  await at.close();
});
const cfg = (over: Partial<AiConfig> = {}): AiConfig => ({
  ai: "nearai", model: "nearai/deepseek-v4.1-flash", gatewayUrl: gw.url, gatewayKey: "gw-key-1", attestUrl: at.url, attest: true,
  timeoutMs: 2000, attestWaitMs: 1500, temperature: 0.2, prompts: loadPrompts(PROMPTS), ...over,
});
const evidence = { "x-chainaim-provider-id": "chat-1", "x-chainaim-served-model": "deepseek-ai/DeepSeek-V4.1-Flash", "x-chainaim-req-sha256": HASH_A, "x-chainaim-resp-sha256": HASH_B };
const completion = (content: string, reasoning?: string) => ({ model: "nearai/deepseek-v4.1-flash", choices: [{ index: 0, message: { role: "assistant", content, ...(reasoning ? { reasoning } : {}) } }] });

test("ARCH-735 a valid model answer is source ai; the gateway gets the key, the prompt and a context without LEI or cent totals", async () => {
  reply = { status: 200, headers: evidence, body: completion(JSON.stringify({ decision: "COUNTER", priceCents: 412, messageToBuyer: "We can offer 18,000 units at $4.12 per unit, delivered by 2026-12-22.", reasoning: "close to the buyer" }), "model thoughts") };
  const before = gw.seen.length;
  const a = await synthesize(cfg(), pol, request(18000, 390, 1));
  assert.equal(a.source, "ai");
  assert.deepEqual([a.proposal.decision, a.proposal.counter.priceCents], ["COUNTER", 412]);
  assert.match(a.reasoning, /close to the buyer/);
  assert.match(a.reasoning, /model thoughts/);
  const sent = gw.seen[before]!;
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer gw-key-1");
  const body = JSON.parse(sent.body);
  assert.equal(body.model, "nearai/deepseek-v4.1-flash");
  assert.equal(body.temperature, 0.2);
  assert.match(body.messages[0].content, /seller agent/);
  assert.ok(!sent.body.includes(JUPITER_LEI));
  assert.ok(!/\d{9,}/.test(body.messages[1].content), "no run of 9+ digits (residual guard)");
});

test("ARCH-735 the four attest headers go to ca-attest /verify and the verdict comes back", async () => {
  reply = { status: 200, headers: evidence, body: completion(JSON.stringify({ decision: "ACCEPT", priceCents: 425, messageToBuyer: "We accept 20,000 units at $4.25 per unit." })) };
  const before = at.seen.length;
  const a = await synthesize(cfg(), pol, request(20000, 425, 1));
  assert.deepEqual(a.attest, { chatId: "chat-1", servedModel: "deepseek-ai/DeepSeek-V4.1-Flash", verdict: "verified" });
  const call = JSON.parse(at.seen[before]!.body).calls[0];
  assert.deepEqual({ chatId: call.chatId, servedModel: call.servedModel, requestSha256: call.requestSha256, responseSha256: call.responseSha256 }, { chatId: "chat-1", servedModel: "deepseek-ai/DeepSeek-V4.1-Flash", requestSha256: HASH_A, responseSha256: HASH_B });
});

test("ARCH-735 a slow ca-attest leaves the verdict pending; no evidence headers -> no-evidence", async () => {
  reply = { status: 200, headers: evidence, body: completion(JSON.stringify({ decision: "ACCEPT", priceCents: 425, messageToBuyer: "We accept." })) };
  attestDelayMs = 800;
  const a = await synthesize(cfg({ attestWaitMs: 100 }), pol, request(20000, 425, 1));
  attestDelayMs = 0;
  assert.equal(a.attest?.verdict, "pending");
  reply = { status: 200, body: completion(JSON.stringify({ decision: "ACCEPT", priceCents: 425, messageToBuyer: "We accept." })) };
  const b = await synthesize(cfg(), pol, request(20000, 425, 1));
  assert.equal(b.attest?.verdict, "no-evidence");
});

test("ARCH-735 a 422 residual refusal, a timeout and a non-JSON answer all fall back to rules with the reason", async () => {
  reply = { status: 422, body: { error: { message: "residual: digits" } } };
  const a = await synthesize(cfg(), pol, request(18000, 390, 1));
  assert.equal(a.source, "rules");
  assert.match(a.reasonAiSkipped!, /422/);
  assert.equal(a.proposal.counter.priceCents, 418);
  reply = { status: 200, body: completion("{}"), delayMs: 600 };
  const b = await synthesize(cfg({ timeoutMs: 200 }), pol, request(18000, 390, 1));
  assert.equal(b.source, "rules");
  assert.match(b.reasonAiSkipped!, /did not answer within 200 ms/);
  reply = { status: 200, body: completion("I think we should counter at 412.") };
  const c = await synthesize(cfg(), pol, request(18000, 390, 1));
  assert.equal(c.source, "rules");
  assert.match(c.reasonAiSkipped!, /not JSON/);
});

test("ARCH-735 guards: below the floor, or a message leaking the floor, falls back to rules", async () => {
  reply = { status: 200, body: completion(JSON.stringify({ decision: "COUNTER", priceCents: 395, messageToBuyer: "We can offer $3.95." })) };
  const a = await synthesize(cfg({ attest: false }), pol, request(18000, 390, 1));
  assert.equal(a.source, "rules");
  assert.match(a.reasonAiSkipped!, /below the floor/);
  reply = { status: 200, body: completion(JSON.stringify({ decision: "COUNTER", priceCents: 412, messageToBuyer: "Our floor is 404, so 412 it is." })) };
  const b = await synthesize(cfg({ attest: false }), pol, request(18000, 390, 1));
  assert.equal(b.source, "rules");
  assert.match(b.reasonAiSkipped!, /guard/);
});

test("ARCH-735 --ai off never calls the gateway", async () => {
  const before = gw.seen.length;
  const a = await synthesize(cfg({ ai: "off" }), pol, request(20000, 425, 1));
  assert.equal(a.source, "rules");
  assert.equal(a.model, null);
  assert.equal(gw.seen.length, before);
});
