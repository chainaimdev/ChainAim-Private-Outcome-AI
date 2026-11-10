/**
 * The paid-job event feed to near-watch (chainaim-adminUI-NEAR architecture-adminui-jobs.md ARCH-205). Off unless
 * --job-feed-url is set (and that needs --paid-jobs on). One JSON event per job transition, POSTed to near-watch's
 * /ingest/job with the ingest key:
 *   job_quoted    when a job is quoted and held: amount, totalUsd, expiresAt, steps (analyst, query model call(s), SQL,
 *                 answer model call) and the quote's breakdown
 *   job_released  when the paywall tells this console the job was settled (POST /internal/jobs/:id/released)
 *   job_expired   when a held job passes expiresAt unreleased (checked every --job-expiry-check-sec)
 *   job_attested  when ca-attest has judged the job's model calls (attest.ts onDone; PLAN-private-ai-nearai-attestation.md
 *                 ARCH-411, adminUI ARCH-501): summary and, per call, ids, an address, a report time, check results and a
 *                 short reason, in exactly the shape near-watch's parseJobEvent accepts (it refuses unknown fields)
 *   job_receipt   when the job's signed receipt is stored (privateAI-design-32 ARCH-615): receipt id, signing key id, the
 *                 result and files hashes, whether settled and the settlement transaction. Only with --job-feed-receipts on
 *                 (default off): near-watch refuses event names it does not know, so turn it on once near-watch accepts it.
 * Never awaited by a request: a feed that is slow, down or refusing never blocks or fails a job. A failed post is
 * logged once as job_feed_failed with the job id and a reason (an HTTP status, "timeout", "unreachable", "too many in
 * flight") only.
 *
 * Never text: an event holds ids, times, amounts, model ids, zones, token and row counts, entity kinds and counts. No
 * question, SQL, result row, answer, path or key is put in one (the builders below read only those fields).
 */
import type { CrossAskResult } from "../../packages/crossask/src/index.ts";
import type { JobQuote } from "../../packages/crossask/src/cost.ts";
import type { JobAttestation, JobSummary } from "./attest.ts";
import type { SignedReceipt } from "../../packages/receipt/src/index.ts";

export type JobFeedFlags = {
  "job-feed-url"?: string; "job-feed-key-env"?: string; "job-feed-timeout-ms"?: string; "job-feed-max-inflight"?: string; "job-expiry-check-sec"?: string;
  "job-feed-attest-keep"?: string; "job-feed-receipts"?: string;
};
/** attestKeep: quoted jobs whose call list is kept for their job_attested (oldest dropped first; a re-check needs it too); default 500. */
/** receipts: send job_receipt (--job-feed-receipts on); absent/false: not sent. */
export type JobFeedConfig = { url: string; key: string; keyEnv: string; timeoutMs: number; maxInflight: number; expiryCheckSec: number; attestKeep?: number; receipts?: boolean };
export const DEFAULT_ATTEST_KEEP = 500;

