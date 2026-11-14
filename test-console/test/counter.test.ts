/**
 * privateAI-design-43 ARCH-720/721: the counter-offer ladder (config/counter-ladder.json, as committed) and the pure walk,
 * priced with the REAL offer arithmetic (packages/offer quoteOffer) on the committed cost model, the conf fees
 * (config/paid-jobs-prices.conf) and NEAR AI deepseek-v4.1-flash's catalog price (0.30 / 1.20 USD per M tokens). The live
 * demo job (smb-fin-1, template 1: exact SQL, one NEAR AI answer call) is quoted 0.02 and counters to 0.01 by answer rows
 * 20 + tokens 1024 (design-43 F8), and the console's start-up settings refuse what one round cannot do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCostModel, quoteOffer, type CrossaskBasis } from "../../packages/offer/src/index.ts";
import { applyStep, ceilingMicro, counterConfig, fitCounter, microUsd, parseLadder, usdMicroCeil } from "../console/counter.ts";

const REPO = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, REPO), "utf8");
const cm = parseCostModel(JSON.parse(read("config/cost-model.json")));
const conf = Object.fromEntries(read("config/paid-jobs-prices.conf").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=") as [string, string]));
const fees = { perModelCallUsd: conf.FEE_PER_MODEL_CALL_USD, analystUsd: conf.FEE_ANALYST_USD, nearGasUsd: conf.NEAR_GAS_FEE_USD, marginPct: conf.MARGIN_PCT, minPriceUsd: conf.MIN_PRICE_USD };
const prices = { "nearai/deepseek-v4.1-flash": { inputPerM: 0.3, outputPerM: 1.2 }, "local/qwen2.5-3b": { inputPerM: 0, outputPerM: 0 } };
const price = async (b: CrossaskBasis) => quoteOffer(b, prices, fees, cm, "cent");
const LADDER = parseLadder(JSON.parse(read("config/counter-ladder.json")));
/** smb-fin-1 template 1 as the console estimates it (4 files, 5,395 bytes; the console's default limits). */
const A: CrossaskBasis = { kind: "crossask", model: "local/qwen2.5-3b", answerModel: "nearai/deepseek-v4.1-flash", phrase: "llm", userSql: true, totalBytes: 5395, files: 4, maxPromptChars: 40000, answerMaxPromptChars: 8000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50 };
const T02_ACCEPTS = new Set(["answerMaxRows", "phrase", "maxTokens"]);
const all = () => true;

test("ARCH-720: the committed ladder: answer rows 20 / 4,000 chars, then 1,024 and 512 tokens, then one SQL try", () => {
  assert.deepEqual(LADDER.steps, [
    { name: "answerMaxRows", set: { answerMaxRows: 20, answerMaxPromptChars: 4000 } },
    { name: "maxTokens", set: { maxTokens: 1024 } },
    { name: "maxTokens", set: { maxTokens: 512 } },
    { name: "sqlRetries", set: { sqlRetries: 0 } },
  ]);
});

