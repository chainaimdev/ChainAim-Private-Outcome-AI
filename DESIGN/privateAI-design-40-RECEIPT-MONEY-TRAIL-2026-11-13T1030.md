# privateAI-design-40: the receipt shows the money trail (price, cost, margin, overrun, payment, attestation)

Chat near-ai-impl-12, 2026-11-13 ~10:30Z. Must-do item 4 of the near-ai-impl-11 table. Release target: v2.1.0.
Status: DESIGN ONLY. No code changed. Punchline: **"One receipt shows what you paid, what it cost us, and what we earned."**
Track: Real-World Money (the business model is visible and checkable per job).

## 0. Sources read in this chat (v2.0.0 code)

- packages/receipt/src/index.ts: `RECEIPT_VERSION = 1`; `ReceiptPrice {amountUnits, usdcDecimals, priceUsd,
  quoteBasis, actualUsd?}` ("what the run actually cost by the meter; recorded, never charged", ARCH-609);
  `ReceiptBody` has optional `evidenceBundleSha256` (checked as 64 hex at :145), `merchantAuthSha256`, `mandate`;
  `Settlement {network, transaction, invoiceId, payer, settledAt}` appended with its own signature (ARCH-616).
- packages/signer/src/index.ts: `RECEIPT_FIELDS` / `QUOTE_BASIS_FIELDS` / price `onlyFields(["amountUnits",
  "usdcDecimals", "priceUsd", "quoteBasis", "actualUsd"])`: the signer's allowlist is strict, so every new member must
  be added there or the signer refuses the receipt (400).
- packages/crossask/src/cost.ts: `quoteJob(meter, prices, fees)` → `JobQuote {totalUsd, breakdown {calls[{model,
  promptTokens, completionTokens, usd}], modelUsd, callFeesUsd, analystUsd, nearGasUsd, marginPct, minPriceUsd,
  minApplied, subtotalUsd, withMarginUsd}}`; `Fees {perModelCallUsd, analystUsd, nearGasUsd, marginPct, minPriceUsd}`.
- test-console/console/server.ts:427-441 (runOffer: `metered = quoteJob(meterOf(out.served), prices, fees)`; overrun
  logged as `offer_overrun`; receipt `priceUsd: o.quote.totalUsd, actualUsd: metered.totalUsd`).
- Grep: `evidenceBundleSha256` is in the schema, the checker and receipt.ts's input type, but **nothing sets it**.
- docs/judge/sample-receipt-2026-11-13T0547Z.json: price `{amountUnits "20000", usdcDecimals 6, priceUsd "0.020000",
  quoteBasis {...}, actualUsd "0.010000"}`, one call with `attestStatus "verified"`, settlement tx `4vv6QJSa…mGWAAc`.

What `actualUsd` is today (read from the code, stated so the new fields are not confused with it): the metered job
priced with the SAME fee and margin settings as the quote, i.e. "what the price would have been after the fact", not
ChainAim's cost. The cost parts are inside `metered.breakdown` and are not written to the receipt.

## 1. Decision: optional fields, no version bump

Every v2.0.0 receipt (including the judge sample) must still verify. Precedent: design-33 and design-36 added
`merchantAuthSha256` and `mandate` as optional members of v1. Same rule here: `v` stays 1; all new members optional;
the signer's allowlist and `checkBody` learn them; verify-receipt checks them when present. A version bump would force
every relying party to upgrade for no gain.

## 2. New receipt content

```jsonc
"price": {
  "amountUnits": "20000", "usdcDecimals": 6, "priceUsd": "0.020000", "quoteBasis": { ... }, "actualUsd": "0.010000",
  "economics": {                        // NEW, optional (ARCH-690)
    "costBasis": "catalog",             // costs come from ChainAim's pricing catalog and fee settings, not a provider invoice
    "nearAiCostUsd": "…",               // breakdown.modelUsd of the metered run: the model calls at catalog prices
    "callFeesUsd": "…", "analystUsd": "…", "nearGasUsd": "…",   // metered breakdown parts
    "costUsd": "…",                     // nearAiCostUsd + nearGasUsd (ChainAim's direct outlay for this job)
    "marginUsd": "…",                   // priceUsd - costUsd (may be negative)
    "overrunAbsorbedUsd": "…"           // max(0, actualUsd - priceUsd): what the firm quote saved the buyer
  }
},
"evidenceBundleSha256": "…",            // NOW SET (ARCH-692): SHA-256 of the canonical JSON of the job's attestation bundle
"settlement": { …, "flow": "upfront" }  // NEW optional member (ARCH-691): which x402 flow moved the money
```

