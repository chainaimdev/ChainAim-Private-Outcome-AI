/**
 * Paid jobs on the test console (architecture.md ARCH-104, ARCH-105, ARCH-114): tab 03 "run, hold, quote, pay, release".
 * The job runs exactly as /crossask does; every model call is metered from the gateway's usage, packages/crossask
 * cost.ts computes ONE total, the result is held here in memory, the job {jobId, amount, expiresAt} is registered with
 * the paywall, and the page gets only the cost. The paywall reads the result from the internal listener
 * (x-jobs-key) only while it settles the payment, and tells this console to drop it once settled.
 *
 * Nothing here is logged: no question, SQL, rows, answer or key; the held result never leaves through a log.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatReply, CrossAskResult } from "../../packages/crossask/src/index.ts";
import { parseDecimal, pricesFromCatalog, quoteJob, type Fees, type JobQuote, type MeterLine, type ModelPrice } from "../../packages/crossask/src/cost.ts";

export type PaidJobsFlags = {
  "paid-jobs"?: string; "jobs-internal-host"?: string; "jobs-internal-port"?: string; "paid-jobs-key-env"?: string;
  "job-ttl-min"?: string; "job-max"?: string; "pricing-catalog"?: string;
  "fee-per-model-call-usd"?: string; "fee-analyst-usd"?: string; "near-gas-fee-usd"?: string; "margin-pct"?: string; "min-price-usd"?: string;
};
export type PaidJobsConfig = {
  internalHost: string; internalPort: number; key: string; keyEnv: string; ttlMs: number; max: number;
  prices: Map<string, ModelPrice>; fees: Fees;
};

/** The fee flags ARCH-114 requires, in the order their absence is reported. */
export const FEE_FLAGS = ["fee-per-model-call-usd", "fee-analyst-usd", "near-gas-fee-usd", "margin-pct", "min-price-usd"] as const;

