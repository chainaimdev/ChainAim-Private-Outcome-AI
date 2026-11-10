# privateAI-design-32 — Firm-quote pricing, Job Evidence Receipt, stronger attestation, agent spending policy

Written 2026-11-09 (chat PRMS-chiro-11). DESIGN ONLY: no code is changed by this file.
Labels: **[read]** = read in the repo this session · **[doc]** = official doc read this session · **[verify]** = not proven,
checked first in the build (stop and report if it fails) · **[owner]** = owner decision or manual step.

Requirement IDs proposed: **ARCH-601 … ARCH-625** (623–625 added 2026-11-10). Taken (from PLAN-private-ai-nearai-attestation.md): ARCH-001…018,
101…115, 201…211, 301…314, 401…414, 501…506. **[verify]** no other file already uses 6xx before the build starts.

**Changes 2026-11-10 (chat near-ai-impl-2) [owner]:**
- `--pricing firm` is the demo setting: the code default stays `after` (safe fallback); desk.ps1 passes `-Pricing firm`.
- Counter-offer added as a separate item, ARCH-623…625 (§1.4), built after the agent policy and before ITA / TLS (§7).
- Negotiation stated explicitly (§1.5): quote → deterministic accept / counter / decline; the LLM never decides to pay.
- Calling agent stays in this repo for the hackathon (`services/paywall/scripts/agent-jobs*.ts`, container ca-agent);
  new buyer-side logic goes into packages so it can move to its own repo later: `packages/agent-policy` (ARCH-620/621/624),
  `packages/receipt` (ARCH-613 types, canonical JSON, signature verify — console signs, agent verifies with the same code).

---

## 0. Facts this design rests on

| # | Fact | Source |
|---|---|---|
| F1 | The NEAR rail uses the x402 **exact** scheme only (`ExactNearScheme` from `@x402/near`): one NEP-141 `ft_transfer` to payTo for the exact amount, inside a NEP-366 signed delegate; ChainAim's relayer pays gas; settlement waits for FINAL. There is no "upto" scheme in the code. | `services/paywall/src/near/facilitator.ts` [read] |
| F2 | Paid jobs today: the console runs the job, holds the result, registers `{jobId, amount, expiresAt}`; `POST /v1/jobs/:id/release` is paid for exactly that amount; the result is fetched from the console and released only once the payment settled ("@x402/hono replaces the body on a failed settlement"). `beginPaying` prevents two releases in flight. Invoices are bound to one job (`JobInvoices`). | `services/paywall/src/jobs.ts`, `test-console/console/jobs.ts` [read] |
| F3 | The quote is `quoteJob(meter, prices, fees)`: Σ model token cost + calls × perModelCallUsd + analystUsd + nearGasUsd, × (1 + margin%), at least minPriceUsd, ceil to 6 decimals, BigInt-exact, fails closed on missing usage or price. Pure. | `packages/crossask/src/cost.ts` [read] |
| F4 | What reaches the gateway (and so masking): the query step sends **headers and relations only, no data values**; the answer step sends the question + the result, **at most `answerMaxRows` rows**. With `sql` given, no model writes the query. Prompt size is capped by `maxPromptChars`; the gateway refuses more than 48,000 characters. | `packages/crossask/src/index.ts` header comment and `CrossAskInput` [read] |
| F5 | Therefore model calls per job ≤ `(sql ? 0 : 1 + sqlRetries) + (phrase == "llm" ? 1 : 0)`. An exact-query template that words the answer makes **1** call. | derived from F4 [read] |
| F6 | Dataset size drives only the analyst's work (relations + DuckDB SQL), not masking or model cost. | derived from F4 [read] |
| F7 | Templates carry `label`, `q`, `sql`; there is **no per-template row cap** field today. | `config/datasets.json` [read] |
| F8 | Requests get the smallest `maxOutputTokens` of the catalog entries (2048). | PLAN-private-ai-nearai-attestation.md F7 [read] |
| F9 | Agent mode: Strands agent with one tool; the tool posts the job to the console, then pays `/v1/jobs/<id>/release` with the tenant's own key; payments one at a time per account (`AccountQueue`). | `services/paywall/scripts/agent-jobs-core.ts` [read] |
| F10 | NEAR AI offers an Intel Trust Authority token endpoint (`/v1/attestation/ita-token`) and an opt-in `include_tls_fingerprint=true` that changes report_data to `SHA256(signing_address ‖ tls_cert_fingerprint) ‖ nonce`. | docs.near.ai api-reference + verification pages [doc] |

---

## 1. The three hackathon extensions — effort and what each adds

