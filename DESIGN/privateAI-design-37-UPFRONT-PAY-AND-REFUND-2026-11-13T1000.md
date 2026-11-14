# privateAI-design-37: pay before work, automatic refund (x402 `upfront` + signer refunds)

Chat near-ai-impl-11, 2026-11-13 ~10:00Z. Item 1 of the near-ai-impl-11 must-do table. Status: DESIGN, not built.
Release target: v2.1.0 (with design-38..41). ARCH-670..679.

Punchline: **"ChainAim never works unpaid; you never pay for a failed job."**

## 0. Sources read (Rule 4 / Rule 8)

- `services/paywall/src/app.ts` 150-262 (onBeforeVerify, onSettleFailure, onAfterSettle, notifyReleased), 265-330
  (release, runOffer); `services/paywall/src/routes.ts` 228-242 (job release price); `services/paywall/src/config.ts`
  (PAID_JOBS block 361-370, NEAR RPC 47-48, 308-309).
- `services/paywall/node_modules/@x402/core/dist/cjs/server/index.js` 428-500: PAYMENT_FLOWS (`authorization`: verify
  before, settle after; `upfront`: settle before, not after; `escrow`), `resolvePaymentFlow` (flow from
  `requirements.extra.paymentFlow`, must be in the scheme's `supported`), `resolveFailurePathSettlement` (on failure the
  before-handler settlement is echoed).
- DESIGN-REF/near-hackathon-session-2026-11-13T0827Z.md §7-8 (read earlier: `@x402/near` exact server supports
  ["authorization","upfront"]; facilitator accepts one `ft_transfer` to payTo only; settle() re-runs verify();
  onVerifiedPaymentCanceled fires on handler status >= 400 after an upfront settle).
- `test-console/console/server.ts` 376-440 (runOffer: mandate verify, basis checks, 409/422 refusals).
- `services/paywall/scripts/agent-jobs-core.ts` 440-470 (agent: tx taken when receipt.success; non-200 → fail).
- `packages/signer/src/index.ts` (SellerSigner: price, signQuote, verifyMandate with in-memory nonce set, signReceipt,
  settle); `services/signer/src/main.ts` (routes table, X-Signer-Key, zero npm deps); `services/signer/compose.yml`
  (no volume today).
- `packages/observer/src/index.ts` (zero-dependency NEP-366 payment decoder over public RPC, archival fallback).
- `services/paywall/package.json`: `@near-js/*` 2.5.1, `@x402/*` 2.29.0.

## 1. Problem

