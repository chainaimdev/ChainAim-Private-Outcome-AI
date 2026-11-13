/**
 * chainaim-paywall: the only public service (spec section 9). It asks for
 * payment (x402, exact scheme, RLUSD on the XRP Ledger through the t54
 * facilitator), then proxies the call to the private gateway with the
 * gateway key. Payment headers are never forwarded, so the gateway cannot
 * learn who paid.
 *
 * Order matters: the body limit and the capacity guard run before the
 * payment middleware, so nobody is asked to pay for a call that cannot be
 * served. The middleware settles only responses below 400, so every refusal
 * is free for the caller.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { xrplOf, type PaywallConfig } from "./config.ts";
import { InvoiceBook, SeenPayments, invoiceIdOf } from "./invoices.ts";
import { JobBook, JobInvoices, jobIdOfPath, parseJob } from "./jobs.ts";
import type { NearRail } from "./near/rail.ts";
import { PAID_ROUTES, routesConfig } from "./routes.ts";
import { createSink, type PaymentSink } from "./sink.ts";
import { requestRefund, UpfrontBook, type RefundReason, type UpfrontPayment } from "./upfront.ts";

/** The same limit as the gateway's default --max-body-bytes. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Gateway response headers passed back to the caller; everything else is dropped. */
const PASS_BACK = /^(content-type|retry-after|x-chainaim-[a-z-]+)$/;
/**
 * Operator-only gateway headers, never passed to the public caller: the masking counts of --expose-entity-counts (adminUI
 * ARCH-203) and the provider attestation evidence of attested deployments (PLAN-private-ai-nearai-attestation.md ARCH-408;
 * the gateway's server.ts ATTEST_HEADERS).
 */
export const NEVER_PASS_BACK: ReadonlySet<string> = new Set([
  "x-chainaim-entity-counts",
  "x-chainaim-residual",
  "x-chainaim-provider-id",
  "x-chainaim-served-model",
  "x-chainaim-req-sha256",
  "x-chainaim-resp-sha256",
  // privateAI-design-41 ARCH-696: the egress receipt line (destination, zone, sent hash, masked counts) is the operator's
  // and the buyer's console's; PASS_BACK would forward it, so it is named here.
  "x-chainaim-egress",
]);

export type PaywallDeps = {
  log?: (line: string) => void;
  now?: () => number;
  maxOpenInvoices?: number;
  /** Monotonic milliseconds for the phase log (PAYWALL_PHASE_LOG); performance.now() by default. */
  clock?: () => number;
  /** The payment log sink; built from config.paymentLog by default, none when that is unset. */
  sink?: PaymentSink;
  /**
   * The NEAR rail (src/near/rail.ts, loadNearRail), required when config.near is
   * set. It is loaded before the app is built, so an XRPL-only paywall never
   * loads @x402/near or @near-js.
   */
  nearRail?: NearRail;
};

/**
 * The resource server with one scheme per enabled rail. XRPL only (PAY_RAILS
 * unset) is built exactly as before rails existed: one t54 facilitator client.
 * With NEAR too, the server gets one facilitator client per rail and picks by
 * network.
 */
function resourceServer(config: PaywallConfig, nearRail: NearRail | undefined): x402ResourceServer {
  const xrpl = config.rails.includes("xrpl") ? xrplOf(config) : undefined;
  const near = config.near;
  if (xrpl && !near) return new x402ResourceServer(new HTTPFacilitatorClient({ url: xrpl.facilitatorUrl })).register(xrpl.network, new ExactXrplScheme());
  const clients: FacilitatorClient[] = [];
  if (xrpl) clients.push(new HTTPFacilitatorClient({ url: xrpl.facilitatorUrl }));
  if (near && nearRail) clients.push(nearRail.facilitator);
  const server = new x402ResourceServer(clients);
  if (xrpl) server.register(xrpl.network, new ExactXrplScheme());
  if (near && nearRail) server.register(near.network, nearRail.scheme);
  return server;
}

