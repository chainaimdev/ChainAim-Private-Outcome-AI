# chiro-synth: synthetic chiropractic data sets (ChiroTouch or Jane + ERA 835 + Bank of America)

Generates and checks **synthetic** chiropractic-practice data for the reconciliation engine (privateAI-design-30 §8-12).
One canonical model (patients, visits, claims, remittances, payments, deposits) is written in the layout family of one
PRMS, so the same `--seed` gives the same business events in `chiro-1-chirotouch` and `chiro-2-jane`. All names, IDs,
amounts and bank descriptions are made up.

## Files

| File | Purpose |
|---|---|
| `gen_chiro_set.py` | Writes one set plus its answer key. Every knob is a flag (`--help`); same seed = same files. |
| `chiro_leaks.py` | The 16 leak types: which claim / remittance / payment / day each one changes, and its expected exception. Imported by the generator. |
| `verify_chiro_set.py` | Re-reads a set by header and checks it (bank totals and running balance, answer key, ERA vs EFT by TRN, batches vs bank, PRMS payments vs deposit report, care plans). NEG: every planted leak is checked in the files, and every anomaly in the files must be a planted leak. `--compare` checks the other PRMS folder for the same seed (and the same findings). Exit 0 = pass. |

## Output (git-ignored: `sample-data/` is in `.gitignore`)

```
sample-data/prms/chiro-1-chirotouch/SET-1/POS/        sample-data/prms/chiro-2-jane/SET-1/POS/
  CT-PATIENTS / CT-DAYSHEET / CT-DEPOSITS -<TAG>.csv     JANE-PATIENTS / JANE-TRANSACTIONS -<TAG>.csv
  CTPAY-<TAG>.csv          (CT Payments batches)         JANE-PAYMENTS-REFUNDS-FEES-<TAG>.csv
  CASHPRAC-<TAG>.csv       (Cash Practice auto-debits)   JANEPAY-PAYOUTS-<TAG>.csv
  shared: ERA-<TAG>.835, BANK-ST-<TAG>.csv, FEESCHED-<TAG>.csv, PI-CASES-<TAG>.csv, CAREPLANS-<TAG>.csv
  _answer-key/expected-matches.csv   every bank credit -> group, source refs (ERA trace, batch ID, payment IDs), expect (match | exception:<LEAK>)
  _answer-key/truth.json             counts, payer mix, group totals, unearned plan revenue, every flag used;
                                     NEG: expected_exceptions, unmatched_bank_credits, unmatched_prms_rows, not_applicable;
                                     all scenarios: watch_items (PI_STALE: open PI case, LOP older than --pi-stale-days)
```

Layout status is in the docstring of `gen_chiro_set.py`: BofA and 835 verified; Jane payment/payout columns from Jane's
public guides; ChiroTouch and the other Jane files canonical (UNVERIFIED) until real header lines arrive.

## Analyst adapters (services/analyst/src/sources/prms/chiro)

Each file is recognised only by its exact header line (no positional guessing). If a real export has no header row, add
the header line of its layout as the first line. Every column carries { header, verified, basis }; all are UNVERIFIED
until a real export is seen, and each loaded file reports that in its checks.

| File | Adapter | Header line |
|---|---|---|
| CT-PATIENTS | prms/chirotouch/patients | `Patient ID,Last Name,First Name,Primary Insurance,Payer Class,State,Provider` |
| CT-DAYSHEET | prms/chirotouch/daysheet | `Date,Patient ID,Visit,Provider,Type,Code,Modifiers,Units,Amount,Reference,Payer` |
| CT-DEPOSITS | prms/chirotouch/deposits | `Date,Payment ID,Method,Payer,Reference,Amount,Patient ID` |
| CTPAY | processor/ct-payments | `Batch Date,Batch ID,Transactions,Gross,Fees,Net,Settlement Date` |
| CASHPRAC | processor/cash-practice | `Date,Patient ID,Plan ID,Type,Amount,Reference` |
| JANE-PATIENTS | prms/jane/patients | `Patient Number,Last Name,First Name,Primary Policy,Payer Class,State,Practitioner` |
| JANE-TRANSACTIONS | prms/jane/transactions | `Date,Patient Number,Invoice,Practitioner,Type,Item,Modifiers,Units,Amount,Reference,Payer` |
| JANE-PAYMENTS-REFUNDS-FEES | prms/jane/payments-refunds-fees | `Date,Payor name,Payment method,Reference number,Invoice number,Amount,Processing fees,Amount paid to the clinic` (Jane guide names) |
| JANEPAY-PAYOUTS | processor/jane-payments-payouts | `Date Created,Date Deposited,Payout Amount,Payout Status` (Jane guide names) |
| FEESCHED | owner/fee-schedule | `Payer Code,Payer,CPT,Allowed` |
| PI-CASES | owner/pi-cases | `Case ID,Patient ID,State,Coverage,Carrier,Attorney,LOP Date,Billed,Carrier Paid,Has Health Insurance,Status,Settled Date,Prior Balance,Settlement Received,Reduction,Reduction Approved` |
| CAREPLANS | owner/care-plans | `Plan ID,Patient ID,Start Date,Visits Bought,Price,Payment,Visits Used,Collected,Earned,Unearned` |

