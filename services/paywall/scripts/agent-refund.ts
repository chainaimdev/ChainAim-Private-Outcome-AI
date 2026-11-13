/**
 * privateAI-design-37 ARCH-677: the buyer agent's side of an automatic refund. With the upfront flow the payment settles
 * before ChainAim runs the job; when the run is refused, the paywall's answer carries ChainAim's refund record. The agent
 * believes it only when the record's Ed25519 signature verifies with the receipt key it already pins AND it names this
 * payment (paidTx), this amount and this tenant's account as payer. Never "refunded" on the paywall's word alone.
 *
 * A pending refund is asked again at GET <paywall>/v1/refunds/<invoiceId> (pollMs apart, at most pollMax times).
 */
import { verifyRefund } from "../../../packages/receipt/src/index.ts";

export type RefundExpect = { paidTx: string; amountUnits: string; payer: string };
export type RefundOutcome =
  | { kind: "refunded"; refundTx: string; invoiceId: string }
  | { kind: "pending"; invoiceId?: string; reason: string }
  | { kind: "invalid"; reason: string };

/** One refund block as the paywall or GET /v1/refunds answered it. publicKeyPem: the pinned receipt key (none = cannot verify). */
export function checkRefund(raw: unknown, expect: RefundExpect, publicKeyPem: string | undefined): RefundOutcome {
  if (typeof raw !== "object" || raw === null) return { kind: "invalid", reason: "no refund record" };
  const r = raw as Record<string, unknown>;
  const invoiceId = typeof r.invoiceId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(r.invoiceId) ? r.invoiceId : undefined;
  if (r.paidTx !== undefined && r.paidTx !== expect.paidTx) return { kind: "invalid", reason: "the refund names another payment" };
  if (r.status === "refund_refused") return { kind: "invalid", reason: `ChainAim did not refund automatically: ${typeof r.reason === "string" ? r.reason.slice(0, 200) : "refused"}` };
  if (r.status === "refund_pending") return { kind: "pending", ...(invoiceId ? { invoiceId } : {}), reason: typeof r.reason === "string" ? r.reason.slice(0, 200) : "pending" };
  if (r.status !== "refunded") return { kind: "invalid", reason: "the refund record has no known status" };
  if (!publicKeyPem) return { kind: "pending", ...(invoiceId ? { invoiceId } : {}), reason: "reported refunded, but no receipt key is pinned to verify the record (--receipt-check)" };
  const v = verifyRefund(raw, publicKeyPem);
  if (!v.ok) return { kind: "invalid", reason: `the refund record does not verify: ${v.reason}` };
  if (v.record.amountUnits !== expect.amountUnits) return { kind: "invalid", reason: "the refund record names another amount" };
  if (v.record.payer !== expect.payer) return { kind: "invalid", reason: "the refund record names another payer" };
  if (typeof v.record.refundTx !== "string") return { kind: "invalid", reason: "the refund record has no refund transaction" };
  return { kind: "refunded", refundTx: v.record.refundTx, invoiceId: v.record.invoiceId };
}

/** Asks GET <paywall>/v1/refunds/<invoiceId> until the refund is verified, invalid, or pollMax asks are used. */
export async function awaitRefund(
  paywall: string,
  invoiceId: string,
  expect: RefundExpect,
  publicKeyPem: string | undefined,
  o: { pollMs: number; pollMax: number; fetchTimeoutMs: number; signal?: AbortSignal },
): Promise<RefundOutcome> {
  let last: RefundOutcome = { kind: "pending", invoiceId, reason: "pending" };
  for (let i = 0; i < o.pollMax; i++) {
    if (o.signal?.aborted) break;
    await new Promise((ok) => setTimeout(ok, o.pollMs));
    let body: unknown;
    // A timer cleared after each ask (not AbortSignal.timeout): none is left running once the answer is in.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.fetchTimeoutMs);
    try {
      const r = await fetch(`${paywall}/v1/refunds/${invoiceId}`, { signal: ac.signal });
      if (r.status === 404) { await r.body?.cancel(); continue; }
      body = await r.json();
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
    last = checkRefund(body, expect, publicKeyPem);
    if (last.kind !== "pending") return last;
  }
  return last.kind === "pending" ? { ...last, invoiceId } : last;
}
