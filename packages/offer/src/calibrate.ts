/**
 * Calibration (privateAI-design-34 ARCH-635 = design-32 ARCH-602..604): the cost model from real measurements on this
 * machine, never from invented numbers. Pure: the runner (scripts/calibrate.ts) takes the measurements through the
 * running console API; this file only turns them into config/cost-model.json.
 *
 * Units (design-32 §3.2):
 *   presidioPerKbUsd       max over the timed /gateway/scan and /gateway/mask calls of ms per KB of text
 *   analystBaseUsd +       (ARCH-635b) the analyst as a line over the dataset size: a fixed time per run (start-up, file
 *   analystPerMbUsd        scan) plus a time per MB. Each measured size's slowest run (relationsMs + sqlMs) is a point;
 *                          the line lies on or above every point, and of those lines the one closest to them overall
 *                          (least total excess) is kept. Needs 2+ sizes, the largest at least analystSizeRatio x the
 *                          smallest (default 16), so the per-MB part is not read from one tiny folder: on a few KB
 *                          the fixed part is the whole run, and dividing it by the size overprices a large folder.
 *   gatewayBaseUsd +       (ARCH-635c) the model call the same way, over the prompt size: a fixed time per call (the
 *   gatewayPerKbPromptUsd  round trip, the model's reply) plus a time per KB of prompt sent; each prompt size's slowest
 *                          call is a point. Needs 2+ prompt sizes, the largest at least gatewaySizeRatio x the smallest
 *                          (default 4); the large datasets' query prompts (their schema) give the large sizes.
 * each converted with the operator's compute price (USD per hour), rounded UP to 12 decimals. The max ratio is the worst
 * case seen: an offer is firm, so a slow run must still be covered.
 *   safetyPct      the largest run-to-run spread seen for the same work (same group: max / min - 1), in whole percent UP:
 *                  a run as much slower again as the worst spread observed is still covered. Needs 2+ runs per group.
 *   bytesPerChar   max UTF-8 bytes per UTF-16 unit over the prompts sent (crossask's maxPromptChars counts UTF-16 units)
 *   tokensPerByte  "bound" (default, design-32 --tokens-per-byte 1): 1, valid only when every observed call has
 *                  promptTokens <= promptBytes (V-P4); "observed": the largest ratio seen, rounded UP to 4 decimals.
 * The observations behind each number go into the file's "observed" block (sizes, ms and counts only, never data).
 */
import { parseDecimal } from "../../crossask/src/cost.ts";
import { parseCostModel, type CostModel } from "./index.ts";

export type CalibrationSample =
  | { kind: "presidio"; group: string; op: "scan" | "mask"; bytes: number; ms: number }
  | { kind: "analyst"; group: string; bytes: number; ms: number }
  | { kind: "call"; group: string; promptBytes: number; promptChars: number; promptTokens: number | null; ms: number };

export type CalibrationOptions = {
  /** The operator's compute price in USD per hour, a decimal string (no default: an owner number). */
  computeUsdPerHour: string;
  tokensPerByte: "bound" | "observed";
  calibratedAt: string;
  machine: string;
  source: string;
  /** The largest analyst dataset size must be at least this many times the smallest (default 16). */
  analystSizeRatio?: number;
  /** The largest prompt size must be at least this many times the smallest (default 4). */
  gatewaySizeRatio?: number;
};

export type CalibrationObserved = {
  samples: { presidio: number; analyst: number; call: number };
  presidioMsPerKbMax: string; analystBaseMs: string; analystMsPerMb: string; analystSizes: number[]; gatewayBaseMs: string; gatewayMsPerKb: string; gatewayPromptBytes: [number, number];
  spreadMaxPct: string; spreadGroup: string;
  tokensPerByteObservedMax: string | null; callsWithUsage: number;
  bytesPerCharObservedMax: string;
};

const SC = 12n;
/** A rational a/b as an exact decimal string rounded UP to `scale` decimals. */
function upDec(a: bigint, b: bigint, scale = SC): string {
  const p = 10n ** scale;
  const t = ((a * p + b - 1n) / b).toString().padStart(Number(scale) + 1, "0");
  return `${t.slice(0, -Number(scale))}.${t.slice(-Number(scale))}`;
}
type Ratio = { a: bigint; b: bigint };
const gt = (x: Ratio, y: Ratio) => x.a * y.b > y.a * x.b;
const maxRatio = (rs: Ratio[]): Ratio => rs.reduce((m, r) => (gt(r, m) ? r : m));

const whole = (n: unknown, what: string, min: number): bigint => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < min) throw new Error(`${what} must be a number of at least ${min}`);
  return BigInt(Math.ceil(n));
};

