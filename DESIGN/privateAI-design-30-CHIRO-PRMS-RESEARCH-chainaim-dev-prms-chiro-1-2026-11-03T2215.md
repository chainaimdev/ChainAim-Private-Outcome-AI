# privateAI-design-30 — US Chiropractic practice-management example (chainaim-dev-prms-chiro-1): research and design

Status: RESEARCH / PROPOSAL; CHIRO-1a built 2026-11-03 (§11). Every file layout below is UNVERIFIED until the owner supplies
anonymized real exports (same rule as the dental pack: `{ value, verified, basis }`, nothing guessed).

## 0. What I read in this repo first (basis)
- `config/datasets.json` — dataset `dental-prms`: engine `domain-pack`, pack `finance/rcm/dental`, folder `prms/dent-prms-c-sample`, Set picklist, fileKinds.
- `services/analyst/src/domain-packs/finance/rcm/pack.ts` — `finance/rcm` kinds: ledger, deposit_detail, bank, patient_list, adjustments; comment says "kept thin until a second specialty needs more here (xrplh-24 §5.3)". Chiro IS that second specialty.
- `services/analyst/src/domain-packs/finance/rcm/dental/pack.ts` — dental adds `reconcile.json` + `sourceConfigs.financing`.
- `config/domain-packs/finance/rcm/dental/{reconcile.json,queries.json,financing.json}` and `config/domain-packs/finance/rcm/payer-aliases.csv` (already specialty-neutral).
- `sample-data/prms/dent-prms-c-sample/SET-2/POS/*` — headers of BANK-ST, BankDep-Det, Per-Sum, SPR-patientlist.
- No existing "chiro" references anywhere in the repo.

## 1. Which PRMS to model (web research, 2026-11-03)
| PRMS | Why it matters | Exports relevant to us (from vendor / migration docs) |
|---|---|---|
| **ChiroTouch** (PracticeTek) | Largest US chiro install base (~1 in 6 clinics per a market-data source); the "Curve Dental" of chiro | Front Desk → Billing/Statement Reports → **Data Export** (Patient Data, Excel/CSV); insurers + policies export (CSV/Excel); Reports Manager (e.g. "Future Schedule By Date"); A/R Aging exportable PDF/Excel/CSV; **CT ProClear** = TriZetto clearinghouse + automatic **ERA (835) posting**; **CT Payments** = integrated card/ACH via **Global Payments** (same acquirer family as the dental GLOBAL-* exports) |
| **Jane App** | Multi-discipline clinics (chiro + PT + massage); very well documented exports | Patient list, Appointments, Insurance Policies, Transaction ("Cash Out") report, **Payments, Refunds & Fees** (detail: Date, Payor name, Payment method, Reference number, Invoice number, Amount, Processing fees, Amount paid to the clinic), **Jane Payments Transactions**, **Jane Payments Payouts** (Date Created, Date Deposited, Payout Amount, Payout Status; US deposits on a 2-business-day rolling schedule; cutoff 11:59 pm ET), Accounts Receivable, Claim Submissions search export (CSV), ERA posting via Claim.MD |
| ChiroFusion, ChiroHD, Genesis, ECLIPSE, ChiroSpring, EZBIS | Long tail | ChiroSpring has an ERA Center (835 import, EFT / virtual card / check). Not modelled first. |
| **Cash Practice** (add-on) | Auto-debit for care plans, used with ChiroTouch/ChiroHD | **Posted Payments Report** imported into ChiroTouch daily (auto-debits, voids, refunds, returns) — a second ledger that must agree with ChiroTouch and the bank |

Recommendation: **ChiroTouch first** (layout family 1), Jane second (layout family 2). Both reconcile to the same BofA bank adapter already built.

