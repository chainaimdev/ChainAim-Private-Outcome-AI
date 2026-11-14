# privateAI-design-43: counter-offer, one round (item 17, R4) — ARCH-720..726

Chat near-ai-impl-15, 2026-11-14. BUILT in near-ai-impl-16 (2026-11-14 ~07:30Z, not committed; BUILD_LOG.md). Deviations from §3: --counter-max-rounds accepts only 1; the counter route also answers 404 counter_off when --counter is off; the agent emits quoted + quote_signed again for the new offer after countered. It implements design-32 §1.4 / §1.5 (ARCH-623..625) in
today's flow (estimate-first offers, ChainAim's signer, signed quotes with limits, checkout mandates, upfront pay). The
Apprentice design moves to design-44.

Rule kept from design-32 §1.4: **the price is never discounted; only the job shrinks.** Every counter price is priced by
ChainAim's signer from a smaller basis, with the same fees, margin and minimum, so ChainAim never sells below cost.
The LLM never decides: the tenant's policy (deterministic code) asks for the counter and accepts or refuses it.

## 0. Facts this design rests on (read in this chat)

| # | Fact | Source |
|---|---|---|
| F1 | The policy already returns `{action:"counter", ceilingUsd = autoApproveMaxUsd, counterOf}` when the cheapest quote is above autoApprove (or above maxPerJob) and `counter.enabled` with rounds left; a counter quote passes only if every `reduced` step is in `counter.acceptReduced`. | packages/agent-policy/src/index.ts decide(), counterOr() |
| F2 | The agent stops on "counter" today: "counter-offers are not built yet (ARCH-623), so nothing was signed or paid". | services/paywall/scripts/agent-jobs-core.ts:637 |
| F3 | Reducible step names today: `answerMaxRows, phrase, sqlRetries, route`. | agent-policy REDUCIBLE |
| F4 | Tenant policies: t01 auto 0.05 / max 0.05, counter on, 2 rounds, accepts answerMaxRows+phrase; t02 auto 0.05 / max 0.50, same counter; t03 auto 0.005 / max 0.005, counter off. | rig/tenants/t0*/tenant.json |
| F5 | An offer's price is the signer's `price({kind:"offer", basis})` = worst case of the basis (quoteOffer/worstCase): query calls at maxPromptChars, the answer call at answerMaxPromptChars, every call at maxTokens completion tokens, analyst + gateway units, fees, 20 % margin, minimum 0.01, whole cents with AP2 on. | packages/offer worstCase/quoteOffer; server.ts POST /offers |
| F6 | The signer writes the signed limits from the priced basis; the run is held to them (answerMaxRows, answerMaxPromptChars, maxTokens, modelCalls ...). | design-38 ARCH-680..682 |
| F7 | The receipt already carries `counterOf` + `reduced` (both or neither); the signer's receipt allowlist accepts them; verify-receipt already prints "counter of <id>". | packages/receipt, packages/signer RECEIPT_FIELDS, scripts/verify-receipt.ts:213 |
| F8 | Real prices (computed here with the committed cost model, the catalog price of nearai/deepseek-v4.1-flash and the conf fees) for the live template (smb-fin-1, template 1: exact SQL, NEAR AI answer): as signed **0.02**; answer 4000 chars / 20 rows **0.02**; maxTokens 1024 **0.02**; maxTokens 512 **0.02**; **answer 4000 chars / 20 rows + maxTokens 1024 → 0.01** (still one attested NEAR AI call); phrase none → 0.01 but no model call, so not an attested route. | node run of packages/offer quoteOffer in this chat |

## 1. How it works (one round)

