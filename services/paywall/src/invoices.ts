/**
 * Invoices. Every price the paywall quotes carries its own invoice id, and the
 * payer's signed XRPL transaction commits to it, so the facilitator settles a
 * transaction for one invoice only. An invoice is claimed the first time a
 * payment for it is presented, whatever the outcome: a payment that is
 * verified but never settled (the middleware settles only responses below 400,
 * so every refusal is free) cannot be presented again to spend the free-model
 * quota a second time.
 */
import { randomUUID } from "node:crypto";

/** About 5 MB of memory: 32-character ids in a Map. Anyone can ask for a price, so the count is bounded. */
export const MAX_OPEN_INVOICES = 50_000;

export class InvoiceBook {
  private readonly open = new Map<string, number>(); // id -> expiry; insertion order is time order
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly max: number;

  /** ttlMs is how long a quoted price stays payable: the scheme's maxTimeoutSeconds. */
  constructor(ttlMs: number, now: () => number = Date.now, max: number = MAX_OPEN_INVOICES) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.max = max;
  }

  /** A new invoice id, open until it is claimed or expires. When the book is full the oldest invoice is dropped. */
  issue(): string {
    this.expire();
    const id = randomUUID().replaceAll("-", "").toUpperCase();
    this.open.set(id, this.now() + this.ttlMs);
    while (this.open.size > this.max) this.open.delete(this.open.keys().next().value as string);
    return id;
  }

  isOpen(id: string): boolean {
    this.expire();
    return this.open.has(id);
  }

  /** True the first time an open invoice is claimed; it is then closed for good. */
  claim(id: string): boolean {
    this.expire();
    return this.open.delete(id);
  }

  /**
   * The invoice for a request: the one its payment names while that is still
   * open, otherwise a new one. A payment for a claimed, expired or unknown
   * invoice therefore never matches the price it is checked against, and the
   * caller is asked to pay the new invoice.
   */
  forRequest(paymentHeader: string | undefined): string {
    const named = invoiceIdOf(paymentHeader);
    return named !== undefined && this.isOpen(named) ? named : this.issue();
  }

  private expire(): void {
    const t = this.now();
    for (const [id, expiry] of this.open) {
      if (expiry > t) break;
      this.open.delete(id);
    }
  }
}

/**
 * Payments seen once. A NEAR signed delegate (the x402 NEAR exact scheme) does
 * not name the invoice it pays: the delegate's ft_transfer carries no memo. A
 * payer whose call was refused (never settled) could otherwise present the
 * same signed delegate again under a new invoice and reach the gateway again
 * without paying. Each delegate is therefore claimed here by its hash, the
 * same key @x402/near uses for its duplicate-settlement cache (spec section 10),
 * and is refused the second time, whatever the outcome of the first.
 *
 * An entry is kept for ttlMs, well past the delegate's own validity window
 * (max_block_height, about one block per second), after which it can no
 * longer land on chain. The count is bounded like the invoice book's.
 */
export class SeenPayments {
  private readonly seen = new Map<string, number>(); // key -> expiry; insertion order is time order
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly max: number;

  constructor(ttlMs: number, now: () => number = Date.now, max: number = MAX_OPEN_INVOICES) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.max = max;
  }

  /** True the first time a key is presented; false for every later time while it is kept. */
  first(key: string): boolean {
    const t = this.now();
    for (const [k, expiry] of this.seen) {
      if (expiry > t) break;
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, t + this.ttlMs);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
}

/** The invoice id a PAYMENT-SIGNATURE header says it pays (accepted.extra.invoiceId), or undefined when it names none. */
export function invoiceIdOf(paymentHeader: string | undefined): string | undefined {
  if (!paymentHeader) return undefined;
  let payment: unknown;
  try {
    payment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  } catch {
    return undefined; // not a payment; the middleware answers it with a price
  }
  const id = (payment as { accepted?: { extra?: { invoiceId?: unknown } } } | null)?.accepted?.extra?.invoiceId;
  return typeof id === "string" && id !== "" ? id : undefined;
}