## 2. What is different from dental (drives new leak types)
1. **Medicare CMT rules** (CMS LCD/billing articles): only 98940/98941/98942 are covered; **AT** modifier required for active/corrective care, otherwise denied; maintenance care needs a signed **ABN** and **GA**; **GZ** = no ABN (provider liable); **GY** = statutorily non-covered (98943, exams, x-rays); AT+GA on the same line rejects (Palmetto, DOS ≥ 2015-11-01). ABN form CMS-R-131 revised in 2026 (one billing-firm source; verify on cms.gov before relying).
2. **Therapy add-ons + bundling**: 97140/97110/97112/97012 with CMT; **CO-97** bundling denials; modifier 59 misuse.
3. **Visit caps**: **CARC 119** "benefit maximum reached" (PR or CO) — visits past the plan limit.
4. **ERA 835 is the remittance source of truth** (CARC/RARC, group CO/PR/OA/PI): PR-1/2/3 = deductible/coinsurance/copay must move to the patient ledger; CO-45 = contractual write-off.
5. **Personal injury (PI)**: MedPay/PIP (first-party auto) + **lien / letter of protection** settled by an attorney months later, often with a **lien reduction** → large aged A/R and write-offs outside insurance.
6. **Workers' comp** payers (separate claim/attachment flow).
7. **Prepaid care plans / memberships**: cash collected before visits = **unearned revenue**; several state boards regulate them (e.g. North Dakota requires an FDIC-insured escrow account, no commingling; Ohio/Colorado/NC require written refund-proration terms; Minnesota caps at 50 visits). Refunds of unused visits.

## 3. Proposed source files per Set (kinds, not final names — folder/file names are the owner's)
| Proposed kind | Real source | Maps to finance/rcm kind | Status |
|---|---|---|---|
| Patient list | ChiroTouch Data Export → Patient Data / Jane Patients List | patient_list | layout UNVERIFIED |
| Insurance policies | ChiroTouch insurers/policies export / Jane Insurance Policies report | **NEW: coverage** (payer, plan, priority, visit limit, effective dates) | UNVERIFIED |
| Day sheet / transactions (charges by CPT+modifiers, payments, adjustments) | ChiroTouch day sheet / Jane Transaction report | ledger (+ adjustments) | UNVERIFIED |
| Deposit / payments by type | ChiroTouch deposit report / Jane Payments, Refunds & Fees | deposit_detail | UNVERIFIED |
| A/R aging (insurance, patient, PI/attorney) | ChiroTouch A/R Aging / Jane AR report | **NEW: ar_aging** | UNVERIFIED |
| ERA 835 (raw .835 + parsed CSV) | TriZetto (CT ProClear) / Claim.MD | **NEW: remittance** | X12 835 is a public standard → parser can be verified against the spec |
| Card processor batches | CT Payments (Global Payments) / Jane Payments Transactions + Payouts | processor (reuse dental card_processor group) | UNVERIFIED for chiro |
| Auto-debit ledger | Cash Practice Posted Payments Report | processor | UNVERIFIED |
| PI cases | No standard export; clinic spreadsheet (case, attorney, LOP date, billed, settled, reduction) | **NEW: pi_case** | owner-defined |
| Care plans | ChiroTouch/Jane packages & memberships | **NEW: prepay_plan** | UNVERIFIED |
| Bank statement | BofA CSV (existing adapter) | bank | VERIFIED (dental) |

## 4. Chiro leak scenarios for a SET (mirrors dental SET-2 POS + NEG-*)
Reused from dental (same reconcile engine): NEG-UNDEPOSITED-CHECK, NEG-EFT-MISSING (ERA posted, EFT never in bank), NEG-BANK-UNPOSTED (EFT in bank, ERA never posted), NEG-CARD-BATCH-SHORT, NEG-CASH-SHORT, NEG-POSTED-TWICE, NEG-REF-MISMATCH.
New, chiro-specific:
- NEG-MCR-AT-MISSING — Medicare CMT line without AT, denied, then written off instead of corrected/rebilled.
- NEG-MAINT-NO-ABN — maintenance CMT billed without ABN (GZ/no modifier) → provider-liable write-off; or GA with ABN but patient never charged.
- NEG-PR-NOT-TRANSFERRED — ERA PR-1/2/3 never moved to patient balance.
- NEG-VISIT-CAP — CARC 119 lines left on insurance A/R or written off instead of billed to patient.
- NEG-BUNDLED-97140 — CO-97 on 97140 with CMT, written off.
- NEG-CONTRACT-UNDERPAY — paid below the fee schedule (needs a fee-schedule file; phase 2).
- NEG-PI-REDUCTION — lien settled below billed without a recorded, approved reduction; NEG-PI-STALE (PI A/R > N days, flag only).
- NEG-PREPAY-UNEARNED — plan cash recognised as revenue before visits; refund owed on unused visits; escrow/commingling check where the owner's state requires it.
- NEG-AUTODEBIT-RETURNED — Cash Practice return/void not reflected in ChiroTouch ledger or bank.