```
agent: estimate (POST /offers) -> 0.02, signed quote ✓, limits ✓
agent policy: 0.02 > autoApprove 0.01 -> "counter", ceiling 0.01            (F1; t02 after the owner's policy change)
agent -> console: POST /offers/<id>/counter {maxPriceUsd:"0.01"}            (ARCH-721)
console: walk config/counter-ladder.json, each step a SMALLER basis;
         skip a step whose route is not attested when the console sells attested only;
         signer.price(basis') per step; first price <= 0.01 wins             (ARCH-720, ARCH-721)
console: new offer (new job id, paywall registered at 0.01, NEW signed quote whose limits are the smaller basis),
         holds counterOf + reduced; answers like POST /offers + {counterOf, reduced}
         or 422 {code:"no_fit", cheapestUsd} (nothing registered, nothing signed)
agent: step "countered"; signed quote ✓ and limits ✓ again on the NEW offer; policy again (round 1, reduced steps
       must be in acceptReduced) -> pay; [re-check size]; mandate for the NEW quote; pay 0.01 upfront
console: run held to the smaller signed limits (F6); receipt carries counterOf + reduced (F7)
```

One round only: `--counter-max-rounds 1` on the console (a counter of a counter is refused) and on the agent; the
tenant's `counter.maxRounds` still applies (the smaller of the two wins).

## 2. The ladder (owner approved 2026-11-14, "make the examples reasonable") — `config/counter-ladder.json`

### 2.1 What a price is made of (packages/offer worstCase + quoteJob, read and run in this chat)

price = ceil_to_cent( max(0.01, 1.20 x (fees + model worst case + compute)) ), with
- fees: 0.001 per priced model call + 0.002 analyst + 0.002 NEAR gas (fixed: 0.005 for 1 call, 0.007 for 3 calls);
- model worst case: every call billed at its prompt cap AND at maxTokens completion tokens (NEAR AI deepseek-v4.1-flash:
  0.30 / 1.20 USD per M tokens; the local query model is free);
- compute: analyst + gateway time from the calibrated cost model, about 0.0009 USD per MB of data plus ~0.0007 per job.

So only three things can shrink a price: fewer model calls, smaller prompt caps, fewer completion tokens. Data size
cannot shrink without changing the question, and whole-cent rounding means a step only helps when it crosses a cent.

### 2.2 Realistic data (sizes measured on the repo's sample data; D and E scaled from Orion's bytes per row)

| Data | Files | Rows | Bytes | Bytes/row |
|---|---|---|---|---|
| A smb-fin-1 (demo: bank statement, open AR, open AP) | 3 CSV (+1) | 32 | 5,395 | ~110 |
| B Orion, one year of a small manufacturer's ERP (bank, invoices, payments, orders) | 14 CSV | ~3,900 | 526 KB | 110-210 |
| C the same Orion year as one ERPNext JSON bundle | 1 JSON | 2,432 documents | 2.05 MB | — |
| D mid-size SMB, one year (scaled) | 20 CSV | ~80,000 | 12 MB | ~150 |
| E multi-site business, one year (scaled) | 40 CSV | ~350,000 | 50 MB | ~145 |

Templates: T1 exact SQL + NEAR AI worded answer (1 call; the demo); T2 the local model writes the SQL (2 tries) + NEAR AI
answer; T3 NEAR AI writes the SQL (2 tries) and answers (3 attested calls).

### 2.3 Why the ladder values are reasonable (measured, not guessed)

- Answer rows 50 -> **20** (answer prompt cap 8,000 -> 4,000 chars): every shipped template's result is far below 20 rows
  (UI smoke 2026-11-14: smb-fin-1 1 row; Orion templates 4-12 rows), so the worded answer loses nothing on them;
  20 rows x ~10 columns x ~12 chars ~ 2,400 chars + the question fits 4,000.
- Answer length 2,048 -> **1,024** -> **512** tokens: the live NEAR AI answer of job d8d0a251 used **209** completion
  tokens (admin Jobs breakdown), so 512 still leaves ~2.4x headroom (~380 words); SQL replies are shorter still.
- SQL tries 2 -> **1** (sqlRetries 0): only matters when a model writes the SQL (T2, T3); the exact-SQL templates have none.
- "Table only" (phrase none) is NOT on the ladder: no model call means no attested route, which t01/t02 require and the
  console's -PayOnlyAttested verified refuses.

