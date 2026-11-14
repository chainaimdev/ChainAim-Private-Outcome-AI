# xrplh-24 — Dental RCM reconciliation, domain-packs, settlement, decoupling: full session

Session: 2026-10-31 14:08 to 2026-11-01 13:30 (UTC-05:00). Repository: CreditSeal (branch main).
Paths below use forward slashes; on Windows they are under `<your-folder>/FINAGENTS/CreditSeal/CreditSeal/`.

Status legend: **BUILT** = files exist on the PC (verified by size/read-back). **DESIGN** = agreed in discussion, nothing built.
**VERIFIED** = read from a file or an official/public source. **ASSUMED** = inference, to be confirmed.

---

## 1. Goal (owner)

Reconcile a dental practice's payments and find revenue leaks by combining:
Curve Dental (Curve Hero) exports (patient list, payments / bank deposit detail, ledger, period summary),
Bank of America statement CSV, payer remittances (CT HUSKY, MA MassHealth, Aetna, Anthem BCBS, Delta, UnitedHealthcare, ...).
Design must be generic: Curve is one vendor; dental is one specialty; later chiro, PT, medical and other practice systems.
Everything runs as private AI: raw data stays on the PC; only computed, masked evidence reaches a model.

## 2. External facts checked this session

| Fact | Status | Source |
|---|---|---|
| Curve has no public developer portal / self-serve API; access via ~30 curated partners or a request to Curve Account Management | VERIFIED (secondary sources, consistent) | supergood.ai API report card; nirmitee.io dental PMS integration page |
| No public column layout for any Curve CSV export | VERIFIED (prior chat 2026-10-18 + this session) | Curve help center sections (most report articles are videos) |
| CT HUSKY dental = Connecticut Dental Health Partnership (CTDHP), administered by BeneCare under an ASO contract with DSS; RA downloadable; X12N 835 is the HIPAA ERA | VERIFIED | ctdhp.com PB16-64; CGA CTDHP overview |
| MassHealth dental TPA = DentaQuest again; first DentaQuest-processed payments 2026-02-23 (Run 100874); BeneCare ran it from 2025-04-01 | VERIFIED | MassHealth Dental Bulletin 55 (Jan 2026); change.org petition re BeneCare transition |
| DentaQuest and Delta Dental of MA offer 835 ERA to trading partners | VERIFIED | dentaquest.com ERA enrollment; deltadentalma.com trading partner |
| Aetna, Anthem BCBS, UHC 835 per payer | NOT VERIFIED (standard practice, assumed) | — |
| CDT is copyrighted by the ADA; CPT by the AMA (code sets are licensed) | VERIFIED for CDT (notice in MassHealth manual); CPT ASSUMED (well known) | — |

## 3. Owner's sample files (data/pms/dental-curve-sample/, git-ignored)

Samples = **real layouts, made-up data** (owner built them from the Curve and BofA report schemas; names are made up).

| File | What it is | Layout facts (read) |
|---|---|---|
| BankDep-Det-Sim-Sample-4.csv | Curve payments, one row per payment and provider | 14 columns: Date, ID, Payment Posted By, Payment Type, Ref. ID, Ext. ID, Payer, Responsible Party, RP-AN-L, RP-AN-F, RP Profile Tag(s), Provider, Posted At Clinic, Amount. No deposit-batch id. Same ID can repeat per provider (227347: 0.00 + 43.00). RP-AN-L sometimes holds a full name instead of PLnnn |
| Per-Sum-Sample-4-anon.csv | **Row-level ledger**, not Period Summary totals | Date, Details, Patient, ANON-PT-3-L, AN-PT-3-F, Default dentist, Provider of service, Clinic, Posted at clinic, Amount. Details = `<Type> #<id>[, <method>[ - <ref>]]`; Type = Invoice/Payment/Deposit/Adjustment |
| SPR-patientlist-sample.csv | Patient list | Header only (Full Name, Status, Preferred Clinic, Default Doctor, Prim. Insurance Plan, Sec. Insurance Plan), no rows; no patient-ID and no ZIP column |
| BANK-ST-JUL-OCT-2026.csv | BofA statement | 5 preamble lines (beginning balance, total credits, total debits, ending balance), blank, header on row 7, "Beginning balance" pseudo-row; Amount quoted with commas; dates are 2024 although the name says 2026; RBalAdj = owner's scratch column (= Running Bal. + 100,000.00 on every row read); duplicate "Running Bal." header |

Owner answers: **HFD = Healthcare Finance Direct**, patient financing integrated with Global Payments. RBalAdj = derived scratch column. Names made up.

