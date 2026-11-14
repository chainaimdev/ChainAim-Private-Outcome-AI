/** Buyer tenant (Tommy): private requisitions, buyer treasury and buyer synthesis (rules, same as Signatory's rule buyer). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buyerSynthesize, buyerTreasury, isBuyerDir, loadBuyerData, parseBuyerSynthesizeRequest, parseBuyerTreasuryRequest, roundHalfEven } from "../src/buyer.ts";
import { createQuoteServer, loadAll } from "../src/main.ts";
import { DATA_ROOT, JUPITER_LEI, PROMPTS, TENANTS, TOMMY_LEI } from "./helpers.ts";

const dir = join(DATA_ROOT, "tommy-hilfiger-europe");
const tommy = () => loadBuyerData(dir);
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return `${(e as { status: number }).status} ${(e as { code: string }).code}`;
  }
  return "ok";
};

test("Tommy's data folder is a buyer tenant with a requisition per RFQ (T01-T08, S01-S10)", () => {
  assert.equal(isBuyerDir(dir), true);
  assert.equal(isBuyerDir(join(DATA_ROOT, "jupiter-knitting")), false);
  const d = tommy();
  assert.equal(d.requisitions.size, 18);
  assert.deepEqual(d.requisitions.get("RFQ-S02"), { rfq: "RFQ-S02", sku: "GAR-TSHIRT-CREW-A", qty: 20000, maxPriceCents: 302, concession: 0.5 });
  assert.deepEqual(d.policy, { agentMaxUsd: 100000, cpoMaxUsd: 250000, safetyThresholdUsd: 50000 });
});

test("buyer treasury: within budget, approver by total (agent ≤ $100k, CPO ≤ $250k), cash; never the budget itself", () => {
  const t = (rfqId: string, sku: string, qty: number, priceCents: number, advancePct = 0) => buyerTreasury(tommy(), { rfqId, sku, qty, priceCents, advancePct });
  const s01 = t("RFQ-S01", "FAB-JERSEY-140-A", 30000, 300);
  assert.deepEqual([s01.withinBudget, s01.totalUsd, s01.approval, s01.approver, s01.cash.status], [true, 90000, "AGENT", "tommyBuyerAgent", "OK"]);
  const s03 = t("RFQ-S03", "FAB-PC-160-A", 60000, 319);
  assert.deepEqual([s03.withinBudget, s03.totalUsd, s03.approval, s03.approver], [true, 191400, "CPO", "Tommy_Chief_Procurement_Officer"]);
  assert.equal(t("RFQ-S09", "FAB-COT-180-A", 20000, 401).withinBudget, false);
  assert.equal(t("RFQ-S05", "GAR-SAREE-COT-A", 8000, 878, 30).cash.advanceDueUsd, 21072);
  assert.equal(t("RFQ-S04", "FAB-JERSEY-140-A", 30000, 295).withinBudget, true, "a better grade of the requested family is accepted");
  assert.ok(!JSON.stringify(s01).includes("320"), "Tommy's maximum (320) is not in the answer");
  assert.equal(code(() => t("RFQ-X", "FAB-COT-180-A", 1, 1)), "422 unknown_requisition");
  assert.equal(code(() => t("RFQ-S01", "GAR-SAREE-COT-A", 1, 1)), "422 sku_mismatch");
});

test("buyer synthesis: the rule buyer's moves — round 1 counters, later accepts within budget, half-to-even, escalation best and final", () => {
  const s = (rfqId: string, sku: string, phase: "round" | "escalation", round: number, askCents: number, lastOfferCents: number) =>
    buyerSynthesize(tommy(), { rfqId, sku, phase, round, askCents, lastOfferCents });
  // S02: opening 270, budget 302, concession 0.5 → R1 ask 306 → 288; R2 ask 300 → accept
  assert.deepEqual([s("RFQ-S02", "GAR-TSHIRT-CREW-A", "round", 1, 306, 270).decision, s("RFQ-S02", "GAR-TSHIRT-CREW-A", "round", 1, 306, 270).priceCents], ["COUNTER", 288]);
  assert.deepEqual([s("RFQ-S02", "GAR-TSHIRT-CREW-A", "round", 2, 300, 288).decision, s("RFQ-S02", "GAR-TSHIRT-CREW-A", "round", 2, 300, 288).priceCents], ["ACCEPT", 300]);
  // round 1 counters even when the ask is within budget
  assert.equal(s("RFQ-S01", "FAB-JERSEY-140-A", "round", 1, 300, 290).decision, "COUNTER");
  // S09: budget 385, concession 0.25 → capped at the budget
  assert.equal(s("RFQ-S09", "FAB-COT-180-A", "round", 3, 401, 382).priceCents, 385);
  // escalation: officer ask above budget → best and final = budget; within → accept
  assert.deepEqual([s("RFQ-S09", "FAB-COT-180-A", "escalation", 4, 397, 385).decision, s("RFQ-S09", "FAB-COT-180-A", "escalation", 4, 397, 385).priceCents], ["COUNTER", 385]);
  assert.equal(s("RFQ-S06", "FAB-LIN-150-A", "escalation", 2, 690, 640).decision, "ACCEPT");
  assert.equal(s("RFQ-S02", "GAR-TSHIRT-CREW-A", "round", 1, 306, 270).source, "rules");
  assert.deepEqual([roundHalfEven(2.5), roundHalfEven(3.5), roundHalfEven(288)], [2, 4, 288]);
  assert.equal(code(() => parseBuyerSynthesizeRequest({ requestId: "r", rfqId: "RFQ-S02", sku: "X", phase: "later", round: 1, askCents: 1, lastOfferCents: 1 })), "400 bad_body");
  assert.equal(code(() => parseBuyerTreasuryRequest({ requestId: "r", rfqId: "RFQ-S02", sku: "X", qty: 0, priceCents: 1, advancePct: 0 })), "400 bad_body");
});

test("HTTP: Tommy's agents/treasury and buyer/synthesize answer for Tommy's own agents; Jupiter has no buyer/synthesize", async () => {
  const env = { QUOTE_TOKEN_JUPITER: "jupiter-token-a1", QUOTE_TOKEN_TOMMY: "tommy-token-b2" };
  const cfg = { host: "127.0.0.1", port: 0, asOf: "2026-11-16", dataRoot: DATA_ROOT, tenantsPath: TENANTS, probeMs: 500, promptsDir: PROMPTS,
    ai: { ai: "off", model: "nearai/deepseek-v4.1-flash", gatewayUrl: "http://127.0.0.1:1", gatewayKey: undefined, attestUrl: "http://127.0.0.1:1", attest: false, timeoutMs: 1000, attestWaitMs: 0, temperature: 0 } };
  const loaded = loadAll(cfg as never);
  assert.ok(loaded.buyers.has("tommy-hilfiger-europe") && !loaded.data.has("tommy-hilfiger-europe"));
  const server = createQuoteServer(cfg as never, loaded, env as never);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, b: object, token: string, alias: string, lei: string) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agent-alias": alias, "x-agent-lei": lei }, body: JSON.stringify(b) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  try {
    const tre = await post("/v1/tenants/tommy-hilfiger-europe/agents/treasury", { requestId: "t1", rfqId: "RFQ-S06", sku: "FAB-LIN-150-A", qty: 5000, priceCents: 700, advancePct: 0 }, "tommy-token-b2", "TommyTreasuryAgent", TOMMY_LEI);
    assert.deepEqual([tre.status, tre.json.requestId, tre.json.withinBudget, tre.json.approval], [200, "t1", true, "AGENT"]);
    const syn = await post("/v1/tenants/tommy-hilfiger-europe/buyer/synthesize", { requestId: "t2", rfqId: "RFQ-S06", sku: "FAB-LIN-150-A", phase: "escalation", round: 2, askCents: 719, lastOfferCents: 640 }, "tommy-token-b2", "tommyBuyerAgent", TOMMY_LEI);
    assert.deepEqual([syn.status, syn.json.decision, syn.json.priceCents], [200, "COUNTER", 700]);
    const wrongAlias = await post("/v1/tenants/tommy-hilfiger-europe/buyer/synthesize", { requestId: "t3" }, "tommy-token-b2", "TommyTreasuryAgent", TOMMY_LEI);
    assert.equal(wrongAlias.status, 403);
    const noBuyerOnJupiter = await post("/v1/tenants/jupiter-knitting/buyer/synthesize", { requestId: "t4" }, "jupiter-token-a1", "jupiterSellerAgent", JUPITER_LEI);
    assert.equal(noBuyerOnJupiter.status, 403, "jupiterSellerAgent may not call buyer/synthesize");
    const sellerPathOnTommy = await post("/v1/tenants/tommy-hilfiger-europe/agents/procurement", { requestId: "t5" }, "tommy-token-b2", "tommyBuyerAgent", TOMMY_LEI);
    assert.equal(sellerPathOnTommy.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
