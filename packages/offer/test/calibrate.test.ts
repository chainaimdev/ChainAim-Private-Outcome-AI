import { test } from "node:test";
import assert from "node:assert/strict";
import { analystLine, costModelFrom, type CalibrationOptions, type CalibrationSample } from "../src/calibrate.ts";
import { parseCostModel, quoteOffer } from "../src/index.ts";
import type { Fees } from "../../crossask/src/cost.ts";

// 3.6 USD per hour = 0.000001 USD per ms, so each unit's USD is its worst ms per unit x 1e-6.
const OPT: CalibrationOptions = { computeUsdPerHour: "3.6", tokensPerByte: "bound", calibratedAt: "2026-11-12T02:00:00Z", machine: "unit", source: "unit test measurements" };
const MB = 1024 * 1024;
const SAMPLES: CalibrationSample[] = [
  { kind: "presidio", group: "scan|1kb", op: "scan", bytes: 1024, ms: 10 },
  { kind: "presidio", group: "scan|1kb", op: "scan", bytes: 1024, ms: 12 },
  { kind: "analyst", group: "smb|t1", bytes: 64 * 1024, ms: 100 },
  { kind: "analyst", group: "smb|t1", bytes: 64 * 1024, ms: 110 },
  { kind: "analyst", group: "erp|t1", bytes: MB, ms: 200 },
  { kind: "analyst", group: "erp|t1", bytes: MB, ms: 210 },
  { kind: "call", group: "smb|t1|query", promptBytes: 2048, promptChars: 2048, promptTokens: 600, ms: 400 },
  { kind: "call", group: "smb|t1|query", promptBytes: 2048, promptChars: 2048, promptTokens: 600, ms: 500 },
  { kind: "call", group: "smb|t1|answer", promptBytes: 512, promptChars: 512, promptTokens: 100, ms: 300 },
];

test("ARCH-635: each unit is the worst ms per unit seen x the compute price; safety is the widest run-to-run spread", () => {
  const { model, observed } = costModelFrom(SAMPLES, OPT);
  // analyst (ARCH-635b): points 64 KB -> 110 ms, 1 MB -> 210 ms; the line through both: 100 ms per 960 KB
  // = 106.67 ms/MB, base 110 - 106.67/16 = 103.33 ms; at 1e-6 USD/ms, rounded up
  // model call (ARCH-635c): points 512 B -> 300 ms, 2048 B -> 500 ms: 200 ms per 1.5 KB = 133.33 ms/KB, base 233.33 ms
  assert.deepEqual(model.units, { presidioPerKbUsd: "0.000012000000", analystBaseUsd: "0.000103333334", analystPerMbUsd: "0.000106666667", gatewayBaseUsd: "0.000233333334", gatewayPerKbPromptUsd: "0.000133333334" });
  assert.equal(model.safetyPct, "25", "500 / 400 - 1 on the model call beats 20 % (Presidio) and 10 % / 5 % (analyst)");
  assert.deepEqual([observed.spreadGroup, observed.spreadMaxPct], ["call|smb|t1|query", "25.00"]);
  assert.deepEqual([model.tokensPerByte, model.bytesPerChar], ["1", "1"], "bound: 1, since 600 tokens <= 2048 bytes (V-P4)");
  assert.deepEqual([observed.tokensPerByteObservedMax, observed.callsWithUsage], ["0.2930", 3]);
  assert.deepEqual(observed.samples, { presidio: 2, analyst: 4, call: 3 });
  assert.deepEqual(observed.gatewayPromptBytes, [512, 2048]);
  assert.deepEqual(observed.analystSizes, [64 * 1024, MB]);
  assert.deepEqual([model.version, model.calibratedAt, model.machine, model.source], [2, OPT.calibratedAt, "unit", "unit test measurements"]);
  assert.deepEqual(parseCostModel(JSON.parse(JSON.stringify(model))), model, "the written file reads back the same");
});

test("ARCH-635: rounding is UP, exact (no floating point), and a fractional ms counts as the next whole ms", () => {
  const s: CalibrationSample[] = [
    { kind: "presidio", group: "p", op: "mask", bytes: 3072, ms: 0.4 }, { kind: "presidio", group: "p", op: "mask", bytes: 3072, ms: 1 },
    { kind: "analyst", group: "a", bytes: 64 * 1024, ms: 1 }, { kind: "analyst", group: "b", bytes: 3 * MB, ms: 1 },
    { kind: "call", group: "c", promptBytes: 3072, promptChars: 2048, promptTokens: 1000, ms: 1 },
    { kind: "call", group: "d", promptBytes: 768, promptChars: 512, promptTokens: 100, ms: 1 },
  ];
  const { model } = costModelFrom(s, { ...OPT, computeUsdPerHour: "1" });
  // 1 ms per 3 KB = 1/3 ms per KB; / 3,600,000 = 9.2592...e-8, up to 12 decimals
  assert.equal(model.units.presidioPerKbUsd, "0.000000092593");
  // the 3 MB folder takes no longer than the 64 KB one: a flat line, 1 ms a run; 1 / 3,600,000 up to 12 decimals
  assert.deepEqual([model.units.analystBaseUsd, model.units.analystPerMbUsd], ["0.000000277778", "0.000000000000"]);
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
  assert.throws(() => costModelFrom([SAMPLES[0], SAMPLES[2], SAMPLES[4], SAMPLES[6], SAMPLES[8]], OPT), /no work was measured twice \(run each at least 2 times, --runs 2 or more\)/);
  assert.throws(() => costModelFrom(SAMPLES.map((s) => (s.kind === "call" ? { ...s, promptTokens: null } : s)), OPT), /no model call reported its token usage/);
  assert.throws(() => costModelFrom(SAMPLES, { ...OPT, computeUsdPerHour: "0" }), /computeUsdPerHour must be above 0/);
  assert.throws(() => costModelFrom(SAMPLES, { ...OPT, computeUsdPerHour: "" }), /computeUsdPerHour/);
  assert.throws(() => costModelFrom([...SAMPLES, { kind: "analyst", group: "x", bytes: 0, ms: 1 }], OPT), /sample 10 \(analyst, x\) bytes must be a number of at least 1/);
  assert.throws(() => costModelFrom(SAMPLES, { ...OPT, calibratedAt: "yesterday" }), /calibratedAt must be an ISO time/);
});