test("ARCH-720: parseLadder refuses unknown steps and fields, values below a floor, a step that does not reduce, extra members", () => {
  const ok = { version: 1, steps: [{ name: "maxTokens", set: { maxTokens: 1024 } }] };
  assert.doesNotThrow(() => parseLadder(ok));
  for (const [raw, why] of [
    [{ ...ok, version: 2 }, /version must be 1/],
    [{ ...ok, extra: 1 }, /extra is not a ladder member/],
    [{ version: 1, steps: [] }, /1 to 20 steps/],
    [{ version: 1, steps: [{ name: "phrase", set: { phrase: 0 } }] }, /name must be one of answerMaxRows, maxTokens, sqlRetries/],
    [{ version: 1, steps: [{ name: "maxTokens", set: { answerMaxRows: 10 } }] }, /answerMaxRows is not a limit the step maxTokens may reduce/],
    [{ version: 1, steps: [{ name: "maxTokens", set: { maxTokens: 8 } }] }, /maxTokens must be a whole number of at least 16/],
    [{ version: 1, steps: [{ name: "maxTokens", set: { maxTokens: 512 } }, { name: "maxTokens", set: { maxTokens: 1024 } }] }, /must be lower than an earlier step's \(512\): each step only reduces/],
    [{ version: 1, steps: [{ name: "maxTokens", set: {} }] }, /must name at least one limit/],
    [{ version: 1, steps: [{ name: "maxTokens", set: { maxTokens: 512 }, why: "x" }] }, /why is not a step member/],
  ] as const) assert.throws(() => parseLadder(raw), why);
});

test("ARCH-720: a step changes only what the job uses, and never raises a limit", () => {
  assert.equal(applyStep({ ...A, phrase: "none" }, LADDER.steps[0]), null, "no answer call: answer limits change nothing");
  assert.equal(applyStep(A, LADDER.steps[3]), null, "the buyer's own SQL: no SQL tries to cut");
  assert.equal(applyStep({ ...A, maxTokens: 800 }, LADDER.steps[1]), null, "already below 1,024");
  assert.deepEqual(applyStep(A, LADDER.steps[0]), { ...A, answerMaxRows: 20, answerMaxPromptChars: 4000 });
});

test("ARCH-720 F8 (real prices): smb-fin-1 template 1 is 0.02 and t02's ceiling 0.01 fits at step 2: answer rows 20 + 1,024 tokens", async () => {
  assert.equal((await price(A)).totalUsd, "0.020000");
  const f = await fitCounter(A, LADDER, { maxPriceMicro: ceilingMicro("0.01"), accept: T02_ACCEPTS, price, allowed: all });
  assert.ok("fit" in f, JSON.stringify(f));
  assert.equal(f.fit.quote.totalUsd, "0.010000");
  assert.deepEqual(f.fit.reduced, ["answerMaxRows", "maxTokens"]);
  assert.deepEqual({ rows: f.fit.basis.answerMaxRows, chars: f.fit.basis.answerMaxPromptChars, tokens: f.fit.basis.maxTokens, sql: f.fit.basis.sqlRetries }, { rows: 20, chars: 4000, tokens: 1024, sql: 1 });
  // Still exactly one attested NEAR AI call: nothing about the route changed, only the job's size.
  assert.equal(f.fit.quote.breakdown.calls.length, 1);
});

test("ARCH-720: no fit -> the cheapest smaller price; steps the buyer does not accept are never tried; a basis the console may not sell is skipped", async () => {
  const below = await fitCounter(A, LADDER, { maxPriceMicro: ceilingMicro("0.005"), accept: T02_ACCEPTS, price, allowed: all });
  assert.deepEqual(below, { noFit: { cheapestUsd: "0.01", tried: 3 } }, "the minimum price is 0.01: a smaller job cannot go under it");
  const rowsOnly = await fitCounter(A, LADDER, { maxPriceMicro: ceilingMicro("0.01"), accept: new Set(["answerMaxRows"]), price, allowed: all });
  assert.deepEqual(rowsOnly, { noFit: { cheapestUsd: "0.02", tried: 1 } });
  const none = await fitCounter(A, LADDER, { maxPriceMicro: ceilingMicro("0.01"), accept: new Set(["route"]), price, allowed: all });
  assert.deepEqual(none, { noFit: { cheapestUsd: null, tried: 0 } });
  const priced: CrossaskBasis[] = [];
  const blocked = await fitCounter(A, LADDER, { maxPriceMicro: ceilingMicro("0.01"), accept: T02_ACCEPTS, price: (b) => { priced.push(b); return price(b); }, allowed: () => false });
  assert.deepEqual(blocked, { noFit: { cheapestUsd: null, tried: 0 } });
  assert.equal(priced.length, 0, "nothing the console may not sell is sent to the signer");
});

test("ARCH-720: money as micro-USD: a price is read up, a ceiling exactly", () => {
  assert.equal(usdMicroCeil("0.010000"), 10_000n);
  assert.equal(usdMicroCeil("0.0100001"), 10_001n);
  assert.equal(microUsd(10_000n), "0.01");
  assert.equal(ceilingMicro("0.01"), 10_000n);
  for (const bad of [undefined, 0.01, "0", "0.0000001", "-1", "1e-2"]) assert.throws(() => ceilingMicro(bad), /maxPriceUsd/);
});

test("ARCH-721: console settings: off by default; on needs estimate-first offers and a valid ladder; one round only", () => {
  const readText = (p: string) => readFileSync(new URL(p, REPO), "utf8");
  assert.equal(counterConfig({}, true, readText), undefined);
  assert.throws(() => counterConfig({ "counter-ladder": "config/counter-ladder.json" }, true, readText), /need --counter on/);
  assert.throws(() => counterConfig({ counter: "yes" }, true, readText), /--counter must be on or off/);
  assert.throws(() => counterConfig({ counter: "on" }, false, readText), /needs estimate-first offers/);
  assert.throws(() => counterConfig({ counter: "on", "counter-max-rounds": "2" }, true, readText), /must be 1 \(one round/);
  assert.throws(() => counterConfig({ counter: "on", "counter-ladder": "config/nope.json" }, true, readText), /needs the ladder config\/nope.json/);
  assert.throws(() => counterConfig({ counter: "on" }, true, () => '{"version":1,"steps":[{"name":"maxTokens","set":{"maxTokens":4}}]}'), /is not valid: .*at least 16/);
  const c = counterConfig({ counter: "on" }, true, readText);
  assert.equal(c?.maxRounds, 1);
  assert.equal(c?.ladder.steps.length, 4);
});
