/**
 * Estimate-first offers on tab 03 (privateAI-design-34 ARCH-636, ARCH-638; owner D4/D5 2026-11-12): the console prices a
 * job from sizes only and does NO work (no model, analyst or gateway call) until the buyer has paid for that price; the
 * paywall's paid release then asks the console to run it (POST /internal/jobs/:id/run, ARCH-637) within the estimate.
 *
 *   --offer-mode estimate-first|run-hold    the default mode a buyer gets (default estimate-first)
 *   --offer-modes LIST                      the modes buyers may pick (default estimate-first,run-hold; estimate-first
 *                                           alone hides the choice)
 *   --cost-model FILE                       the calibrated cost model (default config/cost-model.json, desk.ps1 -Calibrate);
 *                                           estimate-first refuses to start without it (nothing is invented)
 *   --offer-max-tokens N                    max_tokens on every model call of an offer's run, and the estimate's
 *                                           completion line per call (default 2048)
 *   --offer-size-tolerance-pct N            the folder may grow this much between estimate and run before it is
 *                                           refused for a re-estimate (409; default 10; design-32 ARCH-610)
 *
 * The question is held here with the offer (never sent anywhere before payment): the paid release carries no body
 * (services/web payNearRelease and the agent post it empty). Held in memory only, dropped on run or expiry.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkBasis, OFFER_MODES, parseCostModel, type CostModel, type OfferBasis, type OfferMode } from "../../packages/offer/src/index.ts";
import type { JobQuote } from "../../packages/crossask/src/cost.ts";
import type { Ap2Hold } from "./ap2.ts";

export type OfferFlags = { "offer-mode"?: string; "offer-modes"?: string; "cost-model"?: string; "offer-max-tokens"?: string; "offer-size-tolerance-pct"?: string };
export type OfferConfig = { mode: OfferMode; modes: OfferMode[]; costModel?: CostModel; maxTokens: number; tolerancePct: number };

const isMode = (m: string): m is OfferMode => (OFFER_MODES as readonly string[]).includes(m);
const int = (raw: string | undefined, fallback: number, name: string, lo: number, hi: number): number => {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${name} must be a whole number from ${lo} to ${hi}, got ${raw}`);
  return n;
};

/**
 * The offer settings; undefined without paid jobs (offers are paid jobs). Throws at start-up, naming the flag or the
 * missing calibration, so a console never quotes from a guessed cost model.
 */
export function offerConfig(flags: OfferFlags, paidJobsOn: boolean, readText: (path: string) => string): OfferConfig | undefined {
  const given = flags["offer-mode"] !== undefined || flags["offer-modes"] !== undefined;
  if (!paidJobsOn) {
    if (given) throw new Error("--offer-mode / --offer-modes need --paid-jobs on: an offer is a paid job");
    return undefined;
  }
  const mode = flags["offer-mode"] ?? "estimate-first";
  if (!isMode(mode)) throw new Error(`--offer-mode must be one of ${OFFER_MODES.join(", ")}, got ${mode}`);
  const modes = (flags["offer-modes"] ?? OFFER_MODES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!modes.length || modes.some((m) => !isMode(m))) throw new Error(`--offer-modes must list ${OFFER_MODES.join(" and/or ")}, got ${flags["offer-modes"]}`);
  if (!modes.includes(mode)) throw new Error(`--offer-mode ${mode} must be one of --offer-modes (${modes.join(",")})`);
  const maxTokens = int(flags["offer-max-tokens"], 2048, "offer-max-tokens", 16, 65_536);
  const tolerancePct = int(flags["offer-size-tolerance-pct"], 10, "offer-size-tolerance-pct", 0, 100);
  let costModel: CostModel | undefined;
  if (modes.includes("estimate-first")) {
    const file = flags["cost-model"] ?? "config/cost-model.json";
    let text: string;
    try { text = readText(file); }
    catch { throw new Error(`estimate-first offers need the cost model ${file}: run .\\test-console\\desk.ps1 -Calibrate on this PC, or start with --offer-modes run-hold`); }
    try { costModel = parseCostModel(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)); }
    catch (e) { throw new Error(`the cost model ${file} is not valid (${(e as Error).message}): run .\\test-console\\desk.ps1 -Calibrate again`); }
  }
  return { mode, modes: modes as OfferMode[], ...(costModel ? { costModel } : {}), maxTokens, tolerancePct };
}

