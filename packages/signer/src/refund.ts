/**
 * privateAI-design-37 ARCH-673: ChainAim's signer refunds an upfront payment whose job was not delivered.
 *
 * The caller (ca-paywall, X-Signer-Key) names an invoice, a job, the paid transaction, the amount and a reason; nothing it
 * says is trusted for the money. The refund goes out only when the CHAIN shows that transaction final and successful, with
 * exactly one ft_transfer of that amount on the configured USDC contract to ChainAim's payTo account, younger than
 * maxAgeSec and not claimed by another invoice; it goes to the account that paid (the transfer's predecessor), which must
 * be the account of the mandate accepted for that invoice (I2). A job with a delivered receipt is never refunded, and a
 * refunding job never gets a receipt (I3, RefundBook). One request per invoice is answered with the same record
 * (idempotent); refunds run one at a time, so two never take the same access-key nonce.
 *
 * The signed transaction is written to the ledger and fsynced BEFORE it is broadcast; a timeout leaves it "refunding" and
 * sweep() finishes it (status by hash; re-send of the same bytes when the chain never saw it).
 */
import type { ReceiptSigner, RefundRecord } from "../../receipt/src/index.ts";
import { signRefund } from "../../receipt/src/index.ts";
import { accessKey, blockTimeMs, nearBalance, paidTransfer, sendSigned, signFtTransfer, txOutcome, type NearKey } from "../../near-refund/src/index.ts";
import type { RefundBook, RefundState } from "./refund-book.ts";

/** The reasons ca-paywall sends (services/paywall/src/upfront.ts REFUND_REASONS); anything else is refused by name. */
export const REFUND_REASONS = ["over_estimate", "refused", "mandate_refused", "unreachable", "timeout", "bad_result", "bad_request", "already_paying", "canceled", "attestation_not_proven", "owner"] as const;

export type RefundRequest = { invoiceId: string; jobId: string; paidTx: string; network: string; amountUnits: string; reason: string };

/** A request that is malformed: 400, naming the field. */
export class RefundInputError extends Error {}
/** A refund that must not happen (chain mismatch, receipt delivered, another payer): 409, naming why. Nothing moves. */
export class RefundRefused extends Error {}

const FIELDS = ["invoiceId", "jobId", "paidTx", "network", "amountUnits", "reason"] as const;
const CHECKS: Record<(typeof FIELDS)[number], [RegExp, string]> = {
  invoiceId: [/^[A-Za-z0-9_-]{1,100}$/, "the payment's invoice id"],
  jobId: [/^[0-9a-f]{32}$/, "32 lowercase hex characters"],
  paidTx: [/^[1-9A-HJ-NP-Za-km-z]{32,64}$/, "a NEAR transaction hash"],
  network: [/^near:(testnet|mainnet)$/, "near:testnet or near:mainnet"],
  amountUnits: [/^[1-9]\d{0,18}$/, "a positive whole number of USDC base units"],
  reason: [new RegExp(`^(${REFUND_REASONS.join("|")})$`), REFUND_REASONS.join(", ")],
};

/** The request checked against its allowlist: ids and amounts only. */
export function parseRefundRequest(raw: unknown): RefundRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new RefundInputError("$ must be a JSON object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(FIELDS as readonly string[]).includes(k)) throw new RefundInputError(`$.${k} is not accepted: the signer takes ids and amounts only`);
  for (const f of FIELDS) {
    const [re, want] = CHECKS[f];
    if (typeof o[f] !== "string" || !re.test(o[f] as string)) throw new RefundInputError(`$.${f} must be ${want}`);
  }
  return o as RefundRequest;
}

