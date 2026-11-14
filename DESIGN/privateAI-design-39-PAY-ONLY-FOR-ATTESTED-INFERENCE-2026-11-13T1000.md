# privateAI-design-39: pay only for private inference (unverified attestation → refund)

Chat near-ai-impl-11, 2026-11-13 ~10:00Z. Item 3 of the must-do table. Status: DESIGN, not built. ARCH-686..690.
Uses design-37 (refund) and design-38 (`limits.attestedRoute`).

Punchline: **"If privacy isn't proven, you get your money back."**

## 0. Sources read

- `test-console/console/server.ts` 92-100 (flag docs: attestation runs in the background after a job is quoted,
  "never awaited, never fails a job"), 348-349 (`ATTEST_CONFIG`), 424-426 (runOffer: 422 only when an attested
  estimate ran a call **without evidence**).
- `test-console/console/attest.ts` 12-125: `AttestClient` (`get(jobId)`, start per job, never throws), per-call status
  `verified | unverified | unavailable | not_applicable`, job summary `verified | partly | unverified | unavailable |
  not_applicable | pending`, `--attest-timeout-ms` (default 20000), `--attest-poll-ms` 3000, `--attest-poll-max` 40.
- `packages/crossask/src/index.ts` 31-42 (`ChatReply.attest`: chatId, servedModel, requestSha256, responseSha256,
  calledAt, from the gateway's x-chainaim-* headers).
- `services/gateway/src/dispatch.ts:18, 139` (evidence only for `kind: "nearai"`; requestSha256 = SHA-256 of the exact
  request bytes sent).
- `packages/receipt` `ReceiptCall.attestStatus: verified | failed | pending | none`.
- STATE.md 2026-11-13: live runs show "NEAR AI proof 1/1"; the 8800 attested mark can show ⧗ first and ✓ seconds later.

## 1. Problem (verified gap)

Today a buyer whose policy paid for an attested route is protected only against **missing evidence** (`server.ts:426`).
The real check — TDX quote, NVIDIA GPU evidence, signature over the request/response hashes — runs afterwards in
ca-attest and cannot change the outcome. A call whose evidence later turns out `unverified` is still paid for and its
result is released. The privacy claim is checked, but the money does not depend on it.

## 2. Target

With `--pay-only-attested verified`, a job priced as attested is released only when ca-attest has verified **every**
model call. Otherwise it is refused, and with design-37 `upfront` the buyer is refunded. The receipt then carries final
verdicts (no `pending`).

| Verdict at release time | `evidence` mode (today) | `verified` mode (new) |
|---|---|---|
| all calls `verified` | release | release |
| any call `unverified` | release (marked later) | refuse 422 `not_attested` → refund |
| no evidence on a call | 422 | 422 `not_attested` → refund |
| `unavailable` / still pending at timeout | release (pending) | per `--attest-pending refund\|release` (default refund) |

## 3. ARCH-IDs

| ARCH | What | Where |
|---|---|---|
| ARCH-686 | flag `--pay-only-attested off\|evidence\|verified` (default `evidence` = today); `verified` needs `--attest-url` (start-up refuses otherwise) | `server.ts` flags, `up.ps1 -PayOnlyAttested`, desk.json |
| ARCH-687 | `AttestClient.verifyNow(jobId, served, deadlineMs)`: starts the job's check if not started and resolves with the final `JobAttestation` or `pending` at the deadline; the background path stays for other modes | `attest.ts` |
| ARCH-688 | runOffer gate: after the run and the call-count check, before the receipt: `verified` mode awaits ARCH-687; non-verified → 422 `{code: "not_attested", calls: [{index, status, reason}]}` | `server.ts` runOffer |
| ARCH-689 | policy for pending: `--attest-pending refund\|release` (default refund) and `--attest-gate-timeout-ms` (default 20000, ≤ the paywall's run timeout) | `server.ts` |
| ARCH-690 | receipt calls carry the final verdict; job feed `job_attested` sent before release in `verified` mode; page/terminal: "Released only after 1 of 1 NEAR AI calls verified" or "Refunded: attestation unverified (call 1: <reason>)" | `server.ts`, `receipt.ts`, `paid-jobs.html`, agent output |

## 4. Workflow (verified mode, upfront flow)

1. Estimate: the signed limits say `attestedRoute: true` (design-38); the agent's policy requires it.
2. Payment settles before the run (design-37).
3. Run: masked prompts go through the gateway to NEAR AI; each reply carries evidence (chatId, servedModel, req/resp
   SHA-256, calledAt).
4. Gate (ARCH-688):
   - any served call without evidence → 422 `not_attested` (today's check, now a refund reason);
   - `verifyNow(jobId, served, attestGateTimeoutMs)`; ca-attest fetches the NEAR AI report for each chat id and checks
     TDX, GPU, signature and that its signed text contains the request/response hashes;
   - all `verified` → continue to the receipt and release;
   - any `unverified` → 422 `not_attested` with per-call reasons → paywall requests the refund (reason `not_attested`);
   - `pending`/`unavailable` at the deadline → `--attest-pending refund` (default) → same as unverified with reason
     `attestation_unavailable`; `release` → today's behaviour, receipt says `pending`.
5. Receipt: `calls[i].attestStatus` = `verified`; design-40 adds the attestation digest.
6. Agent/page show the gate line; admin UI receives `job_attested` before `job_released`.

Authorization flow (no upfront): the same gate gives 422 and nothing settles — the buyer is equally protected, ChainAim
is not paid (design-37 explains why upfront is the target).

## 5. Technical notes

- Only calls whose route is attestable count. A job priced `attestedRoute: false` (e.g. local Ollama, Bedrock) is not
  gated and is never described as attested (wording rule).
- Mixed routes cannot happen in an attested job: design-38 `limits_model` refuses a served model other than the signed
  one.
- `verifyNow` reuses the existing ca-attest POST /verify per call and the existing cache (`results`), so the background
  re-check and the admin feed see the same result. Poll settings `--attest-poll-ms` / `--attest-poll-max` stay for the
  background path.
- Time budget: gate timeout (20 s default) + run must stay under `PAID_JOBS_RUN_TIMEOUT_SEC` (300 s); start-up checks it.

## 6. Latency (to measure)

Adds the ca-attest check to every attested paid job before release. STATE.md shows the admin ✓ arriving "a few seconds"
after the job; the real number is unmeasured [assumption]. The run records `attestGateMs` in the console log and in
`PAYWALL_PHASE_LOG` phases so the demo can state a measured figure.

## 7. Tests

- attest.ts: verifyNow returns verified / unverified / pending at deadline (fake ca-attest), starts once, shares cache.
- console: verified mode releases on all-verified; 422 `not_attested` on unverified, on missing evidence, on
  unavailable with `--attest-pending refund`; release with `--attest-pending release`; `evidence` mode unchanged
  (existing tests untouched); start-up refuses `verified` without `--attest-url`.
- paywall + signer (with design-37): 422 `not_attested` → refund requested with that reason → record signed.
- live (owner): one attested job released after the gate; the refusal clip can now be "attestation could not be
  verified → refunded" if a failure can be forced honestly (e.g. ca-attest pointed at a wrong expected measurement) —
  only if it is a real failure, never a mock.

## 8. Effort

~30 min AI for the gate and flags + tests (the attestation checker exists). No manual steps.

## 9. Wording

"You pay only when this job's NEAR AI calls are verified as attested." Not "every AI call is attested": non-NEAR routes
are not attested and are not sold as such.