/**
 * Marks taken during one request when the phase log is on (P14). The payment
 * middleware verifies, then runs the handler (the gateway call), then settles,
 * so verify = handler start - beforeVerify, gateway = the proxied fetch,
 * settle = afterSettle - handler end. Only the two hooks already used here are
 * relied on.
 */
type PhaseMarks = { capacityMs?: number; verifyAt?: number; gatewayStart?: number; gatewayEnd?: number };

/** The phases of one settled call, whole milliseconds, or undefined when a mark is missing. */
export function settledPhases(marks: PhaseMarks, settledAt: number): Record<string, number> | undefined {
  const { capacityMs, verifyAt, gatewayStart, gatewayEnd } = marks;
  if (verifyAt === undefined || gatewayStart === undefined || gatewayEnd === undefined) return undefined;
  const ms = (n: number): number => Math.max(0, Math.round(n));
  return {
    ...(capacityMs === undefined ? {} : { capacity_ms: ms(capacityMs) }),
    verify_ms: ms(gatewayStart - verifyAt),
    gateway_ms: ms(gatewayEnd - gatewayStart),
    settle_ms: ms(settledAt - gatewayEnd),
  };
}

const SITE_NAME = "PrivacyBuddy";
const OWNER = "ChainAim";
const SITE_DESCRIPTION = "Private AI chat. Sensitive details are masked before any model sees them, and every answer is paid per call in RLUSD on the XRP Ledger with x402.";

/**
 * The root page. The facilitator's Bazaar names a merchant from the HTML at the
 * root of its domain (og:site_name, then og:title, then the title), so this
 * page is what the leaderboard shows. No og:image: no logo was chosen. The
 * trademark sign goes only in the visible body: the title and og tags stay the
 * plain name, so the listing is not renamed.
 */