function check(s: CalibrationSample, i: number): void {
  const at = `sample ${i + 1} (${s.kind}${s.group ? `, ${s.group}` : ""})`;
  if (typeof s.group !== "string" || !s.group) throw new Error(`${at}: group is required`);
  whole(s.ms, `${at} ms`, 0);
  if (s.kind === "call") {
    whole(s.promptBytes, `${at} promptBytes`, 1); whole(s.promptChars, `${at} promptChars`, 1);
    if (s.promptTokens !== null) whole(s.promptTokens, `${at} promptTokens`, 1);
  } else whole(s.bytes, `${at} bytes`, 1);
}

/**
 * The cost model from the measurements. Throws, naming what is missing, when a unit has no measurement, when no group was
 * run twice (no spread), when no call reported token usage, or when tokensPerByte "bound" does not hold (V-P4).
 */
export function costModelFrom(samples: readonly CalibrationSample[], o: CalibrationOptions): { model: CostModel; observed: CalibrationObserved } {
  samples.forEach(check);
  const cuh = parseDecimal(o.computeUsdPerHour, "computeUsdPerHour");
  if (cuh.n <= 0n) throw new Error("computeUsdPerHour must be above 0");
  if (o.tokensPerByte !== "bound" && o.tokensPerByte !== "observed") throw new Error("tokensPerByte must be bound or observed");
  const pres = samples.filter((s) => s.kind === "presidio"), ana = samples.filter((s) => s.kind === "analyst"), calls = samples.filter((s) => s.kind === "call");
  if (!pres.length) throw new Error("no Presidio measurement (scan or mask): presidioPerKbUsd cannot be calibrated");
  if (!ana.length) throw new Error("no analyst measurement (a crossask run): analystPerMbUsd cannot be calibrated");
  if (!calls.length) throw new Error("no model call measured (a crossask run with a model): gatewayPerKbPromptUsd cannot be calibrated");

  // ms per unit as ratios: ms x unit / bytes
  const KB = 1024n, MB = 1024n * 1024n;
  const rate = (s: CalibrationSample): Ratio => {
    const ms = BigInt(Math.ceil(s.ms));
    return s.kind === "presidio" ? { a: ms * KB, b: BigInt(s.bytes) } : s.kind === "analyst" ? { a: ms * MB, b: BigInt(s.bytes) } : { a: ms * KB, b: BigInt(s.promptBytes) };
  };
  const presMax = maxRatio(pres.map(rate));
  const fit = analystLine(ana, o.analystSizeRatio ?? 16);
  const gw = gatewayLine(calls, o.gatewaySizeRatio ?? 4);
  // USD per unit = ms per unit x computeUsdPerHour / 3,600,000 ms
  const usd = (r: Ratio) => upDec(r.a * cuh.n, r.b * 3_600_000n * 10n ** BigInt(cuh.scale));

  // spread per group of the same work: the per-unit rate's max / min
  const groups = new Map<string, Ratio[]>();
  for (const s of samples) { const k = `${s.kind}|${s.group}`; groups.set(k, [...(groups.get(k) ?? []), rate(s)]); }
  let spread: Ratio | null = null, spreadGroup = "";
  for (const [k, rs] of groups) {
    if (rs.length < 2) continue;
    const hi = maxRatio(rs), lo = rs.reduce((m, r) => (gt(m, r) ? r : m));
    if (lo.a === 0n) continue; // a 0 ms run has no ratio to compare with
    const s = { a: hi.a * lo.b - lo.a * hi.b, b: lo.a * hi.b }; // hi/lo - 1
    if (!spread || gt(s, spread)) { spread = s; spreadGroup = k; }
  }
  if (!spread) throw new Error("no work was measured twice (run each at least 2 times, --runs 2 or more): safetyPct comes from the run-to-run spread");
  const safetyPct = ((spread.a * 100n + spread.b - 1n) / spread.b).toString();

  // bytes per UTF-16 unit, at least 1
  const bpc = maxRatio(calls.map((s) => ({ a: BigInt(s.promptBytes), b: BigInt(s.promptChars) })));
  const bytesPerChar = bpc.a <= bpc.b ? "1" : upDec(bpc.a, bpc.b, 4n);

  // tokens per byte: V-P4
  const withUsage = calls.filter((s) => s.promptTokens !== null);
  if (!withUsage.length) throw new Error("no model call reported its token usage (served[].usage): tokensPerByte cannot be checked (V-P4); pick a model whose provider reports usage");
  const tpb = maxRatio(withUsage.map((s) => ({ a: BigInt(s.promptTokens as number), b: BigInt(s.promptBytes) })));
  const tpbObserved = upDec(tpb.a, tpb.b, 4n);
  let tokensPerByte: string;
  if (o.tokensPerByte === "bound") {
    if (tpb.a > tpb.b) throw new Error(`V-P4 fails: a call used ${tpbObserved} prompt tokens per byte, more than 1, so the byte bound does not hold for this model; use --tokens-per-byte observed or another model`);
    tokensPerByte = "1";
  } else tokensPerByte = tpbObserved;

  const model = parseCostModel({
    version: 2, calibratedAt: o.calibratedAt, machine: o.machine, source: o.source, tokensPerByte, bytesPerChar,
    units: { presidioPerKbUsd: usd(presMax), analystBaseUsd: usd(fit.base), analystPerMbUsd: usd({ a: fit.slope.a * MB, b: fit.slope.b }), gatewayBaseUsd: usd(gw.base), gatewayPerKbPromptUsd: usd({ a: gw.slope.a * KB, b: gw.slope.b }) }, safetyPct,
  });
  const msDec = (r: Ratio) => upDec(r.a, r.b, 3n);
  return {
    model,
    observed: {
      samples: { presidio: pres.length, analyst: ana.length, call: calls.length },
      presidioMsPerKbMax: msDec(presMax), analystBaseMs: msDec(fit.base), analystMsPerMb: msDec({ a: fit.slope.a * MB, b: fit.slope.b }), analystSizes: fit.sizes,
      gatewayBaseMs: msDec(gw.base), gatewayMsPerKb: msDec({ a: gw.slope.a * KB, b: gw.slope.b }), gatewayPromptBytes: [gw.sizes[0], gw.sizes.at(-1)!],
      spreadMaxPct: upDec(spread.a * 100n, spread.b, 2n), spreadGroup,
      tokensPerByteObservedMax: tpbObserved, callsWithUsage: withUsage.length,
      bytesPerCharObservedMax: upDec(bpc.a, bpc.b, 4n),
    },
  };
}

