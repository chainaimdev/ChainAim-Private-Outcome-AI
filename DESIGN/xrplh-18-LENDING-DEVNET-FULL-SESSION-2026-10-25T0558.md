# xrplh-18 — FULL SESSION: first Devnet run of the lending flow, fixes, product/USP/demo, ACTUS ↔ XLS-66 ↔ ledger

Session: 2026-10-25 00:40 – 05:58 (UTC-5). Continuation of mid-check-3-TR-2. Track: XRPL hackathon, Lending & Borrowing.
Repo: C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2-TR2\chainaim-router-private-ai-2
Note: this is a structured record of the session (decisions, commands, results, answers), not a verbatim chat transcript.
Companion docs: DESIGN/xrplh-16 (lending design), DESIGN/xrplh-17 (ACTUS ↔ XLS-66 ↔ ledger), BUILD_LOG.md "LEND-1".

---

## 1. Environment findings

- The AI shell on the owner's PC (Cowork VM) goes through a host-name allowlist proxy: s.devnet.rippletest.net is refused
  (HTTP 403, X-Proxy-Error: blocked-by-allowlist) on :51233 (WebSocket) and :51234 (JSON-RPC). A proxy agent cannot help.
  → All ledger commands are run by the owner in a normal Windows terminal; the AI reads output and drives the next step.
  (Closes handoff Open Check 1.) ACTUS server 34.203.247.32:8083 is also not reachable from the AI shell.
- The pasted `git clone` lines were old terminal history: .git created 21:40 local 2026-10-24; lending files 00:30 today
  (the verified copy). Nothing was overwritten.
- GitHub (raw.githubusercontent.com, api.github.com) IS reachable from the AI shell — used to read XLS-66 and xrpld code.

## 2. Devnet run 1 (00:44 – 01:14 local) — every transaction tesSUCCESS

Seeds: C:\PRIV-AI-SECRETS\lending-devnet.env (outside the repo, never printed). `$E` = that path.