| Step (cumulative) | Reduced name | A T1 | B T1 | C T1 | A T3 | B T3 | D T1 | E T1 |
|---|---|---|---|---|---|---|---|---|
| as quoted | — | 0.02 | 0.02 | 0.02 | 0.04 | 0.04 | 0.03 | 0.07 |
| 1 answer reads <= 20 rows | answerMaxRows | 0.02 | 0.02 | 0.02 | 0.04 | 0.04 | 0.03 | 0.07 |
| 2 + answer <= 1,024 tokens | maxTokens | **0.01** | 0.02 | 0.02 | 0.03 | 0.03 | 0.03 | 0.07 |
| 3 + answer <= 512 tokens | maxTokens | 0.01 | **0.01** | 0.02 | 0.03 | 0.03 | 0.03 | 0.07 |
| 4 + one SQL try | sqlRetries | 0.01 | 0.01 | 0.02 | **0.02** | **0.02** | 0.03 | 0.07 |

(Prices from packages/offer quoteOffer with config/cost-model.json, catalog prices and config/paid-jobs-prices.conf fees.)
Reading it: a counter wins a cent on small data (A, B) and halves T3 (0.04 -> 0.02, one SQL try instead of two). On big
data (D, E) compute dominates and the honest answer is **no_fit** (the cheapest smaller job is still above the ceiling).

### 2.4 The buyer's accepted steps go with the request

`POST /offers/<id>/counter {maxPriceUsd, accept:[...reduced names]}`: the console walks only steps whose names the tenant
accepts (its `counter.acceptReduced`), so a fit is never refused afterwards for a step the buyer would not take.

### 2.5 Demo cases with t02 (autoApproveMaxUsd 0.01; acceptReduced answerMaxRows, phrase, maxTokens — owner approved)

| Run | Quote | Counter | Outcome |
|---|---|---|---|
| smb-fin-1, template 1 (T1) | 0.02 | ceiling 0.01 -> step 2 fits: 0.01, reduced [answerMaxRows, maxTokens] | paid 0.01; receipt "counter of <first id>" |
| Orion, "Biggest payments out" (T1) | 0.02 | step 3 fits: 0.01, reduced [answerMaxRows, maxTokens] | paid 0.01 |
| smb-fin-1 with a free question, NEAR AI writes SQL (T3) | 0.04 | sqlRetries not accepted by t02 -> cheapest 0.03 > 0.01 | refused **no_fit**, nothing signed or paid |
| t01 any of the above | 0.02 | none: 0.02 <= t01's auto-approve 0.05 | paid 0.02 as today |

## 3. IDs

| ID | Where | What |
|---|---|---|
| ARCH-720 | test-console/console/counter.ts (new), config/counter-ladder.json (new) | Ladder parser (each step only reduces; known fields; step names in REDUCIBLE) and the pure fit walk: `fitCounter(basis, ladder, maxPriceMicro, price(basis'), allowed(basis'))` -> first fit `{basis, reduced, quote}` or `{noFit, cheapestUsd}`. No model, deterministic. |
| ARCH-721 | console server.ts (+ offers.ts HeldOffer) | `--counter on\|off` (default off), `--counter-ladder PATH`, `--counter-max-rounds N` (default 1). `POST /offers/<id>/counter {maxPriceUsd, accept}` (same host check as POST /offers): checks the offer, the round, that maxPriceUsd < its price; walks the ladder with `SIGNER.price`; on a fit makes a new offer through the same code as POST /offers (moved into one function, unchanged), with counterOf/reduced held; 422 no_fit / 409 round_used / 404 / 400. Logs ids, amounts, step names only. The original offer stays until it expires (the buyer may still pay it). |
| ARCH-722 | console server.ts runOffer | The receipt of a counter job carries `counterOf` + `reduced` from the held offer (F7: no receipt or signer change). |
| ARCH-723 | packages/agent-policy | `maxTokens` added to REDUCIBLE (tenant files that do not list it are unchanged). |
| ARCH-724 | services/paywall/scripts/agent-jobs-core.ts, agent-jobs.ts | `--counter on\|off` (default off). On, a policy "counter" asks the console (ARCH-721) with the tenant's acceptReduced as `accept` inside the tenant's queue slot; step `countered {counterOf, jobId, priceUsd, reduced}`; then the NEW offer goes through the existing checks unchanged (signed quote + limits, policy with counterRound 1, re-check, mandate, payment). no_fit or any failure -> refused (code counter_no_fit / counter_failed), nothing signed or paid. Off: "counter" stops as today. |
| ARCH-725 | tab 03 paid-jobs.html, scripts/agent-ask-core.ts | The `countered` step: "Counter-offer: asked for at most 0.01; ChainAim offered a smaller job at 0.01 (answer rows 20, tokens 1024) ✓". The receipt panel already shows the receipt; verify-receipt already prints "counter of". |
| ARCH-726 | test-console/up.ps1, desk.ps1, desk.example.json | `desk.ps1 -Counter on\|off` (else desk.json paidJobs.counter, else off) -> up.ps1 -Counter -> console `--counter on --counter-ladder /app/config/counter-ladder.json` and agent `--counter on`. |

