# privateAI-design-39: pay only for private inference (attestation verdict before delivery)

Chat near-ai-impl-12, 2026-11-13 ~10:30Z. Must-do item 3 of the near-ai-impl-11 table. Release target: v2.1.0.
Status: DESIGN ONLY. No code changed. Uses design-37 (refund) and design-38 (signed limits). Punchline: **"If privacy
isn't proven, you get your money back."** Wording rule: "every NEAR AI call attested", never "every AI call".

## 0. Sources read in this chat (v2.0.0 code)

- test-console/console/attest.ts (whole): `AttestClient.start(jobId, served)` stores `pending`, runs the check in the
  background, "never awaited by a request: ca-attest slow, down or refusing never blocks or fails a job" (:1-9);
  private `run()` POSTs `/verify` in chunks of 16 with `AbortSignal.timeout(cfg.timeoutMs)` and maps results to
  `verified | unverified | unavailable | not_applicable`; `summarize()` → `verified | partly | unverified |
  unavailable | not_applicable`; `--attest-timeout-ms` (default 20000) bounds ONE POST.
- test-console/console/server.ts: :93-100 (flags), :424-426 in runOffer (`if (o.attested && !out.served.every(s =>
  s.attest !== undefined)) → 422 "…without NEAR AI attestation evidence…"`: evidence present, verdict not awaited), :447
  `ATTEST?.start(jobId, out.served)` after the run; run-hold path :1124-1133 (the job runs, is quoted, attestation
  started in the background, `attested` = evidence on every call).