## 5. Bookkeeping view (what the pack should be able to answer)
Gross production by payer class (commercial / Medicare / Medicaid / PI / WC / cash-plan) → contractual adjustments (CO-45) → denials & write-offs by CARC → patient responsibility billed vs collected → deposits by channel (EFT, card batch, cash/check, attorney check) → processing fees → deferred revenue (prepaid plans) → bad debt / lien reductions. All in cents, figures checked like the dental fact sheets.

## 6. Code plan (no code yet; AI can do once samples arrive)
1. `finance/rcm` (shared): add kinds `coverage`, `remittance`, `ar_aging`; move generic CARC/group handling here (dental can use it too).
2. `services/analyst/src/domain-packs/finance/rcm/chiro/pack.ts` (extends finance/rcm) + `config/domain-packs/finance/rcm/chiro/{reconcile.json,queries.json,prepay.json,pi.json}`, every item `{value, verified, basis}`.
3. 835 adapter: `--in <file.835> --out <csv>`; outputs claim / service-line / adjustment (group, CARC, amount) / payment (TRN check/EFT trace) tables; golden tests from the X12 spec.
4. Generator `tools/chiro-synth/gen_chiro_set.py` with flags mirroring dental (`--set`, `--scenario`, `--seed`, `--card-lag-days`, `--medicare-share`, `--pi-share`, `--prepay-share`), POS + each NEG with `_answer-key`.
5. `config/datasets.json`: new dataset `chiro-prms` (label "Practice Management - Chiropractic"), `engine: domain-pack`, `pack: finance/rcm/chiro`, `subfolders: true`.
6. Tests: scenario tests like `dental-scenarios.test.ts`; repo-hygiene guard already covers sample-data.

## 7. Open questions for the owner
- Model ChiroTouch first (recommended) or Jane?
- Folder name under `sample-data/prms/` (dental is `dent-prms-c-sample`); is `chainaim-dev-prms-chiro-1` the folder name or the ticket label?
- Can you get anonymized real exports: ChiroTouch Data Export (patients), insurer/policy export, a day sheet, deposit report, A/R aging, one 835 file, a CT Payments batch report, and the matching bank statement?
- Payer mix to simulate (Medicare share, PI share, cash plans)? State (prepaid-plan rules differ by state)?

