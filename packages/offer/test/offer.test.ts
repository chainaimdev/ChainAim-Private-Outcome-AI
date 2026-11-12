import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBasis, parseCostModel, quoteOffer, worstCase, type CostModel } from "../src/index.ts";
import { quoteJob, type Fees } from "../../crossask/src/cost.ts";

const CM_RAW = {
  version: 1, calibratedAt: "2026-11-12T00:00:00Z", machine: "test", source: "unit test values, not a calibration",
  tokensPerByte: "1", bytesPerChar: "1.25", units: { presidioPerKbUsd: "0.0001", analystPerMbUsd: "0.002", gatewayPerKbPromptUsd: "0.00005" }, safetyPct: "20",
};
const CM: CostModel = parseCostModel(CM_RAW);
const MODEL = "nearai/deepseek-v4.1-flash";
const PRICES = { [MODEL]: { inputPerM: "0.30", outputPerM: "1.20" } };
const FEES: Fees = { perModelCallUsd: "0.001", analystUsd: "0", nearGasUsd: "0.0005", marginPct: "20", minPriceUsd: "0.01" };

test("ARCH-634: the cost model is required field by field; nothing is defaulted", () => {
  assert.equal(CM.safetyPct, "20");
  for (const [f, re] of [["version", /version must be 1/], ["machine", /machine/], ["tokensPerByte", /tokensPerByte/], ["safetyPct", /safetyPct/]] as const) {
    assert.throws(() => parseCostModel({ ...CM_RAW, [f]: undefined }), re, f);
  }
  assert.throws(() => parseCostModel({ ...CM_RAW, units: { ...CM_RAW.units, presidioPerKbUsd: "-1" } }), /presidioPerKbUsd/);
  assert.throws(() => parseCostModel({ ...CM_RAW, bytesPerChar: "0.5" }), /bytesPerChar at least 1/);
  assert.throws(() => parseCostModel(null), /JSON object/);
});

test("ARCH-634: scan and mask make no model call: Presidio per KB with the safety margin only (owner D2)", () => {
  const w = worstCase({ kind: "mask", textBytes: 2048 }, CM);
  assert.deepEqual(w.meter, []);
  assert.deepEqual(w.extras, [{ name: "presidio", usd: "0.000240000000" }]); // 0.0001 x 2 KB x 1.2
  const q = quoteOffer({ kind: "scan", textBytes: 2048 }, PRICES, FEES, CM);
  assert.equal(q.amount, "10000", "below the minimum: one cent");
  assert.deepEqual(q.breakdown.calls, []);
});

test("ARCH-634: chat is priced at its whole prompt and full max_tokens on the chosen model, plus Presidio and gateway time", () => {
  const b = { kind: "chat" as const, model: MODEL, promptBytes: 4000, maxTokens: 1000 };
  const w = worstCase(b, CM);
  assert.deepEqual(w.meter, [{ model: MODEL, promptTokens: 4000, completionTokens: 1000 }]);
  const q = quoteOffer(b, PRICES, FEES, CM);
  assert.deepEqual(q, quoteJob(w.meter, PRICES, FEES, { round: "cent", extras: w.extras }), "an offer is quoteJob on the worst-case meter");
  assert.equal(BigInt(q.amount) % 10_000n, 0n, "whole cents (AP2)");
});

test("ARCH-634: crossask counts 1 + retries query calls and the answer call, each at maxPromptChars x bytesPerChar and max_tokens", () => {
  const b = { kind: "crossask" as const, model: MODEL, phrase: "llm" as const, userSql: false, totalBytes: 3 * 1024 * 1024, files: 4, maxPromptChars: 8000, maxTokens: 512, sqlRetries: 1, answerMaxRows: 50 };
  const w = worstCase(b, CM);
  assert.equal(w.meter.length, 3);
  assert.deepEqual(w.meter[0], { model: MODEL, promptTokens: 10000, completionTokens: 512 });
  assert.deepEqual(w.extras[0], { name: "analyst", usd: "0.007200000000" }); // 0.002 x 3 MB x 1.2
  assert.equal(worstCase({ ...b, userSql: true, phrase: "none" }, CM).meter.length, 0, "own SQL, no worded answer: no model call");
  assert.equal(worstCase({ ...b, answerModel: "bedrock/nemotron-nano-3-30b" }, CM).meter[2].model, "bedrock/nemotron-nano-3-30b");
  assert.ok(BigInt(quoteOffer({ ...b, sqlRetries: 3 }, PRICES, FEES, CM).amount) >= BigInt(quoteOffer(b, PRICES, FEES, CM).amount), "more retries never costs less");
});

test("ARCH-634: a bad basis is refused naming the field (sizes come over the wire)", () => {
  assert.throws(() => checkBasis({ kind: "scan", textBytes: 0 }), /textBytes/);
  assert.throws(() => checkBasis({ kind: "chat", model: "x", promptBytes: 1, maxTokens: 1 }), /provider\/name/);
  assert.throws(() => checkBasis({ kind: "chat", model: MODEL, promptBytes: 1.5, maxTokens: 1 }), /promptBytes/);
  assert.throws(() => checkBasis({ kind: "nope" } as never), /kind must be one of/);
  assert.throws(() => quoteOffer({ kind: "chat", model: "openai/unpriced", promptBytes: 10, maxTokens: 10 }, PRICES, FEES, CM), /has no price/);
});
