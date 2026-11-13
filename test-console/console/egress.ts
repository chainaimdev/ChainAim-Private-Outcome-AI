/**
 * privateAI-design-41 ARCH-699: "download what was sent", for the owner of the run on this PC only. While a paid job is
 * held, the console keeps the exact bytes each of its model calls sent (fetched from the gateway by their SHA-256 and
 * checked against it, packages/crossask gatewayChat onSent), in memory only: never logged, never on disk, never sent to the
 * paywall or the signer. GET /jobs/<id>/egress/<call> (127.0.0.1 only) answers them until the job expires.
 */
import type { ChatReply } from "../../packages/crossask/src/index.ts";

type Held = { calls: (Uint8Array | undefined)[]; expiresAt: number };

export class SentStore {
  private readonly jobs = new Map<string, Held>();
  private readonly max: number;
  private readonly now: () => number;
  constructor(max: number, now: () => number = Date.now) {
    this.max = max;
    this.now = now;
  }

  /** The bytes per call of a job (run order), kept until expiresAt; the oldest job goes first beyond `max`. */
  hold(jobId: string, calls: (Uint8Array | undefined)[], expiresAt: number): void {
    this.prune();
    this.jobs.delete(jobId);
    if (!calls.some((c) => c !== undefined)) return;
    this.jobs.set(jobId, { calls, expiresAt });
    while (this.jobs.size > this.max) this.jobs.delete(this.jobs.keys().next().value!);
  }

  /** One call's bytes, or undefined (unknown job, expired, no such call, or the bytes could not be fetched). */
  get(jobId: string, call: number): Uint8Array | undefined {
    this.prune();
    return this.jobs.get(jobId)?.calls[call];
  }

  private prune(): void {
    const t = this.now();
    for (const [id, h] of this.jobs) if (h.expiresAt <= t) this.jobs.delete(id);
  }
}

/** Per call, the bytes collected for its egress hash (sentBySha from gatewayChat's onSent); undefined where none. */
export function sentOf(served: readonly ChatReply[], sentBySha: ReadonlyMap<string, Uint8Array>): (Uint8Array | undefined)[] {
  return served.map((s) => (s.egress ? sentBySha.get(s.egress.sentSha256) : undefined));
}

/** The job-log lines for calls whose x-chainaim-egress header was refused (ARCH-697): call index and reason, never content. */
export function egressRefusedLines(route: string, jobId: string, served: readonly ChatReply[]): string[] {
  return served.flatMap((s, i) => (s.egressRefused ? [JSON.stringify({ ts: new Date().toISOString(), route, event: "egress_refused", jobId, call: i, reason: s.egressRefused })] : []));
}
