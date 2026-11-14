# privateAI-design-38: signed limits in the checkout (what you signed is exactly what runs)

Chat near-ai-impl-11, 2026-11-13 ~10:00Z. Item 2 of the must-do table. Status: DESIGN, not built. ARCH-680..685.
Depends on design-37 for the refund path (works without it: a breach is then 409/422 with nothing charged).

Punchline: **"What you signed is exactly what runs. No bigger model, no extra calls."**

## 0. Sources read

- `packages/signer/src/index.ts` 50-92 (`JobCheckoutInput`, `jobCheckout`: the `dev.chainaim.job` extension holds
  network, asset, payTo, amountUnits, usdcDecimals, datasetId, filesRoot, mode), 184-207 (`QuoteRequest` carries
  `pricing: {kind: "offer", basis}`), 214 (a checkout with members `jobCheckout` does not write is refused),
  334-412 (`SellerSigner.signQuote`, `ownQuote`, `verifyMandate`).
- `test-console/console/server.ts` 1044-1058 (estimate: `SIGNER.signQuote({... pricing: {kind: "offer", basis}})`,
  `OFFERS.hold({... basis ...})`, the 402 shows `basis`), 376-430 (runOffer enforces `withinBasis`, sqlRetries,
  answerMaxRows, maxPromptChars, answerMaxPromptChars, maxTokens, the priced call count).
- `test-console/console/offers.ts:108` `withinBasis(basis, now, tolerancePct)`.
- `packages/receipt/src/index.ts` `ReceiptPrice.quoteBasis` (sizes and limits only; recorded today, not signed by the buyer).
- DESIGN-REF/...T0827Z.md §2: the checkout does NOT cover the limits; the mandate binds the checkout by hash.

## 1. Problem

The limits that decide a job's cost — files and bytes, model and answer model, priced model calls, prompt caps,
max_tokens, SQL retries, answer rows, size tolerance — live only in the console's memory (`OFFERS.hold`). Neither
signature covers them:
- ChainAim's AP2 checkout signs price, payee, network, dataset, folder root, mode — not the limits.
- The buyer's mandate signs the checkout hash, so it inherits the same gap.
So nothing the buyer holds proves which model and how many calls were promised, and nothing stops a console change from
running a bigger model at the same price, or a buyer from presenting more data than priced (the console catches the
second today, unsigned).

## 2. Target

The signer puts a `limits` object into the checkout it signs. Because the mandate signs the checkout's hash, the buyer's
agent signs the limits too, with no mandate format change. The console enforces the run from the **signed** limits. The
receipt's `quoteBasis` must equal them, checked by the signer when signing the receipt and by `verify-receipt` offline.
A run outside the limits is refused before any model call where possible; with design-37 `upfront`, refused = refunded.

## 3. ARCH-IDs

| ARCH | What | Where |
|---|---|---|
| ARCH-680 | `limits` member in the `dev.chainaim.job` extension, built by the signer from the basis it priced (never from a separate caller field) | `packages/signer` `jobCheckout`, `signQuote` |
| ARCH-681 | strict parse of `limits` (allowlist, types, ranges); `ownQuote` re-derives limits from the checkout and refuses a mismatch | `packages/signer` parse*, `ownQuote` |
| ARCH-682 | console enforces from the signed checkout: at run start, `limitsOf(o.ap2.checkout)` must equal `OFFERS` basis (else 422 `limits_mismatch`), then all checks read the signed copy | `test-console/console/server.ts` runOffer, `offers.ts` |
| ARCH-683 | agent shows and checks the limits before signing the mandate (optional policy keys `allowedModels`, `maxModelCalls`, `maxTokensPerCall`) | `services/paywall/scripts/agent-jobs-core.ts`, `packages/agent-policy`, `paid-jobs.html` |
| ARCH-684 | signer `signReceipt` refuses when `body.price.quoteBasis` ≠ checkout limits (409 `limits_mismatch`); `verify-receipt` checks the same offline | `packages/signer`, `scripts/verify-receipt.ts` |
| ARCH-685 | refusal codes for breaches: `limits_files`, `limits_bytes`, `limits_model`, `limits_calls`, `limits_tokens`, `limits_prompt`; with design-37 they become refund reasons (`limits_exceeded`) | console runOffer, paywall refund reason map |

## 4. The `limits` object (technical spec)

Member of `checkout["dev.chainaim.job"]`. Every member is required unless marked; values come from the `CrossaskBasis`
the signer priced (the same object the console sends in `pricing.basis`).

