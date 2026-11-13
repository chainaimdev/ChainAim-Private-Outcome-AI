/**
 * privateAI-design-38 signed limits: the shared helpers the signer, the console, the agent and verify-receipt use.
 * Pure functions on real values; no stand-ins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attestationAtLeast, limitsEqualBasis, limitsOf, parseLimits, pricedCalls, servedWithinLimits, withinLimits, worstCase, parseCostModel, type CrossaskBasis } from "../src/index.ts";

const MODEL = "nearai/deepseek-v4.1-flash";
const LOCAL = "local/qwen3-8b";
const BASIS: CrossaskBasis = { kind: "crossask", model: MODEL, answerModel: LOCAL, phrase: "llm", userSql: false, totalBytes: 2_054_495, files: 3, maxPromptChars: 16_000, answerMaxPromptChars: 8_000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50 };
const CM = parseCostModel({ version: 1, calibratedAt: "2026-11-12T00:00:00Z", machine: "test", source: "unit test values", tokensPerByte: "1", bytesPerChar: "1.25", units: { presidioPerKbUsd: "0.0001", analystPerMbUsd: "0.002", gatewayPerKbPromptUsd: "0.00005" }, safetyPct: "20" });

test("ARCH-680: limits are the priced basis + modelCalls (the priced meter's length) + the size tolerance", () => {
  const l = limitsOf(BASIS, 5);
  assert.deepEqual(l, { model: MODEL, answerModel: LOCAL, phrase: "llm", userSql: false, files: 3, totalBytes: 2_054_495, sizeTolerancePct: 5, maxPromptChars: 16_000, answerMaxPromptChars: 8_000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50, modelCalls: 3 });
  for (const b of [BASIS, { ...BASIS, userSql: true }, { ...BASIS, phrase: "none" as const }, { ...BASIS, userSql: true, phrase: "none" as const }, { ...BASIS, sqlRetries: 3 }]) {
    assert.equal(pricedCalls(b), worstCase(b, CM).meter.length, "modelCalls is exactly what was priced");
  }
  const { answerModel: _a, ...noAnswer } = BASIS;
  assert.equal(limitsOf(noAnswer, 0).answerModel, MODEL, "no answer model: the query model answers");
  assert.throws(() => limitsOf(BASIS, 101), /sizeTolerancePct must be a whole number from 0 to 100/);
});

test("ARCH-681: parseLimits takes exactly the 13 members with their types, naming the member", () => {
  const l = limitsOf(BASIS, 5);
  assert.deepEqual(parseLimits(JSON.parse(JSON.stringify(l))), l);
  assert.throws(() => parseLimits({ ...l, question: "x" }), /limits\.question is not a limit/);
  assert.throws(() => parseLimits({ ...l, model: "gpt" }), /limits\.model must be a model id/);
  assert.throws(() => parseLimits({ ...l, phrase: "long" }), /limits\.phrase must be llm or none/);
  assert.throws(() => parseLimits({ ...l, userSql: "yes" }), /limits\.userSql must be true or false/);
  assert.throws(() => parseLimits({ ...l, maxTokens: 1.5 }), /limits\.maxTokens must be a whole number/);
  const { modelCalls: _m, ...missing } = l;
  assert.throws(() => parseLimits(missing), /limits\.modelCalls must be a whole number/);
});

test("ARCH-682: the held basis must equal the signed limits, member by member", () => {
  const l = limitsOf(BASIS, 5);
  assert.equal(limitsEqualBasis(l, BASIS), null);
  assert.equal(limitsEqualBasis(l, { ...BASIS, maxTokens: 4096 }), "maxTokens");
  assert.equal(limitsEqualBasis(l, { ...BASIS, model: "nearai/glm-5" }), "model");
  assert.equal(limitsEqualBasis(l, { ...BASIS, sqlRetries: 2 }), "sqlRetries");
});

test("ARCH-682: the folder may grow by the signed tolerance only, never gain files", () => {
  const l = { files: 3, totalBytes: 1000, sizeTolerancePct: 10 };
  assert.equal(withinLimits(l, { files: 3, totalBytes: 1100 }), null);
  assert.equal(withinLimits(l, { files: 2, totalBytes: 10 }), null);
  assert.match(withinLimits(l, { files: 3, totalBytes: 1101 })!, /holds 1101 bytes now, more than the 1000 estimated \(\+10 %\): estimate it again/);
  assert.match(withinLimits(l, { files: 4, totalBytes: 10 })!, /has 4 data files now, 3 when it was estimated/);
});

test("ARCH-682: after the run: no extra call, no model outside the limits, no call over maxTokens", () => {
  const l = limitsOf(BASIS, 5);
  const ok = [{ model: MODEL, completionTokens: 40 }, { model: MODEL, completionTokens: 2048 }, { model: LOCAL, completionTokens: 10 }];
  assert.equal(servedWithinLimits(l, ok), null);
  assert.match(servedWithinLimits(l, [...ok, { model: MODEL, completionTokens: 1 }])!, /made 4 model calls, more than the 3 estimated/);
  assert.match(servedWithinLimits(l, [{ model: "nearai/glm-5", completionTokens: 1 }])!, /served by nearai\/glm-5, not a model you signed for/);
  assert.match(servedWithinLimits(l, [{ completionTokens: 1 }])!, /served by an unnamed model/);
  assert.match(servedWithinLimits(l, [{ model: MODEL, completionTokens: 2049 }])!, /2049 completion tokens, more than the 2048 signed/);
});

test("ARCH-688: the console's attestation mode is signed with the limits when given; off < evidence < verified", () => {
  assert.equal("attestation" in limitsOf(BASIS, 5), false, "not given: not in the limits (as before v2.1.0)");
  const v = limitsOf(BASIS, 5, "verified");
  assert.equal(v.attestation, "verified");
  assert.deepEqual(parseLimits(JSON.parse(JSON.stringify(v))), v);
  assert.equal(limitsEqualBasis(v, BASIS), null, "the mode is not part of the priced basis");
  assert.throws(() => parseLimits({ ...v, attestation: "maybe" }), /limits\.attestation must be off, evidence, verified/);
  assert.throws(() => limitsOf(BASIS, 5, "always" as never), /attestation must be off, evidence, verified/);
  assert.deepEqual([attestationAtLeast("verified", "verified"), attestationAtLeast("evidence", "verified"), attestationAtLeast(undefined, "evidence"), attestationAtLeast(undefined, "off"), attestationAtLeast("evidence", "off")], [true, false, false, true, true]);
});