- All amounts are decimal USD strings with 6 decimals (`microsToUsd`), as `priceUsd` and `actualUsd` already are.
- The example dots are deliberate: the real numbers come from a run; nothing is invented here.
- `paidTx` is the existing `settlement.transaction` (in the upfront flow it is the payment made before the run).
- `refundTx` is NOT in a receipt: by design-37 I3 a refunded job never gets a receipt. The refund has its own signed
  record (design-37 §5.5), verified by the same tool (§4.3). This replaces the "paidTx/refundTx in the receipt" line of
  the to-do table, with the reason stated.

Which costs count as "cost" (definition, written into the README so judges read the same thing):
- `nearAiCostUsd` = per-call tokens × the catalog's inputPerM/outputPerM for the served model. The catalog holds NEAR AI's
  list prices as configured by ChainAim; it is not NEAR AI's bill. Labelled `costBasis: "catalog"`.
- `nearGasUsd` = the configured settlement gas fee (`--near-gas-fee-usd`), a flat setting, not the measured gas.
- Call fees and the analyst fee are ChainAim's own charges (revenue lines), shown but not counted in `costUsd`.

## 3. ARCH-IDs (new)

| ARCH | Requirement | Where |
|---|---|---|
| ARCH-690 | `price.economics` built from the metered breakdown and the paid price by ONE function `economicsOf(paidPriceUsd, metered)` in packages/receipt (decimal arithmetic in micros, no floats); written by the console, re-computed and checked by the signer before it signs (the signer has the same prices and fees) | packages/receipt, test-console/console/receipt.ts + server.ts, packages/signer |
| ARCH-691 | `settlement.flow: "authorization"\|"upfront"` (optional) from the paywall's release notice; signed by the settlement signature | packages/receipt Settlement, paywall notifyReleased, console parseSettlement, signer parseSettleRequest |
| ARCH-692 | `evidenceBundleSha256` = sha256(canonicalJson(attestation bundle)) where the bundle = the job's `JobAttestation` (ca-attest verdicts, signing addresses, signed text, signature hex; no text of prompts); the receipt download file carries the bundle as `attestation` | test-console/console/receipt.ts, server.ts receipt download |
| ARCH-693 | verify-receipt: recomputes `economics` from its own members (costUsd = nearAiCostUsd + nearGasUsd; marginUsd = priceUsd − costUsd; overrunAbsorbedUsd = max(0, actualUsd − priceUsd)) and the bundle hash; prints the money trail; old receipts verify and say "no money trail (before v2.1.0)" | scripts/verify-receipt.ts |
| ARCH-694 | verify-receipt `--refund FILE` verifies a design-37 refund record (receipt key signature, fields) and prints paid → refunded | scripts/verify-receipt.ts |

## 4. Detailed changes

### 4.1 packages/receipt (ARCH-690, 691)

```ts
export type ReceiptEconomics = { costBasis: "catalog"; nearAiCostUsd: string; callFeesUsd: string; analystUsd: string;
  nearGasUsd: string; costUsd: string; marginUsd: string; overrunAbsorbedUsd: string };
export function economicsOf(priceUsd: string, actualUsd: string, b: JobQuote["breakdown"]): ReceiptEconomics
```
- Decimal math with `parseDecimal` / micros (packages/crossask cost.ts helpers), signed for `marginUsd` (a leading "-"
  allowed only there; checker pattern `^-?(0|[1-9]\d*)\.\d{6}$`).
- `ReceiptPrice.economics?: ReceiptEconomics`; `checkBody` checks each member and the three identities above (a body
  whose numbers do not add up is refused before signing).
- `Settlement.flow?: "authorization" | "upfront"`; `addSettlement` / verify unchanged in algorithm (canonical JSON covers
  the new member when present).

### 4.2 Console and signer (ARCH-690, 692)

