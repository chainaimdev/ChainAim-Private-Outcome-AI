/**
 * privateAI-design-37 ARCH-674: ChainAim's refund ledger, the single arbiter between "receipt delivered" and "refunded"
 * (invariant I3) and the record that survives a restart.
 *
 * <dir>/refunds.jsonl, append-only, one JSON line per state change, each line signed with the RECEIPT key (Ed25519 over the
 * canonical JSON of the line without `sig`) and fsynced before the call returns. Replay at start checks every signature and
 * refuses the file naming the first bad line: a tampered or torn ledger stops the signer rather than paying twice.
 *
 * Kinds: mandate_accepted (one mandate per invoice, kept across restarts: strengthens ARCH-667), delivered (a receipt was
 * signed for the job), refunding (the signed refund transaction, written BEFORE it is broadcast), refunded, refund_failed.
 * Ids, accounts, amounts and transaction bytes only.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { canonicalJson, type ReceiptSigner } from "../../receipt/src/index.ts";

export type MandateAccepted = { kind: "mandate_accepted"; invoiceId: string; jobId: string; accountId: string; exp: number };
export type Delivered = { kind: "delivered"; jobId: string; invoiceId?: string };
export type Refunding = {
  kind: "refunding"; invoiceId: string; jobId: string; paidTx: string; payer: string; amountUnits: string; network: string;
  reason: string; refundTx: string; signedTxB64: string; nonce: string;
};
export type Refunded = { kind: "refunded"; invoiceId: string; refundTx: string };
export type RefundFailed = { kind: "refund_failed"; invoiceId: string; reason: string };
export type BookEntry = MandateAccepted | Delivered | Refunding | Refunded | RefundFailed;
type Line = BookEntry & { at: string; sig: string };

/** Where one invoice's refund stands. */
export type RefundState = Omit<Refunding, "kind"> & { status: "refunding" | "refunded" | "refund_failed"; failedReason?: string; at: string };

export const LEDGER_FILE = "refunds.jsonl";

export class RefundBook {
  readonly file: string;
  private readonly signer: ReceiptSigner;
  private readonly now: () => number;
  private readonly mandates = new Map<string, MandateAccepted>();
  private readonly deliveredJobs = new Set<string>();
  private readonly deliveredInvoices = new Set<string>();
  private readonly refunds = new Map<string, RefundState>();
  private readonly refundByJob = new Map<string, string>();
  private readonly invoiceByPaidTx = new Map<string, string>();

  /** Opens (creating the folder) and replays the ledger; throws naming the line when a signature does not verify. */
  constructor(dir: string, signer: ReceiptSigner, now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, LEDGER_FILE);
    this.signer = signer;
    this.now = now;
    if (!existsSync(this.file)) return;
    const pub = createPublicKey(signer.publicKeyPem);
    const lines = readFileSync(this.file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (text.trim() === "" && i === lines.length - 1) return;
      let line: Line;
      try { line = JSON.parse(text) as Line; } catch { throw new Error(`${this.file} line ${i + 1} is not JSON: the refund ledger is damaged; restore it from a backup before starting`); }
      const { sig, ...signed } = line;
      if (typeof sig !== "string" || !verify(null, Buffer.from(canonicalJson(signed), "utf8"), pub, Buffer.from(sig, "base64"))) {
        throw new Error(`${this.file} line ${i + 1} does not carry this signer's signature: the refund ledger was changed or another receipt key is loaded`);
      }
      const { at, ...entry } = signed;
      this.apply(entry as BookEntry, at);
    });
  }

  /** Appends one signed line and fsyncs it, then applies it. */
  append(entry: BookEntry): void {
    const at = new Date(this.now()).toISOString();
    const signed = { ...entry, at };
    const line = JSON.stringify({ ...signed, sig: this.signer.signBytes(canonicalJson(signed)) }) + "\n";
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.apply(entry, at);
  }

  private apply(e: BookEntry, at: string): void {
    switch (e.kind) {
      case "mandate_accepted": this.mandates.set(e.invoiceId, e); break;
      case "delivered": this.deliveredJobs.add(e.jobId); if (e.invoiceId) this.deliveredInvoices.add(e.invoiceId); break;
      case "refunding": {
        const { kind: _, ...rest } = e;
        this.refunds.set(e.invoiceId, { ...rest, status: "refunding", at });
        this.refundByJob.set(e.jobId, e.invoiceId);
        this.invoiceByPaidTx.set(e.paidTx, e.invoiceId);
        break;
      }
      case "refunded": { const r = this.refunds.get(e.invoiceId); if (r) { r.status = "refunded"; r.refundTx = e.refundTx; r.at = at; delete r.failedReason; } break; }
      case "refund_failed": { const r = this.refunds.get(e.invoiceId); if (r) { r.status = "refund_failed"; r.failedReason = e.reason; r.at = at; } break; }
    }
  }

  /** The mandate accepted for an invoice (until restart and beyond). */
  mandateFor(invoiceId: string): MandateAccepted | undefined { return this.mandates.get(invoiceId); }
  /** True when a receipt was signed for the job, or for a payment naming this invoice. */
  delivered(jobId: string, invoiceId?: string): boolean { return this.deliveredJobs.has(jobId) || (invoiceId !== undefined && this.deliveredInvoices.has(invoiceId)); }
  refundOf(invoiceId: string): RefundState | undefined { const r = this.refunds.get(invoiceId); return r ? { ...r } : undefined; }
  /** I3: the refund started for a job (any status but a refund that failed before money moved still counts). */
  refundOfJob(jobId: string): RefundState | undefined { const i = this.refundByJob.get(jobId); return i === undefined ? undefined : this.refundOf(i); }
  invoiceOfPaidTx(paidTx: string): string | undefined { return this.invoiceByPaidTx.get(paidTx); }
  /** Every refund, oldest first (ids, accounts, amounts, status; never the transaction bytes). */
  list(): Omit<RefundState, "signedTxB64">[] { return [...this.refunds.values()].map(({ signedTxB64: _, ...r }) => ({ ...r })); }
  /** Refunds still waiting for their transaction to be final. */
  pending(): RefundState[] { return [...this.refunds.values()].filter((r) => r.status === "refunding").map((r) => ({ ...r })); }
}