### 1.1 (#8) Stronger attestation — moderate, ~1.5–2.5 days total

| Part | Effort | What it adds beyond today | Risk |
|---|---|---|---|
| ITA token per report (ca-attest calls `/v1/attestation/ita-token`, verifies the JWT against Intel's published keys) | ~0.5–1 day | An **Intel-signed** verdict, independent of NEAR and of our own dcap-qvl check; a **portable** artefact a lender/auditor can verify without our software | Token format and Intel key URL **[verify]** before code |
| TLS fingerprint binding | ~1 day | Proves the HTTPS endpoint we talk to terminates inside NEAR's **gateway TEE** (no plain proxy in front) | Our gateway calls with `fetch`; reading the peer certificate from that connection is not direct **[verify]**. Fallback: ca-attest makes its own TLS connection and binds that — proves the endpoint, not the gateway's exact connection; say so in the UI |
| Evidence bundle per job (report JSON + signature + ITA token, stored by jobId, hashed into the receipt) | ~0.5 day | Re-verifiable **after** NEAR's retention, and by third parties | Storage size; no message text in it (same rule as ARCH-412) |

Honest value: it strengthens an already-strong proof (#1 in the capability list). It is the cheapest way to show
"verified by Intel, not only by us" in the Privacy track. It may also explain open item b ("Verification needs attention").

### 1.2 (#9) Job Evidence Receipt — easy, ~1–2 days

Contents (hashes, ids, numbers only; never text):
`{v, receiptId, jobId, quoteId, route, datasetId, files:[{name, bytes, sha256}], filesRoot, templateLabel, sqlSha256,
resultSha256 (canonical JSON), calls:[{servedModel, chatId, reqSha256, respSha256, attestStatus}], evidenceBundleSha256,
price:{amountUsdc, quoteBasis}, createdAt}` + Ed25519 signature by the console (node:crypto, no new dependency).

Binding to the payment — **change from earlier chat**: do **not** rely on the `ft_transfer` memo. F1: the exact scheme checks
one `ft_transfer` for the exact amount; whether a memo is allowed or set by the client is unknown **[verify]**. Instead bind
by ids we already have: receipt.jobId ↔ invoice (JobInvoices binds invoice→job) ↔ settlement transaction hash (added to
the receipt after settle, signed again as `receipt.settlement`). Memo binding stays an optional later step.

What it adds: (a) the buyer proves the released result is byte-for-byte the one quoted and paid (`sha256(result) ==
resultSha256`); (b) dispute evidence; (c) the artefact a relying party (lender/auditor) pays to check (business model D3);
(d) the commitment any future ZK proof (o1js) would prove against.

### 1.3 (#10) Agent spending policy — not only for agents

The **policy** runs where the payer key is: in agent mode, inside the agent service (F9). In the manual UI the human is
the policy, but the same limits are useful there as a **tenant budget** (a clinic sets "no job above $X without a second
click"). Design: one policy object per tenant, enforced by the agent, shown and enforced in the UI too.

Policy (in `<tenants>/<id>/tenant.json`, new `"policy"` block; values set by the owner **[owner]**):
```
"policy": { "autoApproveMaxUsd": "0.10", "maxPerJobUsd": "1.00", "dailyCapUsd": "5.00",
            "requireAttestedRoute": true, "requoteAutoAcceptPct": 0 }
```
Rules: quote ≤ autoApproveMaxUsd and within dailyCap → agent pays; above autoApprove but ≤ maxPerJob → run waits for a
human "Approve" in tab 03 (event `job_needs_approval`, expires with the quote); above maxPerJob or over dailyCap → refused.
`requireAttestedRoute` → the agent only accepts the NEAR AI attested route.

"Verify before paying" — honest limit: the attestation of the answer call exists only after the model ran. With the
verify→run→settle flow (§3.4) the check moves **server-side**: `--settle-requires-attest on` makes the paywall settle an
attested-route job only when ca-attest says `verified`; otherwise nothing is charged. The agent then verifies the
receipt signature and result hash after release, and records a mismatch (it cannot un-pay; it stops paying that provider).

Setup (AI side): policy loader + checks in `packages/agent-policy` (pure, no service imports), called from
`agent-jobs-core.ts`; daily spend ledger per tenant (ids/amounts only), approval endpoint + tab 03 button, desk.ps1 switch.
Owner side: choose the numbers.

### 1.4 (#17) Counter-offer — ARCH-623…625 (added 2026-11-10)

Purpose: when every route's firm quote is above what the buyer will pay, the buyer names a ceiling and the seller
answers with a **smaller job** that fits that ceiling, or says it cannot. The price is never discounted; only the job
shrinks, so the seller never sells below cost (quoteFirm keeps margin + minPriceUsd, F3).

Seller (console, deterministic, no model) — ARCH-623:
- `POST /jobs/quote/:quoteId/counter {maxPriceUsd, route?}` (same host check as the other routes).
- Walks the ordered ladder in `config/counter-ladder.json` (committed, owner-editable, `--counter-ladder`). Each step only
  reduces the basis, e.g. `[{"answerMaxRows":50},{"answerMaxRows":20},{"phrase":"none"},{"sqlRetries":0},{"route":"standard"}]`
  (example values — **[owner]** sets the real ladder). quoteFirm() on each candidate; returns the first (richest) basis
  whose price ≤ maxPriceUsd. A route step is offered only if the dataset's data class allows that route (PHI zones).
- Response: a new firm quote `{quoteId, counterOf, route, priceUsd, amount, basis, reduced:[…], expiresAt}`, or
  422 `{error:"no_fit", cheapestUsd}`. At most `--counter-max-rounds` (default 3) per original quote; logs ids, amounts
  and step names only.

Buyer (agent, `packages/agent-policy`) — ARCH-624:
- tenant policy gains `"counter": {"enabled": true, "maxRounds": 2, "acceptReduced": ["answerMaxRows", "phrase"]}`
  **[owner]** values. Ceiling sent = `autoApproveMaxUsd`, so a fitting counter quote is auto-payable.
- A counter quote is accepted only if every `reduced` step is in `acceptReduced` and the normal policy rules pass.
  Deterministic code; the model only triggers the tool.

UI + receipt — ARCH-625: tab 03 "Offer a lower price" box under the route picker, showing what the smaller job drops;
the receipt carries `counterOf` and `reduced`, so the delivered job is provably the one agreed.

Effort: ~1 day (estimate, not measured). **[verify] V-P9** (§5).

### 1.5 Negotiation — where it happens (added 2026-11-10)

No free-form bargaining: **offer (firm quote) → buyer policy decides: accept / counter / ask a human / decline → x402
exact payment of the agreed amount → run within the agreed basis → settle on a good result → signed receipt.**

| Part | Where | Enforced by |
|---|---|---|
| Offer (price per route) | seller: console `jobs.ts` (`/jobs/quote`, QuoteStore), `cost.ts` quoteFirm | calibrated cost-model.json; quote TTL |
| Counter (smaller job for a ceiling) | seller: console `/jobs/quote/:id/counter` + counter-ladder.json | quoteFirm on reduced basis; round limit |
| Accept / counter / approve / decline | buyer: `agent-jobs-core.ts` → `packages/agent-policy` | tenant `policy` block (deterministic code) |
| Binding the agreement | accepted quote's `amount` = x402 exact amount | paywall (F1) |
| Execution terms | quote `basis` (rows, prompt cap, retries, max_tokens, route) | console run endpoint; 409 requote on size drift |
| Proof of delivery | signed receipt (quoteId, counterOf, reduced, hashes, settlement tx) | agent verifies via `packages/receipt` |

Rules: (1) the LLM never decides to pay — a prompt-injected model cannot raise a spend; (2) the servicing side is a
deterministic quote service, not an LLM agent, so prices are reproducible and auditable; (3) a requote after size drift
goes back through the same policy (auto-accept only within `requoteAutoAcceptPct`).

---

## 2. Pricing design (#11–#16) — overview

Old flow (option A): run → meter → quote → hold → pay → release. ChainAim carries the compute when the buyer walks away.

New flow: **size → firm quote per route → buyer accepts → buyer signs payment → run (limits enforced) → settle only on a
good result → release + receipt**.

```
UI / agent ──POST /jobs/quote──▶ console: size files (stat), classify route (question only), quoteFirm() per route
            ◀── [{quoteId, route, priceUsd, amount, basis, expiresAt}] ── (no masking, no SQL, no model yet)
UI / agent ──POST /jobs/quote/:quoteId/accept {route}──▶ console registers {jobId, amount, expiresAt} with paywall
UI / agent ──POST paywall /v1/jobs/:id/release (x402 exact, signed delegate)──▶ paywall VERIFIES payment
            paywall ──POST console /internal/jobs/:id/run──▶ console runs the job within the quote's limits
                 ok + result ─▶ (attested route & --settle-requires-attest on: wait ca-attest verified) ─▶ SETTLE ─▶ release + receipt
                 failed / empty / over limits ─▶ 422 / 409, NO settlement, nothing charged (void rule)
```

Why this order: F1 has only `exact`; F2 already settles after the handler and withholds the body on failed settlement.
Running **inside** the paid request turns the void rule into "do not settle" — **no refunds, no credits needed**.

**[verify] V-P1:** `@x402/hono` does not settle when the handler answers with status ≥ 400.
**[verify] V-P2:** the signed delegate's validity window (`max_block_height`) is longer than the longest job run (SQL +
1 reasoning call). If not: shorten runs (limits) or move to prepaid credits (§3.7 fallback).
**[verify] V-P3:** NEAR AI counts reasoning tokens inside `max_tokens`.

Residual ChainAim risk: the payer's balance drops between verify and settle → settle fails after the run; the result is
withheld (F2), ChainAim loses one job's compute. Bounded by `--max-open-jobs-per-payer`.

---

## 3. Detailed design

### 3.1 (#11) Sizing step — ARCH-601

`POST /jobs/quote` on the console (host check as other routes): body `{datasetId, templateLabel? | question, set?, routes?}`.
- Files: `fs.stat` of every data file in the dataset folder → `{name, bytes}`; `totalBytes`. No file is opened.
- Prompt basis: for a template with `sql` + phrase llm: `maxPromptChars = min(--max-prompt-chars, 48000)`; rows ≤
  `answerMaxRows` (F4). For a free question: calls = 1 + sqlRetries + 1 (F5).
- Route: the routes offered = `--estimate-routes` (default `nearai,bedrock`), filtered by data class rules already in the
  gateway (PHI → only zones allowed by `--phi-zones`). **[verify]** that the route-engine classifier can be called on the
  question alone without the gateway; if not, offer all configured routes allowed for the dataset's class.
- Output per route: `{quoteId, route, priceUsd, amount, basis:{totalBytes, files, calls, maxPromptChars, maxTokens,
  answerMaxRows, sqlRetries}, expiresAt}`. Quote kept in memory (`QuoteStore`, like `JobStore`), TTL `--quote-ttl-min`.
- Nothing is logged except ids, routes, amounts (same rule as jobs.ts).

### 3.2 (#12) Per-component pricing on exact units — ARCH-602…604

`config/cost-model.json` (committed team defaults, like the paid-job prices):
```
{ "version":1, "calibratedAt":"<ISO>", "machine":"<label>",
  "units": { "analystPerMbUsd":"…", "gatewayPerKbPromptUsd":"…" },
  "safetyPct":"…", "source":"desk.ps1 -Calibrate run of <date> over sample-data" }
```
- `quoteFirm(basis, route, prices, fees, costModel)` in `cost.ts` (pure): builds a **worst-case meter** — `calls` lines,
  each `promptTokens = ceil(maxPromptBytes × tokensPerByte)` (`--tokens-per-byte`, default 1 **[verify V-P4]** that
  tokens ≤ UTF-8 bytes for the routed models), `completionTokens = maxTokens` — calls `quoteJob`, then adds
  `analystPerMbUsd × MB(totalBytes)` and `gatewayPerKbPromptUsd × KB(maxPromptChars × calls)` before the margin, and applies
  `safetyPct` to those two time-derived lines only. Breakdown lines extended with `analystDataUsd`, `maskUsd`.
- `Fees` gains `dataPerMbUsd` / `maskPerKbUsd` only through the cost model file (no new CLI fee flags; FEE_FLAGS unchanged).
- Calibration — ARCH-604: `desk.ps1 -Calibrate` runs N real jobs per sample dataset with phrase none and llm, records
  analyst ms/MB and gateway ms/KB (from CrossAskTimings, already measured: relationsMs, sqlMs, callsMs), converts with
  `--compute-usd-per-hour`, writes `cost-model.json` with date and machine. Never invented numbers: no file → quoting off.

### 3.3 (#13) Firm quote per route — ARCH-605

- The buyer sees one exact price per route: "Attested NEAR AI TEE: $X · Standard model: $Y · valid 15 min, pay only for a
  result". `amount` = the x402 exact amount (F1). No ±.
- Tab 03: route picker with prices replaces "run then quote" when `--pricing firm` (code default stays `after`; owner chose `firm` for the demo 2026-11-10, desk.ps1 passes it —
  option A kept as free-trial mode, rate-limited by `--trial-quotes-per-day`).

### 3.4 (#14) Limits enforced at run time — ARCH-606…609

`POST /internal/jobs/:id/run` (x-jobs-key, called by the paywall inside the paid release):
- re-stat files: `totalBytes > basis.totalBytes × (1 + sizeTolerancePct/100)` → 409 `requote` (nothing settled);
- crossask runs with `sqlRetries`, `answerMaxRows`, `maxPromptChars` **from the quote basis**, not from current flags;
- `max_tokens = basis.maxTokens` on every call (F8);
- the run meters actual usage (`quoteJob` on the real meter) and records `actualUsd` next to the firm price in the receipt;
  `actualUsd > priceUsd` → logged as `overrun` (ids/amounts), buyer still charged the firm price.
- Paywall release handler becomes: verify → call run → (attest gate) → settle → body. The existing `beginPaying` guard keeps
  one run per job; a second release while one is in flight is refused (F2).

### 3.5 (#15) Tolerance only internal — ARCH-610

`--size-tolerance-pct` (default 10), `safetyPct` (calibrated), `--requote-auto-accept-pct` (default 0) for agents within
policy. Nothing shown to the buyer except the firm price and "re-quoted because your data changed".

### 3.6 (#16) Void rule — ARCH-611

Failed run, empty result (today's rule: a job with no result is never sold), refused residual (422), over-limit (409),
attest gate failed → **no settlement**. The buyer's signed delegate is never submitted; nothing to refund (V-P1).

### 3.7 Fallback if V-P1 or V-P2 fails — ARCH-612

Prepaid **credits** per tenant: top up with the existing x402 exact payment to a `credits/topup` route; jobs debit on a
good result only (void = no debit). Ledger of ids/amounts per tenant in the paywall (file, like the decision ledger).

### 3.8 Receipt, attestation, policy — ARCH-613…622

ARCH-613 receipt builder (§1.2) · 614 receipt signature key: env var name only (`--receipt-key-env`), refuse start without
it · 615 receipt in job feed (`job_receipt`) and tab 03 "Download receipt" · 616 settlement tx hash appended ·
617 ITA token in ca-attest · 618 TLS fingerprint binding · 619 evidence bundle store (`--evidence-dir`, git-ignored) ·
620 tenant policy loader + checks · 621 approval flow (`job_needs_approval`, approve endpoint, tab 03 button) ·
622 `--settle-requires-attest on|off` · 623 counter endpoint + ladder · 624 agent counter policy · 625 counter UI +
receipt fields.

---

## 4. Flags (all with defaults; nothing hardcoded)

Console: `--pricing after|firm` (default after) · `--estimate-routes nearai,bedrock` · `--cost-model config/cost-model.json`
· `--tokens-per-byte 1` · `--quote-ttl-min 15` · `--size-tolerance-pct 10` · `--trial-quotes-per-day 3` ·
`--receipt-key-env RECEIPT_SIGNING_KEY` · `--evidence-dir runtime/evidence`.
Paywall: `--settle-requires-attest off` · `--max-open-jobs-per-payer 3` · `--run-timeout-ms` (≤ delegate window, V-P2).
Agent: policy (incl. `counter` block) from tenant.json; `--requote-auto-accept-pct 0`.
Counter (console): `--counter-ladder config/counter-ladder.json` · `--counter-max-rounds 3`.
desk.ps1: `-Calibrate`, `-Pricing firm|after`, guards in `scripts/test/desk.test.ts`.

## 5. Verify first (before code)

V-P1 hono no-settle on ≥400 · V-P2 delegate window vs run time · V-P3 reasoning tokens within max_tokens · V-P4 tokens ≤
bytes for routed models · V-P5 route classifier callable on the question alone · V-P6 ITA token format + Intel keys ·
V-P7 peer-certificate access for TLS binding · V-P8 ARCH-601…625 IDs unused · V-P9 each counter-ladder step still
yields a non-empty result that passes the existing answer checks for the sample templates (else drop that step).

## 6. AI vs owner

AI: V-P1…V-P9 probes, all ARCH-601…625 code and tests, desk.ps1 switches, docs, BUILD_LOG.
Owner, one at a time: (1) choose default `--pricing` for the demo — DONE 2026-11-10: firm; (2) set the tenant policy
numbers incl. the `counter` block, and approve the counter ladder; (3) run
`desk.ps1 -Calibrate` once on this PC; (4) live runs: firm-quote job paid manually, then by the agent.

## 7. Build order for the hackathon (deadline 14 Nov 2026 23:59 UTC)

1. V-P1…V-P9 (V-P1/V-P2 decide verify→run→settle vs credits) · 2. receipt (ARCH-613…616, `packages/receipt`) ·
3. sizing + firm quote + limits + void (601…611) · 4. agent policy (620…622, `packages/agent-policy`) ·
5. counter-offer (623…625) · 6. ITA token + bundle (617, 619) · 7. TLS binding (618) if time remains.
