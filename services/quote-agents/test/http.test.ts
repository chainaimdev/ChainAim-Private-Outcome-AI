import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createQuoteServer, loadAll, parseConfig } from "../src/main.ts";
import { DATA_ROOT, JUPITER_LEI, PROMPTS, TENANTS, TOMMY_LEI } from "./helpers.ts";

const env = { QUOTE_TOKEN_JUPITER: "jupiter-token-a1", QUOTE_TOKEN_TOMMY: "tommy-token-b2" };
const cfg = parseConfig(["--port", "8785", "--data-root", DATA_ROOT, "--tenants", TENANTS, "--prompts-dir", PROMPTS], {});
const server = createQuoteServer(cfg, loadAll(cfg), env);
let base = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const post = (path: string, body: unknown, token = "jupiter-token-a1", alias = "JupiterInventoryAgent", lei = JUPITER_LEI) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agent-alias": alias, "x-agent-lei": lei }, body: typeof body === "string" ? body : JSON.stringify(body) });
const INV = "/v1/tenants/jupiter-knitting/agents/inventory";

test("ARCH-736 defaults: port 8785, loopback, as-of 2026-11-16, ai off, attest on only with nearai", () => {
  const d = parseConfig(["--prompts-dir", PROMPTS], {});
  assert.deepEqual([d.port, d.host, d.asOf, d.ai.ai, d.ai.attest], [8785, "127.0.0.1", "2026-11-16", "off", false]);
  const n = parseConfig(["--prompts-dir", PROMPTS, "--ai", "nearai"], { CHAINAIM_GATEWAY_KEY: "k" });
  assert.deepEqual([n.ai.model, n.ai.attest, n.ai.gatewayKey], ["nearai/deepseek-v4.1-flash", true, "k"]);
  assert.equal(parseConfig(["--prompts-dir", PROMPTS, "--ai", "bedrock"], {}).ai.model, "bedrock/nemotron-nano-3-30b");
  assert.throws(() => parseConfig(["--prompts-dir", PROMPTS, "--host", "0.0.0.0"], {}), /loopback/);
  assert.throws(() => parseConfig(["--prompts-dir", PROMPTS, "--ai", "openai"], {}), /--ai/);
});

test("ARCH-736 GET /healthz answers ok with the as-of date, ai mode and tenants", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual([j.ok, j.asOf, j.ai, j.tenants], [true, "2026-11-16", "off", ["jupiter-knitting", "tommy-hilfiger-europe"]]);
  assert.equal(j.gateway.ok, false);
});

test("ARCH-736 an inventory call over HTTP echoes requestId and answers the sources", async () => {
  const res = await post(INV, { requestId: "rq-1", sku: "FAB-COT-180-A", qty: 20000, shipBy: "2026-12-20" });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.requestId, "rq-1");
  assert.equal(j.sources[0].units, 20000);
});

test("ARCH-736 errors are {error:{code, message}}: 404 route, 400 bad JSON / body, 401, 403, 404 tenant without endpoints", async () => {
  const shape = async (res: Response, status: number, code: string) => {
    assert.equal(res.status, status);
    const j = await res.json();
    assert.equal(j.error.code, code);
    assert.equal(typeof j.error.message, "string");
  };
  await shape(await fetch(`${base}/nope`), 404, "unknown_route");
  await shape(await post(INV, "{not json"), 400, "bad_json");
  await shape(await post(INV, { requestId: "r", sku: "FAB-COT-180-A", qty: -1, shipBy: "2026-12-20" }), 400, "bad_body");
  await shape(await post(INV, { requestId: "r" }, "wrong"), 401, "bad_token");
  await shape(await post(INV, { requestId: "r" }, "jupiter-token-a1", "JupiterTreasuryAgent"), 403, "path_not_allowed");
  await shape(await post("/v1/tenants/tommy-hilfiger-europe/agents/treasury", { requestId: "r" }, "jupiter-token-a1", "TommyTreasuryAgent", TOMMY_LEI), 403, "wrong_tenant");
  await shape(await post("/v1/tenants/tommy-hilfiger-europe/agents/procurement", { requestId: "r" }, "tommy-token-b2", "tommyBuyerAgent", TOMMY_LEI), 404, "unknown_path");
  await shape(await post(INV, { requestId: "r", sku: "NOPE", qty: 1, shipBy: "2026-12-20" }), 422, "unknown_sku");
});

test("ARCH-736 seller/synthesize over HTTP as jupiterSellerAgent: rules proposal", async () => {
  const res = await post("/v1/tenants/jupiter-knitting/seller/synthesize", {
    requestId: "s-1", mode: "round", round: 1, history: [],
    inquiry: { sku: "FAB-COT-180-A", qty: 20000, priceCents: 425, deadline: "2027-01-08" },
    answers: { inventory: null, logistics: { legs: [{ lot: "L-180A-01", units: 20000, mode: "SEA_STD", carrier: "MSC", etd: "2026-11-20", delivered: "2026-12-22", freightCents: 420000, late: false }], freightCents: 420000, meetsDeadline: true, lateUnits: 0, airOption: null }, treasury: { landedCents: 353, pricesAtMargin: { "0.15": 415, "0.135": 408, "0.12": 401 }, reallocPremiumCents: 0 } },
    authority: { level: "AGENT", floorCents: 401, maxRounds: 3, allowed: [] },
  }, "jupiter-token-a1", "jupiterSellerAgent");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual([j.requestId, j.source, j.proposal.decision, j.proposal.counter.priceCents, j.attest], ["s-1", "rules", "ACCEPT", 425, null]);
});
