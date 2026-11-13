/**
 * The agent checks the receipt of the job it just paid for (privateAI-design-32 step B; ARCH-613 "the console signs, the
 * buyer's agent verifies with the same code", ARCH-615 receipt fetched from GET <console>/jobs/<id>/receipt, ARCH-616
 * settlement). Design: DESIGN/privateAI-design-32b-AGENT-RECEIPT-VERIFY-2026-11-10T2245.md.
 *
 * The key is PINNED: the agent verifies with the public key from --receipt-public-key (default
 * config/receipt-public-key.pem, committed to the repository, exported by desk.ps1 -ReceiptKey), never with the
 * publicKeyPem the console sends beside the receipt. A console holding another key cannot produce a receipt this agent
 * accepts.
 *
 * On top of packages/receipt verifyReceipt (body shape, Ed25519 body signature, settlement signature, and
 * sha256(canonical released result) == resultSha256), the agent binds the receipt to what it saw itself: the job id it ran,
 * the amount it was quoted and capped its signer at, and the NEAR transaction it paid with.
 *
 * The console builds the receipt just after the release and never awaits it, so the agent asks up to pollMax times,
 * pollMs apart (the page uses 1000 ms x 15). It also keeps asking while the receipt has no settlement yet; after the last
 * try an unsettled but valid receipt is reported as verified with settled: false.
 *
 * The payment has already gone through when this runs, so a failed check is reported (event receipt_failed with a
 * reason), never a refusal, and the run still ends with done. Nothing here throws to the caller.
 */
import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { keyIdOf, verifyReceipt, type SignedReceipt } from "../../../packages/receipt/src/index.ts";

/** The agent's receipt check, from the --receipt-* flags of agent-jobs.ts. */
export type ReceiptCheck = {
  /** The pinned console public key (SPKI PEM, Ed25519). */
  publicKeyPem: string;
  /** keyIdOf(publicKeyPem), shown at start-up and in the event. */
  keyId: string;
  /** Where the pinned key came from (for messages only). */
  keyPath: string;
  /** Milliseconds between two asks (default 1000). */
  pollMs: number;
  /** Most asks before giving up (default 15). */
  pollMax: number;
  /** Timeout of one GET (default 5000). */
  fetchTimeoutMs: number;
};

export type ReceiptEvent =
  /** mandateSha256 (privateAI-design-36 ARCH-668): the checkout mandate the receipt records as verified, when it records one. */
  | { type: "receipt_verified"; jobId: string; receiptId: string; keyId: string; settled: boolean; transaction?: string; mandateSha256?: string }
  | { type: "receipt_failed"; jobId: string; reason: string };

/** What the agent itself knows about the job it paid for. */
export type PaidJob = { jobId: string; amount: string; transaction: string; result: unknown };

/**
 * The pinned key from `path`, checked to be an Ed25519 public key. Throws an Error naming the path and what to run,
 * never a key value.
 */
export function loadPinnedKey(path: string): { publicKeyPem: string; keyId: string } {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`the pinned receipt public key ${path} could not be read (${(e as NodeJS.ErrnoException).code ?? "unreadable"}): export it with .\\test-console\\desk.ps1 -ReceiptKey`);
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error(`${path} is not a PEM public key: export it again with .\\test-console\\desk.ps1 -ReceiptKey`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} is not an Ed25519 public key`);
  return { publicKeyPem: key.export({ type: "spki", format: "pem" }).toString(), keyId: keyIdOf(key) };
}

const sleepMs = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

type Ask = { receipt: SignedReceipt } | { retry: string } | { stop: string };

/** One GET <console>/jobs/<id>/receipt. Only {receipt} is read from the answer; its publicKeyPem is ignored (pinned key). */
async function askOnce(consoleUrl: string, jobId: string, timeoutMs: number): Promise<Ask> {
  let r: Response;
  try {
    r = await fetch(`${consoleUrl}/jobs/${jobId}/receipt`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { retry: `the console could not be reached at ${consoleUrl} (${(e as Error).name})` };
  }
  const j = (await r.json().catch(() => null)) as { receipt?: unknown; error?: unknown } | null;
  if (r.status === 404 && typeof j?.error === "string" && /receipts are off/.test(j.error)) {
    return { stop: "the console has receipts off (desk.ps1 -ReceiptKey, then start again), so there is no receipt to check" };
  }
  if (!r.ok) return { retry: `the console answered HTTP ${r.status}${typeof j?.error === "string" ? `: ${j.error.slice(0, 200)}` : ""}` };
  const rc = j?.receipt as SignedReceipt | undefined;
  if (typeof rc !== "object" || rc === null || typeof rc.body !== "object" || rc.body === null || typeof rc.sig !== "object" || rc.sig === null) {
    return { stop: "the console's receipt could not be read" };
  }
  return { receipt: rc };
}

/** Checks one receipt against the pinned key and the agent's own view of the job; a reason when it does not hold. */
export function checkReceipt(receipt: SignedReceipt, check: Pick<ReceiptCheck, "publicKeyPem">, paid: PaidJob): { ok: true; settled: boolean } | { ok: false; reason: string } {
  const v = verifyReceipt(receipt, check.publicKeyPem, paid.result);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (receipt.body.jobId !== paid.jobId) return { ok: false, reason: "the receipt is for another job" };
  if (receipt.body.price.amountUnits !== paid.amount) return { ok: false, reason: `the receipt's amount (${receipt.body.price.amountUnits} units) is not the amount paid (${paid.amount} units)` };
  if (receipt.settlement && receipt.settlement.transaction !== paid.transaction) return { ok: false, reason: "the receipt's settlement names another transaction than the one the agent paid with" };
  return { ok: true, settled: receipt.settlement !== undefined };
}

/**
 * Fetches and checks the receipt of a paid job. Returns the event to emit; never throws. `sleep` is for the tests.
 */
export async function verifyPaidReceipt(check: ReceiptCheck, consoleUrl: string, paid: PaidJob, sleep: (ms: number) => Promise<void> = sleepMs): Promise<ReceiptEvent> {
  const failed = (reason: string): ReceiptEvent => ({ type: "receipt_failed", jobId: paid.jobId, reason });
  let lastProblem = "no receipt yet";
  let unsettled: { receipt: SignedReceipt } | undefined;
  for (let n = 1; n <= check.pollMax; n++) {
    if (n > 1) await sleep(check.pollMs);
    const a = await askOnce(consoleUrl, paid.jobId, check.fetchTimeoutMs);
    if ("stop" in a) return failed(a.stop);
    if ("retry" in a) { lastProblem = a.retry; continue; }
    const c = checkReceipt(a.receipt, check, paid);
    if (!c.ok) return failed(c.reason);
    if (!c.settled) { unsettled = a; lastProblem = "the receipt has no settlement yet"; continue; }
    return { type: "receipt_verified", jobId: paid.jobId, receiptId: a.receipt.body.receiptId, keyId: check.keyId, settled: true, transaction: paid.transaction, ...(a.receipt.body.mandate ? { mandateSha256: a.receipt.body.mandate.sha256 } : {}) };
  }
  if (unsettled) return { type: "receipt_verified", jobId: paid.jobId, receiptId: unsettled.receipt.body.receiptId, keyId: check.keyId, settled: false, ...(unsettled.receipt.body.mandate ? { mandateSha256: unsettled.receipt.body.mandate.sha256 } : {}) };
  return failed(`no receipt after ${check.pollMax} tries ${check.pollMs} ms apart (last: ${lastProblem}); the console log names the reason as job_receipt_failed`);
}