Observed in samples: payment 227385 reference 30587067 (deposit file) vs 020587066 (ledger) = mismatch (data-quality finding or anonymization artifact).
BofA `COMM OF MASS DES:HCCLAIMPMT ... PMT INFO:TRN*1*<trace>*<payer id>` carries the 835 reassociation trace.
`GLOBAL PAYMENTS DES:GLOBAL DEP` = card settlement credit; `GLOBAL STL` = processor debit; Cherry / SYNCHRONY = patient financing.

## 4. BUILT this session

| Path | Bytes | Committed? | Purpose |
|---|---|---|---|
| config/pms/curve-bofa-835-schema.csv | 9,751 | not yet (untracked) | Every column of each sample + X12 835 fields: format, canonical table/field, join key, privacy, basis |
| config/pms/header-crosswalk.csv | 3,267 | not yet | One row per concept: which column in each file, match type and rule |
| tools/dental-synth/gen_dental_set.py | 24,594 | not yet | Synthetic set generator, seeded, every knob a flag; only `--scenario pos` |
| tools/dental-synth/verify_set.py | 3,300 | not yet | Re-reads a set by header and checks it reconciles against its answer key |
| tools/dental-synth/README.md | ~3,700 | not yet | Run, outputs, checks, assumptions |
| data/pms/dental-curve-sample/SET-1/POS/* | 4 CSVs + _answer-key/{expected-matches.csv, truth.json} | git-ignored | Seed 1, Sept 2024: 260 patients, 447 ledger rows, 162 deposit rows, 67 bank rows, 45 bank credits, 45 matches |

Verification done: generator output identical across two runs with the same seed; verifier ALL CHECKS PASS
(159 deposit IDs, 444 ledger IDs, 45 bank credits, 45 matches); also passes for seed 7 with `--card-fee-mode daily-net`;
all files on the PC byte-identical to the generated files. A transfer artefact (raw BOM char instead of `\ufeff`) was replaced by `chr(0xFEFF)`.

Generator modelling ASSUMPTIONS (all flags): card and HFD payments post as `Deposit #id, <method>` (+) then `Payment #id, Account Credit` (-);
cash posts as `Payment #id, Cash`; Visa/Mastercard/HFD/Ins VCC settle in one daily Global Payments credit `--card-lag-days` (default 1) later;
`--card-fee-mode monthly|daily-net` (monthly = one GLOBAL STL debit); insurance EFT = one ACH per payer remittance with TRN trace, posted next day;
insurance checks and cash deposited at an ATM the next day; patient list Full Name `--patient-name-format last_first|first_last`.

Verifier checks: deposit ID ↔ ledger Details (amount with sign rule, method); bank preamble foots; running balance; detail = preamble;
each bank credit = sum of its Curve payments (minus fee when daily-net); each banked payment in exactly one credit; EFT trace in description.

## 5. Design decisions (DESIGN)

### 5.1 Code computes, the LLM explains
Matching and sums are deterministic (DuckDB over every row). A reasoning LLM is used only to: propose mappings for a new layout
(headers + masked samples), suggest payer aliases (owner approves), explain an evidence pack (findings, match trail, diagnostics,
pseudonymized examples), and pick catalog queries for drill-down (code builds the SQL). Every number in an answer is checked by `/verify`.

### 5.2 Analyst today (read on disk: README, main.ts, config.ts, profile.ts, actus.ts; headers of analyze.ts, crossask.ts)
Compute-only service on 127.0.0.1:8740, DuckDB in memory, file access locked after load, no keys, no model calls.
Recipe per folder: kinds (production, billing, income, collections, deposits, ledger, tax, adjustments, other), roles
(date, amount, debit, credit, party, reference, category), measures; an included file needs date + amount.
Routes: /profile /recipe /analyze /status /evidence /verify /relations /sql. `main.ts` does not import actus.ts.
Generic: config, db, relate, sqlrun, crossask (orchestrator), report (mostly). Financial: analyze (tie/ratio), profile (kinds, hints).
Separate workflow placed inside: actus.ts (loan cash flows).
Gaps for dental (from README, ASSUMED until code read): no preamble skip; many-to-one matching per day only, no method grouping;
no TRN extraction; no payer alias; Details not parsed; reference files (patient list) and rule checks unsupported.

### 5.3 Target analyst structure
```
services/analyst/src/
  core/          config, db, relate, sqlrun, report, server; ports (interfaces), registry
  engines/       flow (tie/ratio), match (reference / amount+date / many-to-one + group-by + lag), rules (reference lookups)
  sources/       FILE FORMATS, flat, any pack may use: bank/bofa, processor/global-payments, x12/835, pms/curve-hero, ledger/xrpl (later)
  domain-packs/  BUSINESS LOGIC, tree max 3 levels, child extends parent explicitly
    finance/                 today's default kinds and flow
      rcm/                   payer, claim, remit, denial; 835 <-> bank; payer aliases (thin until a 2nd specialty)
        dental/              CDT, PPO write-off, HUSKY / MassHealth   <- first build
        chiro/ pt/ medical/  later (maybe under rcm/professional/ if 837P specialties share more with each other)
      ar/                    ERP invoices <-> bank (later)
      saas-billing/          ChainAim's own revenue: settlement log <-> ledger <-> bank (later)
    lending/actus/           uses packages/actus
config/sources/<source>/     layouts, crosswalk (config/pms/* splits into these)
config/domain-packs/...      payer aliases, rule thresholds
```
Rules: packs reference sources by name, never contain them; inheritance explicit, `--print-pack` shows the effective rule set;
promote logic to a parent only when two children need it; reference codes present in practice data, never bundle CDT/CPT lists.

### 5.4 Settlement (how ChainAim gets paid) — separate service, holds credentials
```
services/settlement/
  core/    rail.ts (quote, start, confirm, refund, reconcileSource), entitlements.ts, events.ts (append-only, chain-neutral)
  rails/
    x402/                      one rail = the protocol
      protocol/                402 challenge offering several networks, payment header, facilitator verify/settle
      networks/xrpl/           existing (RLUSD, t54 facilitator)  <- first
      networks/evm/ solana/ …  later; only where the x402 version or a facilitator supports it
    card/ ach/ invoice/        later
services/chain-watch/          = ledger-watch renamed only when a 2nd chain is real
config/billing/                pricing.json, plans.json, rails.json, networks.json (chain id, assets+decimals, pay-to, facilitator, confirmations)
```
Status model: pending -> provisional -> final -> reversed. Confirm is idempotent. Finality per network/rail
(XRPL final on validation; cards and ACH reversible; exact windows from the chosen provider's docs, not looked up).
Card: PCI via hosted checkout. Getting paid for own service = merchant activity; moving money between other parties raises
money-transmitter questions (see stablecoin legality chat) — counsel review before launch.
x402 details (accepts list, scheme/network, facilitator verify/settle) are from general knowledge: check against the `@x402/*` 2.27.0 used by the paywall.

### 5.5 Loose coupling rules
One-way dependencies: core <- engines <- plugins (domain-packs, sources, rails, networks); only `main.ts` (composition root) knows concrete plugins, chosen by config.
Services talk over HTTP/JSON or the event log only. Shared code lives in `packages/`; shared data shapes in `packages/contracts/` (versioned, additive).
Each piece of data has one owner. Small interfaces (rule of two). Enforced by `scripts/check-deps.ts` in `npm test`, contract tests per port, fakes in unit tests.

## 6. Coupling map (VERIFIED, owner's PowerShell searches 2026-11-01): 34 static import lines

| Shared code (lives in) | Imported by | Lines |
|---|---|---|
| services/web/src/{balance, xrpl-payment, crossmark-signer}.ts | paywall scripts xrpl.ts, stream-core.ts, signer.ts; paywall tests agent, payment-sink, rig-loop, rig, signer-pay; ledger-watch test/fixtures.ts; test-console/console/server.ts:60 | 12 |
| services/gateway/src/privacy/{entities, presidio, residual}.ts | paywall scripts/prompt-scan.ts (3) + test/prompt-scan.test.ts | 4 |
| services/paywall/scripts/client-mask.ts | services/web/src/mask.ts (re-export) => **cycle web <-> paywall** | 1 |
| services/analyst/src/actus.ts | packages/underwrite src/loan.ts, src/underwrite.ts, test/underwrite.test.ts (**package -> service, inverted**); services/lending src/stages.ts:17, scripts/cockpit.ts:26 | 5 |
| services/analyst/src/crossask.ts | test-console/console/server.ts:61 (crossask calls the gateway: an orchestrator inside a compute-only service) | 1 |
| services/ledger-watch src + test/fixtures | apps/admin-console test/seller-store.test.ts, test/watch-server.ts | 12 (tests only) |

Not covered by the searches: dynamic `import()`, single-quoted paths, `require`, `.ps1` / `package.json` paths.
Good existing pattern: `services/lending/src/stages.ts` also imports `packages/underwrite` and `packages/xls66` by relative path.

Target packages:
```
packages/actus/        <- analyst/src/actus.ts
packages/crossask/     <- analyst/src/crossask.ts
packages/x402-xrpl/    <- web balance, xrpl-payment, crossmark-signer (browser-safe: no node: imports; = client side of settlement x402 xrpl)
packages/privacy/      <- gateway privacy core + paywall client-mask (or: prompt-scan calls gateway /v1/privacy/mask over HTTP)
```

## 7. Fix order and safe-move procedure

1. packages/actus  2. packages/x402-xrpl + browser masking (break the cycle)  3. packages/crossask
4. gateway privacy (package vs HTTP; gateway is privacy-critical, explicit owner approval)  5. admin-console tests = declared integration tests
6. check-deps rules: no packages -> services, no services/X -> services/Y, no cycles, one allowed test path.

Each move: tag -> baseline all suites (analyst npm test; root npm test, npm run test:paywall, npm run test:engine per PROJECT_CONTEXT.md)
+ analyst golden masters -> move unchanged -> one-line re-export shim at the old path -> all green -> repoint importers -> green -> remove shim.
Known break points: crossask and actus importers (above), saved recipes without `pack` (default finance-generic), HTTP routes and flags (unchanged), ledger-watch rename (deferred).

## 8. Test plan for dental RCM

| Layer | Proves | Pass rule |
|---|---|---|
| L1 fixture integrity | data set consistent | verify_set ALL CHECKS PASS (built) |
| L2 source adapter unit tests | layouts parsed | exact rows/values; cases from samples: Details incl. "PPO Write-off" hyphen, repeated ID per provider, RP-AN-L full names flagged, BofA preamble/pseudo-row/duplicate header/"1,069.50", TRN extraction, payer spellings |
| L3 POS | no false alarms | 0 exceptions |
| L4 NEG (one leak per set, then combined) | leaks caught with cause | found = answer key exactly: UNDEPOSITED_CHECK, EFT_MISSING, CARD_BATCH_SHORT, CASH_SHORT, REF_MISMATCH, POSTED_TWICE, BANK_UNPOSTED, HFD_LAG (= watch, not loss) |
| L5 robustness | not seed-dependent | many seeds and flag variants: 0 exceptions |
| L6 evidence + LLM | right facts, correct citations | planted findings in the pack; every number passes /verify |
| L7 privacy | no names to the model | no synthetic names in evidence |
| L8 refactor safety | moves change nothing | golden masters byte-identical |
| L9 real data | works on a real month | known issues surface; rest reviewed |

Samples cannot prove export mechanics (encoding, BOM, line endings, quoting, page breaks) or real data behaviour: add
`tools/dental-synth/shape.py` (layout-only output, values replaced by types) and compare a real export's shape before L9.
Port the generator to TypeScript (`services/analyst/scripts/make-dental-fixtures.ts`), keep Python as reference until byte-identical.

## 9. Size estimate (files)

| Scope | New | Modified | Total |
|---|---|---|---|
| A. Decoupling (fixes 1–6 + golden master) | ~15 | ~35 | ~50 |
| B. Analyst seams, minimal (ports, registry, finance pack, loader) | ~4 | ~3 | ~7 |
| C. Dental RCM sources, packs, config, fixtures, tests, docs | ~31 | ~5 | ~36 |
| All | ~50 | ~43 | ~93 (±15) |

Least certain: fix 2 (web-internal importers not searched) and fix 4 (package option).
Dental work depends only on phase 1 (actus) and phase 3 (seams): ~19 changed files before the dental build can start.

Phasing (each PR-sized, approved separately):
1. golden master + fix 1 actus (~12)  2. fix 3 crossask + check-deps (~10)  3. analyst seams (~7)
4. dental: sources + packs (~18), then tests (~18)  5. fix 2 x402-xrpl with the settlement x402 work (~20)  6. fix 4 gateway privacy (decide).

## 10. Open items

- Manual: run verify_set.py on the PC (pending); run and paste baseline test suites; commit config/pms/ and tools/dental-synth/ only
  (not DESIGN/xrplh-23-NEAR-PORT-...md unless intended).
- AI: read packages/underwrite layout and root package.json test scripts before fix 1; read db.ts, relate.ts, report.ts, analyze.ts and analyst tests to confirm the dental gaps.
- Decisions: config/pms vs config/sources + config/domain-packs layout; admin-console tests (a) declared integration vs (b) contract package; gateway privacy package vs HTTP.
- Real data: one anonymized month of Curve exports + BofA (+ a real 835) for shape check and L9.
- Out of scope here: services/ledger-watch/src/reconcile.ts (XRPL reconciliation, separate workflow).

## 11. Sources

- https://supergood.ai/api-report-card/curve-dental
- https://nirmitee.io/healthcare-interoperability/dental-practice-management-integration/
- https://www.ctdhp.com/documents/pb16_64.pdf
- https://www.mass.gov/doc/dental-bulletin-55-upcoming-transition-of-dental-third-party-administrator-for-masshealth-the-childrens-medical-security-plan-and-health-safety-net-0/download
- https://www.dentaquest.com/era-enrollment/
- https://deltadentalma.com/trading-partner
- Prior chat "PRIVAI-1-ui2server-2" (2026-10-18): Curve report inventory, canonical RCM model, semantic layer design
