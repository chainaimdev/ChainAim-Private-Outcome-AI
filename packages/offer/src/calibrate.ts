/**
 * Calibration (privateAI-design-34 ARCH-635 = design-32 ARCH-602..604): the cost model from real measurements on this
 * machine, never from invented numbers. Pure: the runner (scripts/calibrate.ts) takes the measurements through the
 * running console API; this file only turns them into config/cost-model.json.
 *
 * Units (design-32 §3.2):
 *   presidioPerKbUsd       max over the timed /gateway/scan and /gateway/mask calls of ms per KB of text
 *   analystPerMbUsd        max over the crossask runs of (relationsMs + sqlMs) per MB of the dataset's files
 *   gatewayPerKbPromptUsd  max over the model calls of callsMs per KB of the prompt sent
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
};

export type CalibrationObserved = {
  samples: { presidio: number; analyst: number; call: number };
  presidioMsPerKbMax: string; analystMsPerMbMax: string; gatewayMsPerKbMax: string;
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
  const presMax = maxRatio(pres.map(rate)), anaMax = maxRatio(ana.map(rate)), gwMax = maxRatio(calls.map(rate));
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
    version: 1, calibratedAt: o.calibratedAt, machine: o.machine, source: o.source, tokensPerByte, bytesPerChar,
    units: { presidioPerKbUsd: usd(presMax), analystPerMbUsd: usd(anaMax), gatewayPerKbPromptUsd: usd(gwMax) }, safetyPct,
  });
  const msDec = (r: Ratio) => upDec(r.a, r.b, 3n);
  return {
    model,
    observed: {
      samples: { presidio: pres.length, analyst: ana.length, call: calls.length },
      presidioMsPerKbMax: msDec(presMax), analystMsPerMbMax: msDec(anaMax), gatewayMsPerKbMax: msDec(gwMax),
      spreadMaxPct: upDec(spread.a * 100n, spread.b, 2n), spreadGroup,
      tokensPerByteObservedMax: tpbObserved, callsWithUsage: withUsage.length,
      bytesPerCharObservedMax: upDec(bpc.a, bpc.b, 4n),
    },
  };
}