const ROOT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE_NAME}</title>
<meta name="description" content="${SITE_DESCRIPTION}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${SITE_NAME}">
<meta property="og:description" content="${SITE_DESCRIPTION}">
</head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<h1>${SITE_NAME}™</h1>
<p>${SITE_DESCRIPTION}</p>
<p>This address is the paywall API. <a href="https://chainaim-router.vercel.app">Try it in the browser</a> · <a href="https://github.com/chainaimdev/chainaim-router">Source code</a></p>
<p style="font-size: clamp(.78rem, 2.4vw, .85rem); opacity: .7">© 2026 ${OWNER}. ${SITE_NAME}™ is a trademark of ${OWNER}. All rights reserved. Source-available, not open source: <a href="https://github.com/chainaimdev/chainaim-router/blob/main/LICENSE">License</a></p>
</body>
</html>
`;

function errorBody(c: Context, status: 400 | 401 | 404 | 409 | 410 | 413 | 422 | 502 | 503, message: string, headers: Record<string, string> = {}): Response {
  return c.json({ error: { message, type: status >= 500 ? "gateway_error" : "invalid_request_error", code: status } }, status, headers);
}

/** privateAI-design-36 ARCH-667: the longest checkout mandate header passed on to the console (packages/ap2 MANDATE_MAX_CHARS). */
export const MANDATE_HEADER_MAX = 16_384;

export function createPaywall(config: PaywallConfig, deps: PaywallDeps = {}): Hono {
  const log = deps.log ?? ((line: string) => console.log(line));
  const clock = deps.clock ?? (() => performance.now());
  const phaseLog = config.phaseLog === true;
  const marks = new AsyncLocalStorage<PhaseMarks>();
  const sink = deps.sink ?? (config.paymentLog ? createSink(config.paymentLog) : undefined);
  /** The current request's marks, only when the phase log is on. */
  const mark = (): PhaseMarks | undefined => (phaseLog ? marks.getStore() : undefined);
  const nearRail = deps.nearRail;
  if (config.near && !nearRail) throw new Error("the near rail is enabled (PAY_RAILS) but not loaded: pass deps.nearRail from loadNearRail(config.near)");
  const server = resourceServer(config, nearRail);
  server.registerExtension(bazaarResourceServerExtension as never);
  // A payment is accepted once: a refused call is never settled, so nothing else stops a replay from draining the free-model quota.
  const invoices = new InvoiceBook(config.maxTimeoutSeconds * 1000, deps.now, deps.maxOpenInvoices);
  // NEAR only: a signed delegate names no invoice, so it is also claimed by its hash (invoices.ts, SeenPayments).
  const delegates = nearRail ? new SeenPayments(config.maxTimeoutSeconds * 4000, deps.now, deps.maxOpenInvoices) : undefined;
  // Paid jobs (ARCH-106 to ARCH-110), only with PAID_JOBS=on: ids, amounts and times; never a result.
  const paidJobs = config.paidJobs;
  const jobs = paidJobs ? new JobBook(paidJobs.max, paidJobs.ttlSec * 1000, deps.now) : undefined;
  const jobInvoices = paidJobs ? new JobInvoices(config.maxTimeoutSeconds * 1000, deps.now, deps.maxOpenInvoices) : undefined;
  // privateAI-design-37 ARCH-671: with PAID_JOBS_FLOW=upfront the release is settled before its handler; undefined otherwise.
  const refundSigner = paidJobs?.flow === "upfront" ? paidJobs.refund : undefined;
  const upfront = refundSigner ? new UpfrontBook(config.maxTimeoutSeconds * 4000, deps.now, deps.maxOpenInvoices) : undefined;
  const pathOf = (transportContext: unknown): string | undefined => (transportContext as { request?: { path?: string } } | undefined)?.request?.path;
  server.onBeforeVerify(async (ctx) => {
    const m = mark();
    if (m) m.verifyAt = clock();
    const invoiceId = (ctx.requirements.extra as { invoiceId?: unknown } | undefined)?.invoiceId;
    // A job invoice pays only the job it was issued for (ARCH-109); a signed delegate is still accepted once only.
    if (jobInvoices && typeof invoiceId === "string" && jobInvoices.owns(invoiceId)) {
      const delegate = nearRail?.isNearNetwork(ctx.requirements.network) ? nearRail.delegateKey(ctx.paymentPayload.payload) : undefined;
      if (delegate !== undefined && !delegates!.first(delegate)) return { abort: true, reason: "payment_already_used", message: "this payment was already presented; sign a new one" };
      if (jobInvoices.claim(invoiceId, jobIdOfPath(pathOf(ctx.transportContext)))) return;
      return { abort: true, reason: "payment_already_used", message: "this payment was already presented; sign a new one" };
    }
    const delegate = delegates && nearRail?.isNearNetwork(ctx.requirements.network) ? nearRail.delegateKey(ctx.paymentPayload.payload) : undefined;
    if (delegate !== undefined && !delegates!.first(delegate)) {
      return { abort: true, reason: "payment_already_used", message: "this payment was already presented; sign a new one" };
    }
    if (typeof invoiceId === "string" && invoices.claim(invoiceId)) return;
    return { abort: true, reason: "payment_already_used", message: "this payment was already presented; sign a new one" };
  });
  // NEAR only: a call that was served but whose transfer did not settle is reported once, with ids and the reason, never a body.
  if (nearRail) {
    server.onSettleFailure(async (ctx) => {
      if (!nearRail.isNearNetwork(ctx.requirements.network)) return;
      const request = (ctx.transportContext as { request?: { method?: string; path?: string } } | undefined)?.request;
      // A release that did not settle released nothing (S0-b): the job may be paid again until it expires.
      const failedJob = jobs ? jobIdOfPath(request?.path) : undefined;
      if (failedJob !== undefined) jobs!.endPaying(failedJob);
      const invoiceId = (ctx.requirements.extra as { invoiceId?: unknown } | undefined)?.invoiceId;
      const failed = ctx.error as { errorReason?: unknown; transaction?: unknown } | undefined;
      log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "payment_settle_failed",
          route: `${request?.method ?? "?"} ${request?.path ?? "?"}`,
          amount: ctx.requirements.amount,
          asset: ctx.requirements.asset,
          network: ctx.requirements.network,
          ...(typeof invoiceId === "string" ? { invoiceId } : {}),
          ...(typeof failed?.transaction === "string" && failed.transaction !== "" ? { transaction: failed.transaction } : {}),
          reason: typeof failed?.errorReason === "string" ? failed.errorReason : (ctx.error?.message ?? "unknown").slice(0, 200),
        }),
      );
    });
  }
  // Payment log: one line per settled payment; never a decision id or a body.
  // With the payment log sink on (PAYMENT_LOG_URL / PAYMENT_LOG_FILE) the line also carries the invoice id,
  // ledger-watch's join key to the ledger payment and the buyer's trace, and is handed on without being awaited.
  server.onAfterSettle(async (ctx) => {
    const request = (ctx.transportContext as { request?: { method?: string; path?: string } } | undefined)?.request;
    // ARCH-671: an upfront release settled before its handler is stored by invoice; it is released (and the console told)
    // only after the handler's 200, and refunded after any other answer. The log line says which phase settled it.
    const upfrontJob = upfront && ctx.phase === "before-handler" ? jobIdOfPath(request?.path) : undefined;
    if (upfrontJob !== undefined) {
      const invoiceId = (ctx.requirements.extra as { invoiceId?: unknown } | undefined)?.invoiceId;
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        event: "payment_settled",
        route: `${request?.method ?? "?"} ${request?.path ?? "?"}`,
        amount: ctx.requirements.amount,
        asset: ctx.requirements.asset,
        network: ctx.result.network,
        payer: ctx.result.payer ?? null,
        transaction: ctx.result.transaction,
        ...(typeof invoiceId === "string" ? { invoiceId } : {}),
        phase: "before-handler",
      });
      log(line);
      sink?.send(line);
      if (typeof invoiceId === "string") {
        upfront!.put({
          invoiceId,
          jobId: upfrontJob,
          transaction: ctx.result.transaction,
          payer: ctx.result.payer ?? null,
          network: ctx.result.network,
          amount: ctx.requirements.amount,
          asset: ctx.requirements.asset,
          settledAt: (deps.now ?? Date.now)(),
        });
      }
      return;
    }
    const m = mark();
    const phases = m ? settledPhases(m, clock()) : undefined;
    const invoiceId = sink ? (ctx.requirements.extra as { invoiceId?: unknown } | undefined)?.invoiceId : undefined;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "payment_settled",
      route: `${request?.method ?? "?"} ${request?.path ?? "?"}`,
      amount: ctx.requirements.amount,
      asset: ctx.requirements.asset,
      network: ctx.result.network,
      payer: ctx.result.payer ?? null,
      transaction: ctx.result.transaction,
      ...(typeof invoiceId === "string" ? { invoiceId } : {}),
      ...(phases ? { phases } : {}),
    });
    log(line);
    sink?.send(line);
    // A settled release (ARCH-110): the job is closed here, and the console is told to drop the result.
    const settledJob = jobs ? jobIdOfPath(request?.path) : undefined;
    if (settledJob !== undefined) {
      jobs!.markReleased(settledJob);
      const jobInvoice = (ctx.requirements.extra as { invoiceId?: unknown } | undefined)?.invoiceId;
      // The settlement the console appends to the job's receipt (privateAI-design-32 ARCH-616): ids only, never a body.
      void notifyReleased(settledJob, {
        transaction: ctx.result.transaction,
        network: ctx.result.network,
        payer: ctx.result.payer ?? null,
        ...(typeof jobInvoice === "string" ? { invoiceId: jobInvoice } : {}),
        // privateAI-design-40 ARCH-691: which x402 flow moved the money (signed into the receipt's settlement).
        flow: "authorization",
      });
    }
  });

  /**
   * POST console /internal/jobs/:id/released with the settlement's ids (transaction, network, payer, invoice); a failure
   * is logged with the job id and a reason only (the console's TTL still drops the job).
   */
  async function notifyReleased(jobId: string, settlement: Record<string, unknown>): Promise<void> {
    let reason: string | undefined;
    try {
      const r = await fetch(`${paidJobs!.resultUrl}/internal/jobs/${jobId}/released`, {
        method: "POST",
        headers: { "x-jobs-key": paidJobs!.key, "content-type": "application/json" },
        body: JSON.stringify(settlement),
        signal: AbortSignal.timeout(5000),
      });
      await r.body?.cancel();
      if (!r.ok) reason = `HTTP ${r.status}`;
    } catch (e) {
      reason = (e as Error).name === "TimeoutError" ? "timeout" : "unreachable";
    }
    if (reason !== undefined) log(JSON.stringify({ ts: new Date().toISOString(), event: "job_release_notify_failed", jobId, reason }));
  }

  // ARCH-672 safety net: @x402 cancels a payment whose handler threw or answered >= 400. An upfront settlement the handler
  // did not close (it threw) is refunded here; one it closed is left alone (the signer is idempotent per invoice anyway).
  if (upfront && refundSigner) {
    server.onVerifiedPaymentCanceled(async (ctx) => {
      const invoiceId = (ctx.requirements.extra as { invoiceId?: unknown } | undefined)?.invoiceId;
      const paid = typeof invoiceId === "string" ? upfront.get(invoiceId) : undefined;
      if (!paid || paid.outcome !== undefined) return;
      const refund = await refundOf(paid, "canceled");
      upfront.close(paid.invoiceId, refund.status);
      jobs!.endPaying(paid.jobId);
    });
  }

  /** Asks ChainAim's signer to refund an upfront payment, and logs the outcome with ids only. */
  async function refundOf(paid: UpfrontPayment, reason: RefundReason) {
    const refund = await requestRefund(refundSigner!, { invoiceId: paid.invoiceId, jobId: paid.jobId, paidTx: paid.transaction, network: paid.network, amountUnits: paid.amount, reason }, log);
    log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "job_refund",
        jobId: paid.jobId,
        invoiceId: paid.invoiceId,
        paidTx: paid.transaction,
        status: refund.status,
        reason,
        ...(typeof refund.refundTx === "string" ? { refundTx: refund.refundTx } : {}),
      }),
    );
    return refund;
  }

  /** ARCH-671: the upfront settlement this release request paid with (by the invoice its payment names), while still open. */
  function paidOf(c: Context, jobId: string): UpfrontPayment | undefined {
    if (!upfront) return undefined;
    const invoiceId = invoiceIdOf(c.req.header("payment-signature"));
    const paid = invoiceId === undefined ? undefined : upfront.get(invoiceId);
    return paid && paid.jobId === jobId && paid.outcome === undefined ? paid : undefined;
  }

  /**
   * The 200 of a release. Authorization flow: as before (the middleware settles it, then onAfterSettle releases). Upfront
   * (ARCH-671): the money already settled, so the job is released here and the console told with the stored settlement.
   */
  function delivered(c: Context, jobId: string, result: unknown): Response {
    const paid = paidOf(c, jobId);
    if (paid) {
      jobs!.markReleased(jobId);
      upfront!.close(paid.invoiceId, "released");
      void notifyReleased(jobId, { transaction: paid.transaction, network: paid.network, payer: paid.payer, invoiceId: paid.invoiceId, flow: "upfront" });
    }
    return c.json(result as object, 200);
  }

  /**
   * Every refusal of a release (ARCH-672). Authorization flow: today's body, "...; you were not charged", nothing settles.
   * Upfront: the payment already moved, so ChainAim's signer is asked for the refund before answering, and the body carries
   * its refund record. began = this request holds the job's paying mark (false for a second payment refused with 409).
   */
  async function answerUnpaid(c: Context, jobId: string, status: 400 | 409 | 422 | 502, message: string, reason: RefundReason, began = true): Promise<Response> {
    const paid = paidOf(c, jobId);
    if (!paid) {
      if (began) jobs!.endPaying(jobId);
      return errorBody(c, status, `${message}; you were not charged`);
    }
    const refund = await refundOf(paid, reason);
    upfront!.close(paid.invoiceId, refund.status);
    if (began) jobs!.endPaying(jobId);
    const said =
      refund.status === "refunded" ? `was refunded in ${refund.refundTx}`
      : refund.status === "refund_pending" ? `is being refunded (GET /v1/refunds/${paid.invoiceId})`
      : `was not refunded automatically (${refund.reason ?? "refused"}); ChainAim's operator settles it by hand`;
    return c.json({ error: { message: `${message}; your payment ${paid.transaction} ${said}`, type: status >= 500 ? "gateway_error" : "invalid_request_error", code: status }, refund }, status);
  }

  /** The x-jobs-key header equals PAID_JOBS_KEY (constant time). */
  const jobsKeyOk = (c: Context): boolean => {
    const given = Buffer.from(c.req.header("x-jobs-key") ?? "", "utf8");
    const want = Buffer.from(paidJobs!.key, "utf8");
    return given.length === want.length && timingSafeEqual(given, want);
  };

  /**
   * The paid release handler: read the held result from the console, or for an estimate-first offer (privateAI-design-34
   * ARCH-637) have the console run it now. The payment middleware verified the payment before this handler and settles only
   * a 2xx after it, so a run that fails, is refused or goes over its estimate settles nothing (design-32 ARCH-611 void rule).
   * Only a 200 is settled, and only a settled one is sent (S0-b).
   */
  async function release(c: Context): Promise<Response> {
    const jobId = jobIdOfPath(c.req.path)!;
    if (!jobs!.beginPaying(jobId)) return answerUnpaid(c, jobId, 409, "this job is already being paid or was released", "already_paying", false);
    if (jobs!.isRun(jobId)) return runOffer(c, jobId);
    let held: { jobId?: unknown; result?: unknown };
    try {
      const r = await fetch(`${paidJobs!.resultUrl}/internal/jobs/${jobId}`, { headers: { "x-jobs-key": paidJobs!.key }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) {
        await r.body?.cancel();
        throw new Error(`HTTP ${r.status}`);
      }
      held = (await r.json()) as { jobId?: unknown; result?: unknown };
      if (held?.jobId !== jobId || held.result === undefined) throw new Error("not the job asked for");
    } catch {
      return answerUnpaid(c, jobId, 502, "the job's result could not be read", "bad_result");
    }
    return delivered(c, jobId, held.result);
  }

  /**
   * ARCH-637: POST console /internal/jobs/:id/run; its refusal (409 over the estimate, 422 no result) passes on unsettled.
   * privateAI-design-36 ARCH-667: the run notice carries the invoice id the verified payment names and, when the buyer's
   * agent sent one, its AP2 checkout mandate (header x-ap2-checkout-mandate, passed as it came). The paywall checks
   * neither: ChainAim's signer verifies the mandate in the run step, and a refusal there (422) settles nothing here.
   */
  async function runOffer(c: Context, jobId: string): Promise<Response> {
    const timeoutMs = (paidJobs!.runTimeoutSec ?? 300) * 1000;
    const invoiceId = invoiceIdOf(c.req.header("payment-signature"));
    const mandate = c.req.header("x-ap2-checkout-mandate");
    if (mandate !== undefined && (mandate.length > MANDATE_HEADER_MAX || !/^[A-Za-z0-9_.~-]+$/.test(mandate))) {
      return answerUnpaid(c, jobId, 400, `x-ap2-checkout-mandate must be an SD-JWT presentation of at most ${MANDATE_HEADER_MAX} characters`, "bad_request");
    }
    // ARCH-671: with upfront, the run notice also names the settled payment (ids only).
    const paid = paidOf(c, jobId);
    const notice = JSON.stringify({ ...(invoiceId ? { invoiceId } : {}), ...(mandate ? { checkoutMandate: mandate } : {}), ...(paid ? { paidTx: paid.transaction, ...(paid.payer ? { payer: paid.payer } : {}) } : {}) });
    let r: Response;
    try {
      r = await fetch(`${paidJobs!.resultUrl}/internal/jobs/${jobId}/run`, { method: "POST", headers: { "x-jobs-key": paidJobs!.key, "content-type": "application/json" }, body: notice, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      return answerUnpaid(c, jobId, 502, timedOut ? `the job did not finish within ${timeoutMs / 1000} s` : "the console could not be reached to run the job", timedOut ? "timeout" : "unreachable");
    }
    let body: { jobId?: unknown; result?: unknown; error?: unknown; code?: unknown } | null;
    try { body = (await r.json()) as typeof body; } catch { body = null; }
    if (r.status === 409 || r.status === 422) {
      const why = typeof body?.error === "string" ? body.error : "the job could not be run as estimated";
      // privateAI-design-39 ARCH-689: the console's 422 code attestation_not_proven (--pay-only-attested verified) is its own reason.
      const reason: RefundReason = r.status === 409 ? "over_estimate" : body?.code === "attestation_not_proven" ? "attestation_not_proven" : /mandate|AP2/i.test(why) ? "mandate_refused" : "refused";
      return answerUnpaid(c, jobId, r.status as 409 | 422, why, reason);
    }
    if (r.status !== 200 || body?.jobId !== jobId || body.result === undefined) {
      return answerUnpaid(c, jobId, 502, "the job's result could not be read", "bad_result");
    }
    return delivered(c, jobId, body.result);
  }

  /**
   * Forward the method, path, content type and body; pass back the status,
   * body and allowed headers. A caller who hangs up cancels the gateway call,
   * so the answer is a 502 and nothing is settled.
   */
  async function proxy(c: Context): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${config.gatewayKey}` };
    const type = c.req.header("content-type");
    if (type) headers["content-type"] = type;
    const signal = AbortSignal.any([AbortSignal.timeout(config.gatewayTimeoutMs), c.req.raw.signal]);
    const init: RequestInit = { method: c.req.method, headers, signal };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") init.body = await c.req.arrayBuffer();
    let upstream: Response;
    const m = mark();
    if (m) m.gatewayStart = clock();
    try {
      upstream = await fetch(`${config.gatewayUrl}${c.req.path}`, init);
    } catch {
      return errorBody(c, 502, "the gateway did not answer; you were not charged");
    } finally {
      if (m) m.gatewayEnd = clock();
    }
    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (PASS_BACK.test(name) && !NEVER_PASS_BACK.has(name)) out.set(name, value);
    });
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  const app = new Hono();
  // One set of marks per request, read by the hooks above through the async context.
  if (phaseLog) app.use((_c, next) => marks.run({}, () => next()));
  app.use(bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => errorBody(c, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`) }));

  // Capacity guard: no price is shown for a chat call that cannot be served now.
  app.use("/v1/chat/completions", async (c, next) => {
    if (c.req.method !== "POST") return next();
    let capacity: { chatAvailable?: unknown; reason?: unknown; retryAfterSec?: unknown };
    const m = mark();
    const asked = clock();
    try {
      const r = await fetch(`${config.gatewayUrl}/internal/capacity`, {
        headers: { authorization: `Bearer ${config.gatewayKey}` },
        signal: AbortSignal.timeout(5000),
      });
      capacity = r.ok ? await r.json() : { reason: `gateway HTTP ${r.status}` };
    } catch {
      capacity = { reason: "gateway unreachable" };
    }
    if (m) m.capacityMs = clock() - asked;
    if (capacity.chatAvailable === true) return next();
    const retryAfter = typeof capacity.retryAfterSec === "number" && capacity.retryAfterSec > 0 ? String(Math.ceil(capacity.retryAfterSec)) : "60";
    const reason = typeof capacity.reason === "string" ? capacity.reason : "no capacity";
    return errorBody(c, 503, `chat is unavailable right now (${reason}); you were not charged`, { "retry-after": retryAfter });
  });

  if (jobs && paidJobs) {
    // Job intake from the test console (ARCH-106): the key, then each field; nothing of the body is logged.
    app.post("/internal/jobs", async (c) => {
      if (!jobsKeyOk(c)) return errorBody(c, 401, "x-jobs-key is missing or wrong");
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorBody(c, 400, "body must be JSON");
      }
      const job = parseJob(body, (deps.now ?? Date.now)(), paidJobs.ttlSec, paidJobs.clockSkewSec ?? 0);
      if ("error" in job) return errorBody(c, 400, job.error);
      const stored = jobs.register(job);
      if (stored === "full") return errorBody(c, 503, `${paidJobs.max} jobs are open (PAID_JOBS_MAX); try again later`);
      if (stored === "exists") return errorBody(c, 409, "this jobId is already registered");
      return c.json({ jobId: job.jobId, amount: job.amount, expiresAt: job.expiresAt }, 201);
    });
    // Release guard (ARCH-107), before the payment middleware: nobody is asked to pay for a job that cannot be released.
    app.use("/v1/jobs/:id/release", async (c, next) => {
      if (c.req.method !== "POST") return next();
      const jobId = jobIdOfPath(c.req.path);
      const state = jobId === undefined ? "unknown" : jobs.state(jobId);
      if (state === "unknown") return errorBody(c, 404, "no such job; nothing was charged");
      if (state === "expired") return errorBody(c, 410, "this job has expired; run it again. Nothing was charged");
      if (state === "released") return errorBody(c, 409, "this job was already paid and released");
      return next();
    });
  }

  app.use(
    paymentMiddleware(
      jobs && jobInvoices
        ? routesConfig(config, (paymentHeader) => invoices.forRequest(paymentHeader), {
            amountOf: (jobId) => jobs.amountOf(jobId),
            invoiceFor: (jobId, paymentHeader) => jobInvoices.forRequest(jobId, paymentHeader),
            jobIdOf: jobIdOfPath,
          })
        : routesConfig(config, (paymentHeader) => invoices.forRequest(paymentHeader)),
      server,
    ),
  );

  for (const route of PAID_ROUTES) app.post(route.path, proxy);
  if (jobs) app.post("/v1/jobs/:id/release", release);
  // ARCH-672: the refund record of an upfront release, from ChainAim's signer (no payment; ids and amounts only).
  if (refundSigner) {
    app.get("/v1/refunds/:invoiceId", async (c) => {
      const invoiceId = c.req.param("invoiceId");
      if (!/^[0-9A-F]{32}$/.test(invoiceId)) return errorBody(c, 404, "no refund for this invoice");
      let r: Response;
      try {
        r = await fetch(`${refundSigner.url}/v1/refunds/${invoiceId}`, { headers: { "x-signer-key": refundSigner.key }, signal: AbortSignal.timeout(refundSigner.timeoutMs) });
      } catch {
        return errorBody(c, 502, "ChainAim's signer could not be reached; ask again later");
      }
      if (r.status === 404) { await r.body?.cancel(); return errorBody(c, 404, "no refund for this invoice"); }
      let body: unknown;
      try { body = await r.json(); } catch { body = undefined; }
      if (r.status !== 200 || typeof body !== "object" || body === null) return errorBody(c, 502, "ChainAim's signer gave no refund record; ask again later");
      return c.json(body as object, 200);
    });
  }
  app.get("/", (c) => c.html(ROOT_PAGE));
  app.get("/v1/models", proxy);
  app.get("/healthz", proxy);
  app.notFound((c) => errorBody(c, 404, `no route for ${c.req.method} ${c.req.path}`));
  return app;
}
