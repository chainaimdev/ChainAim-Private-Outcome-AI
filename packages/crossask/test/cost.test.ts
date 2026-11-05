import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gatewayChat } from "../src/index.ts";
import { quoteJob, pricesFromCatalog, type Fees } from "../src/cost.ts";

const NEMOTRON = "bedrock/nemotron-nano-3-30b";
const prices = pricesFromCatalog(JSON.parse(readFileSync(new URL("../../../config/catalog.bedrock.json", import.meta.url), "utf8")));
const ZERO: Fees = { perModelCallUsd: "0", analystUsd: "0", nearGasUsd: "0", marginPct: "0", minPriceUsd: "0.000001" };

// ---- ARCH-102: gatewayChat carries usage ----
let reply: Record<string, unknown> = {};
const gw: Server = createServer((req, res) => {
  req.resume();
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json", "x-chainaim-model": NEMOTRON, "x-chainaim-zone": "private-cloud" }); res.end(JSON.stringify(reply)); });
});
const gwUrl = await new Promise<string>((ok) => gw.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(gw.address() as AddressInfo).port}`)));
after(() => new Promise<void>((ok) => gw.close(() => ok())));
const chat = gatewayChat({ url: gwUrl, key: "k", timeoutMs: 5000 });

test("ARCH-102: gatewayChat copies usage", async () => {
  reply = { choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } };
  assert.deepEqual(await chat([{ role: "user", content: "q" }], NEMOTRON), { text: "hello", model: NEMOTRON, zone: "private-cloud", usage: { promptTokens: 1200, completionTokens: 80 } });
});

test("ARCH-102: gatewayChat without usage leaves it undefined", async () => {
  for (const usage of [undefined, { prompt_tokens: 5 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: "5", completion_tokens: 2 }]) {
    reply = { choices: [{ message: { content: "hi" } }], ...(usage ? { usage } : {}) };
    const r = await chat([{ role: "user", content: "q" }], NEMOTRON);
    assert.equal(r.usage, undefined, JSON.stringify(usage));
    assert.deepEqual(Object.keys(r).sort(), ["model", "text", "zone"]);
  }
});

// ---- ARCH-103: quoteJob ----
test("ARCH-103: worked example with Nemotron prices from config/catalog.bedrock.json", () => {
  assert.deepEqual(prices.get(NEMOTRON), { inputPerM: 0.0618, outputPerM: 0.2472 });
  // 2 calls: (1000 in, 50 out) and (2000 in, 150 out).
  // model = (3000 × 0.0618 + 200 × 0.2472) / 1e6 = (185.4 + 49.44) / 1e6 = 0.00023484
  // + 2 × 0.001 + 0.002 analyst + 0.0004 gas = 0.00463484; × 1.2 = 0.005561808 → ceil 6 dp = 0.005562
  const q = quoteJob([{ model: NEMOTRON, promptTokens: 1000, completionTokens: 50 }, { model: NEMOTRON, promptTokens: 2000, completionTokens: 150 }], prices,
    { perModelCallUsd: "0.001", analystUsd: "0.002", nearGasUsd: "0.0004", marginPct: "20", minPriceUsd: "0.001" });
  assert.equal(q.totalUsd, "0.005562");
  assert.equal(q.amount, "5562");
  assert.equal(q.breakdown.calls.length, 2);
  assert.equal(q.breakdown.modelUsd, "0.000235"); // 0.00023484 rounded up
  assert.equal(q.breakdown.callFeesUsd, "0.002000");
  assert.equal(q.breakdown.minApplied, false);
});

test("ARCH-103: rounding up at the 7th decimal", () => {
  assert.equal(quoteJob([], prices, { ...ZERO, analystUsd: "0.0100001" }).amount, "10001");
  assert.equal(quoteJob([], prices, { ...ZERO, analystUsd: "0.01" }).amount, "10000");
  assert.equal(quoteJob([], prices, { ...ZERO, analystUsd: "0.010000000000000001" }).totalUsd, "0.010001");
});

test("ARCH-103: min price applied", () => {
  const q = quoteJob([{ model: NEMOTRON, promptTokens: 10, completionTokens: 1 }], prices, { ...ZERO, minPriceUsd: "0.01" });
  assert.equal(q.totalUsd, "0.010000");
  assert.equal(q.breakdown.minApplied, true);
});

test("ARCH-103: :free priced 0", () => {
  const q = quoteJob([{ model: "meta-llama/llama-3.3-70b-instruct:free", promptTokens: 999999, completionTokens: 99999 }], prices, { ...ZERO, perModelCallUsd: "0.002" });
  assert.equal(q.amount, "2000");
  assert.equal(q.breakdown.calls[0].usd, "0.000000");
});

test("ARCH-103: throws on missing usage", () => {
  assert.throws(() => quoteJob([{ model: NEMOTRON }], prices, ZERO), /no token usage/);
  assert.throws(() => quoteJob([{ model: NEMOTRON, promptTokens: 5 }], prices, ZERO), /no token usage/);
  assert.throws(() => quoteJob([{ model: NEMOTRON, promptTokens: -1, completionTokens: 0 }], prices, ZERO), /no token usage/);
});

test("ARCH-103: throws on unpriced model", () => {
  assert.throws(() => quoteJob([{ model: "openai/gpt-4o", promptTokens: 1, completionTokens: 1 }], prices, ZERO), /has no price/);
  assert.throws(() => quoteJob([{ model: "toString", promptTokens: 1, completionTokens: 1 }], Object.fromEntries(prices), ZERO), /has no price/);
  assert.throws(() => quoteJob([], prices, { ...ZERO, marginPct: "-5" }), /not a non-negative decimal/);
  assert.throws(() => quoteJob([], prices, { ...ZERO, minPriceUsd: "0" }), /total is 0/);
});

test("ARCH-103: zero model calls (user-typed SQL, phrase none) = fees only", () => {
  const q = quoteJob([], prices, { perModelCallUsd: "0.5", analystUsd: "0.003", nearGasUsd: "0.0005", marginPct: "10", minPriceUsd: "0.001" });
  assert.equal(q.totalUsd, "0.003850"); // (0.003 + 0.0005) × 1.1
  assert.deepEqual(q.breakdown.calls, []);
  assert.equal(q.breakdown.callFeesUsd, "0.000000");
});