/** undefined without --job-feed-url; otherwise the checked configuration, or an Error naming what to set. The key is never in a message. */
export function jobFeedConfig(flags: JobFeedFlags, env: Record<string, string | undefined>, paidJobsOn: boolean): JobFeedConfig | undefined {
  const url = flags["job-feed-url"];
  const receiptsMode = flags["job-feed-receipts"] ?? "off";
  if (receiptsMode !== "on" && receiptsMode !== "off") throw new Error(`--job-feed-receipts must be on or off, got ${receiptsMode}`);
  if (url === undefined || url === "") {
    if (receiptsMode === "on") throw new Error("--job-feed-receipts on needs --job-feed-url");
    return undefined;
  }
  if (!paidJobsOn) throw new Error("--job-feed-url needs --paid-jobs on: the feed reports paid jobs only");
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`--job-feed-url must be a URL (e.g. http://127.0.0.1:8790/ingest/job), got ${url}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`--job-feed-url must be http or https, got ${u.protocol}`);
  const keyEnv = flags["job-feed-key-env"] ?? "NEAR_WATCH_INGEST_KEY";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw new Error(`--job-feed-key-env must be an environment variable name, got ${keyEnv}`);
  const key = env[keyEnv];
  if (!key || key.length < 24) throw new Error(`--job-feed-url needs the environment variable ${keyEnv}: near-watch's ingest key (NEAR_WATCH_INGEST_KEY there), at least 24 characters`);
  const int = (name: "job-feed-timeout-ms" | "job-feed-max-inflight" | "job-expiry-check-sec" | "job-feed-attest-keep", fallback: string, min: number, max: number): number => {
    const raw = flags[name] ?? fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}, got ${raw}`);
    return n;
  };
  return {
    url, key, keyEnv,
    timeoutMs: int("job-feed-timeout-ms", "5000", 100, 120_000),
    maxInflight: int("job-feed-max-inflight", "20", 1, 1000),
    expiryCheckSec: int("job-expiry-check-sec", "30", 1, 3600),
    attestKeep: int("job-feed-attest-keep", String(DEFAULT_ATTEST_KEEP), 1, 100_000),
    receipts: receiptsMode === "on",
  };
}

export type ModelStep = {
  name: "query" | "answer"; ms: number; model: string; zone?: string; promptTokens: number; completionTokens: number; usd: string;
  entityCounts?: Record<string, number>; residual?: "pass" | "refused";
};
export type JobStep = { name: "analyst"; ms: number; files: number; relations: number } | ModelStep | { name: "sql"; ms: number; rows: number };
/** near-watch's names (jobs.ts ATTEST_SUMMARIES / ATTEST_STATUSES); "unavailable" = evidence not obtainable yet, never trusted. */
export type WatchSummary = "attested" | "partial" | "unverified" | "unavailable" | "not_applicable";
export const SUMMARY_TO_WATCH: Record<Exclude<JobSummary, "pending">, WatchSummary> = {
  verified: "attested", partly: "partial", unverified: "unverified", unavailable: "unavailable", not_applicable: "not_applicable",
};
/** One call as near-watch's parseAttestedCall takes it (field for field; anything it would refuse is sent as null). */
export type WatchAttestedCall = {
  step: "query" | "answer"; model: string; servedModel: string | null; providerId: string | null;
  signatureKind: "provider_tee" | "gateway" | null; signingAlgo: "ecdsa" | "ed25519" | null; signingAddress: string | null;
  reportFetchedAt: string | null; tdx: boolean | null; gpu: boolean | null; signature: boolean | null; hashes: boolean | null;
  status: "verified" | "unverified" | "unavailable" | "not_applicable"; reason: string | null;
  /** Fix 4 (near-watch >= v1.0.9): the signed text (model id + two hashes) and the signature hex; null when absent or out of bounds. */
  signedText: string | null; signatureHex: string | null;
};
/** Per quoted job: its network and, per model call in run order, the step name and the priced model id. */
export type AttestMeta = { network: string; calls: { step: "query" | "answer"; model: string }[] };

export type JobEvent =
  | { v: 1; event: "job_quoted"; ts: string; jobId: string; network: string; amount: string; totalUsd: string; expiresAt: string; steps: JobStep[]; breakdown: JobQuote["breakdown"] }
  | { v: 1; event: "job_released" | "job_expired"; ts: string; jobId: string; network: string }
  | { v: 1; event: "job_attested"; ts: string; jobId: string; network: string; summary: WatchSummary; calls: WatchAttestedCall[] }
  | { v: 1; event: "job_receipt"; ts: string; jobId: string; network: string; receiptId: string; keyId: string; resultSha256: string; filesRoot: string; settled: boolean; transaction: string | null };

/** job_receipt (ARCH-615): ids and hashes of a stored receipt only. */
export function receiptEvent(r: SignedReceipt, network: string, now = Date.now()): JobEvent {
  return {
    v: 1, event: "job_receipt", ts: new Date(now).toISOString(), jobId: r.body.jobId, network: r.settlement?.network ?? network,
    receiptId: r.body.receiptId, keyId: r.sig.keyId, resultSha256: r.body.resultSha256, filesRoot: r.body.filesRoot,
    settled: r.settlement !== undefined, transaction: r.settlement?.transaction ?? null,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The steps of a quoted job, in the order they ran: analyst, the query model call(s), SQL, the answer model call.
 * Model call i is served[i] and breakdown.calls[i] (cost.ts prices served in order); its ms is timings.callsMs[i].
 */
export function jobSteps(out: CrossAskResult, quote: JobQuote): JobStep[] {
  const t = out.timings;
  if (!t) throw new Error("the job has no step timings (crossAsk ran without a clock)");
  const answered = t.answerMs !== undefined && out.served.length > 0;
  const model = (i: number, name: "query" | "answer"): ModelStep => {
    const s = out.served[i];
    const c = quote.breakdown.calls[i];
    const step: ModelStep = { name, ms: t.callsMs[i] ?? 0, model: c.model, promptTokens: c.promptTokens, completionTokens: c.completionTokens, usd: c.usd };
    if (s.zone) step.zone = s.zone;
    if (s.entityCounts) step.entityCounts = { ...s.entityCounts };
    if (s.residual) step.residual = s.residual;
    return step;
  };
  const queries = out.served.length - (answered ? 1 : 0);
  return [
    { name: "analyst", ms: t.relationsMs, files: t.files, relations: Array.isArray(out.relations) ? out.relations.length : 0 },
    ...Array.from({ length: queries }, (_, i) => model(i, "query")),
    { name: "sql", ms: t.sqlMs, rows: out.result?.rows.length ?? 0 },
    ...(answered ? [model(out.served.length - 1, "answer")] : []),
  ];
}

export function quotedEvent(j: { jobId: string; network: string; expiresAt: number; out: CrossAskResult; quote: JobQuote }, now = Date.now()): JobEvent {
  const b = j.quote.breakdown;
  return {
    v: 1, event: "job_quoted", ts: iso(now), jobId: j.jobId, network: j.network, amount: j.quote.amount, totalUsd: j.quote.totalUsd, expiresAt: iso(j.expiresAt),
    steps: jobSteps(j.out, j.quote),
    breakdown: { calls: b.calls.map((c) => ({ model: c.model, promptTokens: c.promptTokens, completionTokens: c.completionTokens, usd: c.usd })), modelUsd: b.modelUsd, callFeesUsd: b.callFeesUsd, analystUsd: b.analystUsd, nearGasUsd: b.nearGasUsd, marginPct: b.marginPct, minPriceUsd: b.minPriceUsd, minApplied: b.minApplied, subtotalUsd: b.subtotalUsd, withMarginUsd: b.withMarginUsd },
  };
}

// near-watch's bounds (services/near-watch/src/jobs.ts): a value outside them is sent as null, so one odd id never loses the event.
const WATCH_MODEL_ID = /^[A-Za-z0-9._:\/@-]{1,128}$/;
const WATCH_PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const WATCH_ECDSA = /^0x[0-9a-fA-F]{40}$/;
const WATCH_ED25519 = /^(0x)?[0-9a-fA-F]{64}$/;
const WATCH_SIGNED_TEXT = /^(?:[A-Za-z0-9._:\/@-]{1,128}:)?[0-9a-f]{64}:[0-9a-f]{64}$/;
const WATCH_SIG_ECDSA = /^(0x)?[0-9a-fA-F]{130}$/;
const WATCH_SIG_ED25519 = /^(0x)?[0-9a-fA-F]{128}$/;
const WATCH_MAX_CALLS = 32;
const ok = (v: string | null, re: RegExp): string | null => (v !== null && re.test(v) ? v : null);
/** A reason as near-watch takes it: printable ASCII on one line, at most 200 characters; empty -> null. */
export function watchReason(r: string | null): string | null {
  if (r === null) return null;
  const s = r.replace(/[^\x20-\x7E]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 200).trim();
  return s || null;
}

/** The model calls of a quoted job (steps query/answer in run order, the same order as out.served and attest.ts calls). */
export function attestMetaOf(network: string, out: CrossAskResult, quote: JobQuote): AttestMeta {
  const calls = jobSteps(out, quote).filter((s): s is ModelStep => s.name === "query" || s.name === "answer").map((s) => ({ step: s.name, model: s.model }));
  return { network, calls };
}

/**
 * job_attested for near-watch, or null while the check is still pending. Throws when the attestation does not line up with the
 * job's calls (a different count): that is a console bug, logged as job_feed_failed, never sent.
 */
export function attestedEvent(a: JobAttestation, meta: AttestMeta, now = Date.now()): JobEvent | null {
  if (a.summary === "pending") return null;
  if (a.calls.length !== meta.calls.length) throw new Error(`attestation has ${a.calls.length} call(s), the job ${meta.calls.length}`);
  if (a.calls.length > WATCH_MAX_CALLS) throw new Error(`more than ${WATCH_MAX_CALLS} model calls`);
  const calls = a.calls.map((c, i): WatchAttestedCall => {
    const m = meta.calls[i];
    const algo = c.signingAlgo === "ecdsa" || c.signingAlgo === "ed25519" ? c.signingAlgo : null;
    const fetched = c.reportFetchedAt !== null && !Number.isNaN(Date.parse(c.reportFetchedAt)) ? new Date(Date.parse(c.reportFetchedAt)).toISOString() : null;
    return {
      step: m.step,
      model: ok(m.model, WATCH_MODEL_ID) ?? "unknown",
      servedModel: ok(c.servedModel, WATCH_MODEL_ID),
      providerId: ok(c.chatId, WATCH_PROVIDER_ID),
      signatureKind: c.signatureKind === "provider_tee" || c.signatureKind === "gateway" ? c.signatureKind : null,
      signingAlgo: algo,
      signingAddress: algo === "ecdsa" ? ok(c.signingAddress, WATCH_ECDSA) : algo === "ed25519" ? ok(c.signingAddress, WATCH_ED25519) : null,
      reportFetchedAt: fetched,
      tdx: c.tdx, gpu: c.gpu, signature: c.signature, hashes: c.hashes,
      status: c.status,
      reason: watchReason(c.reason),
      signedText: typeof c.signedText === "string" && c.signedText.length <= 258 ? ok(c.signedText, WATCH_SIGNED_TEXT) : null,
      // near-watch needs signingAlgo for a signature: without a known algo the signature is not sent.
      signatureHex: algo === "ecdsa" ? ok(c.signatureHex, WATCH_SIG_ECDSA) : algo === "ed25519" ? ok(c.signatureHex, WATCH_SIG_ED25519) : null,
    };
  });
  return { v: 1, event: "job_attested", ts: iso(now), jobId: a.jobId, network: meta.network, summary: SUMMARY_TO_WATCH[a.summary], calls };
}

/** Posts events without blocking the caller; remembers each open job's network for its released/expired event. */
export class JobFeed {
  readonly counters = { sent: 0, failed: 0 };
  private inflight = 0;
  private readonly networks = new Map<string, string>();
  /** Quoted jobs' call lists for job_attested; kept after release (the check may finish later), the oldest dropped beyond attestKeep. */
  private readonly attestMeta = new Map<string, AttestMeta>();
  private readonly cfg: JobFeedConfig;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  constructor(cfg: JobFeedConfig, log: (line: string) => void = (l) => console.log(l), now: () => number = Date.now) {
    this.cfg = cfg;
    this.log = log;
    this.now = now;
  }

  quoted(j: { jobId: string; network: string; expiresAt: number; out: CrossAskResult; quote: JobQuote }): void {
    let event: JobEvent;
    try { event = quotedEvent(j, this.now()); }
    catch (e) { return this.failed(j.jobId, (e as Error).message); }
    this.networks.set(j.jobId, j.network);
    this.attestMeta.delete(j.jobId);
    this.attestMeta.set(j.jobId, attestMetaOf(j.network, j.out, j.quote));
    while (this.attestMeta.size > (this.cfg.attestKeep ?? DEFAULT_ATTEST_KEEP)) this.attestMeta.delete(this.attestMeta.keys().next().value!);
    this.post(event);
  }
  /** ca-attest's result for a quoted job (attest.ts onDone). Pending results are not sent; a later one for the same job replaces it there. */
  attested(a: JobAttestation): void {
    const meta = this.attestMeta.get(a.jobId);
    if (!meta) return this.failed(a.jobId, "no job_quoted for this job in this console (restarted, or older than --job-feed-attest-keep)");
    let event: JobEvent | null;
    try { event = attestedEvent(a, meta, this.now()); }
    catch (e) { return this.failed(a.jobId, (e as Error).message); }
    if (event) this.post(event);
  }
  /** A stored receipt (ARCH-615); sent only with --job-feed-receipts on. */
  receipt(r: SignedReceipt, network: string): void {
    if (!this.cfg.receipts) return;
    this.post(receiptEvent(r, network, this.now()));
  }
  released(jobId: string): void { this.closed(jobId, "job_released"); }
  expired(jobId: string): void { this.closed(jobId, "job_expired"); }

  /** Resolves when every post started so far has finished (tests and shutdown). */
  async idle(): Promise<void> { while (this.inflight > 0) await new Promise((r) => setTimeout(r, 10)); }

  private closed(jobId: string, event: "job_released" | "job_expired"): void {
    const network = this.networks.get(jobId);
    if (!network) return; // never quoted through this feed (e.g. held before a restart): nothing to report against
    this.networks.delete(jobId);
    this.post({ v: 1, event, ts: iso(this.now()), jobId, network });
  }

  private post(event: JobEvent): void {
    if (this.inflight >= this.cfg.maxInflight) return this.failed(event.jobId, "too many in flight");
    this.inflight += 1;
    fetch(this.cfg.url, { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": this.cfg.key }, body: JSON.stringify(event), signal: AbortSignal.timeout(this.cfg.timeoutMs) })
      .then(async (r) => {
        await r.body?.cancel();
        if (r.status === 202) this.counters.sent += 1;
        else this.failed(event.jobId, `HTTP ${r.status}`);
      }, (e: unknown) => this.failed(event.jobId, (e as Error).name === "TimeoutError" ? "timeout" : "unreachable"))
      .finally(() => { this.inflight -= 1; });
  }

  private failed(jobId: string, reason: string): void {
    this.counters.failed += 1;
    this.log(JSON.stringify({ ts: iso(this.now()), route: "job-feed", event: "job_feed_failed", jobId, reason }));
  }
}