/** undefined with --paid-jobs absent or off; otherwise the checked configuration, or an Error naming what to set. */
export function paidJobsConfig(flags: PaidJobsFlags, env: Record<string, string | undefined>): PaidJobsConfig | undefined {
  const mode = flags["paid-jobs"] ?? "off";
  if (mode !== "on" && mode !== "off") throw new Error(`--paid-jobs must be on or off, got ${mode}`);
  if (mode === "off") return undefined;
  if (!flags["pricing-catalog"]) throw new Error("--paid-jobs on needs --pricing-catalog PATH (the model catalog whose pricing.inputPerM / outputPerM price each call, e.g. config/catalog.bedrock.json)");
  for (const f of FEE_FLAGS) {
    const v = flags[f];
    if (v === undefined || v === "") throw new Error(`--paid-jobs on needs --${f} (a non-negative decimal; see MANUAL_SETUP.md, "Paid jobs")`);
    parseDecimal(v, `--${f}`);
  }
  const keyEnv = flags["paid-jobs-key-env"] ?? "PAID_JOBS_KEY";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw new Error(`--paid-jobs-key-env must be an environment variable name, got ${keyEnv}`);
  const key = env[keyEnv];
  // The key's value is never put in a message.
  if (!key || key.length < 24) throw new Error(`--paid-jobs on needs the environment variable ${keyEnv}: the key shared with the paywall (PAID_JOBS_KEY there), at least 24 characters`);
  const int = (name: "jobs-internal-port" | "job-ttl-min" | "job-max", fallback: string, min: number, max: number): number => {
    const raw = flags[name] ?? fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}, got ${raw}`);
    return n;
  };
  let catalog: unknown;
  try { catalog = JSON.parse(readFileSync(flags["pricing-catalog"], "utf8").replace(/^﻿/, "")); }
  catch (e) { throw new Error(`--pricing-catalog ${flags["pricing-catalog"]} cannot be read: ${(e as Error).message}`); }
  const fees: Fees = { perModelCallUsd: flags["fee-per-model-call-usd"]!, analystUsd: flags["fee-analyst-usd"]!, nearGasUsd: flags["near-gas-fee-usd"]!, marginPct: flags["margin-pct"]!, minPriceUsd: flags["min-price-usd"]! };
  return {
    internalHost: flags["jobs-internal-host"] ?? "127.0.0.1",
    internalPort: int("jobs-internal-port", "8731", 1, 65535),
    key, keyEnv,
    ttlMs: int("job-ttl-min", "15", 1, 1440) * 60_000,
    max: int("job-max", "100", 1, 10_000),
    prices: pricesFromCatalog(catalog),
    fees,
  };
}

/** One meter line per model call of the job, from what the gateway reported. */
export function meterOf(served: readonly ChatReply[]): MeterLine[] {
  return served.map((s) => ({ model: s.model ?? "", promptTokens: s.usage?.promptTokens, completionTokens: s.usage?.completionTokens }));
}

export type HeldJob = { jobId: string; result: CrossAskResult; amount: string; breakdown: JobQuote["breakdown"]; expiresAt: number };

/** Held results, in memory only, removed on release or expiry. */
export class JobStore {
  private readonly jobs = new Map<string, HeldJob>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Called once for each held job dropped because it passed expiresAt unreleased (the job feed, adminUI ARCH-205). */
  private readonly onExpire: ((job: HeldJob) => void) | undefined;
  constructor(max: number, ttlMs: number, now: () => number = Date.now, onExpire?: (job: HeldJob) => void) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.onExpire = onExpire;
  }

  /** The number of open jobs (expired ones are dropped first). */
  size(): number { this.prune(); return this.jobs.size; }
  full(): boolean { return this.size() >= this.max; }
  newJobId(): string { return randomBytes(16).toString("hex"); }
  expiryFromNow(): number { return this.now() + this.ttlMs; }
  hold(job: HeldJob): void { this.prune(); this.jobs.set(job.jobId, job); }
  get(jobId: string): HeldJob | undefined { this.prune(); return this.jobs.get(jobId); }
  drop(jobId: string): boolean { return this.jobs.delete(jobId); }
  private prune(): void { const t = this.now(); for (const [id, j] of this.jobs) if (j.expiresAt <= t) { this.jobs.delete(id); this.onExpire?.(j); } }
}

const JOB_ID = /^[0-9a-f]{32}$/;
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

/** The most a release notice body may hold: the settlement's ids (privateAI-design-32 ARCH-616) are far below this. */
export const RELEASE_NOTICE_MAX_BYTES = 4096;

/** The JSON body of a request up to max bytes; undefined for an empty, oversized or non-JSON body (the body is never logged). */
function readSmallJson(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > max) over = true; else chunks.push(c); });
    req.on("error", () => resolve(undefined));
    req.on("end", () => {
      if (over || size === 0) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(undefined); }
    });
  });
}

/** The second listener (ARCH-105): GET /internal/jobs/:id and POST /internal/jobs/:id/released, x-jobs-key required. */
/**
 * onReleased: called after a released job is dropped (the job feed, adminUI ARCH-205), with the job as it was held and the
 * paywall's release notice body (the settlement's ids, privateAI-design-32 ARCH-616; undefined when it sent none).
 */
export function internalHandler(store: JobStore, key: string, onReleased?: (jobId: string, job: HeldJob, notice: unknown) => void): (req: IncomingMessage, res: ServerResponse) => void {
  const want = Buffer.from(key, "utf8");
  return (req, res) => {
    const given = Buffer.from(String(req.headers["x-jobs-key"] ?? ""), "utf8");
    if (given.length !== want.length || !timingSafeEqual(given, want)) { req.resume(); return send(res, 401, { error: "x-jobs-key is missing or wrong" }); }
    const m = /^\/internal\/jobs\/([^/]+)(\/released)?$/.exec(new URL(req.url ?? "/", "http://internal").pathname);
    if (!m) { req.resume(); return send(res, 404, { error: "not found" }); }
    const jobId = m[1];
    if (m[2] && req.method === "POST") {
      void readSmallJson(req, RELEASE_NOTICE_MAX_BYTES).then((notice) => {
        const job = JOB_ID.test(jobId) ? store.get(jobId) : undefined;
        if (!job || !store.drop(jobId)) return send(res, 404, { error: "no such job" });
        try {
          onReleased?.(jobId, job, notice);
        } catch (e) {
          // The payment settled and the job is released whatever the hook does; its failure is logged with ids only.
          console.error(JSON.stringify({ ts: new Date().toISOString(), event: "job_release_hook_failed", jobId, reason: String((e as Error).message ?? e).slice(0, 200) }));
        }
        send(res, 200, { jobId, released: true });
      });
      return;
    }
    req.resume();
    if (!m[2] && req.method === "GET") {
      const job = JOB_ID.test(jobId) ? store.get(jobId) : undefined;
      if (!job) return send(res, 404, { error: "no such job" });
      return send(res, 200, { jobId, result: job.result });
    }
    send(res, 404, { error: "not found" });
  };
}

/** The NEAR offer a registered job is quoted at, read back from the paywall's 402 for its release route. */
export type JobOffer = { network: string; asset: string; payTo: string; amount: string };

/**
 * Registers a quoted job with the paywall and reads back its 402 offer, which must name the same amount.
 * Throws (and the caller holds nothing) when either step fails. Messages carry status codes, never a body or key.
 */
export async function registerJob(paywall: string, key: string, job: { jobId: string; amount: string; expiresAt: number }): Promise<JobOffer> {
  let r: Response;
  try {
    r = await fetch(`${paywall}/internal/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-jobs-key": key }, body: JSON.stringify(job), signal: AbortSignal.timeout(10_000) });
  } catch { throw new Error("the paywall is not reachable to register the job; nothing was charged"); }
  if (r.status !== 201) {
    const why = await r.json().then((b: { error?: { message?: unknown } }) => (typeof b?.error?.message === "string" ? b.error.message : ""), () => "");
    throw new Error(`the paywall refused the job (HTTP ${r.status}${why ? `: ${why}` : ""}); nothing was charged`);
  }
  await r.body?.cancel();
  let q: Response;
  try { q = await fetch(`${paywall}/v1/jobs/${job.jobId}/release`, { method: "POST", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error("the paywall is not reachable to quote the job; nothing was charged"); }
  await q.body?.cancel();
  const header = q.headers.get("payment-required");
  if (q.status !== 402 || !header) throw new Error(`the paywall did not quote the job (HTTP ${q.status}); nothing was charged`);
  const offer = (JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts ?? [])[0] as Record<string, unknown> | undefined;
  if (!offer || typeof offer.network !== "string" || !offer.network.startsWith("near:") || typeof offer.asset !== "string" || typeof offer.payTo !== "string" || offer.amount !== job.amount) {
    throw new Error("the paywall quoted the job differently from this console's total; nothing was charged");
  }
  return { network: offer.network, asset: offer.asset, payTo: offer.payTo, amount: offer.amount };
}
