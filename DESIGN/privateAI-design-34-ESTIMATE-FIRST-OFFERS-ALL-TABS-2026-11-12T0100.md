# privateAI-design-34: estimate first, work only after the buyer's go-ahead, on tabs 01, 02 and 03 (ARCH-634 to ARCH-645)

Chat near-ai-impl-8, 2026-11-12 ~01:00Z. Status: DESIGN (analysis + file list), no code. Builds on design-32 §3.1-3.7
(firm quote, ARCH-601..612: specified 2026-11-09, never built) and design-33 (AP2 signed quote, Phase 1 built and live).

Owner requirement (2026-11-12 00:54Z): "the service provider SHOULD NOT do any work - it should just estimate - before
any work is done until the buyer says the go ahead to make sure the mandates are compliant, and an AI agent can pay. It
should be the same in tabs 01 and 02 as well. Which files need to change? Any refactor so the 3 tabs share components?"

## 0. What the code does today (read in this chat; file and line refs)

| Tab | Today | Work before go-ahead? | Price | Signed quote (AP2) | Agent can pay |
|---|---|---|---|---|---|
| 01 Scan and mask (index.html t1, 314-333) | Buttons call `/gateway/scan`, `/gateway/mask` (index.html 1059-1083) with the console's gateway key: **free, no payment at all**. The "$0.01" label is read from the paywall's 402 (index.html 1055) but never paid | n/a (free) | fixed `PRICE_SCAN/MASK` (paywall config.ts 354), shown only | no | no |
| 02 Private chat (t2, 334-367) | Paid Send: `/paid/chat` -> paywall fixed-price x402 route (services/web `payAndChat`, `nearPayAndChat`; server.ts 965). Paywall: verify payment -> gateway serves -> settle; a refused call is never settled | **No** (pay-then-serve), correct already | fixed `PRICE_CHAT`, same for any prompt | no | no |
| 03 Across files (t5 + paid-jobs.html) | `/jobs/crossask` runs the whole job, meters it, quotes, holds the result; then pay to release (design-33 signs this quote) | **Yes** - the owner's objection | metered after the run, cent-rounded under AP2 | yes (design-33) | yes |

So: tab 02 already does no work before the go-ahead but its price is not an estimate of the work and is unsigned; tab 01
has no paid path; tab 03 has the right signing and agent path but does the work first.

## 1. Target flow, the same for all three tabs: Offer -> go-ahead -> run -> settle

```
1 ESTIMATE  page/agent -> console POST /offers {kind, sizing}            no model call, no analyst query, no gateway call
            console: basis (sizes, limits, route) -> firm price (cost model, worst case) -> AP2 signed checkout
            -> registers {offerId, amount, expiresAt} with the paywall -> answers {offer, ap2}
2 GO-AHEAD  Me: page checks the signed quote (WebCrypto, built), shows the firm price, user presses Pay (wallet signs)
            Agent: verifies the signed quote with the pinned key (built) + spending policy -> signs
3 RUN       paywall POST /v1/offers/<id>/release (payment header + the request body: text / prompt / question)
            -> verify payment (not settled) -> console POST /internal/offers/<id>/run with the body
            -> the console runs ONLY within the offer's basis (max bytes, max_tokens, retries, rows, route)
4 SETTLE    good result -> settle -> result to the buyer -> receipt (points at the signed quote) ; failed / over-limit /
            empty -> no settlement, the signed delegate is never submitted (design-32 ARCH-611 void rule)
```
The input text (tab 01 text, tab 02 prompt, tab 03 question) is sent only in step 3, after the go-ahead; step 1 sends
sizes only (bytes, characters, file count), so nothing is examined before the buyer agrees.

## 2. Pricing per kind (firm, worst case, from config; no invented numbers)