Person names (Last Name, First Name) are read only into name_key; Jane's Payor name is loaded only on insurance rows
(EFT, Manual EOB, Insurance Check), because on patient rows it is a person's name.

## Run (from the repo root, Python 3.9+)

```powershell
python tools\chiro-synth\gen_chiro_set.py --prms chirotouch --out sample-data\prms\chiro-1-chirotouch\SET-1\POS
python tools\chiro-synth\gen_chiro_set.py --prms jane       --out sample-data\prms\chiro-2-jane\SET-1\POS
python tools\chiro-synth\verify_chiro_set.py --dir sample-data\prms\chiro-1-chirotouch\SET-1\POS --tag SET1-POS --compare sample-data\prms\chiro-2-jane\SET-1\POS
```

Expected (seed 1): 150 patients, 723 visits, 622 claims, 16 ERA payments; `ALL CHECKS PASS` for both folders.

## Scenarios

One folder per scenario, as in dental (`SET-1/POS`, `SET-1/NEG-ALL`, `SET-1/NEG-<LEAK>`):

```powershell
python tools\chiro-synth\gen_chiro_set.py --prms jane --scenario neg-all --out sample-data\prms\chiro-2-jane\SET-1\NEG-ALL
python tools\chiro-synth\verify_chiro_set.py --dir sample-data\prms\chiro-2-jane\SET-1\NEG-ALL --tag SET1-NEG-ALL --compare sample-data\prms\chiro-1-chirotouch\SET-1\NEG-ALL
```

`pos`: everything reconciles; Medicare CMT lines carry AT; no denials. `neg-all`: all leaks on separate claims, remittances,
payments and days (16 on ChiroTouch, 15 on Jane). `neg-<leak>`: one leak. Leaks use their own random streams
(`--leak-seed`), so everything outside a leak is the POS set, and the same seeds give the same findings in both PRMS.

| Leak | What changes in the files | Expected exception (group, amount) |
|---|---|---|
| UNDEPOSITED_CHECK | a posted check (patient, PI carrier or attorney) is left out of the next ATM deposit | branch_atm_deposit, the check |
| EFT_MISSING | 835 payment posted in the PRMS, no EFT in the bank | insurance_eft, the payment |
| BANK_UNPOSTED | an EFT in the bank with a TRN that no 835 / PRMS posting has | insurance_eft, the credit |
| CARD_BATCH_SHORT | bank card credit lower than the CT Payments batch / Jane payout | card_processor, the shortfall |
| CASH_SHORT | ATM deposit lower than the day's posted cash | branch_atm_deposit, the shortfall |
| POSTED_TWICE | ERA post plus a manual EOB post of the same claim payment (day sheet + deposit report); one EFT | insurance_eft, the claim payment |
| REF_MISMATCH | bank TRN differs from the ERA TRN (same payer, amount) | insurance_eft, the payment |
| MCR_AT_MISSING | Medicare CMT line without AT, denied `--at-missing-cas` (CO-50, ASSUMPTION), written off | remittance, Medicare allowed |
| MAINT_NO_ABN | Medicare CMT billed GZ (no ABN), denied `--gz-cas` (CO-50, ASSUMPTION), written off | remittance, Medicare allowed |
| PR_NOT_TRANSFERRED | ERA patient responsibility with no patient payment | remittance, CLP05 |
| VISIT_CAP | CARC PR-119 line; PRMS writes it off (WO-PR-119) instead of billing the patient | remittance, PR-119 amount |
| BUNDLED_97140 | 97140 without 59, CO-97, written off | remittance, contracted payment |
| CONTRACT_UNDERPAY | line allowed `--underpay-pct` below FEESCHED, posted as paid | remittance, the shortfall |
| PI_REDUCTION | settled lien below the balance, no recorded or approved reduction in PI-CASES | pi_case, the unexplained gap |
| PREPAY_UNEARNED | the whole care-plan price posted as one PLAN charge at purchase | prepay_plan, unearned at period end |
| AUTODEBIT_RETURNED | ChiroTouch only: CASHPRAC Return row, not imported into ChiroTouch, no bank credit | autodebit, the installment |

Basis: leak list owner-approved (design-30 §10 #10). Medicare AT / GZ behaviour: Noridian JF chiropractic claim submission
requirements (no AT = maintenance, denied) and Palmetto GBA acute-treatment page (GZ lines auto-denied); the exact CARC is
not on those pages, so it is a flag. Cash Practice returns must be imported into ChiroTouch each business day (Cash Practice
help center), which is how AUTODEBIT_RETURNED happens.