- test-console/console/offers.ts:86-92 (`attestedRoute`: every model the estimate may call is in the attestable catalog set).
- test-console/console/receipt.ts:355-360 (`attestStatusFrom`: anything not judged yet → `pending`; "never verified
  without ca-attest saying so").

Gap: today the buyer pays for a job whose NEAR AI calls carried attestation evidence, but the evidence is checked only
after delivery; a job whose evidence later fails still delivered and (authorization flow) still settled. The receipt then
shows `attestStatus: "failed"` or `"pending"`, after the money moved.

## 1. Behaviour

New console flag `--pay-only-attested off|evidence|verified` (default `evidence` = exactly today's rule):

| Mode | Estimate (`/offers`) | Run step (`runOffer`) | Run-hold quote (`/jobs/crossask`) |
|---|---|---|---|
| `off` | as today | no attestation rule | as today |
| `evidence` (default) | as today (`attested` shown) | 422 when the estimate said attested and a call lacks evidence (today) | as today |
| `verified` | refused (422, nothing to pay) when the route is not attestable | after the run, **await ca-attest's verdict** within `--pay-only-attested-deadline-ms`; `verified` → 200; anything else → 422 → design-37 refund | the verdict is awaited before the quote is issued; not verified → 422, nothing asked for |

Verdict rule in `verified` mode: summary must be `verified` (every attested call verified) AND every call is attested
(no `not_applicable` call: a job that mixes a local or OpenRouter call with a NEAR AI call is not "private inference
proven"). `partly`, `unverified`, `unavailable`, or still `pending` at the deadline → not proven.

## 2. Architecture

```mermaid
sequenceDiagram
  participant P as ca-paywall
  participant C as console runOffer
  participant G as ca-gateway
  participant N as NEAR AI (TEE)
  participant T as ca-attest
  participant S as ca-control-signer
  P->>C: run (upfront: money already settled)
  C->>G: model calls (masked prompts)
  G->>N: inference
  N-->>G: reply + chat id; gateway adds req/resp sha256
  G-->>C: replies with attestation evidence
  C->>T: POST /verify (all calls), deadline D
  alt summary verified, no non-attested call
    T-->>C: verified
    C->>C: ATTEST.store(verdict) so the receipt says verified (not pending)
    C-->>P: 200 result
  else unverified / partly / unavailable / deadline passed
    C-->>P: 422 {error, code:"attestation_not_proven", summary}
    P->>S: POST /v1/refunds (reason "attestation_not_proven")
  end
```

## 3. ARCH-IDs (new)

| ARCH | Requirement | Where |
|---|---|---|
| ARCH-685 | `--pay-only-attested off\|evidence\|verified` (default evidence) and `--pay-only-attested-deadline-ms N` (default 30000, 1000..240000); `verified` needs `--attest-url` (start-up refuses otherwise) | server.ts flags |
| ARCH-686 | `AttestClient.verifyNow(jobId, served, deadlineMs): Promise<JobAttestation>` awaits the same check `start()` runs, stores the result (so the receipt reads it), and resolves `pending` at the deadline without throwing; `start()` unchanged | attest.ts |
| ARCH-687 | runOffer in `verified` mode: verdict before the 200; not proven → 422 `attestation_not_proven` (refund via design-37); the estimate refuses a non-attestable route; run-hold awaits before quoting | server.ts runOffer, /offers, /jobs/crossask |
| ARCH-688 | the signed limits (design-38) carry `attestation: "off"\|"evidence"\|"verified"`, so the mode is part of what the buyer signed; the agent's policy can require `verified` (`requireAttestation: "verified"` per tenant) | packages/signer, packages/offer, agent-policy |
| ARCH-689 | the refund reason `attestation_not_proven` is in the signer's closed reason set; the agent shows "refunded: privacy was not proven (<summary>)" | packages/signer, agent-jobs-core.ts, paid-jobs.html |

## 4. Detailed changes

### 4.1 attest.ts (ARCH-686)

```ts
/** Awaited check (pay-only-attested verified): the same requests as start(), bounded by deadlineMs overall. */
async verifyNow(jobId: string, served: readonly ChatReply[], deadlineMs: number): Promise<JobAttestation> {
  const iso = new Date(this.now()).toISOString();
  const pending = { jobId, summary: "pending" as const, at: iso, calls: served.map(/* same as start() */) };
  this.store(pending);
  this.inflight += 1;
  try {
    const timer = new Promise<JobAttestation>((r) => setTimeout(() => r(pending), deadlineMs).unref());
    const a = await Promise.race([this.run(jobId, served), timer]);
    if (a.summary !== "pending") { this.store(a); this.log(/* job_attested line, same fields */); this.onDone?.(a); }
    return a;
  } finally { this.inflight -= 1; }
}
```

- A late `run()` result after the deadline is still stored and logged (the job feed shows the real verdict), but the
  run step has already answered 422; the refund stands (I3 of design-37 blocks a receipt).
- Each POST stays bounded by `--attest-timeout-ms`; the overall `deadlineMs` bounds the sum of chunks.

### 4.2 Console (ARCH-685, ARCH-687): server.ts

- Flags parsed with the existing helpers; `verified` without `ATTEST` → start-up error naming `--attest-url`.
- `/offers` in `verified`: `attestedRoute(basis, attestable) === false` → 422 "this job's models are not all NEAR AI
  attested models, and this console sells only attested private inference (--pay-only-attested verified)".
- `runOffer`, after the design-38 checks (calls, models, tokens) and before metering:
  ```ts
  if (PAY_ONLY_ATTESTED === "verified") {
    const a = await ATTEST!.verifyNow(jobId, out.served, PAY_ONLY_DEADLINE_MS);
    const allAttested = out.served.length > 0 && out.served.every((s) => s.attest !== undefined);
    if (a.summary !== "verified" || !allAttested)
      return { status: 422, body: { error: `privacy was not proven for this job (NEAR AI attestation: ${a.summary})`,
                                    code: "attestation_not_proven", summary: a.summary } };
  }
  ```
  and the later `ATTEST?.start(jobId, out.served)` is skipped in `verified` (already stored).
- `/jobs/crossask` (run-hold) in `verified`: `verifyNow` before `SIGNER.signQuote`; not proven → 422 "nothing can be
  paid". Nothing was paid yet in run-hold, so no refund is involved.
- The paywall's `PAID_JOBS_RUN_TIMEOUT_SEC` must cover `--crossask-timeout-sec + deadline`; desk.ps1 computes
  `PAID_JOBS_RUN_TIMEOUT_SEC = crossask + ceil(deadline/1000) + 10` when `verified` is set, and the console logs a
  warning line at start-up if its own two values exceed the paywall's configured value (read from settings.json).

### 4.3 Signed mode (ARCH-688)

- design-38 `limits` gains `attestation` (closed set). The console sends its mode in the QuoteRequest
  (`attestation`, allowlisted), and the signer copies it into the limits it signs. A console started `evidence` cannot
  claim `verified` later: the mode is fixed per offer at signing time.
- The run step uses the mode from the signed limits, not the live flag (a flag changed between estimate and run cannot
  weaken a paid offer).
- packages/agent-policy: tenant `requireAttestation: "off"|"evidence"|"verified"` (default off); the agent refuses to
  pay a quote whose signed `limits.attestation` is weaker (nothing signed).

### 4.4 Refund reason and UI (ARCH-689)

- Signer reason set (design-37 §5.4) gets `attestation_not_proven`.
- paid-jobs.html chip: `refused: privacy not proven (unavailable)` → `refunded ✓`.
- Agent terminal text: "Refunded: NEAR AI attestation was not verified for this job (<summary>), so you were not
  charged; refund <refundTx>."

## 5. Deliberate refusal for the live demo run (design-37 §7 step 3)

Two real refusals, no special code path:
1. **Privacy not proven** (this design): console started with `-PayOnlyAttested verified`; estimate on an attested
   route; stop ca-attest after the estimate with `desk.ps1 -StopService attest` (new switch: stops one container; guard
   in desk.test.ts); pay → the run completes, the verdict is `unavailable` at the deadline → 422 → refunded. Start
   ca-attest again with `desk.ps1 -StartService attest`.
2. **Data changed after the quote** (design-38): add a file to the dataset folder after the estimate → 409 → refunded.

The video uses (1) because it shows the Privacy-track rule; (2) is the backup take.

## 6. Open decision (owner)

Verdict still `pending` at the deadline. **Proposed:** treat as not proven → 422 → refund (`refund_pending` until the
refund tx is final, then `refunded`). Alternative: deliver and record `attestStatus: "pending"` in the receipt. The
proposal keeps the punchline literally true; the cost is a refund when ca-attest is slow (`--pay-only-attested-deadline-ms`
can be raised).

## 7. Latency (for the demo script's latency line)

The awaited check adds one ca-attest round trip per job (chunks of 16 calls; jobs here make 1-3 calls). Its real cost
is measured in step 5 below from the console's `job_attested` log timestamps against `offer_ran`, and the number goes
into the demo script. No figure is stated here until it is measured.

## 8. Tests (names carry the ARCH-ID; real ca-attest service process from services/attest, no mocks)

| Test | File |
|---|---|
| ARCH-685 flag parsing; verified without --attest-url refused | scripts/test/console-attest.test.ts |
| ARCH-686 verifyNow returns the verdict; returns pending at the deadline; late result stored; start() unchanged | test-console/test/attest.test.ts |
| ARCH-687 verified: proven → 200 with receipt attestStatus verified; ca-attest stopped → 422 attestation_not_proven; mixed route → 422; /offers refuses non-attestable route; run-hold not proven → 422 before a quote | scripts/test/console-attest.test.ts |
| ARCH-688 limits.attestation signed; run uses the signed mode; agent refuses a weaker mode | packages/signer/test/limits.test.ts, services/paywall/test/agent-ap2.test.ts |
| ARCH-689 refund reason accepted; UI chip text | packages/signer/test/refund.test.ts, scripts/test/paid-jobs-page.test.ts |
| Live (owner): deliberate refusal (1) refunded on testnet | BUILD_LOG.md |

## 9. Implementation steps (AI ~30 min plus tests)

1. attest.ts verifyNow + tests.
2. Flags, /offers refusal, runOffer + run-hold awaits + tests.
3. `attestation` in limits (after design-38 is in), agent policy + tests.
4. desk.ps1: `-PayOnlyAttested`, `-StopService/-StartService`, run-timeout sum; guards in desk.test.ts.
5. Measure the added latency on the desk run; write it into the demo script (item 7). STATE.md + BUILD_LOG.md.
