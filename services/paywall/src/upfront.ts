/**
 * privateAI-design-37 ARCH-671/672: the upfront payment flow of paid jobs (PAID_JOBS_FLOW=upfront).
 *
 * With upfront, @x402 settles the buyer's payment BEFORE the release handler runs, so ChainAim never works unpaid. The
 * settlement is stored here by invoice id (UpfrontBook) and the handler finds it through the invoice its PAYMENT-SIGNATURE
 * names. A 200 closes it as released; every other answer asks ChainAim's signer for the refund first (requestRefund) and
 * closes it with the signer's outcome. Only ids and amounts are kept, never a result or a key.
 */

/** A settlement made before the handler, as the settle hook saw it. */
export type UpfrontPayment = {
  invoiceId: string;
  jobId: string;
  transaction: string;
  payer: string | null;
  network: string;
  amount: string;
  asset: string;
  settledAt: number;
};

export type UpfrontOutcome = "released" | "refunded" | "refund_pending" | "refund_refused";

type Entry = UpfrontPayment & { outcome?: UpfrontOutcome; keepUntil: number };

/** In memory, bounded like JobInvoices: entries are kept keepMs after settlement, and at most max of them. */
export class UpfrontBook {
  private readonly entries = new Map<string, Entry>(); // insertion order is settlement order
  private readonly keepMs: number;
  private readonly now: () => number;
  private readonly max: number;

  constructor(keepMs: number, now: () => number = Date.now, max = 50_000) {
    this.keepMs = keepMs;
    this.now = now;
    this.max = max;
  }

  put(payment: UpfrontPayment): void {
    this.prune();
    this.entries.set(payment.invoiceId, { ...payment, keepUntil: this.now() + this.keepMs });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
  }

  /** The settlement for an invoice and its outcome (undefined while open). */
  get(invoiceId: string): (UpfrontPayment & { outcome?: UpfrontOutcome }) | undefined {
    const e = this.entries.get(invoiceId);
    if (!e || e.keepUntil <= this.now()) return undefined;
    const { keepUntil: _, ...rest } = e;
    return rest;
  }

  /** Records the outcome once; false when the invoice is unknown or already closed. */
  close(invoiceId: string, outcome: UpfrontOutcome): boolean {
    const e = this.entries.get(invoiceId);
    if (!e || e.outcome !== undefined) return false;
    e.outcome = outcome;
    return true;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, e] of this.entries) if (e.keepUntil <= t) this.entries.delete(id);
  }
}

/**
 * Why a settled release was not delivered (closed set; ChainAim's signer allowlists the same names):
 * over_estimate 409 from the run, refused / mandate_refused 422, unreachable / timeout / bad_result 502, bad_request 400,
 * already_paying 409 (a second payment for a job already being paid), canceled (the x402 cancel hook, the safety net).
 */
export const REFUND_REASONS = ["over_estimate", "refused", "mandate_refused", "unreachable", "timeout", "bad_result", "bad_request", "already_paying", "canceled", "attestation_not_proven"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** What the buyer gets in the refusal body: the signer's signed record, or an unsigned pending / refused note. */
export type RefundBlock = {
  status: "refunded" | "refund_pending" | "refund_refused";
  invoiceId: string;
  paidTx: string;
  refundTx?: string;
  reason?: string;
  [k: string]: unknown;
};

export type RefundRequest = { invoiceId: string; jobId: string; paidTx: string; network: string; amountUnits: string; reason: RefundReason };

/**
 * POST {signer}/v1/refunds with X-Signer-Key. The signer's 200 record is passed on as it came (it carries its own Ed25519
 * signature, which the buyer checks with the receipt key it pins). A 409 from the signer is a refusal (e.g. a receipt was
 * already delivered, or the paid transaction does not match): refund_refused with the signer's message. A network error,
 * a timeout, another status or a record for another invoice is refund_pending, unsigned: the owner's -Refunds -RefundRetry
 * and the buyer's GET /v1/refunds/:invoiceId finish it. The key is never logged.
 */
export async function requestRefund(
  signer: { url: string; key: string; timeoutMs: number },
  req: RefundRequest,
  log: (line: string) => void,
): Promise<RefundBlock> {
  const pending = (why: string): RefundBlock => {
    log(JSON.stringify({ ts: new Date().toISOString(), event: "refund_request_failed", jobId: req.jobId, invoiceId: req.invoiceId, paidTx: req.paidTx, reason: why }));
    return { status: "refund_pending", invoiceId: req.invoiceId, paidTx: req.paidTx, reason: req.reason };
  };
  let r: Response;
  try {
    r = await fetch(`${signer.url}/v1/refunds`, {
      method: "POST",
      headers: { "x-signer-key": signer.key, "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(signer.timeoutMs),
    });
  } catch (e) {
    return pending((e as Error).name === "TimeoutError" ? "timeout" : "unreachable");
  }
  let body: Record<string, unknown> | null;
  try { body = (await r.json()) as Record<string, unknown>; } catch { body = null; }
  if (r.status === 409) {
    const message = typeof (body?.error as { message?: unknown } | undefined)?.message === "string" ? String((body!.error as { message: string }).message).slice(0, 300) : "refused by the signer";
    log(JSON.stringify({ ts: new Date().toISOString(), event: "refund_refused", jobId: req.jobId, invoiceId: req.invoiceId, paidTx: req.paidTx, reason: message }));
    return { status: "refund_refused", invoiceId: req.invoiceId, paidTx: req.paidTx, reason: message };
  }
  if (r.status !== 200 || body === null) return pending(`HTTP ${r.status}`);
  if ((body.status !== "refunded" && body.status !== "refund_pending") || body.invoiceId !== req.invoiceId || body.paidTx !== req.paidTx) return pending("the signer answered a record for another refund");
  if (body.status === "refunded" && typeof body.refundTx !== "string") return pending("the signer's refunded record has no refundTx");
  return body as RefundBlock;
}
