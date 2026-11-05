/**
 * Paid jobs (architecture.md ARCH-106 to ARCH-110): pay-after-quote for tab 03 of the test console. The console runs
 * the job, holds its result and registers {jobId, amount, expiresAt} here; POST /v1/jobs/:id/release is then paid in
 * USDC on NEAR for exactly that amount, and the result is fetched from the console and released only once the
 * payment has settled (@x402/hono replaces the body on a failed settlement).
 *
 * Only ids, amounts and times are kept here; the result never is. Off unless PAID_JOBS=on.
 */
import { InvoiceBook, invoiceIdOf } from "./invoices.ts";

/** What the console registers. */
export type Job = { jobId: string; amount: string; expiresAt: number };
export type JobState = "open" | "expired" | "released" | "unknown";

export const JOB_ID = /^[0-9a-f]{32}$/;
/** The release route; the id is matched as [^/]+ by @x402/core and checked against JOB_ID by the guard. */
export const JOB_RELEASE_KEY = "POST /v1/jobs/:id/release";
export const JOB_RELEASE_PATH = /^\/v1\/jobs\/([^/]+)\/release$/;

/** The job id in a release path, or undefined. */
export function jobIdOfPath(path: string | undefined): string | undefined {
  const m = path === undefined ? null : JOB_RELEASE_PATH.exec(path);
  return m && JOB_ID.test(m[1]) ? m[1] : undefined;
}

type Entry = Job & { released: boolean; paying: boolean };

export class JobBook {
  private readonly jobs = new Map<string, Entry>(); // insertion order is registration order
  private readonly now: () => number;
  private readonly max: number;
  /** How long an expired or released job is still remembered, so a late call gets 410 / 409 rather than 404. */
  private readonly keepMs: number;

  constructor(max: number, keepMs: number, now: () => number = Date.now) {
    this.max = max;
    this.keepMs = keepMs;
    this.now = now;
  }

  /** Stores a job; "full" when max jobs are open, "exists" for an id already registered. */
  register(job: Job): "stored" | "full" | "exists" {
    this.prune();
    if (this.jobs.has(job.jobId)) return "exists";
    if (this.openCount() >= this.max) return "full";
    this.jobs.set(job.jobId, { ...job, released: false, paying: false });
    return "stored";
  }

  state(jobId: string): JobState {
    const j = this.jobs.get(jobId);
    if (!j) return "unknown";
    if (j.released) return "released";
    return j.expiresAt <= this.now() ? "expired" : "open";
  }

  /** The amount of an open job, or undefined. */
  amountOf(jobId: string): string | undefined {
    return this.state(jobId) === "open" ? this.jobs.get(jobId)!.amount : undefined;
  }

  /** True the first time a release of an open job starts; false while one is in flight. */
  beginPaying(jobId: string): boolean {
    const j = this.jobs.get(jobId);
    if (!j || this.state(jobId) !== "open" || j.paying) return false;
    j.paying = true;
    return true;
  }

  /** A release that did not settle: the job is payable again until it expires. */
  endPaying(jobId: string): void {
    const j = this.jobs.get(jobId);
    if (j) j.paying = false;
  }

  markReleased(jobId: string): void {
    const j = this.jobs.get(jobId);
    if (j) { j.released = true; j.paying = false; }
  }

  private openCount(): number {
    let n = 0;
    const t = this.now();
    for (const j of this.jobs.values()) if (!j.released && j.expiresAt > t) n++;
    return n;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, j] of this.jobs) if (j.expiresAt + this.keepMs <= t) this.jobs.delete(id);
    // Remembered (closed) jobs are bounded too: the oldest closed ones go first.
    if (this.jobs.size > this.max * 2) {
      for (const [id, j] of this.jobs) {
        if (this.jobs.size <= this.max * 2) break;
        if (j.released || j.expiresAt <= t) this.jobs.delete(id);
      }
    }
  }
}

/**
 * Invoices for job releases, each bound to one job (ARCH-109). A separate book from the routes' own, so an invoice
 * issued for a job is never reused on another route, and a payment naming another job's invoice is priced with a
 * new invoice and so matches nothing: it is refused before verification.
 */
export class JobInvoices {
  private readonly book: InvoiceBook;
  private readonly jobOf = new Map<string, string>();

  constructor(ttlMs: number, now?: () => number, max?: number) {
    this.book = new InvoiceBook(ttlMs, now, max);
  }

  /** The invoice for a release of jobId: the one the payment names when it is open and bound to that job, else a new one. */
  forRequest(jobId: string, paymentHeader: string | undefined): string {
    const named = invoiceIdOf(paymentHeader);
    if (named !== undefined && this.book.isOpen(named) && this.jobOf.get(named) === jobId) return named;
    const id = this.book.issue();
    this.jobOf.set(id, jobId);
    // Ids of invoices the book has dropped are forgotten too.
    if (this.jobOf.size > 2 * 50_000) for (const k of this.jobOf.keys()) { if (!this.book.isOpen(k)) this.jobOf.delete(k); }
    return id;
  }

  /** True the first time an open invoice bound to jobId is claimed. */
  claim(invoiceId: string, jobId: string | undefined): boolean {
    if (jobId === undefined || this.jobOf.get(invoiceId) !== jobId) return false;
    this.jobOf.delete(invoiceId);
    return this.book.claim(invoiceId);
  }

  owns(invoiceId: string): boolean {
    return this.jobOf.has(invoiceId);
  }
}

/** A registration body checked field by field; the message names the field, never a value. */
export function parseJob(body: unknown, now: number, ttlSec: number): Job | { error: string } {
  const b = body as { jobId?: unknown; amount?: unknown; expiresAt?: unknown } | null;
  if (typeof b !== "object" || b === null) return { error: "body must be a JSON object {jobId, amount, expiresAt}" };
  if (typeof b.jobId !== "string" || !JOB_ID.test(b.jobId)) return { error: "jobId must be 32 lowercase hex characters" };
  if (typeof b.amount !== "string" || !/^[1-9]\d{0,30}$/.test(b.amount)) return { error: "amount must be a positive whole number of USDC base units, as a string" };
  if (typeof b.expiresAt !== "number" || !Number.isInteger(b.expiresAt)) return { error: "expiresAt must be a time in milliseconds since 1970" };
  if (b.expiresAt <= now) return { error: "expiresAt must be in the future" };
  if (b.expiresAt > now + ttlSec * 1000) return { error: `expiresAt must be at most PAID_JOBS_TTL_SEC (${ttlSec} s) from now` };
  return { jobId: b.jobId, amount: b.amount, expiresAt: b.expiresAt };
}
