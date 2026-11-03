# xrplh-17 — ACTUS ↔ XLS-66 ↔ ledger: interoperability and the regulator-facing story

Light pass (owner: understanding, not an exhaustive read). Every fact carries its source; [PROPOSAL] marks design, not fact.

## 1. The three things, in one line each

| Layer | What it is | Source |
|---|---|---|
| ACTUS | Open, machine-readable standard for how financial contracts behave (cash flows), run by the ACTUS Financial Research Foundation (Rockville, MD); names institutions, regulators and developers as intended users. Its homepage states no formal standards-body or regulator engagement. | https://www.actusfrf.org/ (read 2026-10-25) |
| XLS-66 spec | Draft text of the XRPL Lending Protocol. Master text uses *instant interest recognition*: LoanSet adds InterestDue to Vault.AssetsTotal and Principal+InterestDue to LoanBroker.DebtTotal; DefaultAmount = TotalValueOutstanding − ManagementFeeOutstanding. | XRPLF/XRPL-Standards master, XLS-0066 README lines ~1140-1142, ~1287-1297 |
| Ledger (xrpld) | The server code that actually moves funds. It has **two accounting modes** and picks one per vault. | rippled develop @ 1f46f753 (2026-10-23), src/libxrpl/ledger/helpers/LendingHelpers.cpp lines 338-427 |

## 2. What the ledger does (from the code) — and why Devnet showed principal-only debt

`LendingHelpers.cpp` (develop; Devnet runs 3.4.1, the tag was not compared — [CHECK]):
- `instant_recognition` (vaults created **before** LendingProtocolV1_1): origination adds interest to AssetsTotal and principal+interest to DebtTotal; default/impair exposure = TotalValueOutstanding − ManagementFeeOutstanding. = master spec text.
- `cash_basis` (vaults created **under** LendingProtocolV1_1 or later — comment at lines ~409-410: older vaults keep instant recognition forever):
  - origination: AssetsTotal +0, DebtTotal +principal;
  - each payment: AssetsTotal +interestPaid, DebtTotal −principalPaid;
  - default and impair exposure = **PrincipalOutstanding**.
- LoanManage.cpp uses that exposure for default (line ~265) and impair (line ~420, then the tecLIMIT_EXCEEDED check at ~444-450).

This explains every number observed on 2026-10-25 (BUILD_LOG LEND-1): DebtTotal 40,182.218082 = principal after instalment 1; AssetsTotal 150,000 + 544.50 (interest received, net of the 1 % fee); drill impair +1,000 and default −1,000 (principal), not 1,000.000414.

Consequences for our code ([PROPOSAL], AI work):
1. engine: add `accounting: "cash-basis" | "instant"` (default from the vault: V1.1 vault → cash-basis); default/impair/"if it defaulted now" use PrincipalOutstanding under cash-basis.
2. gates: impair #8 check uses the same exposure → today's gate is stricter than the ledger for a vault's only loan (seen on Devnet: refused 1,000.000414 > 1,000 lent out).
3. reconcile/view: label which accounting basis the vault uses.

## 3. Why cash basis helps the regulator story

Cash basis = a vault never counts interest it has not received. Depositors' share value cannot be inflated by interest a borrower may never pay; a default only writes off principal. That is the conservative convention. Banks' books are usually accrual-based (interest recognised as earned) [general knowledge — not sourced here]; the difference is a convention, not an error, and it is exactly what a reconciliation statement explains.

## 4. Interoperability: one loan, three views ([PROPOSAL])

| View | Who reads it | Content |
|---|---|---|
| Contract of record — ACTUS | bank risk/accounting systems, supervisor | `ANN` contract terms (notional, rate, 30E360 monthly ≡ PaymentInterval 2,628,000 s, maturity) + ACTUS event schedule (proved: ACTUS 20,367.78 = ledger 20,367.781918) |
| Execution — XRPL ledger | anyone | LoanSet/LoanPay/LoanManage transactions; cash-basis vault accounting |
| Bridge — ChainAim | lender, depositors, auditor | attestation hashes in LoanSet.Data (underwriting pack + ACTUS terms; Data uses 134 of 256 bytes), ACTUS-vs-ledger reconciliation, status in ACTUS vocabulary |

Status mapping, XLS-66 → ACTUS `contractPerformance` (values PF performant, DL delayed within grace, DQ delinquent beyond grace, DF default, MA matured, TE terminated — https://documentation.actusfrf.org/docs/contract-terms/contractPerformance):
on time → PF · now > NextPaymentDueDate → DL · now > due + GracePeriod → DQ (impair = the lender's accounting action here) · LoanManage default → DF · last payment → MA. Each transition tied to an XRPL tx hash.

Regulator/bank statement per loan: ACTUS expected events vs ledger actual payments; ACTUS status; convention notes ("vault uses cash-basis accounting: interest recognised when paid; exposure = principal outstanding").

## 5. Positioning the Devnet caveat

- The ACTUS contract does not change when XLS-66 or xrpld changes; only the bridge's mapping does, and every difference is reported. (Shown live: the spec says instant recognition, the V1.1 ledger uses cash basis, and the reconciliation surfaced it.)
- Honest scope: Devnet only (amendments not on mainnet); specs Draft; only fixed-rate amortising/bullet loans map to XLS-66 (no floating rates).
- ACTUS standing: say "open contract standard engaged in US regulatory consultations" — filings appear on fdic.gov, federalreserve.gov, cftc.gov, sec.gov (titles seen in search, not opened). ECB / Commonwealth Bank of Australia: no source found — not to be claimed until sourced.

## 6. Build items ([PROPOSAL], AI) — in order
1. Cash-basis accounting in engine/gates/view (§2) + tests from the Devnet numbers.
2. ACTUS record per loan (terms + schedule from the server) and its hash in LoanSet.Data.
3. Status timeline in ACTUS vocabulary + 3-way reconcile (ACTUS · engine · ledger).
4. Cockpit panel "the same loan, as a bank sees it".
Manual (owner): ACTUS server calls run only from the owner's terminal (34.203.247.32:8083 is not reachable from the AI shell).