## 8. Decisions (owner, 2026-11-03 22:13)
- Model BOTH ChiroTouch and Jane.
- Folders under `sample-data/prms/` (same names under the private root `C:\PRIV-AI-DATA\chainaim3003\prms\` for real data):
  - `chiro-1-chirotouch/`
  - `chiro-2-jane/`
- `chainaim-dev-prms-chiro-1` = work label for this effort, not a folder.

### How the two are kept apart
1. One folder per PRMS, never mixed in one Set. A clinic runs one PRMS at a time; mixing a ChiroTouch day sheet and a Jane transaction report in one Set would count the same visit twice.
2. Inside each folder, the dental layout:
   ```
   chiro-1-chirotouch/
     SET-1/POS/            generated, everything reconciles (+ _answer-key/)
     SET-1/NEG-<LEAK>/     one planted leak each (+ _answer-key/)
     SET-1/NEG-ALL/
     sample-prms-fin/      owner's anonymized real exports (layout verification)
   chiro-2-jane/
     (same shape)
   ```
3. File-name prefixes per PRMS (fileKinds in datasets.json): `CT-*` for ChiroTouch, `JANE-*` for Jane, `CTPAY-*` (Global Payments batches), `CASHPRAC-*` (Cash Practice posted payments), `JANEPAY-*` (Jane Payments transactions / payouts). Shared across both: `BANK-ST-*` (BofA adapter, verified), `ERA-*.835` (X12 standard), `PI-CASES-*`, `CAREPLANS-*`.
4. One pack, two layout families: `finance/rcm/chiro` holds the chiro rules (modifiers, CARC handling, PI, prepay). Header-signature adapters per PRMS live under it (`.../chiro/layouts/chirotouch`, `.../chiro/layouts/jane`), each with its own `{value, verified, basis}` config. Leak logic and queries.json are shared, so one question bank answers both.
5. Two datasets in `config/datasets.json`, same pack, different folder:
   - `chiro-ct`  label "Practice Management - Chiro (ChiroTouch)", folder `prms/chiro-1-chirotouch`
   - `chiro-jane` label "Practice Management - Chiro (Jane)", folder `prms/chiro-2-jane`
6. Generator: one `tools/chiro-synth/gen_chiro_set.py --prms chirotouch|jane --set SET-1 --scenario POS|NEG-...|ALL --seed N --out <folder>`. Same underlying visits/claims/payments model, written out in each PRMS's layout; answer keys identical in meaning, so the same scenario must produce the same findings in both folders (a cross-check test).

## 9. Chiro topics and query bank (DRAFT — same paired format as dental queries.json; 30 exact + 16 model)
Format follows `config/domain-packs/finance/rcm/dental/queries.json`: an exact entry (`sql`, answered by code, no model) and a
model entry (`question` + `facts`, every figure cited) answering the same intent name each other in `pair`; the console shows
them as one question with "Answer as: Table | Explained". SQL is not written yet: it depends on the chiro tables, which do not
exist yet. Tables each entry needs are listed so the build can be checked against this list. Applies to both
`chiro-1-chirotouch` and `chiro-2-jane` (one shared bank).

New tables (proposed): `charges` (visit, patient_ref, dos, cpt, modifiers, units, fee, payer_class, provider) |
`era_claims` (trace, payer, claim_ref, billed, paid, patient_resp) | `era_lines` (claim_ref, cpt, modifiers, billed, allowed, paid) |
`era_adjustments` (claim_ref, line, group CO/PR/OA/PI, carc, rarc, cents) | `eft` (bank_row, payer, trace, cents) |
`processor_batches` (CT Payments / Jane Payments payouts / Cash Practice) | `pi_cases` | `plans`, `plan_visits` |
plus the existing `exceptions`, `matches`, `unmatched_*`, `group_totals`, `file_checks`.

### Topics
| id | label |
|---|---|
| leaks | Leaks overview |
| payers | Insurance payers, ERA & EFT |
| medicare | Medicare & modifiers (AT / GA / GZ / GY) |
| denials | Denials, bundling & visit caps |
| patient | Patient responsibility & balances |
| deposits | Deposits & bank matching |
| card | Card, auto-debit & payouts |
| pi | Personal injury, MedPay/PIP & liens |
| plans | Care plans & prepaid visits |
| production | Production & coding mix |
| actions | Office actions & controls |
| quality | Data quality & posting |

### Query bank
| id | topic | type | pair | title | needs |
|---|---|---|---|---|---|
| leak-summary | leaks | sql | ask-priorities | Every leak type found: how many and how much | exceptions |
| money-at-risk | leaks | sql | ask-loss-vs-timing | Real losses vs unposted money vs timing items | exceptions |
| top-leaks | leaks | sql | – | The 10 largest leaks with dates, claims and payment IDs | exceptions |
| leaks-by-payer-class | leaks | sql | – | Leaks by payer class (commercial, Medicare, Medicaid, PI, WC, cash plan) | exceptions, charges |
| era-vs-eft | payers | sql | ask-eft-followup | ERAs posted vs EFTs in the bank, matched by trace number | era_claims, eft |
| eft-without-era | payers | sql | ask-extra-money | Insurance money in the bank with no ERA posted | eft, era_claims |
| era-without-eft | payers | sql | ask-missing-money | ERAs posted whose EFT never arrived | era_claims, eft |
| paid-by-payer | payers | sql | ask-payers | Billed, allowed, paid and days-to-pay per payer | era_claims, era_lines |
| mcr-at-missing | medicare | sql | ask-medicare | Medicare 98940-98942 lines without AT, and what happened to them | charges, era_adjustments |
| mcr-maintenance | medicare | sql | ask-medicare | Maintenance visits: GA with ABN billed to patient vs GZ / no-ABN written off | charges, era_adjustments |
| mcr-gy | medicare | sql | – | Non-covered services (GY: 98943, exams, x-rays) and whether the patient was charged | charges |
| denials-by-carc | denials | sql | ask-denials | Denials and adjustments by group + CARC (CO-45, CO-97, 119, CO-50, ...) | era_adjustments |
| visit-cap-119 | denials | sql | ask-visit-caps | Visits past the plan limit (CARC 119): moved to patient, left on insurance, or written off | era_adjustments, charges |
| bundled-97140 | denials | sql | ask-denials | 97140 / therapy lines denied as bundled with CMT (CO-97) | era_adjustments |
| pr-not-transferred | patient | sql | ask-patient-resp | ERA patient responsibility (PR-1/2/3) never moved to the patient ledger | era_adjustments, charges |
| open-patient-balances | patient | sql | – | Largest open patient balances and their age | charges, ledger |
| unapplied-credits | patient | sql | – | Patient money received but not applied to a visit | ledger |
| group-reconciliation | deposits | sql | ask-reconciled | Posted vs matched in the bank, per deposit group | group_totals |
| deposit-lag | deposits | sql | – | Days each deposit group takes to reach the bank | matches |
| card-batches | card | sql | ask-card-batches | Each card / payout batch vs the day's card payments (CT Payments or Jane Payments) | processor_batches, matches |
| autodebit-returns | card | sql | ask-card-batches | Auto-debits returned or voided but still counted as paid (Cash Practice) | processor_batches, ledger |
| processing-fees | card | sql | – | Processing fees and chargebacks vs card deposits | processor_batches, bank |
| pi-aging | pi | sql | ask-pi | Personal-injury A/R by case age and attorney | pi_cases |
| pi-reductions | pi | sql | ask-pi | Settled cases: billed vs received, reduction approved or not | pi_cases |
| medpay-pip | pi | sql | – | MedPay / PIP payments received vs billed per case | pi_cases, era_claims |
| plan-liability | plans | sql | ask-plans | Prepaid plans: cash collected vs visits used = unearned balance | plans, plan_visits |
| plan-refunds-owed | plans | sql | ask-plans | Ended plans with unused visits and the refund owed | plans, plan_visits |
| production-by-cpt | production | sql | – | Visits, charges and collections by CPT code | charges, era_lines |
| collection-rate | production | sql | ask-loan-capacity | Production, adjustments, collections and collection rate per provider and month | charges, ledger, era_claims |
| file-checks | quality | sql | – | Data-quality checks that failed, per file | file_checks |
| ask-priorities | leaks | model | leak-summary | Which leaks lose money, the total, and what to fix first | facts: totals, losses |
| ask-loss-vs-timing | leaks | model | money-at-risk | Separate real losses from timing items and posting errors | totals, all |
| ask-payers | payers | model | paid-by-payer | Which payers pay slowly or short, and what to chase | payers |
| ask-eft-followup | payers | model | era-vs-eft | EFT follow-up per payer | payers |
| ask-missing-money / ask-extra-money | payers | model | era-without-eft / eft-without-era | Money missing from / extra in the bank | losses / extra |
| ask-medicare | medicare | model | mcr-at-missing | Medicare modifier problems, the money involved, and the fix (documentation vs ABN process) | medicare |
| ask-denials | denials | model | denials-by-carc | Denial patterns that are fixable (bundling, modifiers) vs final | denials |
| ask-visit-caps | denials | model | visit-cap-119 | Patients past their visit limit and what is collectible | denials, patient |
| ask-patient-resp | patient | model | pr-not-transferred | Patient balances never billed after insurance paid | patient |
| ask-card-batches | card | model | card-batches | Card / payout / auto-debit batches that do not match | card |
| ask-pi | pi | model | pi-aging | PI cases to follow up with attorneys, and reductions to review | pi |
| ask-plans | plans | model | plan-liability | How much prepaid money is not yet earned, and refunds owed | plans |
| ask-loan-capacity | production | model | collection-rate | Are collections steady enough to support a loan installment of X a month? | totals, groups |
| ask-office-actions | actions | model | – | Checklist for the office manager, one line per exception | all |
| ask-controls | actions | model | – | Which process controls would have prevented these leaks | all |

### Demo script (6 clicks, on SET-1/NEG-ALL, both PRMS folders)
1. Leaks overview → "Every leak type found" (Table), then Explained.
2. Medicare → "Medicare lines without AT" (shows a chiro-only leak).
3. Payers → "ERAs posted whose EFT never arrived".
4. Patient → "Patient responsibility never billed".
5. Care plans → "Unearned prepaid balance".
6. Production → "Can collections support a loan installment of X?" (links to CreditSeal underwriting).
Repeat step 1 on `chiro-2-jane` to show the same findings from a different PRMS.

## 10. Additional questions for the owner (chiro)
1. State(s) of the sample clinic — drives prepaid-plan rules (escrow, refunds) and PIP/no-fault vs MedPay.
2. Payer mix to simulate: % commercial / Medicare / Medicaid / PI / workers' comp / cash plan.
3. Workers' comp in scope for v1, or later?
4. Clearinghouse per PRMS: ChiroTouch → TriZetto (CT ProClear) assumed; Jane → Claim.MD assumed. Correct?
5. Card processing: CT Payments (Global Payments) for ChiroTouch, Jane Payments for Jane? Is Cash Practice in the ChiroTouch clinic?
6. Bank: same Bank of America layout as dental? (Then bank matching is reused as-is.) How do Jane Payments payouts and
   insurance EFTs appear on the statement (originator / description)? Unknown — needs one real statement line each.
7. A fee schedule (contracted rates per payer + CPT) — needed for underpayment checks; include in v1?
8. Providers / locations / period: dental used S1 clinic, PV1-PV4, Sep 2024. Same shape (e.g. 1 clinic, 3 DCs, 3 months)?
9. Demo audience: clinic owner (leaks) or lender (CreditSeal loan capacity) — sets the default template order.
10. ANSWERED (owner, 2026-11-03 22:22: keep the dental leaks that are meaningful in chiro). Keep 7, drop 1:
    - NEG-UNDEPOSITED-CHECK — keep: patient checks, paper insurance / WC checks, and large PI attorney settlement checks.
    - NEG-EFT-MISSING — keep: ERA posted, EFT never in the bank (= era-without-eft).
    - NEG-BANK-UNPOSTED — keep: EFT in the bank, ERA never posted (errored / unprocessed ERAs).
    - NEG-CARD-BATCH-SHORT — keep: copays and cash-plan payments via CT Payments / Jane Payments payouts.
    - NEG-CASH-SHORT — keep: cash-pay visits are common in chiro.
    - NEG-POSTED-TWICE — keep: ERA auto-post plus a manual EOB post, or a Cash Practice file imported twice.
    - NEG-REF-MISMATCH — keep, redefined: ERA trace number (TRN) or check number differs from the bank / deposit reference.
    - NEG-HFD-LAG — drop: dental patient-financing lender; chiro uses care plans and auto-debit instead (NEG-PREPAY-UNEARNED, NEG-AUTODEBIT-RETURNED).
    NEG-ALL for chiro = 7 kept + 9 chiro-specific = 16 leak types. Basis: assessment from the research in section 1-2, not from a real chiro export.

## Sources
- ChiroTouch market position: https://www.withorbital.com/data/software/chirotouch/
- ChiroTouch data export: https://chirospring.helpscoutdocs.com/article/441-exporting-data-from-chirotouch ; https://katanahub.zendesk.com/hc/en-us/articles/360043654171
- CT ProClear (TriZetto, ERA auto-posting): https://www.chirotouch.com/product/ct-proclear
- CT Payments (Global Payments): https://chirotouch.com/product/ct-payments
- Cash Practice Posted Payments import: https://support.cashpractice.com/help/how-do-i-download-and-import-the-posted-payments-report-generator-for-chirotouch
- Jane reports: https://jane.app/guide/payments-refunds-and-fees-report ; https://jane.app/guide/jane-payments-payouts-report-ba29b007-eec6-47ac-8798-fb9ebcc3ddfb ; https://jane.app/guide/insurance-specific-reporting-us ; https://jane.app/guide/importing-from-jane
- Medicare chiro modifiers: https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleid=58412 ; https://downloads.cms.gov/medicare-coverage-database/lcd_attachments/34585_17/L34585_CHIRO001_BCG.pdf ; https://www.csscoperations.com/palmetto/rr.nsf/DIDC/A22JLH1132~Specialties~Chiropractic
- CARC list: https://x12.org/codes/claim-adjustment-reason-codes (via https://portal.ct.gov/-/media/ohs/health-it-advisory-council/apcd-advisory-group/data-submission-guide-workgroup/meeting-materials/6-30-22/carc-codes_final.pdf)
- PI liens/MedPay/PIP: https://www.chiroeco.com/?p=142581 ; https://corporate.findlaw.com/litigation-disputes/the-dc-lien-in-lean-times.html
- Prepaid plan rules: https://regulations.justia.com/states/north-dakota/title-17/article-17-03/chapter-17-03-01/section-17-03-01-05 ; https://codes.ohio.gov/ohio-administrative-code/rule-4734-9-11 ; https://www.law.cornell.edu/regulations/minnesota/Minn-R-2500-6060

## 11. Build status
### CHIRO-1a (2026-11-03) — independent of §10 answers
| Item | Where | Basis |
|---|---|---|
| ERA 835 parser (pure) | `services/analyst/src/sources/remit/x12-835-parse.ts` | AultCare 5010 835 Companion Guide v1.6 (2025-01-23): BPR01-16, TRN01-03, CLP01-07, NM1*QC, DTM 232/233/405/472, SVC01-05, CAS01-19 (six triplets; positive amount reduces payment), AMT*B6. CMS 835 TI Companion Guide 3.0 (005010X221A1): SVC06, LQ*HE, PLB03 codes, CO/OA/PR/PI. Amerigroup 835 guide: PLB up to six adjustments. **Unverified** (TR3 knowledge, reported as checks only): REF*6R, BPR02 = sum(CLP04) - sum(PLB). |
| Source adapter `remit/x12-835` | `.../sources/remit/x12-835.ts` | Loads claims + `__payments`, `__lines`, `__adjustments`, `__plb`. Names (NM1) never loaded. |
| CLI | `services/analyst/scripts/era-to-csv.ts --in <file.835> [--out <dir>] [--prefix] [--tables] [--allow-unbalanced] [--json]` | exit 0 ok / 1 check failed (files written) / 2 usage |
| finance/rcm kinds | coverage, remittance, ar_aging | design-30 §3, §6.1 |
| finance/rcm/chiro pack | `.../domain-packs/finance/rcm/chiro/pack.ts` | kinds processor, pi_case, prepay_plan; prefixes from §8.3. No `reconcile`/`sourceConfigs` until layouts are verified. |

Checks the parser reports per file: service lines balance (SVC02 - line CAS = SVC03), claims balance (CLP03 - all CAS = CLP04),
PR adjustments = CLP05 (payer practice), BPR02 = sum(CLP04) - sum(PLB), SE01 count, SE02 = ST02, every segment parsed.

Known limit: `reconcile.ts` allows one file per layout per folder, so a Set keeps all payments in one interchange file (one ST per payment).

### §10 answers (owner, 2026-11-03 23:20; options proposed by Claude, chosen by the owner)
- 2 Payer mix default (generator flags, assumption, not real clinic data): commercial 45, Medicare 20, Medicaid 5, PI 15, cash plan 15, WC 0.
- 3 Workers' comp: not in v1 (WC share 0).
- 4 Clearinghouse: ChiroTouch -> TriZetto (CT ProClear); Jane -> Claim.MD. Unverified against a real ERA envelope.
- 5 Processors: CT Payments (Global Payments, CTPAY-*) and Cash Practice auto-debit (CASHPRAC-*) for ChiroTouch; Jane Payments (JANEPAY-*) for Jane.
- 8 Clinic shape: 1 clinic, 3 DCs, 1 month.
- 1 State (revised 23:22): Connecticut + Massachusetts, both PRMS (payers from both states, like the dental HUSKY + MassHealth sample).
  Auto PI coverage and prepaid-plan rules per state: see §12 (sources read before the generator uses them).
- 6 Bank: insurance EFT (DES:HCCLAIMPMT ... TRN*1*<trace>) and Global Payments card deposit (GB PY DES:GLOBAL DEP) reuse the verified
  dental BofA formats. Jane Payments payout and Cash Practice auto-debit deposit lines: still open (owner to supply one anonymized line each).
- 7 Fee schedule: yes, synthetic FEESCHED-*.csv (contracted rate per payer + CPT); NEG-CONTRACT-UNDERPAY stays in NEG-ALL (16 leak types).
- 9 Demo audience: clinic owner (leaks first, loan capacity last).
- Still open: ChiroTouch/Jane export header lines (first row only).

### CHIRO-1b-1 (2026-11-03): generator POS for both PRMS
- `tools/chiro-synth/gen_chiro_set.py` (canonical model, both layout families, 835 writer, BofA writer, answer key) and
  `verify_chiro_set.py` (independent re-read; cross-PRMS check). Seed 1: 150 patients, 723 visits, 622 claims, 16 ERA payments.
- Checked: both folders ALL CHECKS PASS with --compare; ERA byte-identical across PRMS; the TS 835 parser reads it with 0 failed
  checks; four tampered copies (bank amount, 835 line, other seed) are caught. Found and fixed during build: payroll 100x
  (randrange bounds), different event streams per PRMS (auto-debit draw).
- `services/analyst/test/chiro-sets.test.ts`: the sets through bank/bofa and remit/x12-835 (DuckDB, owner PC).

### Next (CHIRO-1b-2): NEG scenarios (16 leaks) + chiro reconcile + query bank + datasets
Generator canonical model (`tools/chiro-synth`), 835 writer verified by this parser, chiro reconcile.json (ERA TRN vs bank trace),
ChiroTouch/Jane layout adapters (after header lines from real exports), datasets.json entries chiro-ct / chiro-jane, scenario tests.

### CHIRO-1b-2 stage 1 (2026-11-04): NEG scenarios for both PRMS
- `tools/chiro-synth/chiro_leaks.py` (16 leaks, two stages: claims before payments/remittances, model after IDs) wired into
  `gen_chiro_set.py` (`--scenario neg-<leak>|neg-all`, `--leak-seed`, `--short-max-cents`, `--unposted-min/max-cents`,
  `--underpay-pct`, `--at-missing-cas`, `--gz-cas`, `--return-days`, `--pi-stale-days`). Answer key: `expect` column per bank
  credit; truth.json `expected_exceptions` (code, severity, group, date, cents, refs, payer, detail), `unmatched_bank_credits`,
  `unmatched_prms_rows`, `not_applicable`, `watch_items` (PI_STALE). 835: denied claims carry CLP02 = 4; CO adjustments are posted
  per CARC (POS output unchanged: only CO-45).
- Decisions taken in the build (owner may override): AUTODEBIT_RETURNED is ChiroTouch-only (Jane has no Cash Practice) -> Jane
  NEG-ALL = 15 leaks; PI_STALE is a watch item in every scenario, not a 17th leak; patient responsibility is collected as the ERA
  states (a denied line carries no coinsurance); the denial CARC for AT-missing / GZ is a flag (CO-50, ASSUMPTION: Noridian JF and
  Palmetto GBA confirm the denial, not the CARC).
- `verify_chiro_set.py`: NEG-aware generic checks, one check per leak in the files, a reverse scan (every anomaly must be a planted
  leak), the scenario's leak set, and cross-PRMS findings. Tamper tests: dropping any one of the 16 leaks from the key fails.
- Linux workspace: POS data files byte-identical to v1.3.1 both PRMS; NEG-ALL deterministic; 35 sets (18 ChiroTouch, 17 Jane)
  ALL CHECKS PASS with --compare; era-to-csv on both NEG-ALL ERAs 0 failed checks. Sets written to sample-data (git-ignored).
- Next: stage 2 layout adapters (ChiroTouch with a no-header fallback, Jane with the public Jane guide names as basis), stage 3
  reconcile.json + reconcile-check reproducing these answer keys, stage 4 query bank + datasets switch, stage 5 scenario tests.

## 12. State rules used by the chiro generator (sources read 2026-11-03)
| Rule | State | Value used | Basis |
|---|---|---|---|
| Auto PI first-party coverage | MA | PIP compulsory, $8,000 per person; when the patient has health insurance PIP pays medical up to $2,000, then the health plan | mass.gov Superior Court jury instruction 8.00 (PIP, amended Nov 2021, G.L. c. 90 s.34A); insurer pages (Plymouth Rock, MAPFRE) for the $8,000 limit |
| Auto PI first-party coverage | CT | Not no-fault; MedPay optional; MedPay primary over health insurance (policies from 2000-11-01) | CT Insurance Dept. regulation 38a-334-7 (portal.ct.gov/cid pc48); Plymouth Rock "Is CT a no-fault state" |
| Prepaid care plans | MA, CT | No state-specific rule found (searched MA 233 CMR and CT); generator uses unearned revenue + pro-rata refund of unused visits, no escrow check | ASSUMPTION (pro-rata is the rule in NC 21 NCAC 10.0305 and the Illinois Chiropractic Society guidance; not MA/CT law) |