Not built (left as design-32 says or for later): the human "Offer a lower price" box in tab 03 (the Me path), more than
one round, a route step, showing counterOf on the admin Jobs tab, and putting counterOf inside the signed quote itself
(today it is signed inside the receipt; adding it to the checkout would change the signer).

## 4. Files

Changed (11): test-console/console/server.ts, test-console/console/offers.ts, test-console/console/paid-jobs.html,
packages/agent-policy/src/index.ts, services/paywall/scripts/agent-jobs-core.ts, services/paywall/scripts/agent-jobs.ts,
scripts/agent-ask-core.ts, test-console/up.ps1, test-console/desk.ps1, config/local/desk.example.json,
rig/tenants/t02/tenant.json (**owner's values**, §6).
New (2): test-console/console/counter.ts, config/counter-ladder.json.
Tests: new test-console/test/counter.test.ts (ladder + fit, with the real quoteOffer numbers of F8),
new services/paywall/test/agent-counter.test.ts (through the real paywall: counter -> pay 0.01; no_fit -> nothing paid;
off -> stops as today; reduced step not accepted -> refused); changed scripts/test/console-paid-jobs.test.ts (the route
on the real console, analyst, gateway and paywall), scripts/test/desk.test.ts (guards), scripts/test/agent-ask.test.ts
(step line), packages/agent-policy test (maxTokens reducible).
Docs: this file, MANUAL_SETUP.md, BUILD_LOG.md, STATE.md.
No change: the signer (packages/signer, services/signer), packages/receipt, verify-receipt, the paywall, the admin repo.

## 5. Tests

Automated (AI, then owner `-Test`): as §4.

Terminal (owner, after the restart with -Counter on):
`desk.ps1 -AgentAsk -Tenant t02 -Dataset smb-fin-1 -Template 1 -AgentAnswerModel nearai/deepseek-v4.1-flash`
expect: Estimated · Quoted 0.02 · Quote signed OK · Spending policy: counter (above auto-approve 0.01) ·
**Counter-offer ... smaller job at 0.01 (answer rows 20, tokens 1024)** · Quote signed OK (new limits) · Spending policy:
pay OK · Size re-checked OK · Mandate signed · Payment signed · Settled 0.01 · Result released · receipt verified ·
mandate verified. Then `-VerifyReceipt <file>` shows `counter of <first job id>` and the smaller limits.
t01 (auto 0.05) still pays 0.02 directly: the counter path changes nothing for a quote within auto-approve.

UI: tab 03, AI agent **t02**, same template and model: the same steps in the step list; the admin Jobs tab shows the
0.01 job with its signed quote, tenant mandate and receipt.

## 6. Owner decisions before code

1. APPROVED 2026-11-14: t02 `autoApproveMaxUsd` 0.05 -> 0.01 and `counter.acceptReduced` + "maxTokens"; t01 unchanged.
2. APPROVED: the ladder of §2.3 (four steps, no phrase-none step).
3. APPROVED: ~3 h AI + ~30 min owner checks, before the video.