export type RefundDeskSettings = {
  book: RefundBook;
  /** The receipt key: signs every refund record (the buyer pins its public key). */
  receipt: ReceiptSigner;
  network: "near:testnet" | "near:mainnet";
  /** ChainAim's payTo account: receives the payments, sends the refunds. */
  account: string;
  /** Its full-access key (from the environment, never logged). */
  key: NearKey;
  usdcContract: string;
  rpcUrl: string;
  /** The paywall's relayer account: the outer signer of every x402 payment transaction. */
  paidTxSender: string;
  gas: bigint;
  confirmTimeoutMs: number;
  maxAgeSec: number;
  rpcTimeoutMs?: number;
  /** Below this much NEAR (yocto) on the account, health says the refund wallet is low. */
  minYocto?: bigint;
  now?: () => number;
};

export class RefundDesk {
  private readonly s: RefundDeskSettings;
  private readonly now: () => number;
  private readonly rpcMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  /** "ok" / "low" after the last balance read; undefined before one. */
  walletState: "ok" | "low" | undefined;

  constructor(s: RefundDeskSettings) {
    this.s = s;
    this.now = s.now ?? Date.now;
    this.rpcMs = s.rpcTimeoutMs ?? 15_000;
  }

  /** One at a time: each refund reads the access-key nonce and uses the next one. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** The signed record of a refund as it stands. */
  record(r: RefundState): RefundRecord {
    const status = r.status === "refunded" ? "refunded" : "refund_pending";
    const reason = r.status === "refund_failed" ? `refund_failed: ${r.failedReason ?? "unknown"}` : r.reason;
    return signRefund({ status, invoiceId: r.invoiceId, jobId: r.jobId, paidTx: r.paidTx, refundTx: r.status === "refund_failed" ? null : r.refundTx, payer: r.payer, amountUnits: r.amountUnits, network: r.network, reason, at: r.at }, this.s.receipt);
  }

  /** GET /v1/refunds/:invoiceId */
  get(invoiceId: string): RefundRecord | undefined {
    const r = this.s.book.refundOf(invoiceId);
    return r ? this.record(r) : undefined;
  }

  /** GET /v1/refunds (desk.ps1 -Refunds): ids, accounts, amounts and status of every refund; never the transaction bytes. */
  list(): ReturnType<RefundBook["list"]> {
    return this.s.book.list();
  }

  /** POST /v1/refunds. Idempotent per invoice; RefundRefused when the refund must not happen. */
  refund(req: RefundRequest): Promise<RefundRecord> {
    return this.serial(() => this.run(req, false));
  }

  /** Owner (desk.ps1 -Refunds -RefundRetry): a refund that failed is built and sent again, after the same chain checks. */
  retry(invoiceId: string): Promise<RefundRecord> {
    return this.serial(async () => {
      const r = this.s.book.refundOf(invoiceId);
      if (!r) throw new RefundRefused("no refund was asked for this invoice: POST /v1/refunds with its paid transaction");
      if (r.status !== "refund_failed") return this.record(r);
      return this.run({ invoiceId, jobId: r.jobId, paidTx: r.paidTx, network: r.network, amountUnits: r.amountUnits, reason: r.reason }, true);
    });
  }