test("ARCH-635b: the analyst line lies on or above every size's slowest run, and needs 2+ sizes far enough apart", () => {
  // the owner's 2026-11-12 runs: smb-fin-1 (5,395 B) about 0.5-0.65 s, and an ERPNext bundle (2,054,495 B) of about 7 s
  const owner = [
    { bytes: 5395, ms: 527 }, { bytes: 5395, ms: 648 }, { bytes: 5395, ms: 581 },
    { bytes: 2054495, ms: 6900 }, { bytes: 2054495, ms: 7100 },
  ];
  const { base, slope, sizes } = analystLine(owner, 16);
  assert.deepEqual(sizes, [5395, 2054495]);
  const at = (x: number) => Number(base.a) / Number(base.b) + (Number(slope.a) * x) / Number(slope.b);
  for (const p of owner) assert.ok(at(p.bytes) >= p.ms - 1e-9, `the line is below ${p.ms} ms at ${p.bytes} B`);
  // per byte, not per tiny folder: the old per-MB-only rate was 648 ms / 5,395 B = 125,945 ms/MB, about 252 s for Orion
  assert.ok(at(2054495) < 7200, "Orion priced near its measured 7.1 s, not minutes");
  assert.ok(at(5395) < 700, "smb-fin-1 priced near its measured 0.65 s");
  assert.throws(() => analystLine(owner.slice(0, 3), 16), /the analyst was measured on one size only \(5395 bytes\)/);
  assert.throws(() => analystLine([{ bytes: 100_000, ms: 50 }, { bytes: 200_000, ms: 90 }], 16), /differ by less than 16x/);
  assert.equal(analystLine([{ bytes: 100_000, ms: 50 }, { bytes: 200_000, ms: 90 }], 2).sizes.length, 2, "the ratio is the caller's");
  // a larger folder that ran faster gives a flat line at the slowest run, never a negative slope
  const flat = analystLine([{ bytes: 1000, ms: 80 }, { bytes: 1_000_000, ms: 60 }], 16);
  assert.deepEqual([flat.slope.a, Number(flat.base.a) / Number(flat.base.b)], [0n, 80]);
  assert.throws(() => costModelFrom(SAMPLES.filter((s) => s.kind !== "analyst" || s.bytes === MB), OPT), /the analyst was measured on one size only/);
  // ARCH-635c: the same rule for the model call, over its prompt sizes (default ratio 4)
  assert.throws(() => costModelFrom(SAMPLES.filter((s) => s.kind !== "call" || s.promptBytes === 2048), OPT), /the model call was measured on one size only \(2048 bytes\)/);
  assert.throws(() => costModelFrom(SAMPLES, { ...OPT, gatewaySizeRatio: 5 }), /the model call's measured sizes \(512 to 2048 bytes\) differ by less than 5x/);
});

test("ARCH-635b: a version 1 cost model still reads (analyst base 0), and a version 2 one prices the base as its own line", () => {
  const { model } = costModelFrom(SAMPLES, OPT);
  const v1 = parseCostModel({ ...JSON.parse(JSON.stringify(model)), version: 1, units: { ...model.units, analystBaseUsd: undefined } });
  assert.deepEqual([v1.units.analystBaseUsd, v1.units.gatewayBaseUsd], ["0", "0"]);
  assert.throws(() => parseCostModel({ ...JSON.parse(JSON.stringify(model)), units: { ...model.units, gatewayBaseUsd: undefined } }), /gatewayBaseUsd/);
  assert.throws(() => parseCostModel({ ...JSON.parse(JSON.stringify(model)), units: { ...model.units, analystBaseUsd: undefined } }), /analystBaseUsd/);
  assert.throws(() => parseCostModel({ ...JSON.parse(JSON.stringify(model)), version: 3 }), /version must be 1 or 2/);
});

test("ARCH-635 ARCH-634: a calibrated model prices an offer through quoteOffer (cents, firm)", () => {
  const { model } = costModelFrom(SAMPLES, OPT);
  const fees: Fees = { perModelCallUsd: "0.001", analystUsd: "0.002", nearGasUsd: "0.0005", marginPct: "20", minPriceUsd: "0.01" };
  const q = quoteOffer({ kind: "crossask", model: "nearai/m", phrase: "llm", userSql: false, totalBytes: 2 * MB, files: 3, maxPromptChars: 48000, answerMaxPromptChars: 8000, maxTokens: 2048, sqlRetries: 1, answerMaxRows: 50 },
    { "nearai/m": { inputPerM: "0.30", outputPerM: "1.20" } }, fees, model);
  assert.match(q.amount, /^\d+0000$/, "whole cents for AP2");
  assert.ok(Number(q.totalUsd) >= 0.01);
});