| kind | basis sent in step 1 | worst-case price (pure function in cost.ts) |
|---|---|---|
| `scan`, `mask` | text bytes (UTF-8, counted in the browser/agent) | `presidioPerKbUsd x KB` + fees + margin, min price |
| `chat` | prompt bytes, attachment bytes, route, `max_tokens` | `ceil(bytes x tokensPerByte)` prompt tokens + `max_tokens` completion on the route's catalog price + fees + margin |
| `crossask` | dataset id, template or question, set | design-32 `quoteFirm` (worst-case meter: calls = 1 + sqlRetries + answer, maxPromptChars, maxTokens) + analyst per MB |

`config/cost-model.json` (design-32 ARCH-602..604, calibrated by `desk.ps1 -Calibrate`; no file -> estimate-first is off
and the tab falls back to today's behaviour with a visible note). Rounded to cents (design-33 D2) so every kind can be
an AP2 checkout. The meter still runs during step 3 and `actualUsd` goes in the receipt (never charged).

## 3. Common components (the refactor)

| Component | New / from | Shared by |
|---|---|---|
| `packages/offer` (pure): `Offer` type `{offerId, kind, route, basis, priceUsd, amount, expiresAt}`, `basisOf(kind, input)`, `quoteOffer(kind, basis, prices, fees, costModel, round)` | new; `quoteJob` stays in crossask cost.ts and is called by it | all 3 tabs, agent |
| console `offers.ts`: `OfferStore` (replaces the quote half of `JobStore`), `POST /offers`, `POST /internal/offers/:id/run` dispatching on kind (scan/mask -> gateway, chat -> gateway with `max_tokens`, crossask -> `crossAsk` with the basis limits) | from jobs.ts + server.ts `/jobs/crossask` | all 3 |
| console `ap2.ts`: `jobCheckout` -> `offerCheckout(kind, ...)` (line item id `chainaim.<kind>.<route>`, title per kind) | generalise (built) | all 3 |
| paywall `jobs.ts` `JobBook` -> `OfferBook`; route `/v1/offers/:id/release` = verify -> console run -> settle (today it fetches a held result instead of running) | generalise | all 3 |
| page `offer-box.js` (one module, mounted in t1, t2, t5): Estimate -> firm price + signed-quote check -> Pay (Me) or Agent run -> result to the tab's own renderer -> receipt panel | extracted from paid-jobs.html (pay box, `checkSignedQuote`, `receiptPanel`, `agentRun`) | all 3 |
| services/web `nearPayAndRelease(quote, releaseUrl)` | already generic; reused as is. XRPL (Crossmark) needs the same `payAndRelease` | all 3 |
| agent `agent-jobs-core.ts`: tool `chainaim_ask_across_files` -> `chainaim_offer` with `kind`; `runAndPay` becomes estimate -> verify signed quote -> policy -> pay release with body | generalise | all 3 |
| receipt v2: `kind`; `files/filesRoot/datasetId/sqlSha256` required only for crossask; `inputSha256` (hash of the text/prompt, never the text) for scan/mask/chat | packages/receipt (v1 receipts still verify) | all 3 |
| near-watch + admin Jobs tab: `kind` on job events and a "kind" column | adminUI jobs.ts, jobs.tsx | all 3 |

## 4. Files to change

Private repo (chainaim-private-ai):
- NEW `packages/offer/{package.json,src/index.ts,test/offer.test.ts}`
- `packages/crossask/src/cost.ts` (+ `quoteFirm`, worst-case meter; design-32 ARCH-602), `config/cost-model.json` (NEW, from calibration)
- `packages/receipt/src/index.ts` (receipt v2 fields, v1 still verifies), tests
- `test-console/console/offers.ts` (NEW), `jobs.ts` (JobStore keeps holding results only for the legacy `--pricing after`), `server.ts` (routes `/offers`, `/internal/offers/:id/run`, flag `--pricing firm|after`, per-kind price flags), `ap2.ts` (`offerCheckout`), `receipt.ts` (kinds), `job-feed.ts` (kind)
- `test-console/console/offer-box.js` (NEW, served like paid-jobs.html), `paid-jobs.html` (shrinks to tab 03 specifics or is replaced), `index.html` (t1: mount the offer box under Mask/Scan; t2: replace the Crossmark/NEAR paid Send with the offer box; t5 unchanged mount point)
- `services/paywall/src/jobs.ts` -> offers, `app.ts` (`/v1/offers/:id/release`: verify -> run -> settle; fixed-price `PAID_ROUTES` kept behind a flag for old buyers), `routes.ts`, `config.ts` (`PAID_OFFERS=on`, run timeout)
- `services/web/src/near-wallet-entry.ts` (no API change), `services/web/src/*` XRPL `payAndRelease` (NEW, mirrors NEAR)
- `services/paywall/scripts/agent-jobs-core.ts`, `agent-jobs.ts`, `agent-ap2.ts` (bind to offer kind), `scripts/agent-ask*.ts`, `scripts/verify-receipt.ts`
- `test-console/up.ps1`, `desk.ps1` (`-Pricing firm`, `-Calibrate`), console/agent Dockerfiles + ignores (packages/offer, cost-model.json)
- Tests: every file above gets ARCH-tagged tests; paid-jobs-receipt.test.ts (lesson 11), console-paid-jobs.test.ts, agent-ap2/agent-policy tests

Admin repo (chainaim-adminUI-NEAR): `services/near-watch/src/jobs.ts` (`kind`, optional), `store.ts` (column via new table, not ALTER), `apps/admin-console/lib/types.ts`, `components/tabs/jobs.tsx` (kind column), tests.

## 5. ARCH-IDs (unused before this doc: 634+ checked in DESIGN/, architecture*.md, STATE.md)

| ID | Requirement |
|---|---|
| ARCH-634 | packages/offer: Offer, basisOf, quoteOffer per kind (scan, mask, chat, crossask), cents |
| ARCH-635 | cost model file + calibration (= design-32 ARCH-602..604) incl. presidio per KB and gateway per KB |
| ARCH-636 | console POST /offers: estimate only (no model, analyst or gateway call), AP2 signed, registered with the paywall |
| ARCH-637 | paywall /v1/offers/:id/release: verify -> console run -> settle; void rule (design-32 ARCH-611) |
| ARCH-638 | console run within the basis: size re-check (409 requote), max_tokens, retries, rows (design-32 ARCH-606..609) |
| ARCH-639 | shared page offer box (estimate, signed-quote check, Pay, agent run, receipt) mounted in t1, t2, t5 |
| ARCH-640 | tab 01 paid scan/mask through the offer box (today free) |
| ARCH-641 | tab 02 paid chat through the offer box (today fixed-price /paid/chat) |
| ARCH-642 | tab 03 crossask through the offer box (estimate first replaces run-then-quote; `--pricing after` kept as free-trial mode) |
| ARCH-643 | agent: one tool with kind; estimate -> verify -> policy -> pay -> verify receipt |
| ARCH-644 | receipt v2 (kind, inputSha256), verify-receipt, -AgentAsk |
| ARCH-645 | near-watch + admin Jobs tab: kind |

## 6. Verify first (before code; design-32 §5 items still open)

- V-P2 **critical**: the NEAR delegate the buyer signs must stay valid while the work runs inside the release (crossask
  up to 300 s; chat up to `--paid-timeout-sec`). If the window is shorter, estimate-first on tab 03 needs design-32
  ARCH-612 (prepaid credits) instead.
- V-P1 the paywall middleware does not settle on a >= 400 result (tab 02 already relies on this).
- V-P3 / V-P4 reasoning tokens count inside `max_tokens`; tokens <= UTF-8 bytes for the routed models (worst-case price is
  only safe if true).
- V-P5 the route can be chosen from the question alone (PHI rules) before the text is sent; else the estimate offers
  every route the dataset's class allows.
- Calibration data: no cost-model.json exists today, so ARCH-635 needs real calibration runs on this PC first.

## 7. Size and order (AI estimate)

Large: about the size of design-32 Phase 1 + design-33 Phase 1 together. Order that keeps the demo working at each step:
1. ARCH-634, 635 (pure + calibration) - nothing visible changes.
2. ARCH-636, 637, 638, 642 - tab 03 becomes estimate-first (agent and Me); `--pricing after` stays as fallback.
3. ARCH-639 extraction (no behaviour change, page tests prove it), then ARCH-641 (tab 02), then ARCH-640 (tab 01).
4. ARCH-643..645.
Hackathon deadline 2026-11-14 23:59 UTC: steps 1-2 are the realistic part before it; 3-4 after.

## 8. Owner decisions needed

- D1 Order: as §7 (tab 03 first), or tabs 01/02 first?
- D2 Tab 01: should scan/mask become paid at all (today free in the console), or only priced/signed when "Pay" is ticked?
- D3 Tab 02: keep Crossmark (XRPL RLUSD) as a second rail for offers, or NEAR USDC only?
- D4 Free trial: keep `--pricing after` (run-then-quote, no AP2) as a rate-limited free mode, or remove it?

## 9. Owner answers (2026-11-12 ~01:02Z)

- D1 = tab 03 first (§7 order).
- D2 = tab 01 is priced and paid only while its "Pay" box is ticked; unticked it stays free as today. Scan and mask make
  **no model call** (Presidio only, gateway /scan and /mask): the `scan`/`mask` price is `presidioPerKbUsd x KB` + fees +
  margin + minimum, with no token line (§2 already has none; confirmed).
- D3 = keep Crossmark (XRPL RLUSD) as an option: flag `--offer-rails near|xrpl,near` (default near); with xrpl the offer
  box shows both wallets and services/web gains `payAndRelease` (XRPL) beside `nearPayAndRelease`. AP2 checkout carries
  the rail's network/asset/payTo in `dev.chainaim.job`; the x402 amount per rail from the same cents.
- D4 (2026-11-12 ~01:05Z) = both kept as options, default estimate-first:
  - `estimate-first` (DEFAULT): estimate (no work) -> get the buyer's mandate -> run -> settle. "Mandate" here = the
    buyer's go-ahead bound to the signed quote: on the Me path the wallet-signed x402 payment for the offer; on the agent
    path the same plus, once design-33 Phase 2 (ARCH-632/633) is built, the agent's AP2 checkout mandate (SD-JWT+kb),
    which the paywall verifies before the run.
  - `run-hold` (option, today's tab 03 behaviour): run, meter, quote, HOLD the result, release only after payment.
  - Flag `--offer-mode estimate-first|run-hold` (replaces design-32's `--pricing firm|after`); default estimate-first.
    estimate-first needs config/cost-model.json: without it start-up stops naming `desk.ps1 -Calibrate`, and up.ps1
    follows its usual pattern (auto, INFO line, run-hold) unless `-OfferMode estimate-first` is given explicitly.
- D5 (2026-11-12 ~01:11Z) = option B "for now": the buyer sees the choice, default estimate-first.
  - Pay box (tabs 01/02/03): a two-way choice "Estimate first (pay before any work)" [default, pre-selected] /
    "Run first (result held until you pay)"; the run-first label says ChainAim works before the go-ahead.
  - Terminal: `desk.ps1 -AgentAsk ... -OfferMode estimate-first|run-hold` (default estimate-first), shown in its step lines.
  - Agent (POST /run body `offerMode`, default estimate-first); the tenant's policy may refuse run-hold (packages/agent-policy).
  - Operator control kept: `--offer-modes LIST` = the modes buyers may pick (default `estimate-first,run-hold` per D5;
    `estimate-first` alone hides the choice = option A later, no code change). `--offer-mode` = the default (estimate-first).
  - The receipt and the admin Jobs tab record which mode each job ran in.

## 10. Built (chat near-ai-impl-9, 2026-11-12) and one deviation to confirm

Built for tab 03 (crossask), Me and AI agent: ARCH-636 (POST /offers), ARCH-637 (paywall release = verify -> run -> settle),
ARCH-638 (run within the basis), ARCH-642 (pricing choice in the pay box, agent offerMode, -AgentAsk -OfferMode),
up.ps1 -OfferMode auto. Not yet: ARCH-639/640/641 (tabs 01/02), 643-645, design-33 Phase 2 (AP2 checkout mandate).

Deviation (AI choice, owner to confirm): §1 sends only sizes in step 1 and the question in step 3. Built: the question is
sent with the estimate and HELD by the console with the offer; it is never sent to a model, the analyst or the gateway, and
nothing is run, before payment. Reason: the paid release carries no body today (services/web payNearRelease and the agent
post it empty), so the stricter form needs a wallet-bundle change; it can follow without changing the paywall.

Fixes after the live run (2026-11-12 ~23:30Z, chat near-ai-impl-9), owner-approved:
- ARCH-644 (route): the route on the /offers answer, the AP2 checkout and every receipt is the models the job calls, never
  the request's model fields. Estimate: offerModels(basis) (the models priced); run-first quote and every receipt: the
  run's own steps (receipt.ts calledModels over sentToModel). An exact query worded by a model names only the answer model;
  one worded by no model is "analyst-only". Before: an exact-SQL template's receipt named the unused query model.
- ARCH-638 (answer cap): new console flag --crossask-answer-max-prompt-chars N (default 8000). crossask leaves result rows
  out from the end until the answer prompt fits and says how many are shown; when one row does not fit, no model is asked
  and the result is kept with the reason (an estimate-first run then answers 422, not charged). The basis carries
  answerMaxPromptChars; worstCase prices the answer call at it (query calls stay at maxPromptChars). Before: the answer call
  was priced at the query cap (40,000) and the answer prompt had no cap at all, so the priced bound was not enforced.
  Effect with the 2026-11-12 cost model: smb-fin-1 exact template + nearai answer 0.04 -> 0.02; Orion 0.09 -> 0.07 (the rest
  is the analyst line, ARCH-635b: per-MB rate calibrated on 3.4 KB files only).
- ARCH-635b (analyst line): cost model version 2 adds units.analystBaseUsd. Calibration takes each dataset size's slowest
  analyst run as a point and fits base + slope x bytes: of the lines on or above every point (slope 0 or between two sizes,
  base never below 0), the one with the least total excess. It refuses one size, or sizes less than --analyst-size-ratio
  (default 16) apart. worstCase prices "analyst" (per MB) and "analystBase" (per run), both raised by safetyPct. Version 1
  files still load with base 0. Before: one per-MB rate from smb-fin-1 (5,395 B, 648 ms = 125,945 ms/MB) priced Orion's
  2 MB at about 252 s of analyst time; it runs in about 7 s. Projection (assumes Orion about 7.1 s, to be replaced by the
  owner's -Calibrate): Orion template 0.07 -> 0.02; a free question on nearai stays 0.08 (two query calls at the 40,000
  character query cap), above t01/t02's 0.05 auto-approve: an owner decision (cap, retries or policy), not changed here.
- ARCH-635c (model call line + calibration robustness): cost model version 2 also has units.gatewayBaseUsd (per model call);
  calibration fits base + per-KB over each prompt size's slowest call with the same least-excess supporting line
  (--gateway-size-ratio, default 4); worstCase adds "gatewayBase" x the priced calls. The analyst is timed on each
  template's exact query (phrase none, no model), so a model writing a bad query cannot fail it; a free run whose
  model-written query does not run is SKIPPED (printed, in the report's "skipped", left out of the numbers); a rate limit
  left after the retries and every other failure still write nothing. Calibration prints the largest query prompt seen,
  for the owner to set --crossask-max-prompt-chars from data. Projection (recorded smb-fin-1 calls; Orion analyst assumed
  about 7.1 s): Orion template 0.02 (nearai and bedrock); free question nearai 0.07, bedrock 0.04. Open owner decision:
  the 40,000-character query cap, which prices the free question's two query calls.