- server.ts runOffer: `receiptHold.economics = economicsOf(o.quote.totalUsd, metered.totalUsd, metered.breakdown)`;
  run-hold path: `economicsOf(quote.totalUsd, quote.totalUsd, quote.breakdown)` (no overrun by construction).
- receipt.ts `receiptOnRelease`: when the job's attestation is final, `evidenceBundleSha256 = sha256Hex(canonicalJson(a))`.
  When it is still `pending` at release (authorization flow or `--pay-only-attested evidence`), the receipt is signed
  without it, as today; with design-39 `verified` it is always final at release.
- Signer `parseReceiptBody`: allowlist `price.economics` members (patterns above). `SellerSigner.signReceipt` cannot
  re-meter the run (tokens per call are not in the receipt, by the allowlist rule), so it checks the identities
  (checkBody) and that `priceUsd` is the signed quote's amount (it already binds amountUnits). Stated limitation:
  `nearAiCostUsd` is the console's metered figure, signed by ChainAim as ChainAim's statement of its own cost.
  (Roadmap: add per-call token counts to the signer request, ids and numbers only, so the signer meters itself.)
- Receipt download (`GET /jobs/<id>/receipt`): the file gains `attestation` (the bundle) next to `ap2` and `mandate`.

### 4.3 verify-receipt (ARCH-693, 694)

Output example (format; numbers come from the run):
```
OK   receipt valid: signed by the pinned key d27d1e9f…, settlement signed too, signed quote matches, checkout mandate matches
OK   money trail: paid 0.020000 USDC (upfront, tx 4vv6…) · NEAR AI cost 0.00…  · gas 0.00… · margin 0.0… · overrun absorbed 0.000000
OK   attestation bundle matches evidenceBundleSha256 (1/1 NEAR AI calls verified)
```
- `--refund FILE`: verifies `sig` with the pinned receipt key over the record without `sig`; prints
  `OK refund valid: invoice … paid <paidTx> → refunded <refundTx> to <payer>, reason <reason>`.
- The judge sample (no economics, no bundle hash) prints the existing OK line plus "no money trail (before v2.1.0)".

### 4.4 Page and job feed

- Tab 03 receipt panel: a "Money trail" line with the five figures and the flow; observer view the same (amounts only).
- Job feed (near-watch) `job_receipt` event gains `marginUsd` and `overrunAbsorbedUsd` (amounts only), so the admin UI
  can total margin per day; adminUI change is out of scope here (chainaim-adminUI-NEAR repo).

## 5. Tests (names carry the ARCH-ID)

| Test | File |
|---|---|
| ARCH-690 economicsOf: exact decimals, negative margin, overrun 0 when under, identities enforced by checkBody | packages/receipt/test/economics.test.ts |
| ARCH-690 signer refuses a body whose economics do not add up; accepts a good one; allowlist names a stray member | packages/signer/test/receipt-economics.test.ts |
| ARCH-691 settlement.flow signed and verified; absent still verifies | packages/receipt/test/receipt.test.ts |
| ARCH-692 bundle hash set when final, absent when pending; download file carries the bundle | scripts/test/console-signer.test.ts |
| ARCH-693 verify-receipt money trail OK / tampered margin FAIL / judge sample still OK | scripts/test/verify-receipt.test.ts |
| ARCH-694 refund record OK / tampered FAIL | scripts/test/verify-receipt.test.ts |

## 6. Implementation steps (AI ~45 min)

1. packages/receipt types, economicsOf, checkBody + tests.
2. Signer allowlist + tests.
3. Console receipt hold (both paths), bundle hash, download file + tests.
4. Paywall notice `flow` (after design-37 1b), console parseSettlement, signer settle allowlist + tests.
5. verify-receipt + `--refund` + tests; run it on the 0547Z sample (must stay OK) and log the output in BUILD_LOG.md.
6. README: the cost definitions of §2 and the verify command. STATE.md + BUILD_LOG.md.

## 7. Wording

"One receipt shows what you paid, what the NEAR AI calls cost ChainAim at its catalog prices, and ChainAim's margin;
when a job costs more than the firm quote, ChainAim absorbs it and the receipt says how much." Do not say "audited
cost" or "NEAR AI's invoice": the figures are ChainAim's signed statement from its catalog prices.
