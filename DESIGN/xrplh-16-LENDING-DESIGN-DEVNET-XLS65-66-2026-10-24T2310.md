# xrplh-16 — Lending & Borrowing: conceptual + detailed design (XRPL Devnet, XLS-65 / XLS-66)

Checkpoint: **mid-check-2-TR-2**. Codebase: `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2-TR2\chainaim-router-private-ai-2`
Breadcrumb: xrplh-12 (fit) → xrplh-13 (mid-check-1 session record) → **xrplh-16** (this). Supersedes xrplh-12 §4–§5 and §8.3.
Status: **DESIGN ONLY — no code written or changed.** Written 2026-10-24 23:10 (UTC-05:00).

Tags: [S66] XLS-0066 README · [S66.1.2] 66.1/66.1.2-closed-ended-loan-gates.md · [S66.2] 66.2/README.md ·
[S65] XLS-0065 README · [S65.1.4] 65.1/65.1.4-closed-ended-vault.md — all XRPLF/XRPL-Standards master, `status: Draft`, updated 2026-09-15,
downloaded and read this session · [SDK] npm xrpl@5.3.0 package (unpacked and inspected this session) · [XRPL.ORG] xrpl.org pages ·
[CODE] TR2 repo files read this session · [OWNER] owner-run check · [DERIVED] my reasoning from the sources, verify by test · [CHECK] not verified.

---

## 0. Recap of mid-check-1 (from chat "mid-check-1" and DESIGN/xrplh-12, xrplh-13)