  private async run(req: RefundRequest, retrying: boolean): Promise<RefundRecord> {
    const book = this.s.book;
    const known = book.refundOf(req.invoiceId);
    if (known && !(retrying && known.status === "refund_failed")) {
      if (known.jobId !== req.jobId || known.paidTx !== req.paidTx || known.amountUnits !== req.amountUnits) throw new RefundRefused("this invoice's refund names another job, payment or amount");
      return this.record(known);
    }
    if (book.delivered(req.jobId, req.invoiceId)) throw new RefundRefused("a receipt was delivered for this job; no refund");
    if (req.network !== this.s.network) throw new RefundRefused(`network must be ${this.s.network}`);
    const claimed = book.invoiceOfPaidTx(req.paidTx);
    if (claimed !== undefined && claimed !== req.invoiceId) throw new RefundRefused("this paid transaction was already refunded for another invoice");

    // The chain, not the caller: the payment, its payer and its amount.
    const paid = await paidTransfer(this.s.rpcUrl, req.paidTx, this.s.paidTxSender, this.rpcMs);
    if (!paid) throw new RefundRefused("paidTx is not on chain (as a transaction of the paywall's relayer)");
    if (!paid.final || !paid.success) throw new RefundRefused("paidTx is not final and successful");
    const toUs = paid.transfers.filter((t) => t.contract === this.s.usdcContract && t.receiverId === this.s.account);
    if (toUs.length !== 1) throw new RefundRefused(`paidTx must hold exactly one USDC ft_transfer to ${this.s.account}, it holds ${toUs.length}`);
    if (toUs[0].amount !== req.amountUnits) throw new RefundRefused("amountUnits is not the amount paidTx transferred");
    const payer = toUs[0].payer;
    const mandate = book.mandateFor(req.invoiceId);
    if (mandate && (mandate.accountId !== payer || mandate.jobId !== req.jobId)) throw new RefundRefused("the payment came from another account or job than the checkout mandate accepted for this invoice");
    const paidAt = await blockTimeMs(this.s.rpcUrl, paid.blockHash, this.rpcMs);
    if (this.now() - paidAt > this.s.maxAgeSec * 1000) throw new RefundRefused(`paidTx is older than ${this.s.maxAgeSec} s (--refund-max-age-sec); ask ChainAim's operator`);

    const ak = await accessKey(this.s.rpcUrl, this.s.account, this.s.key.publicKeyText, this.rpcMs);
    const nonce = ak.nonce + 1n;
    const signed = signFtTransfer({ signerId: this.s.account, key: this.s.key, nonce, blockHash: ak.blockHash, contract: this.s.usdcContract, receiverId: payer, amount: req.amountUnits, memo: `chainaim refund ${req.invoiceId}`, gas: this.s.gas });
    // I3 again after the awaits: a receipt signed meanwhile wins, and nothing is sent.
    if (book.delivered(req.jobId, req.invoiceId)) throw new RefundRefused("a receipt was delivered for this job; no refund");
    book.append({ kind: "refunding", invoiceId: req.invoiceId, jobId: req.jobId, paidTx: req.paidTx, payer, amountUnits: req.amountUnits, network: req.network, reason: req.reason, refundTx: signed.txHash, signedTxB64: signed.signedTxB64, nonce: nonce.toString() });
    await this.finish(req.invoiceId, signed.txHash, () => sendSigned(this.s.rpcUrl, signed.signedTxB64, this.s.confirmTimeoutMs));
    return this.record(book.refundOf(req.invoiceId)!);
  }

  private async finish(invoiceId: string, refundTx: string, send: () => ReturnType<typeof sendSigned>): Promise<void> {
    const out = await send();
    if (out.kind === "success") this.s.book.append({ kind: "refunded", invoiceId, refundTx });
    else if (out.kind === "failed") this.s.book.append({ kind: "refund_failed", invoiceId, reason: out.reason });
  }

  /**
   * Every refund still "refunding": final success → refunded, final failure → refund_failed, unknown to the chain → the
   * stored bytes are sent again (the spent nonce makes a second execution impossible). Also reads the wallet's NEAR.
   */
  sweep(): Promise<void> {
    return this.serial(async () => {
      for (const r of this.s.book.pending()) {
        const seen = await txOutcome(this.s.rpcUrl, r.refundTx, this.s.account, this.rpcMs);
        if (seen?.kind === "success") this.s.book.append({ kind: "refunded", invoiceId: r.invoiceId, refundTx: r.refundTx });
        else if (seen?.kind === "failed") this.s.book.append({ kind: "refund_failed", invoiceId: r.invoiceId, reason: seen.reason });
        else if (seen === undefined) await this.finish(r.invoiceId, r.refundTx, () => sendSigned(this.s.rpcUrl, r.signedTxB64, this.s.confirmTimeoutMs));
      }
      if (this.s.minYocto !== undefined) this.walletState = (await nearBalance(this.s.rpcUrl, this.s.account, this.rpcMs)) < this.s.minYocto ? "low" : "ok";
    });
  }
}