| Step | Command (from services/lending) | Result |
|---|---|---|
| accounts | `node scripts/lending.ts accounts --secrets-out C:\PRIV-AI-SECRETS\lending-devnet.env` | issuer rBPcizSLzMcHR22GCUBVH2vbbcieqas1RQ · broker raxEvp4tsdPXjZ9NrfxAb7UL2aVtyUqRPP · depositor rw6cbftQuGohQV5Xw7VdkA6UkhCy7ULWqo · borrower rEw7XBQvit8NgCLd9yA6EhmC9MDXi6WLNb · chainaim rMeJtGBL2V5X9oxAnd2JYJNh1Br72EgW1A · driller rQDfe8ecX7nC1JiuE83yfgJnPPtgkf1Scg |
| issue | `issue --env-file $E` | DefaultRipple AD8BA205…; 5 trust lines; mints 30k broker / 200k depositor / 20k borrower / 2k driller |
| vault | `vault --subscription-sec 900 --investment-days 120` | Vault 366B5EE0564CE6364A24D5B1CDDC84A2097D95EC1F2BF71C426B30EB3390F78F; Subscription until 06:03:30Z; Investment until 2027-02-22 |
| broker | `broker --cover 12000` | LoanBroker 2A4ACCBD80693BBBB0179081C63F9573A19F1DD9BECC870AFF2AB7ECA5FA17C6; mgmt fee 1 %, cover min 10 %, liquidation 50 %; cover 12,000 |
| deposit | `deposit --amount 150000` | E346CFFC… |
| underwrite (AI, offline) | `node scripts/underwrite.ts --books ../../data/lending/books/orion` | uw-9b8485ee7e APPROVE 60,000 @ 11 %, 3 × 20,367.78; sha256 e9277f88…bbd0; Data 134 B; cover needed 6,110.33 |
| fee | `fee --request-id uw-9b8485ee7e` | 82D3A80D105CF439257A42AEEDFDB16D62350E89FAF48911045DD918E55F8294 |
| loan A | `loan --pack ..\..\data\lending\packs\uw-9b8485ee7e.pack.json --name loanA --fee-tx 82D3…8294` | broker: re-hash ✓ terms ✓ verdict APPROVE ✓; Loan 27646E02E67321F8C65BB23B0BE95FB52EF0FBAB39BF5A878C36EC607C1CC9CB; periodic 20,367.781918; next due 2026-11-24T16:05:40Z |
| drill B | `drill --interval-sec 300 --grace-sec 120` | Loan 96ABD31C…C966; due 06:10:42Z |
| mint | `mint --to borrower --amount 1000` (new command) | borrower held 19,975 < one instalment |
| pay A | `pay --name loanA` | E0695141…; 2 left; principal 40,182.218082; next due 2026-12-25T02:05:40Z |
| reconcile A | `reconcile --name loanA` | 6/6 ✓: payment, next due, remaining, principal, rate, Data = sha256(pack) (closes Open Check 4) |
| impair B early | `manage --name loanB --action impair` | refused by pre-flight (tecTOO_SOON §3.10.4.2 #9), nothing sent |
| impair B | same, after due | 94B7617E…; LossUnrealized 1,000.00 |
| default B | `manage --name loanB --action default` + `view` | 09867E92…; cover 12,000 → 11,000; depositors lost 0; Loan A "if defaulted now": cover 2,009.110904, depositors 38,720.919474 (spec formula — see §5) |

Hand-checked: mgmt fee 5.50 = 1 % of 550.00 interest in instalment 1; vault assets 150,544.50 = 150,000 + 550 − 5.50.
DefaultRipple lets TUSD move through vault/pseudo-accounts (closes Open Check 2).

## 3. Code changes this session (uncommitted — owner to commit from the Windows terminal)

Files: services/lending/scripts/lending.ts, services/lending/src/state.ts, services/lending/src/ledger.ts,
packages/xls66/src/gates.ts, packages/xls66/test/xls66.test.ts, services/lending/README.md, BUILD_LOG.md.
Tests 30/30 (was 29; +1 LoanPay boundary test); strict tsc clean against xrpl 5.3.0.

| Change | Detail |
|---|---|
| `cycle` | Owner rule: every wait ≤ 2 min. Archives vault/broker/loans into state.history, then vault (default 60 s subscription, refuses < 30) + broker + cover + deposit in one connection; waits for Investment (`--no-wait`). |
| `mint --to <role> --amount <n>` | Issuer top-up (explicit --amount required). |
| `adopt --tx <LoanSet hash> --name <n>` | Registers a loan from its LoanSet metadata (recovers lost state records). |
| drill defaults | 60 s interval / 60 s grace (spec minimum §3.8.5.1 #15-16): impair after 61 s, default after 121 s. |
| `manage --wait-max-sec N` | Waits for the earliest allowed ledger time, then sends (skipped findings ignored — bug fixed after first try). |
| `--skip-check <codes>` | Diagnosis only: lets named pre-flight findings through as warnings so the ledger decides. |
| LoanPay pre-flight `checkLoanPay` | From XLS-66 §3.11.4 (read from XRPLF/XRPL-Standards master): #4 tecKILLED, #9 tecINSUFFICIENT_FUNDS (borrower trust-line balance via new `ledger.holding`), #11 tecEXPIRED late without tfLoanLatePayment (exclusive boundary), #12/#13 tecINSUFFICIENT_PAYMENT. Previously `pay` had no pre-flight although the README claimed one. |
| Name-collision guard | `loan`/`drill` refuse a name already in the state file (an overwrite orphaned a live loan, see §4). |
| Readability | Gate messages show ISO times; `manage` prints "ledger raw before/after" lines (loan TVO, mgmt fee, principal, LoanScale, flags; vault totals, LossUnrealized, Scale; broker debt, cover); `reconcile` prints a raw line. |
| Docs | README run steps rewritten for the 2-minute flow and the Devnet results; BUILD_LOG "LEND-1". |

## 4. Devnet runs 2–4 (01:22 – 02:10 local) with the new code

- `mint --to depositor --amount 150000` + `cycle`: new Vault B26C890F…7905, Broker ACCC89B3…D573; Investment open ~70 s after start.
- Drill (60/60): `pay --mode on-time` refused by the new pre-flight (tecEXPIRED §3.11.4.2 #11), nothing sent. Impair refused by
  our own gate (tecLIMIT_EXCEEDED #8: 1,000.000414 > 1,000 lent out — sole loan). Default: cover 50.00 (= debt 1,000 × 5 %), vault
  loss 950.00 (engine 950.000414). LoanScale −10.
- An earlier `drill --name loanC` (06:31:29Z, tx D0B74B3487634FBBC9FD5B82D152A23B80A52363AA24A01E3F81C4EBC3DFD994) was overwritten in the
  state file by a second loanC → orphaned live loan (DebtTotal 2000). Recovered with `adopt … --name loanC0` and defaulted
  (cover 50, vault loss 950). Guard added.
- Second loanC with `--skip-check`: impair tesSUCCESS (but lent-out was 2,000, so #8 boundary not tested); raw lines: TVO
  1000.0004185689, mgmt fee 0.0000041856, LossUnrealized +1000, default debt −1000 (cover 100, loss 900).
- loanD (sole loan) impair boundary test: not completed (wait bug, fixed). Superseded by the xrpld code reading (§5).

## 5. Key finding: the ledger uses cash-basis accounting for V1.1 vaults

Source: rippled develop @ 1f46f7531850bc1a0870910028abe8b9f9527d4c (2026-10-23), src/libxrpl/ledger/helpers/LendingHelpers.cpp
lines ~338-427; LoanSet.cpp ~354-360, ~604-610; LoanManage.cpp ~265 (default), ~420-450 (impair). Devnet runs 3.4.1 — tag not compared [CHECK].

- `instant_recognition` (vaults created before LendingProtocolV1_1) = XLS-66 master text: origination adds interest to
  AssetsTotal and principal+interest to DebtTotal; exposure = TotalValueOutstanding − ManagementFeeOutstanding.
- `cash_basis` (vaults created under V1.1 or later): origination DebtTotal +principal, AssetsTotal +0; payment AssetsTotal
  +interestPaid, DebtTotal −principalPaid; default/impair exposure = PrincipalOutstanding.
- Explains every observed number (debt 40,182.22; vault +544.50; drill 1,000 not 1,000.000414).
- Consequences: our default/impair predictions, the impair gate #8, the LoanSet cover gate #20 (Open Check 3) and the
  depositor view use instant recognition → wrong for V1.1 vaults. Loan A "if defaulted now" should be depositors lose
  38,173.11 (40,182.22 − 2,009.11), not 38,720.92.

## 6. Answers given (owner questions)

**Terminology.** Spec text = XLS-66 document. "Our engine" = packages/xls66 TypeScript copy of Appendix A-2 formulas (not ACTUS).
Ledger = xrpld's own implementation that moves the money. ACTUS = separate standard engine (server), not used in the Devnet run
(underwrite said "no --actus-url"); earlier ACTUS check 20,367.78 = engine (diff 0). Schedule: all agree. Bookkeeping: ledger (cash
basis) ≠ spec text (instant) — ledger is authoritative.

**Stress scenarios** (config/underwriting.json, policy uw-wc-2026-10-a): base, rate +2 %, all customers 30 days late, largest
customer 60 days late, open order cancelled after costs. Rules: base needs cash buffer ≥ 10,000 and coverage ≥ 1.25x; stress needs
cash ≥ 0. Orion passes all (lowest 10,637.74 at 0.28x = "survives stress"); Jupiter Knits declines. Show both side by side.

**Lender stays in charge.** XLS-66 needs borrower + broker signatures; ChainAim has no key. Broker software re-hashes the pack,
compares with LoanSet.Data, checks terms (principal, rate, interval, count, grace) and verdict; any mismatch → no signature, no loan
(example: 90,000 signed against a 60,000 approval is refused). Live evidence: "broker: pack re-hashed = attestation ✓ · terms = pack ✓ · verdict APPROVE ✓".

**Monitoring example.** Loan A reconcile after instalment 1 (6/6 ✓); depositor view (vault, lent out, cover, "if defaulted now");
drill late → impair → default.

**Money (as built vs proposed).** Built: borrower pays 25 TUSD fee per decision; broker refuses to originate without a validated,
delivered, non-reused fee. Proposed (owner to decide): broker pays ChainAim per decision, recovered via XLS-66 LoanOriginationFee
(lender pays for underwriting, as in credit markets; the protocol's own fee field funds it). Roadmap: LoanServiceFee monitoring;
metered ACTUS what-ifs per actor.

**USP — "Private books, public proof."** Private (books never leave the PC, no names); provable and enforced (verdict fingerprint in
the loan's own creation tx, checked by the lender's co-signature; ChainAim never signs); deterministic (lender's published policy,
recomputable); bank-readable (ACTUS contract + ACTUS status, reconciled against the ledger). Positioning: Evernorth = capital
(XRP treasury), Soil = RLUSD yield, Clearpool + Ripple + Cicada = institutional credit; ChainAim = the credit-decision layer XLS-66
leaves off-chain. xrpl.org institutional-credit page: credential issuers can issue/revoke credentials on criteria like credit score
→ roadmap: ChainAim-issued Credential (Devnet availability unchecked). Name idea: "ChainAim CreditSeal" (trademarks not checked).

**ACTUS / regulator story** (DESIGN/xrplh-17). ACTUS = contract of record (ANN terms + schedule) for banks/supervisors; XRPL =
execution; ChainAim = bridge (both hashes in LoanSet.Data, ACTUS-vs-ledger reconciliation, ACTUS contractPerformance PF → DL → DQ →
DF → MA). The ACTUS contract is stable when XLS-66/xrpld change; differences are reported. Cash basis is the conservative convention.
ACTUS standing: say "open contract standard engaged in US regulatory consultations" (filings seen on fdic.gov, federalreserve.gov,
cftc.gov, sec.gov — titles only). ECB / Commonwealth Bank: no source found — do not claim until sourced.

**Why a TypeScript module at all (owner challenge).** Needed only for jobs neither ACTUS nor the ledger does: (B) map terms →
XLS-66 fields, draft LoanSet, encode attestation; (C) amount due for a late payment; (D) "if it defaulted now" (read ledger values,
don't recompute); (E) pre-flight timing ("allowed after …"). Not needed: the schedule (→ ACTUS, module as labelled offline fallback),
a second copy of ledger bookkeeping (→ read the ledger). Check: XRPL `simulate` RPC for pass/fail (unverified on Devnet 3.4.1 for
co-signed LoanSet). Proposal: rename "engine" → "XRPL rules adapter".

## 7. Demo plan (proposed): 3-minute video, cockpit UI on the owner's PC, terminal as backup

0:00 problem (no collateral; cover = 10 % × 50 %) · 0:20 two borrowers' books analysed locally · 0:40 DECLINE vs APPROVE + 5-scenario
table + ACTUS schedule · 1:10 tampered request refused, honest loan counter-signed, Data on Devnet · 1:40 broker pays ChainAim,
origination fee on the loan · 2:00 pay + 3-way reconcile · 2:20 drill late → impair → default, ACTUS DL → DQ → DF, depositor view ·
2:50 "same loan, as a bank sees it" (ACTUS terms + statement linked to XRPL txs). Optional agent opener (CFO in plain English).

## 8. Open decisions (owner)
1. Broker pays via LoanOriginationFee (recommended) vs borrower pays (built).
2. Restructure: ACTUS for the schedule, ledger for its own numbers, TS module only for B/C/D/E (recommended).
3. Build order: cash-basis-correct predictions/gates/view (via ledger values) → --tamper → ACTUS record + hash in Data → ACTUS status
   + 3-way reconcile → cockpit tab.
4. Name / tagline.

## 9. Next steps
- Manual (owner): commit this session's changes from the Windows terminal (the AI shell cannot run git commit on the mount).
- AI (new chat): items in §8.3 after decisions 1–2. ACTUS and Devnet calls run from the owner's terminal, one manual step at a time.

## 10. Continuation prompt for a new chat

```
Continue ChainAim lending (XRPL hackathon, Lending & Borrowing track, Devnet only, asset TUSD).
Repo: C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\PRIVAI2-TR2\chainaim-router-private-ai-2
Read first: PROJECT_CONTEXT.md, services/lending/README.md, DESIGN/xrplh-16, DESIGN/xrplh-17, DESIGN/xrplh-18 (this session), BUILD_LOG.md "LEND-1".
State: Devnet run works end to end (all tesSUCCESS). Seeds C:\PRIV-AI-SECRETS\lending-devnet.env; state data/lending/devnet-run.json
(current vault B26C890F…, broker ACCC89B3…; run-1 objects in state.history[0]). Ledger commands run ONLY in the owner's Windows terminal
(AI shell proxy blocks Devnet and the ACTUS server). Uncommitted code changes listed in xrplh-18 §3 (tests 30/30, tsc clean).
Key finding: V1.1 vaults use cash-basis accounting (rippled LendingHelpers.cpp cash_basis): debt = principal, interest booked when paid,
default/impair exposure = PrincipalOutstanding. Our predictions/gates/view still use instant recognition → fix.
Open decisions: (1) broker pays via LoanOriginationFee? (2) restructure: ACTUS = schedule, ledger = its own numbers, TS module only for
term mapping/drafts/attestation, late amount due, "if defaulted now", pre-flight timing.
Next step: get decisions 1–2, then build in order: cash-basis-correct predictions/gates/view → --tamper demo → ACTUS record + hash in
LoanSet.Data → ACTUS status (PF/DL/DQ/DF/MA) + 3-way reconcile → cockpit tab. Owner rules: filesystem first, no guessing, flag
assumptions, AI vs manual split, manual steps one at a time, every wait ≤ 2 minutes.
```