Today (`app.ts:273-276`, design-32 ARCH-611): verify the payment → run the job → settle only a 2xx. The buyer is fully
protected. ChainAim is not: the signed NEP-366 delegate is an uncashed cheque. Between verify and settle the buyer can
move the USDC out (or the delegate can expire), and ChainAim has already done the priced local work (DuckDB, ERPNext,
masking, NEAR AI tokens on ChainAim's key). Owner decision 2026-11-13: money reaches ChainAim before any work; no one can
dupe the other.

## 2. Target behaviour

| Case | Money | Buyer sees | ChainAim keeps |
|---|---|---|---|
| Run succeeds (200) | buyer → ChainAim before the run | result + receipt (paid tx) | the payment |
| Run refused/fails (409, 422, 5xx, timeout) | buyer → ChainAim, then ChainAim → buyer (same amount) | error + signed refund record (paid tx, refund tx) | nothing (pays NEAR gas for the refund) |
| Refund transfer cannot complete now | as above, refund retried by the signer | `refund_pending` + signed record; `GET /v1/refunds/:invoiceId` | nothing once retried |
| Mandate refused / limits exceeded / unattested (design-38, -39) | refunded | as refused | nothing |

Default stays `authorization` (today). `upfront` is opt-in by flag.

## 3. Architecture

```
 agent (tenant key)          ca-paywall (x402)                    ca-console-api            ca-control-signer (ChainAim)
 ─────────────────          ─────────────────                    ──────────────            ─────────────────────────────
 POST release ──────────▶ 402 extra{invoiceId, paymentFlow:upfront}
 policy, mandate, delegate ─▶ beforeVerify (invoice/replay)
                             settle BEFORE handler ──▶ NEAR (relayer submits ft_transfer buyer→payTo)
                             onAfterSettle phase=before-handler: store paid{tx,payer,network} by invoice
                             runOffer ── /internal/jobs/:id/run {invoiceId, mandate, paid} ─▶ mandate verify (signer)
                                                                                         run, signReceipt (signer)
                             200 ◀──────────────────────────────────────────────────────
                               markReleased, notifyReleased ─▶ console ─▶ /v1/receipts/settle (signer: "delivered")
                             409/422/5xx ─▶ POST /v1/refunds ───────────────────────────────────────────▶ checks paid tx on
                               (own signer client)                                                         chain (observer),
                                                                                                           ft_transfer back
                             ◀── signed refund record ──────────────────────────────────────────────────── (seller key)
 ◀── 409/422 {error, refund{status, paidTx, refundTx, amountUnits, sig}} + PAYMENT-RESPONSE (paid tx)
 verify refund sig (pinned receipt key) → state refunded | refund_pending
```

Why the paywall calls the signer for refunds directly (not through the console): the refund must work when the console
is the thing that failed (timeout, crash, 502). Safety does not depend on the paywall: the signer re-checks the payment on
chain and can only send the paid amount back to the account that paid it.

## 4. ARCH-IDs

| ARCH | What | Where |
|---|---|---|
| ARCH-670 | `PAID_JOBS_FLOW=authorization\|upfront` (default authorization); job release price sets `extra.paymentFlow` only when upfront; start-up refuses `upfront` without a refund signer | paywall `config.ts`, `routes.ts:236`; up.ps1 `-PaidJobsFlow`; desk.ps1/desk.json `paywall.paidJobsFlow` |
| ARCH-671 | phase-aware settle hooks: `before-handler` stores `{transaction, payer, network, invoiceId, settledAt}` on the job (JobBook `setPaid/paidOf`), logs `payment_settled` with `phase`; markReleased + notifyReleased move into runOffer/release on 200 | paywall `app.ts`, `jobs.ts` |
| ARCH-672 | run notice carries `paid` so the console/receipt know the paid tx before the run | paywall `runOffer`; console `jobs.ts parseRunNotice` (allowlist), `server.ts runOffer` |
| ARCH-673 | signer refund API: `POST /v1/refunds`, `GET /v1/refunds/:invoiceId` (X-Signer-Key, strict allowlist) | `packages/signer` (RefundBook, parseRefundRequest), `services/signer/src/main.ts` |
| ARCH-674 | refund rules: paid on chain (observer) to payTo, asset, amount = quote, payer = mandate account; not delivered; at most once; job `refunding` blocks settle(); caps | `packages/signer` |
| ARCH-675 | refund executor: NEP-141 `ft_transfer` from the seller (payTo) account, 1 yoctoNEAR, 30 Tgas, memo `chainaim refund <invoiceId>`; send-intent persisted before broadcast; retry loop | new `packages/near-refund` (uses `@near-js/*` 2.5.1, same pins as the paywall) |
| ARCH-676 | persistence: `/data` volume, atomic JSON files (refund records, delivered set, refunding set, mandate payer per job, accepted mandate nonces) | `services/signer` compose volume `ca-control-signer-data`; RefundBook |
| ARCH-677 | signed refund record (Ed25519, receipt key, same keyId as receipts) + `verifyRefund()` | `packages/receipt` (or `packages/signer`), `scripts/verify-receipt.ts --refund FILE` |
| ARCH-678 | paywall refund path: on 409/422/5xx/timeout after an upfront settle, POST /v1/refunds, answer `{error, refund}`; `onVerifiedPaymentCanceled` safety net when the handler threw | paywall `app.ts`, new `refund-client.ts` |
| ARCH-679 | agent + UI: terminal states `refunded` / `refund_pending`, refund signature checked with the pinned receipt key, spend ledger counts pending refunds until refunded; page "paid → refused → refunded" with both tx links; job feed event `job_refunded` (ids/amounts only) | `agent-jobs-core.ts`, `paid-jobs.html`, `job-feed.ts`, near-watch accepts the new event (adminUI repo, optional) |

## 5. Workflows in detail

### 5.1 Quote and 402 (ARCH-670)
- `routes.ts` price(): `extra: { invoiceId, ...(paidJobs.flow === "upfront" ? { paymentFlow: "upfront" } : {}) }`.
  `applyPaymentFlowWireExtra` writes `paymentFlow` on the wire only for non-`authorization` flows (read in core).
- Client side needs no change (session record §7: `near-payment.ts` echoes the offer; `near.ts:179-188` reads
  PAYMENT-RESPONSE on every status). The delegate is still one `ft_transfer`, so the stock facilitator accepts it.

### 5.2 Settle before the run (ARCH-671/672)
- Core: `upfront` has `verifyBeforeHandler: false` → our `onBeforeVerify` hooks still run (invoice ownership, replay
  by delegate hash: kept). Settle runs `verify()` inside the facilitator, then submits through the relayer.
- `onAfterSettle(ctx)`: read the phase from ctx. `before-handler` → `jobs.setPaid(jobId, {transaction, payer, network,
  invoiceId, settledAt})`, payment log line with `phase: "before-handler"`, NO markReleased, NO notifyReleased.
  `after-handler` (authorization flow) → unchanged behaviour.
- `onSettleFailure` before the handler: the payment did not happen → endPaying, 402/502 "you were not charged" (unchanged).
- runOffer adds `paid` to the notice. The console stores it on the offer so a later receipt/settlement can be checked.

### 5.3 Success (200)
- Paywall: `jobs.markReleased(jobId)`, `notifyReleased(jobId, paid)` (the console appends the settlement and calls the
  signer's `/v1/receipts/settle`, which records the job as **delivered**), return the result. PAYMENT-RESPONSE carries
  the before-handler settlement (core).

### 5.4 Refusal or failure (ARCH-678)
- Triggers in runOffer: console 409, 422, non-200/502, fetch timeout, unreadable body.
- Paywall → signer `POST /v1/refunds` with `{jobId, invoiceId, network, paidTx, payer, amountUnits, reason}` where
  reason ∈ `over_estimate | no_result | mandate_refused | limits_exceeded | not_attested | console_unreachable |
  run_timeout | result_unreadable`.
- Answer to the buyer: same status as today, body `{ error: "<why>; your payment was refunded" | "...; the refund is
  pending", refund: <signed refund record> }`.
- If the signer is unreachable: body `refund: { status: "refund_requested_failed", paidTx, invoiceId }`, a log line
  `refund_request_failed`, and the paywall retries the POST (in-memory queue, `PAID_JOBS_REFUND_RETRY_SEC`, default 30,
  for the job TTL). The record on the signer is the source of truth; the agent polls `GET /v1/refunds/:invoiceId`
  through the paywall route `GET /v1/jobs/:id/refund` (new, no payment).
- Safety net: `server.onVerifiedPaymentCanceled` (phase "cancel") — if no refund was requested for that invoice (the
  handler threw before our code could), request it there.

### 5.5 Signer refund rules (ARCH-673/674)
Order of checks, each with a stable code:
1. Request shape (strict allowlist, `onlyFields`) → 400.
2. Already a record for `invoiceId` → return it, 200 (idempotent). Same invoice with different fields → 409 `refund_mismatch`.
3. Job delivered (settle() was called) → 409 `refund_refused_delivered`.
4. On-chain check with `packages/observer` `observe({network, transaction: paidTx, payer})`: final and successful;
   token contract = configured USDC; receiver = configured payTo (= seller account); amount = `amountUnits`;
   payer = the mandate's accountId recorded at `verifyMandate` for this job (when mandates are on), else the chain payer.
   Any mismatch → 422 `refund_unverified_payment` (nothing sent).
5. Caps: `--refund-max-units` per refund (default 1000000 = 1 USDC), `--refund-daily-max-units` (default 5000000).
   Over → 429 `refund_cap` (record kept as `refund_pending`, needs the owner). Limits a stolen request key.
6. Mark the job `refunding` (persisted). From now `settle()` for this job throws 409: no result can be released.
7. Execute (5.6) → `refunded` or `refund_pending`. Sign and persist the record. Answer 200 with it.

Race rule: "delivered" = settle() was called (the paywall saw a 200). A run that finished after the paywall gave up is
never released (no notifyReleased), so refunding it is correct.

### 5.6 Refund executor (ARCH-675)
- Transaction: signer_id = seller account (the payTo account that holds the money), receiver = USDC contract,
  action FunctionCall `ft_transfer {receiver_id: payer, amount: amountUnits, memo}`, deposit 1 yoctoNEAR, gas 30 Tgas.
- Key: `SELLER_NEAR_PRIVATE_KEY` (env, from the seller secrets folder). NEP-141 `ft_transfer` requires an attached
  deposit of exactly 1 yoctoNEAR, and function-call access keys cannot attach a deposit, so this must be a
  **full-access key** of the seller account. [Standard as I know it; re-read the NEP-141 / access-key docs before
  coding — Rule 4.]
- Double-send guard: build and sign the tx, compute its hash, persist `{state: "sending", refundTx: hash, nonce,
  blockHash}`, then `send_tx` with `wait_until: FINAL`. On restart a `sending` record is checked by tx status first; it
  is re-built only when the tx is unknown and its block hash has expired.
- Retry: `refund_pending` records are retried every `--refund-retry-sec` (default 60) up to `--refund-max-attempts`
  (default 20), then stay pending for the owner (log + healthz count).
- The recipient is the payer that just sent USDC, so it is already registered on the USDC contract (no storage_deposit).

### 5.7 Refund record (ARCH-677)
```json
{ "body": { "v": 1, "kind": "chainaim.refund", "refundId": "<32 hex>", "jobId": "...", "invoiceId": "...",
  "network": "near:testnet", "asset": "<usdc contract>", "payer": "...", "payTo": "...", "amountUnits": "20000",
  "paidTx": "...", "refundTx": "..." , "status": "refunded", "reason": "no_result",
  "createdAt": "...", "updatedAt": "..." },
  "sig": { "alg": "ed25519", "keyId": "d27d1e9f...", "value": "..." } }
```
Signed over `canonicalJson(body)` with the receipt key, so the agent and `verify-receipt` reuse the pinned key.

### 5.8 Agent and page (ARCH-679)
- `agent-jobs-core.ts`: on 409/422/5xx with a `refund` body: verify the signature and that `paidTx` = the
  PAYMENT-RESPONSE transaction and `amountUnits` = what it signed. Emit `refunded {paidTx, refundTx}` or
  `refund_pending {paidTx}`; exit code distinguishes "refused, refunded" from "failed".
- Spend ledger (`--policy`): `refunded` → not counted; `refund_pending` → counted until a later poll shows refunded.
- `paid-jobs.html`: steps "Paid ✓ (before any work) → Refused: <reason> → Refunded ✓ <refund tx ↗>".
- Job feed: `job_refunded {jobId, invoiceId, amountUnits, paidTx, refundTx, status}` (ids and amounts only).

## 6. Configuration (all flags, defaults keep today's behaviour)

| Where | Flag / env | Default |
|---|---|---|
| paywall | `PAID_JOBS_FLOW` authorization\|upfront | authorization |
| paywall | `PAID_JOBS_REFUND_SIGNER_URL`, `PAID_JOBS_REFUND_KEY_ENV` (name of env holding the signer request key), `PAID_JOBS_REFUND_TIMEOUT_MS`, `PAID_JOBS_REFUND_RETRY_SEC` | unset (required with upfront), SIGNER_REQUEST_KEY, 60000, 30 |
| signer | `--refunds off\|on`, `--seller-account`, `--seller-key-env`, `--usdc-contract`, `--near-network`, `--near-rpc-url` (repeatable, fallback order), `--data-dir`, `--refund-max-units`, `--refund-daily-max-units`, `--refund-retry-sec`, `--refund-max-attempts` | off, -, SELLER_NEAR_PRIVATE_KEY, -, near:testnet, fastnear + archival, /data, 1000000, 5000000, 60, 20 |
| up.ps1 / desk.ps1 | `-PaidJobsFlow`, `-Refunds on\|off` | authorization, off |

Start-up checks: upfront without refund signer config → paywall refuses to start; `--refunds on` without seller key,
seller account ≠ the paywall's payTo, or no data dir → signer refuses to start (`-Planes` shows it).

## 7. Dependency change (stated)

`ca-control-signer` was "zero npm dependencies" (ARCH-660). Refunds need to sign a NEAR transaction. Choice: a new
`packages/near-refund` using `@near-js/transactions`, `signers`, `crypto`, `providers`, `utils` pinned to 2.5.1 (the
versions the paywall already runs); the signer Dockerfile adds `npm ci --omit=dev` for it. The rest of the signer stays
dependency-free. Alternative considered: hand-written borsh + node:crypto Ed25519 (no deps, more risk) — rejected.
check-deps: shared code in `packages/`.

## 8. Tests (none weakened)

- paywall: flow flag parse; 402 carries `paymentFlow: upfront` only when on; before-handler settle does not release;
  200 releases once; 409/422/502/timeout each request one refund and return its record; signer down → retry queue;
  onVerifiedPaymentCanceled safety net; authorization flow unchanged (existing suite passes as is).
- signer: every refund rule (400 shape, idempotent, mismatch 409, delivered 409, observer mismatches 422, caps 429,
  refunding blocks settle 409), restart from disk (refunded stays, sending re-checked), signature verifies.
- near-refund: tx built with the right receiver, method, args, deposit 1 yocto, gas; send-intent persisted before send
  (fake RPC).
- agent: refunded / refund_pending states, bad refund signature rejected, spend ledger rules.
- live (owner): one upfront run that succeeds; one deliberate refusal (e.g. the folder grown past tolerance) → refund tx
  on testnet; `GET /v1/refunds/:invoiceId`; observer view shows both transfers.

## 9. Manual steps (owner, given one at a time when we reach them)

1. Add the seller account's full-access key as `SELLER_NEAR_PRIVATE_KEY=...` to
   `C:\CHAINAIM-SELLER-SECRETS\signer.env`. Do not paste the key or any command output that prints it into the chat.
2. Make sure the seller (payTo) account holds a little NEAR for gas (about 0.1 NEAR on testnet is ample [assumption]).
3. `-Planes`: only ca-control-signer shows SELLER_NEAR_PRIVATE_KEY.

## 10. Open decisions

- Who pays refund gas: ChainAim (default) — fine at testnet scale.
- Whether a refused job's NEAR AI cost is ever charged: no (ChainAim absorbs it; receipt line in design-40 logs it
  internally).
- Hackathon default: keep `authorization` as default and run the demo with `-PaidJobsFlow upfront`.

## 11. Latency

Settlement moves before the run; total time roughly unchanged for a success. A refusal adds one NEAR transaction
(finality ~1-3 s [assumption]). `PAYWALL_PHASE_LOG=on` will show the measured phases.

## 12. Wording

Say "paid before any work; refunded automatically if the job fails or is refused". Never call the payment or the refund
private: both transfers are public on NEAR.
