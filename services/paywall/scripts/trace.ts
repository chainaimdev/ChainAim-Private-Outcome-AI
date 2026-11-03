/**
 * Rig traces (live ops, Phase 2): each buyer-side step of a paid call is sent
 * to ledger-watch's POST /ingest/trace, keyed by the call's invoice id, so the
 * console can follow one call from quote to answer and join it with the
 * paywall's claim and the ledger payment.
 *
 * Fire-and-forget: send() never throws and is never awaited by a call; each
 * POST is abandoned after timeoutMs (default 1500), and at most maxInflight are
 * open at once (beyond that a step is dropped and counted). A dead or slow
 * ledger-watch therefore never slows the rig down or changes what it pays.
 *
 * Steps (ASSUMPTION until DESIGN/xrplh-19/20/21 are in the repository; the
 * same numbering is in services/ledger-watch/src/traces.ts):
 *   1 quoted, 2 signed, 3 sent, 5 answered; 4 is the paywall's settle, seen by
 *   ledger-watch from the paywall's claim.
 * A trace carries the tenant id, payer address, network, times, the HTTP status
 * and the transaction hash: never a seed, a request text or an answer.
 */
import type { PayStep, StepInfo } from "./xrpl.ts";

export const STEP_NUMBERS: Record<PayStep, number> = { quoted: 1, signed: 2, sent: 3, answered: 5 };

export type TraceTarget = {
  /** ledger-watch's /ingest/trace, e.g. http://127.0.0.1:8790/ingest/trace */
  url: string;
  /** The ingest key ledger-watch takes; read from the variable --trace-key-env names, never printed. */
  key: string;
  timeoutMs: number;
  maxInflight: number;
};

export type TraceEvent = {
  v: 1;
  invoiceId: string;
  step: number;
  name: PayStep;
  ts: string;
  network: string;
  tenant: string;
  payer: string;
  /** Milliseconds since the call started. */
  ms: number;
  status?: number;
  transaction?: string;
};

export type TraceStats = { sent: number; failed: number; dropped: number };

/** The trace event for one step; a transaction is included only when it is a ledger hash. */
export function traceEvent(step: PayStep, info: StepInfo, who: { tenant: string; payer: string }, ms: number, at: Date = new Date()): TraceEvent {
  return {
    v: 1,
    invoiceId: info.invoiceId,
    step: STEP_NUMBERS[step],
    name: step,
    ts: at.toISOString(),
    network: info.network,
    tenant: who.tenant,
    payer: who.payer,
    ms: Math.max(0, Math.round(ms)),
    ...(info.status !== undefined ? { status: info.status } : {}),
    ...(info.transaction && /^[0-9A-Fa-f]{64}$/.test(info.transaction) ? { transaction: info.transaction } : {}),
  };
}

export class Tracer {
  readonly stats: TraceStats = { sent: 0, failed: 0, dropped: 0 };
  private readonly target: TraceTarget;
  private readonly doFetch: typeof fetch;
  private readonly inflight = new Set<Promise<void>>();

  constructor(target: TraceTarget, fetchImpl: typeof fetch = fetch) {
    this.target = target;
    this.doFetch = fetchImpl;
  }

  send(event: TraceEvent): void {
    if (this.inflight.size >= this.target.maxInflight) {
      this.stats.dropped += 1;
      return;
    }
    let p: Promise<void>;
    try {
      p = this.doFetch(this.target.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": this.target.key },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.target.timeoutMs),
      })
        .then(async (r) => {
          await r.body?.cancel().catch(() => undefined);
          if (r.ok) this.stats.sent += 1;
          else this.stats.failed += 1;
        })
        .catch(() => {
          this.stats.failed += 1;
        })
        .finally(() => this.inflight.delete(p));
    } catch {
      this.stats.failed += 1;
      return;
    }
    this.inflight.add(p);
  }

  /** Wait (at most timeoutMs more) for the steps still in flight, so a run's last steps are not cut off at exit. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}