/** The data files the analyst reads in a folder, by size only: nothing is opened (ARCH-636: no work before payment). */
export async function folderSize(dir: string, usable: (name: string) => boolean, maxFiles: number): Promise<{ files: number; totalBytes: number }> {
  const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && usable(e.name)).map((e) => e.name).sort().slice(0, maxFiles);
  let totalBytes = 0;
  for (const n of names) totalBytes += (await stat(join(dir, n))).size;
  return { files: names.length, totalBytes };
}

/** What the buyer asked, held until the paid run (ARCH-636); the question is never sent anywhere before payment. */
export type OfferRequest = { folder: string; question: string; model: string; answerModel?: string; phrase: "llm" | "none"; sql?: string; datasetId?: unknown; templateLabel?: unknown };
export type HeldOffer = {
  offerId: string; request: OfferRequest; basis: Extract<OfferBasis, { kind: "crossask" }>; quote: JobQuote;
  amount: string; expiresAt: number; network: string; ap2?: Ap2Hold;
  /** ARCH-636: the estimate said every model call goes to an attested route (enforced at the run, ARCH-638). */
  attested: boolean;
};

/** The models an offer's run calls, in order: the query model 1 + sqlRetries times (none with the buyer's own SQL), then the answer model. */
export function offerModels(b: Extract<OfferBasis, { kind: "crossask" }>): string[] {
  return [...Array.from({ length: b.userSql ? 0 : 1 + b.sqlRetries }, () => b.model), ...(b.phrase === "llm" ? [b.answerModel ?? b.model] : [])];
}
/**
 * ARCH-636: attested before the run when the job calls at least one model and every model it may call is attestable (catalog
 * "attest" on all deployments), as run-hold's attested is every served call carrying attestation evidence.
 */
export function attestedRoute(b: Extract<OfferBasis, { kind: "crossask" }>, attestable: ReadonlySet<string>): boolean {
  const models = offerModels(b);
  return models.length > 0 && models.every((m) => attestable.has(m));
}

/** The crossask basis of a request: sizes and this console's limits, checked by packages/offer. */
export function crossaskBasis(req: OfferRequest, size: { files: number; totalBytes: number }, limits: { maxPromptChars: number; answerMaxPromptChars: number; maxTokens: number; sqlRetries: number; answerMaxRows: number }): Extract<OfferBasis, { kind: "crossask" }> {
  const b = {
    kind: "crossask" as const, model: req.model, ...(req.answerModel ? { answerModel: req.answerModel } : {}), phrase: req.phrase, userSql: req.sql !== undefined,
    totalBytes: size.totalBytes, files: size.files, ...limits,
  };
  checkBasis(b);
  return b;
}

/**
 * ARCH-638 before the run: the folder may not have grown past the tolerance, nor gained files (the estimate would no
 * longer cover it: 409, re-estimate). A smaller folder is fine (the price is a ceiling).
 */
export function withinBasis(basis: { files: number; totalBytes: number }, now: { files: number; totalBytes: number }, tolerancePct: number): string | null {
  if (now.files > basis.files) return `the folder has ${now.files} data files now, ${basis.files} when it was estimated: estimate it again`;
  const limit = Math.floor((basis.totalBytes * (100 + tolerancePct)) / 100);
  if (now.totalBytes > limit) return `the folder holds ${now.totalBytes} bytes now, more than the ${basis.totalBytes} estimated (+${tolerancePct} %): estimate it again`;
  return null;
}

/** Offers in memory until run or expiry, like JobStore (the run turns one into a held job). */
export class OfferStore {
  private readonly offers = new Map<string, HeldOffer>();
  private readonly max: number;
  private readonly now: () => number;
  private readonly onExpire: ((o: HeldOffer) => void) | undefined;
  constructor(max: number, now: () => number = Date.now, onExpire?: (o: HeldOffer) => void) {
    this.max = max;
    this.now = now;
    this.onExpire = onExpire;
  }
  size(): number { this.prune(); return this.offers.size; }
  full(): boolean { return this.size() >= this.max; }
  hold(o: HeldOffer): void { this.prune(); this.offers.set(o.offerId, o); }
  get(offerId: string): HeldOffer | undefined { this.prune(); return this.offers.get(offerId); }
  /** Removed after a good run (it is a held job from then on); a refused or failed run keeps it payable until it expires. */
  drop(offerId: string): boolean { return this.offers.delete(offerId); }
  private prune(): void { const t = this.now(); for (const [id, o] of this.offers) if (o.expiresAt <= t) { this.offers.delete(id); this.onExpire?.(o); } }
}