type Line = { base: Ratio; slope: Ratio; sizes: number[] };

/**
 * ARCH-635b/c: the line base + slope x size (ms, ms per byte, exact ratios) over each size's slowest run. Candidates: slope 0
 * and the slope between every two sizes (rising only), ascending; for each the base is the least that keeps the line on or
 * above every point (never below 0). Kept: the candidate with the least total excess over the points (a tie keeps the
 * smaller slope). Throws when fewer than 2 sizes were measured or the largest is under sizeRatio x the smallest.
 */
export function supportingLine(runs: readonly { bytes: number; ms: number }[], sizeRatio: number, what: string, more: string): Line {
  if (!Number.isInteger(sizeRatio) || sizeRatio < 2) throw new Error(`the ${what} size ratio must be a whole number of at least 2`);
  const worst = new Map<number, bigint>();
  for (const s of runs) { const ms = BigInt(Math.ceil(s.ms)); if (!worst.has(s.bytes) || ms > worst.get(s.bytes)!) worst.set(s.bytes, ms); }
  const pts = [...worst].map(([x, y]) => ({ x: BigInt(x), y })).sort((p, q) => (p.x < q.x ? -1 : 1));
  const sizes = pts.map((p) => Number(p.x));
  if (pts.length < 2) throw new Error(`the ${what} was measured on one size only (${sizes[0]} bytes): its time per byte cannot be told from its fixed time; ${more}`);
  const lo = pts[0].x, hi = pts.at(-1)!.x;
  if (hi < lo * BigInt(sizeRatio)) throw new Error(`the ${what}'s measured sizes (${lo} to ${hi} bytes) differ by less than ${sizeRatio}x: ${more}`);
  const slopes: Ratio[] = [{ a: 0n, b: 1n }];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (pts[j].y > pts[i].y) slopes.push({ a: pts[j].y - pts[i].y, b: pts[j].x - pts[i].x });
  slopes.sort((p, q) => (gt(p, q) ? 1 : gt(q, p) ? -1 : 0)); // ascending, so a tie keeps the smaller slope
  const n = BigInt(pts.length), sx = pts.reduce((t, p) => t + p.x, 0n);
  let best: { base: Ratio; slope: Ratio; cost: Ratio } | null = null;
  for (const sl of slopes) {
    let num = 0n; // base over the common denominator sl.b: max(0, max_k (y_k - slope x_k))
    for (const p of pts) { const v = p.y * sl.b - sl.a * p.x; if (v > num) num = v; }
    const cost: Ratio = { a: n * num + sl.a * sx, b: sl.b }; // total excess, less the constant sum of y
    if (!best || gt(best.cost, cost)) best = { base: { a: num, b: sl.b }, slope: sl, cost };
  }
  return { base: best!.base, slope: best!.slope, sizes };
}

/** ARCH-635b: the analyst over the dataset's file bytes (relationsMs + sqlMs). */
export function analystLine(ana: readonly { bytes: number; ms: number }[], sizeRatio: number): Line {
  return supportingLine(ana, sizeRatio, "analyst", "calibrate with 2+ datasets of different sizes (the default --datasets all includes smb-erp-fin, about 2 MB)");
}

/** ARCH-635c: a model call over the UTF-8 bytes of its prompt (callsMs). */
export function gatewayLine(calls: readonly { promptBytes: number; ms: number }[], sizeRatio: number): Line {
  return supportingLine(calls.map((c) => ({ bytes: c.promptBytes, ms: c.ms })), sizeRatio, "model call", "calibrate with a larger dataset too (smb-erp-fin's query prompts carry its whole schema), or the answer step on (--answer-model same)");
}
