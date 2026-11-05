/**
 * The paid-job event feed to near-watch (chainaim-adminUI-NEAR architecture-adminui-jobs.md ARCH-205). Off unless
 * --job-feed-url is set (and that needs --paid-jobs on). One JSON event per job transition, POSTed to near-watch's
 * /ingest/job with the ingest key:
 *   job_quoted    when a job is quoted and held: amount, totalUsd, expiresAt, steps (analyst, query model call(s), SQL,
 *                 answer model call) and the quote's breakdown
 *   job_released  when the paywall tells this console the job was settled (POST /internal/jobs/:id/released)
 *   job_expired   when a held job passes expiresAt unreleased (checked every --job-expiry-check-sec)
 * Never awaited by a request: a feed that is slow, down or refusing never blocks or fails a job. A failed post is
 * logged once as job_feed_failed with the job id and a reason (an HTTP status, "timeout", "unreachable", "too many in
 * flight") only.
 *
 * Never text: an event holds ids, times, amounts, model ids, zones, token and row counts, entity kinds and counts. No
 * question, SQL, result row, answer, path or key is put in one (the builders below read only those fields).
 */
import type { CrossAskResult } from "../../packages/crossask/src/index.ts";
import type { JobQuote } from "../../packages/crossask/src/cost.ts";

export type JobFeedFlags = {
  "job-feed-url"?: string; "job-feed-key-env"?: string; "job-feed-timeout-ms"?: string; "job-feed-max-inflight"?: string; "job-expiry-check-sec"?: string;
};
export type JobFeedConfig = { url: string; key: string; keyEnv: string; timeoutMs: number; maxInflight: number; expiryCheckSec: number };

/** undefined without --job-feed-url; otherwise the checked configuration, or an Error naming what to set. The key is never in a message. */
export function jobFeedConfig(flags: JobFeedFlags, env: Record<string, string | undefined>, paidJobsOn: boolean): JobFeedConfig | undefined {
  const url = flags["job-feed-url"];
  if (url === undefined || url === "") return undefined;
  if (!paidJobsOn) throw new Error("--job-feed-url needs --paid-jobs on: the feed reports paid jobs only");
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`--job-feed-url must be a URL (e.g. http://127.0.0.1:8790/ingest/job), got ${url}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`--job-feed-url must be http or https, got ${u.protocol}`);
  const keyEnv = flags["job-feed-key-env"] ?? "NEAR_WATCH_INGEST_KEY";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw new Error(`--job-feed-key-env must be an environment variable name, got ${keyEnv}`);
  const key = env[keyEnv];
  if (!key || key.length < 24) throw new Error(`--job-feed-url needs the environment variable ${keyEnv}: near-watch's ingest key (NEAR_WATCH_INGEST_KEY there), at least 24 characters`);
  const int = (name: "job-feed-timeout-ms" | "job-feed-max-inflight" | "job-expiry-check-sec", fallback: string, min: number, max: number): number => {
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
  };
}

export type ModelStep = {
  name: "query" | "answer"; ms: number; model: string; zone?: string; promptTokens: number; completionTokens: number; usd: string;
  entityCounts?: Record<string, number>; residual?: "pass" | "refused";
};
export type JobStep = { name: "analyst"; ms: number; files: number; relations: number } | ModelStep | { name: "sql"; ms: number; rows: number };
export type JobEvent =
  | { v: 1; event: "job_quoted"; ts: string; jobId: string; network: string; amount: string; totalUsd: string; expiresAt: string; steps: JobStep[]; breakdown: JobQuote["breakdown"] }
  | { v: 1; event: "job_released" | "job_expired"; ts: string; jobId: string; network: string };

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

/** Posts events without blocking the caller; remembers each open job's network for its released/expired event. */
export class JobFeed {
  readonly counters = { sent: 0, failed: 0 };
  private inflight = 0;
  private readonly networks = new Map<string, string>();
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
    this.post(event);
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