- Two tracks were designed. This doc is only **Lending & Borrowing**.
- Thesis: XLS-66 deliberately leaves underwriting and risk management off-chain [S66 §1]. **ChainAim is the off-chain decision layer**:
  private (books stay on the CFO's PC), deterministic (ACTUS + exact formulas compute every number), AI only translates language in
  and explanations out. Pitch: *on-chain execution, off-chain judgment — ChainAim makes the judgment private, exact and checkable.*
- Scope chosen: H1 borrower readiness, H2 terms → `LoanSet`, H3 attestation hash in `LoanSet.Data`, H4 ledger-vs-model reconciliation;
  H5 depositor view as one screen; H6 servicing advice / H7 credentialed vaults on the roadmap.
- Decided: **single network = Devnet**; own clearly labelled test IOU (not called RLUSD); ChainAim underwriting fee = plain XRPL `Payment`
  with request id in a memo (x402/t54/RLUSD stays with the Agentic Finance track).
- Verified then: lending amendments **enabled on Devnet** (LendingProtocol, LendingProtocolV1_1, SingleAssetVault, fixCleanup3_4_0,
  Credentials, PermissionedDomains, MPTokensV1) [OWNER, 2026-10-24 19:34]; not enabled on Testnet or Mainnet.
- Open item closed today: the V1.1 maturity buffer = **`LOAN_REDEMPTION_BUFFER = 60` seconds** [S66.1.2 §3.1].

---

# PART A — CONCEPTUAL DESIGN

## A1. Actors and what each one does

| Actor | XRPL account | Role | Signs |
|---|---|---|---|
| Issuer | `I` | Issues the test IOU `TUSD` (labelled "test USD, not RLUSD") | TrustSet-related, issuing Payments |
| Broker = Vault owner | `B` | Creates closed-ended vault + LoanBroker, posts first-loss cover, co-signs loans, services loans. XLS-66: vault owner and broker must be the same account [S66 §2] | VaultCreate, LoanBrokerSet, CoverDeposit, LoanSet (counter-sign), LoanManage |
| Depositor(s) | `D1..Dn` | Fund the vault during Subscription; redeem after RedemptionDate | VaultDeposit, VaultWithdraw |
| Borrower (SME, CFO) | `R` | Asks "can we afford it?", pays ChainAim's fee, signs the loan, repays | Payment (fee), LoanSet (initiator), LoanPay |
| ChainAim | `C` | Receives underwriting fee; produces underwriting pack, verdict, attestation hash, draft `LoanSet`, reconciliation, depositor view | **Never signs a loan transaction** |

## A2. The idea in one picture

```
CFO PC (private)                ChainAim (off-chain, deterministic)             XRPL Devnet (on-chain execution)
────────────────                ───────────────────────────────────             ────────────────────────────────
books (CSV) ─▶ analyst (DuckDB)                                                 closed-ended Vault (XLS-65)
   monthly net cash, no names ─▶ ACTUS ANN schedule + scenarios                 LoanBroker + first-loss cover (XLS-66)
                                 XLS-66 formula engine (exact ledger math)
                                 affordability rules → verdict
                                 AI explanation (masked, /verify-checked)
                                 underwriting pack → SHA-256 → Data (≤256 B)
fee Payment (TUSD, memo=reqId) ─────────────────────────────────────────────▶ Payment R→C
                                 draft unsigned LoanSet  ◀── verify fee
borrower signs ─────────────────────────▶ broker checks hash+verdict, counter-signs ─▶ LoanSet → Loan object
                                 reconcile Loan vs engine ◀──────────────────── ledger_entry / vault_info
depositor screen ◀────────────── cover adequacy, default loss, share-value effect
```

## A3. Why this is the right split (deterministic vs AI)

| Concern | Deterministic | AI |
|---|---|---|
| Business cash flows | analyst DuckDB queries [CODE services/analyst] | picks the question |
| Loan schedule | ACTUS ANN/PAM [CODE actus.ts] **and** a local copy of the XLS-66 amortisation formulas [S66 App. A-2 §1–§2] | — |
| Verdict | rules with thresholds in config | explains the verdict in plain words |
| Ledger fields | pure unit converters + pre-flight validator of every spec failure condition | — |
| Signing | humans (borrower, broker) | never |

## A4. Lifecycle on Devnet under V1.1 (the rules that shape the demo)

Phase is derived from the **parent ledger close time**, not stored [S65 §3.1.2.2]:

| Condition | Phase | Allowed (relevant) |
|---|---|---|
| `now <= SubscriptionDate` | Subscription | VaultDeposit, VaultWithdraw; LoanBrokerSet / Cover (phase-independent) ; **LoanSet fails `tecTOO_SOON`** |
| `SubscriptionDate < now < RedemptionDate` | Investment | **LoanSet** (if maturity gate passes); deposits fail `tecEXPIRED`; withdrawals fail `tecTOO_SOON` |
| `now >= RedemptionDate` | Redemption | VaultWithdraw; **LoanSet fails `tecEXPIRED`** |

Always allowed in every phase: `LoanPay`, `LoanManage`, `LoanDelete`, `LoanBrokerDelete`, `LoanBrokerCover*` [S66.1.2 §3.4].

Hard constraints [S65 §3.2.5, S66.1.2 §3.2]:
- `VaultCreate` (closed-ended): both dates strictly after parent close time; `180 <= RedemptionDate − SubscriptionDate < 946708560`.
- New `LoanBrokerSet` requires `VaultKind = ClosedEnded` (`tecNO_PERMISSION` otherwise).
- `LoanSet`: `StartDate + PaymentInterval × PaymentTotal + 60 <= RedemptionDate`, `StartDate = now` (`tecNO_PERMISSION` otherwise).
- Servicing (fixCleanup3_4_0 enabled) [S66.2]: late only when `now > NextPaymentDueDate`; impair only when `now > NextPaymentDueDate`;
  default only when `now > NextPaymentDueDate + GracePeriod` (both boundaries exclusive). Impair/unimpair no longer move the due date.

## A5. Demo storyline (3 min) — unchanged in spirit from xrplh-12 §6, now on concrete Devnet timings

| t | Show |
|---|---|
| 0:00 | XLS-66 lends without collateral; underwriting is off-chain by design |
| 0:20 | CFO asks in plain English; analyst computes monthly cash from own CSVs (nothing leaves the PC) |
| 0:50 | ACTUS schedule + scenarios → verdict, explanation verified against numbers; fee paid on Devnet (tx link) |
| 1:30 | Draft `LoanSet` (XLS-66 units, `Data` = attestation); borrower signs, broker counter-signs → `Loan` on Devnet |
| 2:00 | `LoanPay` #1; ledger `Loan` vs ChainAim engine: match |
| 2:30 | Depositor view: cover adequacy, "if this loan defaults now: cover absorbs X, vault loses Y" (exact XLS-66 default math) |
| 2:50 | Anyone can recompute the hash in `Loan`'s creating tx `Data` from the published (PII-free) pack |

## A6. What is honest to say

- Asset is a self-issued **test** IOU on Devnet; on mainnet the same flow would use RLUSD once the amendments are enabled there (they are not).
- Devnet can be reset at any time [XRPL.ORG parallel-networks] — every script must be re-runnable from zero.
- Specs are Draft; behaviour verified against the Devnet build, not mainnet.

---

# PART B — DETAILED DESIGN

## B1. Network and environment

| Item | Value | Source |
|---|---|---|
| WebSocket | `wss://s.devnet.rippletest.net:51233/` | [XRPL.ORG xrp-faucets "Public Servers"] |
| JSON-RPC | `https://s.devnet.rippletest.net:51234/` | same |
| Faucet host | `faucet.devnet.rippletest.net` (xrpl.js `client.fundWallet()` default for Devnet) | [SDK Wallet/defaultFaucets.js] |
| Network ID | **[CHECK]** — run `server_info` → `info.network_id`. If > 1024, every tx needs `NetworkID`. Not reachable from my sandbox. | — |
| Amendments | enabled (see §0) — re-check at start of each demo day with `feature` | [OWNER] |
| SDK | **xrpl 5.3.0** (latest on npm, modified 2026-10-08): all `Vault*` / `Loan*` types, `VaultKind` enum (`vaultKindClosed = 1`), `SubscriptionDate`, `RedemptionDate`, `signLoanSetByCounterparty`, `combineLoanSetCounterpartySigners`; codec knows `VaultKind`, `SubscriptionDate`, `RedemptionDate`, `CounterpartySignature` | [SDK] |
| Time | Ledger times are Ripple-epoch seconds [S66 §3.2.2 field notes]; use xrpl.js `unixTimeToRippleTime` / `rippleTimeToUnixTime`, never hand-coded offsets | [S66], [SDK] |

**Isolation decision:** the repo pins `xrpl 4.7.0` in `services/paywall` (devDependency) next to `x402-xrpl 0.3.3` [CODE package.json].
Upgrading there risks the working x402 path. → New package **`services/lending`** with its own `package.json` pinning `xrpl 5.3.0`.
Paywall untouched. The env/seed conventions of `services/paywall/scripts/xrpl.ts` are copied (names only, seed never printed).

Environment variable **names** (values in your secrets file, never in git):
`LENDING_NETWORK=devnet`, `XRPL_WS_URL_DEVNET`, `LENDING_ISSUER_SEED_DEVNET`, `LENDING_BROKER_SEED_DEVNET`,
`LENDING_DEPOSITOR1_SEED_DEVNET`, `LENDING_BORROWER_SEED_DEVNET`, `LENDING_CHAINAIM_SEED_DEVNET` (only to read/verify; C never signs loans).

## B2. Components and boundaries

```
packages/xls66/            pure TS, no I/O, no xrpl import      ← unit-testable against the spec
  units.ts                 % ↔ 1/10 bp; months ↔ seconds; amounts as decimal strings (no floats)
  engine.ts                XLS-66 App. A-2 formulas: periodicRate, periodicPayment, breakdown, TotalValueOutstanding,
                           late/full-payment dues, DefaultAmount/DefaultCovered/VaultLoss, cover-required
  gates.ts                 pre-flight: every data-verification + protocol failure we can evaluate off-ledger for
                           VaultCreate, LoanBrokerSet, CoverDeposit, LoanSet, LoanPay, LoanManage → predicted tem/tec code
  attest.ts                underwriting pack canonical JSON → SHA-256; Data encode/decode (≤256 bytes)
  draft.ts                 builds unsigned tx JSON (no Fee/Sequence) from validated inputs

packages/underwrite/       pure TS
  rules.ts                 affordability rules on numbers (config/underwriting.json thresholds)
  scenarios.ts             base, rate+Δbp, receivables delay +N days, revenue −X%

services/analyst/          EXISTS — DuckDB books → monthly net cash; actus.ts PAM/ANN, termsInDocument check [CODE]

services/lending/          NEW, xrpl 5.3.0
  src/ledger.ts            connect, ledger close time, ledger_entry (Vault/LoanBroker/Loan), vault_info, account_objects
  src/submit.ts            autofill, enforce min fee, sign, submitAndWait, map engine_result → message
  src/counterparty.ts      signLoanSetByCounterparty wrapper + "terms unchanged" check before counter-signing
  src/fee.ts               verify ChainAim fee Payment (validated, dest C, amount, memo reqId, not reused)
  src/store.ts             data/lending/ (gitignored): requests, packs (PII-free), fee receipts, state per run
  scripts/*.ts             one CLI per step (B6), each idempotent and resumable
  test/                    unit + Devnet integration (opt-in flag)

services/paywall/scripts/agent*.ts   EXISTS — Strands agent; add tools (B8)
```

Data flow rule: **only** masked aggregates (dates, amounts, ratios) leave the CFO PC; names are restored locally (existing gateway masking).

## B3. Ledger object setup (exact fields, units, demo defaults — all flags)

### B3.1 Test asset `TUSD`
- Currency: 160-bit hex of `"TUSD"` (non-standard code; 4 chars) — flag `--asset-code TUSD`. Issuer `I`.
- Issuer sets `asfDefaultRipple` before lines are opened so holders can pay each other through the issuer. **[CHECK]** standard IOU
  practice, not stated in XLS-65/66; confirm on first run that a `VaultDeposit` and `LoanPay` ripple through.
- Trust lines from `B`, `D1`, `R`, `C` to `I`; issuer funds them. Vault/broker pseudo-accounts get their holdings created by the protocol
  (failure "cannot add asset holding" → `tecNO_PERMISSION`) [S66 §3.3.3.2 #3].

### B3.2 `VaultCreate` (by B) [S65 §3.2]
| Field | Value | Note |
|---|---|---|
| `Asset` | `{currency, issuer: I}` | IOU must not be globally frozen |
| `VaultKind` | `1` (closed-ended) | required for a new LoanBroker under V1.1 |
| `SubscriptionDate` | `closeTime + --subscription-sec` (default 600) | strictly after parent close time |
| `RedemptionDate` | `SubscriptionDate + --investment-sec` (default 1800) | ≥ 180 s after Subscription |
| `AssetsMaximum` | 0 (no cap) — flag | non-zero cap also limits LoanSet [S66 §3.8.5.2 #6, #14] |
| `WithdrawalPolicy` | 1 (first-come-first-serve) | only value defined |
| `Scale` | default 6 (IOU allows 0–18) | |
| `Flags` | none by default; `--private-domain <DomainID>` sets `tfVaultPrivate` + `DomainID` (H7, roadmap) | |
| `Data` | hex of `"chainaim-demo vault v1"` (≤256 B) | |

### B3.3 `LoanBrokerSet` (by B, create) [S66 §3.3]
| Field | Demo default | Unit / range |
|---|---|---|
| `VaultID` | from VaultCreate meta | |
| `ManagementFeeRate` | 1000 (= 1% of interest) | 1/10 bp, 0–10000; immutable after create |
| `DebtMaximum` | 0 (unlimited) — flag | ≥ 0 |
| `CoverRateMinimum` | 10000 (= 10% of DebtTotal) | 1/10 bp, 0–100000; immutable |
| `CoverRateLiquidation` | 50000 (= 50% of minimum cover) | both rates zero or both non-zero |
Reserve: broker needs **2 owner reserves** (LoanBroker + pseudo-account) [S66 §3.3.3.2 #5]; read reserves via `server_info` (existing `reserves()` pattern [CODE xrpl.ts]).

### B3.4 `LoanBrokerCoverDeposit` (by B) [S66 §3.5]
`Amount` ≥ cover required for the planned loan (B4.3). Pre-flight computes it; default `--cover auto`.

### B3.5 `VaultDeposit` (by D1) [S65 §3.5] — only during Subscription. Default `--amount 100000`.

### B3.6 `LoanSet` (borrower-initiated, broker counter-signs and submits) [S66 §3.8]
| Field | Source | Unit / rule |
|---|---|---|
| `Account` | R | pays the fee |
| `Counterparty` | B (optional; defaults to broker) | |
| `LoanBrokerID` | B3.3 | |
| `PrincipalRequested` | business terms | decimal string, `> 0`, `≤ Vault.AssetsAvailable` |
| `InterestRate` | annual % × 1000 (9% → 9000) | 1/10 bp, 0–100000 |
| `LateInterestRate`, `CloseInterestRate`, `OverpaymentInterestRate` | policy config | 1/10 bp |
| `PaymentTotal` | n | ≥ 1 |
| `PaymentInterval` | real: 2,628,000 s (=365 d/12); demo: `--payment-interval-sec 300` | ≥ 60 |
| `GracePeriod` | `--grace-sec 120` | ≥ 60 and ≤ PaymentInterval |
| `LoanOriginationFee`, `LoanServiceFee`, `LatePaymentFee`, `ClosePaymentFee`, `OverpaymentFee` | policy config (default 0) | origination ≤ principal |
| `Flags` | `tfLoanOverpayment` only if policy allows | |
| `Data` | ChainAim attestation (B5) | hex, ≤256 bytes |
| `CounterpartySignature` | added by broker via `signLoanSetByCounterparty` | not a signing field |
| `Fee` | ≥ **2 × base fee** (1 signer + 1 counterparty) outside Batch [S66 §3.8.1.1]; **[CHECK]** whether xrpl.js `autofill` already does this; `submit.ts` enforces it anyway | |

Gate (V1.1): with demo defaults `StartDate = Sub + ~60`, term = 3 × 300 = 900 s, +60 buffer → `Sub + 1020 ≤ Sub + 1800` ✔.
Pre-flight also evaluates checks 15–18 (precision: interest zero, payment can't cover interest, rounds to zero, count drift) via the engine.

### B3.7 Servicing
- `LoanPay` (R) [S66 §3.11]: on time `Amount ≥ PeriodicPayment + LoanServiceFee`; late → flag `tfLoanLatePayment` and
  `Amount ≥ periodic + service + LatePaymentFee + late interest`; `tfLoanFullPayment` not allowed when `PaymentRemaining == 1`.
  The engine computes the exact due and the flag; the script refuses to send an amount the engine predicts as `tecINSUFFICIENT_PAYMENT`.
- `LoanManage` (B) [S66 §3.10, S66.2]: flags mutually exclusive; timing as A4; impair also needs
  `LossUnrealized + (TotalValueOutstanding − ManagementFeeOutstanding) ≤ AssetsTotal − AssetsAvailable`.
- `LoanDelete` (B or R) when `PaymentRemaining == 0`. `VaultWithdraw` (D1) after RedemptionDate.

## B4. The deterministic engine (`packages/xls66/engine.ts`)

### B4.1 Formulas (copied from [S66 App. A-2], decimal arithmetic, rounding to `LoanScale` last)
- `periodicRate = InterestRate × PaymentInterval / 31,536,000` (rate as decimal) — eq (1)
- `raised = (1 + periodicRate)^remaining`; `factor = periodicRate × raised / (raised − 1)`; `periodicPayment = PrincipalOutstanding × factor` — eq (5–7)
- final payment = `TotalValueOutstanding`; zero rate → `principal / remaining`
- `interest = PrincipalOutstanding × periodicRate`; `principal = periodicPayment − interest` — eq (8–9)
- Default [S66 §3.10.5]: `DefaultAmount = TVO − ManagementFeeOutstanding`; `MinimumCover = DebtTotal × CoverRateMinimum`;
  `DefaultCovered = min(MinimumCover × CoverRateLiquidation, DefaultAmount, CoverAvailable)`; `VaultLoss = DefaultAmount − DefaultCovered`.
- Cover required for a new loan [S66 §3.8.5.2 #20]: `(DebtTotal + Principal + InterestDue) × CoverRateMinimum`.

### B4.2 ACTUS ↔ XLS-66 equivalence [DERIVED — prove with a unit test]
With `PaymentInterval = 2,628,000 s` the XLS-66 periodic rate is exactly `r/12` (31,536,000 / 12 = 2,628,000). ACTUS ANN with
`30E360` and monthly cycle `P1ML0` [CODE actus.ts `buildContract`] also uses `r/12` per period, and both use the standard annuity
formula. So ACTUS (business view) and the ledger formula should agree per period up to `LoanScale` rounding. Reconciliation reports
differences; it never assumes equality ([S66] stored ledger values are authoritative).

### B4.3 Demo time-compression (explicit flag, not hidden)
`--payment-interval-sec 300` keeps the number of payments and the schedule shape but makes per-period interest tiny
(9%: periodic rate ≈ 8.6e-7). The ACTUS screen shows the real monthly schedule; the ledger runs the compressed one; H4 compares
**ledger vs engine at the ledger's own interval** (exact) and **ACTUS vs engine at 2,628,000 s** (business equivalence).

## B5. Attestation in `LoanSet.Data` (`packages/xls66/attest.ts`)

- **Underwriting pack** (stored by ChainAim and given to borrower + broker; PII-free): request id, policy version, terms (XLS-66 units),
  ACTUS schedule hash, engine schedule hash, scenario results, thresholds used, verdict, reasons, fee tx hash.
- Canonical JSON (sorted keys, no whitespace, decimal strings) → SHA-256.
- `Data` = hex of UTF-8 compact JSON `{"v":1,"h":"<64 hex>","r":"APPROVE|REFER|DECLINE","p":"<policy id>","q":"<req id>"}` (≈ 130 B;
  encoder refuses > 256 B; spec limit [S66 §3.8.1, §3.8.5.1 #5]).
- Broker counter-sign check (`counterparty.ts`): decode `Data`, recompute hash from the pack it received, check every term in the tx equals
  the pack's terms, check verdict = APPROVE (or broker override flag logged), then sign. Anyone can later recompute the hash.

## B6. Scripts (each idempotent: reads ledger first, skips a step already done, writes `data/lending/run-<id>.json`)

| Script | Signer | Key flags (defaults) |
|---|---|---|
| `setup-accounts.ts` | faucet | `--roles issuer,broker,depositor1,borrower,chainaim` `--fund faucet` |
| `issue-asset.ts` | I | `--asset-code TUSD` `--default-ripple on` `--mint broker=20000,depositor1=100000,borrower=5000` |
| `vault-create.ts` | B | `--subscription-sec 600` `--investment-sec 1800` `--assets-maximum 0` `--scale 6` `--private-domain none` |
| `broker-set.ts` | B | `--management-fee-rate 1000` `--cover-rate-min 10000` `--cover-rate-liq 50000` `--debt-max 0` |
| `cover-deposit.ts` | B | `--amount auto` |
| `vault-deposit.ts` | D1 | `--amount 100000` |
| `pay-fee.ts` | R | `--to chainaim` `--price 1` `--asset TUSD` `--request-id <id>` |
| `underwrite.ts` | (none) | `--books <folder>` `--terms <doc|json>` `--scenarios base,rate+200,late30` `--policy config/underwriting.json` `--verify-fee <tx>` |
| `loan-draft.ts` | R signs | `--pack <file>` `--draft-only` (default: print, do not submit) |
| `loan-countersign.ts` | B signs + submits | `--tx <file>` `--pack <file>` `--allow-override false` |
| `loan-pay.ts` | R | `--loan-id` `--mode auto|on-time|late|full` `--max-amount <cap>` |
| `loan-manage.ts` | B | `--loan-id` `--action impair|unimpair|default` (refuses before the spec boundary) |
| `reconcile.ts` | read | `--loan-id` `--tolerance-scale 0` |
| `depositor-view.ts` | read | `--vault-id` `--loan-broker-id` `--json` |
| `lending-demo.ts` | orchestrator | `--plan` (print timeline) / `--run` / `--from <step>`; waits on **ledger close time**, not wall clock |
Common: `--network devnet` `--ws <url>` `--dry-run` (build + pre-flight + print, no submit).

## B7. ChainAim fee (Devnet, no t54)
`Payment` R → C, `Amount` = price in TUSD, `Memos[0].MemoData` = hex(`chainaim:uw:<reqId>`). `fee.ts` accepts only a **validated** tx with
`tesSUCCESS`, exact destination, `delivered_amount ≥ price` (not `Amount`), matching memo, and a reqId not seen before (`data/lending/fees.jsonl`).
The underwriting pack is released only after that check.

## B8. Agent tools (Strands, existing agent [CODE services/paywall/scripts/agent*.ts])
`underwrite_loan(terms, booksFolder)` → verdict + pack id; `draft_loanset(packId)` → unsigned tx for the borrower to sign;
`reconcile_loan(loanId)`; `servicing_advice(loanId)` → impair/wait/default with the engine's numbers and the earliest legal time.
Tools never hold the broker seed; the agent cannot counter-sign.

## B9. Errors and pre-flight
Every script runs `gates.ts` first and prints the predicted code with the spec reference (e.g. "LoanSet would fail tecNO_PERMISSION:
maturity + 60 s > RedemptionDate, XLS-66.1.2 check 27"). After submit, `engine_result` is mapped to the same messages. A mismatch between
prediction and ledger result is logged as a finding (spec vs Devnet build drift).

## B10. Tests
- Unit (`packages/xls66`): formulas vs hand-computed values; ACTUS-vs-engine equivalence at 2,628,000 s; gate boundaries at, +1 s, −1 s
  for checks 25–27 and for default/impair (exclusive boundaries); Data size limit; unit converters (9% ↔ 9000).
- Integration (opt-in `--devnet`): full `lending-demo.ts --run` from fresh accounts; asserts ledger `Loan.PeriodicPayment`,
  `NextPaymentDueDate`, `PaymentRemaining` against the engine after each `LoanPay`; one negative test per V1.1 gate.
- Re-run after a Devnet reset must succeed without edits.

## B11. Build order (AI side) — each item small and testable
1. `services/lending` package with xrpl 5.3.0; `ledger.ts`, `submit.ts`. 2. `packages/xls66` units/engine/gates + tests.
3. Setup scripts B6 rows 1–6 with `--dry-run`. 4. attest + fee + underwrite (reusing analyst/actus). 5. draft/countersign/pay/reconcile.
6. depositor view + `lending-demo.ts`. 7. Agent tools.

## B12. Open questions for the owner
1. Verdict thresholds (e.g. min worst-month coverage 1.25×, cash buffer 2 months) — needed for `config/underwriting.json`.
2. H5 depositor view: CLI/JSON only, or a published page?
3. ChainAim fee amount in TUSD (default 1).
4. Show a default scenario live (second loan, wait past due + grace) or only as the engine's "what if"?

## B13. Corrections to earlier docs
- xrplh-12 §8.3 item 2: buffer is **60 s** (`LOAN_REDEMPTION_BUFFER`) [S66.1.2 §3.1].
- xrplh-12 §4 "payments on Testnet/x402": superseded — fee is a Devnet `Payment` (B7).
- xrplh-12 §5: XLS-66 code goes in a new `services/lending` (xrpl 5.3.0), not in `services/paywall`, to keep x402 on 4.7.0 untouched.
- Spec note: LoanBrokerSet table text says ManagementFeeRate "(1% - 10%)" while the unit (1/10 bp, 0–10000) gives 0–10%; we follow the unit.
