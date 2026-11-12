import { test } from "node:test";
import assert from "node:assert/strict";
import { costModelFrom, type CalibrationOptions, type CalibrationSample } from "../src/calibrate.ts";
import { parseCostModel, quoteOffer } from "../src/index.ts";
import type { Fees } from "../../crossask/src/cost.ts";

// 3.6 USD per hour = 0.000001 USD per ms, so each unit's USD is its worst ms per unit x 1e-6.
const OPT: CalibrationOptions = { computeUsdPerHour: "3.6", tokensPerByte: "bound", calibratedAt: "2026-11-12T02:00:00Z", machine: "unit", source: "unit test measurements" };
const MB = 1024 * 1024;
const SAMPLES: CalibrationSample[] = [
  { kind: "presidio", group: "scan|1kb", op: "scan", bytes: 1024, ms: 10 },
  { kind: "presidio", group: "scan|1kb", op: "scan", bytes: 1024, ms: 12 },
  { kind: "analyst", group: "smb|t1", bytes: MB, ms: 100 },
  { kind: "analyst", group: "smb|t1", bytes: MB, ms: 110 },
  { kind: "call", group: "smb|t1|query", promptBytes: 2048, promptChars: 2048, promptTokens: 600, ms: 400 },
  { kind: "call", group: "smb|t1|query", promptBytes: 2048, promptChars: 2048, promptTokens: 600, ms: 500 },
];

test("ARCH-635: each unit is the worst ms per unit seen x the compute price; safety is the widest run-to-run spread", () => {
  const { model, observed } = costModelFrom(SAMPLES, OPT);
  assert.deepEqual(model.units, { presidioPerKbUsd: "0.000012000000", analystPerMbUsd: "0.000110000000", gatewayPerKbPromptUsd: "0.000250000000" });
  assert.equal(model.safetyPct, "25", "500 / 400 - 1 on the model call beats 20 % (Presidio) and 10 % (analyst)");
  assert.deepEqual([observed.spreadGroup, observed.spreadMaxPct], ["call|smb|t1|query", "25.00"]);
  assert.deepEqual([model.tokensPerByte, model.bytesPerChar], ["1", "1"], "bound: 1, since 600 tokens <= 2048 bytes (V-P4)");
  assert.deepEqual([observed.tokensPerByteObservedMax, observed.callsWithUsage], ["0.2930", 2]);
  assert.deepEqual(observed.samples, { presidio: 2, analyst: 2, call: 2 });
  assert.deepEqual([model.version, model.calibratedAt, model.machine, model.source], [1, OPT.calibratedAt, "unit", "unit test measurements"]);
  assert.deepEqual(parseCostModel(JSON.parse(JSON.stringify(model))), model, "the written file reads back the same");
});

test("ARCH-635: rounding is UP, exact (no floating point), and a fractional ms counts as the next whole ms", () => {
  const s: CalibrationSample[] = [
    { kind: "presidio", group: "p", op: "mask", bytes: 3072, ms: 0.4 }, { kind: "presidio", group: "p", op: "mask", bytes: 3072, ms: 1 },
    { kind: "analyst", group: "a", bytes: 3 * MB, ms: 1 }, { kind: "analyst", group: "a", bytes: 3 * MB, ms: 1 },
    { kind: "call", group: "c", promptBytes: 3072, promptChars: 2048, promptTokens: 1000, ms: 1 },
  ];
  const { model } = costModelFrom(s, { ...OPT, computeUsdPerHour: "1" });
  // 1 ms per 3 KB = 1/3 ms per KB; / 3,600,000 = 9.2592...e-8, up to 12 decimals
  assert.equal(model.units.presidioPerKbUsd, "0.000000092593");
  assert.equal(model.units.analystPerMbUsd, "0.000000092593");
  assert.equal(model.bytesPerChar, "1.5000", "3072 bytes for 2048 UTF-16 units");
  assert.equal(model.safetyPct, "0", "0.4 ms counts as 1 ms: the two mask runs agree");
});

test("ARCH-635: tokensPerByte observed writes the worst ratio; bound refuses when a call breaks it (V-P4)", () => {
  const over: CalibrationSample[] = [...SAMPLES, { kind: "call", group: "tiny", promptBytes: 10, promptChars: 10, promptTokens: 13, ms: 5 }];
  assert.throws(() => costModelFrom(over, OPT), /V-P4 fails: a call used 1\.3000 prompt tokens per byte/);
  assert.equal(costModelFrom(over, { ...OPT, tokensPerByte: "observed" }).model.tokensPerByte, "1.3000");
  assert.equal(costModelFrom(SAMPLES, { ...OPT, tokensPerByte: "observed" }).model.tokensPerByte, "0.2930");
});

test("ARCH-635: nothing is invented: a missing measurement, a single run, no usage or no compute price stops calibration", () => {
  const without = (k: CalibrationSample["kind"]) => SAMPLES.filter((s) => s.kind !== k);
  assert.throws(() => costModelFrom(without("presidio"), OPT), /no Presidio measurement/);
  assert.throws(() => costModelFrom(without("analyst"), OPT), /no analyst measurement/);
  assert.throws(() => costModelFrom(without("call"), OPT), /no model call measured/);
  assert.throws(() => costModelFrom([SAMPLES[0], SAMPLES[2], SAMPLES[4]], OPT), /no work was measured twice \(run each at least 2 times, --runs 2 or more\)/);
  assert.throws(() => costModelFrom(SAMPLES.map((s) => (s.kind === "call" ? { ...s, promptTokens: null } : s)), OPT), /no model call reported its token usage/);
  assert.throws(() => costModelFrom(SAMPLES, { ...OPT, computeUsdPerHour: "0" }), /computeUsdPerHour must be above 0/);
  assert.throws(() => costModelFrom(SAMPLES, { ...OPT, computeUsdPerHour: "" }), /computeUsdPerHour/);
  assert.throws(() => costModelFrom([...SAMPLES, { kind: "analyst", group: "x", bytes: 0, ms: 1 }], OPT), /sample 7 \(analyst, x\) bytes must be a number of at least 1/);
  assert.throws(() => costModelFrom(SAMPLES, { ...OPT, calibratedAt: "yesterday" }), /calibratedAt must be an ISO time/);
});

test("ARCH-635 ARCH-634: a calibrated model prices an offer through quoteOffer (cents, firm)", () => {
  const { model } = costModelFrom(SAMPLES, OPT);
  const fees: Fees = { perModelCallUsd: "0.001", analystUsd: "0.002", nearGasUsd: "0.0005", marginPct: "20", minPriceUsd: "0.01" };
  const q = quoteOffer({ kind: "crossask", model: "nearai/m", phrase: "llm", userSql: false, totalBytes: 2 * MB, files: 3, maxPromptChars: 48000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50 },
    { "nearai/m": { inputPerM: "0.30", outputPerM: "1.20" } }, fees, model);
  assert.match(q.amount, /^\d+0000$/, "whole cents for AP2");
  assert.ok(Number(q.totalUsd) >= 0.01);
});
