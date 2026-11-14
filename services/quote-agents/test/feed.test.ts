/** Agent-call feed (src/feed.ts): one record per answered or refused call to <feed-url>/ingest/agent, ids only. */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { agentCallRecord } from "../src/feed.ts";
import { createQuoteServer, loadAll, parseConfig } from "../src/main.ts";
import { DATA_ROOT, JUPITER_LEI, listen, PROMPTS, TENANTS, TOMMY_LEI } from "./helpers.ts";

const env = { QUOTE_TOKEN_JUPITER: "jupiter-token-a1", QUOTE_TOKEN_TOMMY: "tommy-token-b2", NEAR_WATCH_INGEST_KEY: "ingest-key-for-tests" };
const args = ["--data-root", DATA_ROOT, "--tenants", TENANTS, "--prompts-dir", PROMPTS];

async function withServer(feedUrl: string | null, run: (base: string) => Promise<void>) {
  const cfg = parseConfig([...args, ...(feedUrl ? ["--feed-url", feedUrl] : [])], env);
  const server = createQuoteServer(cfg, loadAll(cfg), env);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
const post = (base: string, path: string, body: unknown, token: string, alias: string, lei: string) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agent-alias": alias, "x-agent-lei": lei }, body: JSON.stringify(body) });
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("config: off without --feed-url or without the key; the key comes from the named variable only", () => {
  assert.equal(parseConfig(args, env).feed, null);
  assert.equal(parseConfig([...args, "--feed-url", "http://near-watch:8790"], { ...env, NEAR_WATCH_INGEST_KEY: "" }).feed, null);
  assert.deepEqual(parseConfig([...args, "--feed-url", "http://near-watch:8790/"], env).feed, { url: "http://near-watch:8790", key: "ingest-key-for-tests", timeoutMs: 2000 });
  assert.throws(() => parseConfig([...args, "--feed-url", "near-watch:8790"], env), /--feed-url/);
  assert.throws(() => parseConfig([...args, "--feed-key-env", "abc def"], env), /NAME/);
});

test("record: only fields near-watch accepts; anything else is dropped", () => {
  const r = agentCallRecord({ tenant: "jupiter-knitting", alias: "JupiterInventoryAgent", path: "agents/inventory", status: 200, ms: 11.6, source: "rules", requestId: "abc-123", code: undefined }, new Date("2026-11-14T16:55:24.000Z"));
  assert.deepEqual(r, { v: 1, event: "agent_call", ts: "2026-11-14T16:55:24.000Z", tenant: "jupiter-knitting", alias: "JupiterInventoryAgent", path: "agents/inventory", status: 200, ms: 12, source: "rules", requestId: "abc-123", code: null });
  const odd = agentCallRecord({ tenant: "Acme Corp", alias: "x y", path: "/V1/Weird Path", status: 404, ms: -5, source: "gpt", requestId: "x".repeat(80), code: "unknown_tenant" });
  assert.deepEqual([odd.tenant, odd.alias, odd.path, odd.ms, odd.source, odd.requestId, odd.code], [null, null, "/unknown", 0, null, null, "unknown_tenant"]);
});

test("HTTP: each answered and refused call reaches the feed with the ingest key, ids only; a dead feed never fails a call", async () => {
  const feed = await listen((_s, res) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.end('{"accepted":1}');
  });
  try {
    await withServer(feed.url, async (base) => {
      const inv = await post(base, "/v1/tenants/jupiter-knitting/agents/inventory", { requestId: "req-1", sku: "FAB-JERSEY-140-A", qty: 1000, shipBy: "2027-01-08" }, "jupiter-token-a1", "JupiterInventoryAgent", JUPITER_LEI);
      assert.equal(inv.status, 200);
      const tre = await post(base, "/v1/tenants/tommy-hilfiger-europe/agents/treasury", { requestId: "req-2", rfqId: "RFQ-S06", sku: "FAB-LIN-150-A", qty: 5000, priceCents: 640, advancePct: 0 }, "tommy-token-b2", "TommyTreasuryAgent", TOMMY_LEI);
      assert.equal(tre.status, 200);
      const bad = await post(base, "/v1/tenants/jupiter-knitting/agents/inventory", { requestId: "req-3" }, "wrong", "JupiterInventoryAgent", JUPITER_LEI);
      assert.equal(bad.status, 401);
      await until(() => feed.seen.length === 3);
    });
    for (const s of feed.seen) {
      assert.equal(s.method, "POST");
      assert.equal(s.url, "/ingest/agent");
      assert.equal(s.headers["x-ingest-key"], "ingest-key-for-tests");
    }
    const recs = feed.seen.map((s) => JSON.parse(s.body)).sort((a, b) => String(a.requestId).localeCompare(String(b.requestId)));
    const byPath = Object.fromEntries(recs.map((r) => [r.path, r]));
    assert.deepEqual([byPath["agents/inventory"].tenant, byPath["agents/inventory"].alias, byPath["agents/inventory"].status, byPath["agents/inventory"].requestId], ["jupiter-knitting", "JupiterInventoryAgent", 200, "req-1"]);
    assert.deepEqual([byPath["agents/treasury"].tenant, byPath["agents/treasury"].alias], ["tommy-hilfiger-europe", "TommyTreasuryAgent"]);
    const refused = recs.find((r) => r.status === 401);
    assert.deepEqual([refused.tenant, refused.path, refused.code], ["jupiter-knitting", "/v1/tenants/jupiter-knitting/agents/inventory", "bad_token"]);
    for (const r of recs) {
      assert.deepEqual(Object.keys(r).sort(), ["alias", "code", "event", "ms", "path", "requestId", "source", "status", "tenant", "ts", "v"]);
      assert.ok(!JSON.stringify(r).includes("FAB-"), "no SKU, price or answer content in a record");
    }
  } finally {
    await feed.close();
  }
  // dead feed: the call still answers 200
  await withServer("http://127.0.0.1:9", async (base) => {
    const r = await post(base, "/v1/tenants/jupiter-knitting/agents/inventory", { requestId: "req-4", sku: "FAB-JERSEY-140-A", qty: 1000, shipBy: "2027-01-08" }, "jupiter-token-a1", "JupiterInventoryAgent", JUPITER_LEI);
    assert.equal(r.status, 200);
  });
});