| Member | Type | Meaning |
|---|---|---|
| `v` | 1 | limits version |
| `files` | int ≥ 1 | data files priced |
| `totalBytes` | int ≥ 1 | bytes priced |
| `sizeTolerancePct` | number 0..100 | allowed growth before refusal (the console's `--offer-size-tolerance-pct`, passed in the quote request) |
| `queryModel` | string or null | model that writes the SQL; null for an exact template (`userSql`) |
| `answerModel` | string or null | model that words the answer; null when `phrase` is not `llm` |
| `modelCalls` | int ≥ 0 | priced calls = (userSql ? 0 : 1 + sqlRetries) + (phrase = llm ? 1 : 0) (same formula as runOffer) |
| `sqlRetries` | int ≥ 0 | |
| `maxTokens` | int ≥ 1 | max_tokens on every model call |
| `maxPromptChars` | int | query prompt cap |
| `answerMaxPromptChars` | int | answer prompt cap |
| `answerMaxRows` | int | rows given to the answer model |
| `attestedRoute` | boolean | every model call must be a NEAR AI attested route (feeds design-39) |

Canonical form: members sorted (the AP2 checkout JWT is already signed over the JSON the signer built; `ownQuote`
compares re-derived limits with `canonicalJson`).

Size of the change to the signer's data: sizes, model ids and integers only. No file names, question or content
(the signer's data-minimisation rule of design-36 holds).

## 5. Workflows

### 5.1 Estimate
1. Console sizes the folder, builds `basis`, asks the signer to sign the quote (unchanged call; the quote request gains
   `sizeTolerancePct`).
2. Signer prices from the basis (ARCH-662), builds `limits` from the same basis, signs the checkout with them.
3. Console holds the offer and the signed checkout; the 402/estimate answer shows `limits` from the signed checkout
   (replacing today's unsigned `basis` display; `basis` stays as an alias for one release).

### 5.2 Agent decides (ARCH-683)
1. Agent verifies ChainAim's checkout signature (unchanged), reads `limits`.
2. Policy (optional keys): model in `allowedModels`; `modelCalls ≤ maxModelCalls`; `maxTokens ≤ maxTokensPerCall`;
   `attestedRoute` true when the tenant requires attested routes (today's "attested route" check moves onto the signed
   value instead of the console's unsigned `attested` flag).
3. Signs the mandate (checkout hash covers the limits). Page line: "Limits signed: 1 query call on nearai/…, ≤ 2,048
   tokens, 6 files / 41 KB ±10%".

### 5.3 Run (ARCH-682/685)
1. After the mandate check, `limitsOf(o.ap2.checkout)` vs held basis → mismatch = 422 `limits_mismatch` (console bug or
   tampering; nothing runs).
2. Folder re-size against `files`, `totalBytes`, `sizeTolerancePct` → 409 `limits_files` / `limits_bytes`
   (today's `withinBasis`, now on signed values).
3. `crossAsk` is called with the signed model ids, retries, caps and `maxTokens` (as today, from the signed copy).
4. A served model ≠ the signed model → 422 `limits_model` (new: today a gateway fallback to another model is not
   caught here). Served calls > `modelCalls` → 409 `limits_calls` (today's check).
5. With design-37 `upfront`: each refusal → refund with reason `limits_exceeded` + the specific code.

### 5.4 Receipt (ARCH-684)
- `quoteBasis` in the receipt is written from the signed limits; the signer compares it with the checkout in the
  receipt request (`ReceiptRequest.ap2`) and refuses a mismatch. `verify-receipt` does the same with only the receipt
  and the signed quote. Old receipts (no `limits` in their checkout) still verify (the check runs only when present).

## 6. Configuration

| Flag | Where | Default |
|---|---|---|
| `--checkout-limits off\|on` | signer and console (must agree; console start-up reads `/healthz` `limits: true`) | on with `--ap2 on` |
| `--offer-size-tolerance-pct` | console (exists) — now also sent to the signer and signed | unchanged |
| policy `allowedModels`, `maxModelCalls`, `maxTokensPerCall` | `rig/tenants/<t>/policy` (agent-policy) | absent = not checked |

## 7. Tests

- signer: limits derived from basis; a checkout carrying different limits refused by `ownQuote`; unknown limits member 400;
  receipt with altered `quoteBasis` refused; old checkout without limits still verifies.
- ap2/mandate: a mandate over a checkout whose limits were changed fails `checkout_hash` (existing tamper test extended).
- console: signed vs held mismatch 422; grown folder 409 `limits_bytes`; served model swapped 422 `limits_model`; extra call
  409; all before settlement (authorization) or → refund (upfront).
- agent: policy refusals on each new key; page/terminal limits line.
- verify-receipt: OK on a v2.1.0 receipt; tampered quoteBasis → FAIL with the member named.

## 8. Effort and order

~1 h AI (signer + console + verify), +30 min agent policy keys if time. Build after design-37 1a/1b so the refusal path
is already refund-aware. No manual steps.

## 9. Wording

"The price and the job's limits are signed by ChainAim and by your agent." Not "the model is guaranteed to give a correct
answer": limits bind what runs, not what it says.
