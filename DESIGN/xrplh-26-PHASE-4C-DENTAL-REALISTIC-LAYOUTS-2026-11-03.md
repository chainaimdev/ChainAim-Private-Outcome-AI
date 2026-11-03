# xrplh-26 — Phase 4c: dental reconciliation on the owner's realistic sample layouts

Session: 2026-11-02 23:30 to 2026-11-03 00:45 (UTC-05:00). Repository: CreditSeal (branch main). Continues xrplh-25 §13.
Status legend: **BUILT** = files exist and were tested (where and by whom stated). **DESIGN** = agreed, nothing built.
**VERIFIED** = read from a file. **ASSUMED** = inference, to be confirmed.

## 1. Summary
The owner replaced the old samples (data/pms/dental-curve-sample, deleted) with realistic anonymized exports in
data/pms/dent-pms-c-sample/sample-pms-fin (git-ignored). Owner 2026-11-03: the samples define LAYOUTS and realism; the generator
(tools/dental-synth) produces the POS/NEG truth for every reconciliation and revenue-leak test. Phase 4c is split:
4c-1 (adapters, config, generator layout migration) is **BUILT and verified on the PC**; 4c-2 (new content and leaks) is DESIGN.

## 2. Owner decisions (2026-11-02 23:59 to 2026-11-03 00:29)
- Replace the old layouts; no dual support.
- `SB DES:MTOT DEP` is a bank deposit: listed as a known credit outside Curve, never paired, never BANK_UNPOSTED.
- The Global Payments exports ARE the GLOBAL-CareCredit/Cherry/HFD files; there is no card settlement report. The money arrives as
  shown in the bank statement; the GLOBAL files detail it. Visa/MC/Amex/Ins VCC stay matched to GLOBAL DEP by daily sum.
- Procedure report in scope; the 5 new leaks are Claude's proposal (owner: "you suggest").
- Payer codes compare case-insensitively.
- pms-2025-CC-sample.csv (a 2025 BofA statement excerpt, not card detail) is parked in data/pms/dent-pms-c-sample/_parked/; a folder
  may hold one bank statement only (reconcileFolder refuses two).
- Every paid invoice must be traceable to the bank totals (4c-2).

## 3. VERIFIED from the samples
- Curve headers: deposit detail `...,Payer,RP,Responsible Party,Provider,...` (12 columns); ledger `...,Patient,Patient-LM,Patient-FM,...`;
  patient list leads with `Patient` (key PTn; PT1 has two rows, one per plan; PT36 carries PT38's name); procedure report
  (curveIptReport) has no key column, only `Full Name`.
- Financing rows: Cherry Net Sale = Gross Sales - Refunds - Fees (3/3); HFD Amount = Treatment Amount - Discount (6/6) and
  Discount = Treatment Amount x Discount Rate (6/6), rate by Grade (A 4%, D 15%, E 22%); HFD Type Origination (+), Cancellation (-),
  Adjustment (-); negatives in parentheses; CareCredit Date "MM/DD/YYYY h:mm AM ET", Type Purchase.
- Bank: card credits are `GB PY DES:GLOBAL DEP` (65), not `GLOBAL PAYMENTS` (the old config matched none of them); Counter Credit
  (24), Cherry DES:Funding (3), HATCH HCFD (2), SB MTOT DEP (4), GLOBAL CBK debit (1). Sample artefacts: every running balance is
  $20.00 below previous + amount; summary column 1 is 100,000 below column 2 (the adapter's checks flag both).
- Real leaks in the samples: ID 227385 REF_MISMATCH (020587066 vs 40699078); ID 225388 ledger-only.

## 4. Phase 4c-1 — BUILT and verified on the PC (2026-11-03 00:43)
- Adapters: deposit-detail, ledger, patient-list (patient_key; checks one name per key, names unique across keys), Cherry/HFD
  layouts (trailing empty columns), new pms/curve-hero/procedures.ts (name_key via shared nameKeyExpr; raw names never stored);
  lines.ts sameHeadersPadded; 8 adapters registered.
- Engine: deposit-match.ts knownCredits (config, listed with label and basis, never unaliased ACH); payerKey/samePayer
  (case- and space-insensitive) in deposit-match.ts and deposit-diagnose.ts; reports keep Curve's spelling.
- Config: financing.json items verified only where rows prove them (all `columns` still unverified); reconcile.json card group
  originator `GB PY`, methods American Express / Care Credit (card, ASSUMED) and Personal Check (branch, ASSUMED), knownCredits;
  payer-aliases.csv AETNA (originator a placeholder: no Aetna ACH seen), notes on the new files; config/pms reference CSVs rewritten.
- Generator layout migration (Python + byte-identical TS port): PTn keys in every Curve file, synthetic names in the name columns,
  `GB PY` bank lines, 4-column statement, practice name as Preferred Clinic; business logic unchanged (golden vectors rng, floats,
  dec, csv identical; only `sets` re-recorded).
- Tests: test/data-root.ts (DENTAL_DATA_ROOT, default data/pms/dent-pms-c-sample; sets under SET-2), payer-case.test.ts,
  sources-l2 / sources-financing updated (owner's real files tested when present), scenario and smoke tests on SET-2.
- Evidence: Linux workspace — compare_port 2,240/2,240 identical, analyst 152/152. PC — 10 SET-2 sets ALL CHECKS PASS (counts equal
  the old layout's), analyst 152/152 (0 skipped, routes golden identical), root 340/340, check-deps OK (363 files, 66 cross-unit).

## 5. Phase 4c-2 — DESIGN (next)
- Generator: Counter Credit branch deposits next to ATM; financing exports (CareCredit/Cherry/HFD) and their fundings in the bank;
  procedure report; 5 new NEG leaks: PROCEDURE_NOT_INVOICED (--invoice-window-days 14), FINANCING_UNFUNDED,
  FINANCING_CANCELLATION_UNPOSTED, CHARGEBACK_UNPOSTED (GLOBAL CBK), FINANCING_DISCOUNT_OVER (rate vs contract per Grade).
- Engine: invoice -> payment -> deposit -> bank-credit trace; several bank credits against one day's total (Counter Credits);
  detection of the 5 leaks; REF_MISMATCH only when the ledger row exists (real-sample false positives 227384, 227605); evidence
  directions and the explain prompt for the new codes.
- Open: what HATCH HCFD pays (listed, not paired); contract discount rates per Grade (owner to confirm).

## 6. Phase 4c-1b — one script, query bank, DuckDB fact sheets for a local 8B — BUILT and verified on the PC (2026-11-03 02:30)
**Principle (owner, 01:14):** DuckDB produces the right summaries and data snippets; the 8B model only words them, on time.
- `npm run dental -- <cmd>` (scripts/dental.ts): sets, gen, check, explain (old evidence path), query (bank), status, up (ca-presidio,
  ca-openrouter-stub, ca-gateway + wait), probe (privacy scan of any text). The query path needs no analyst server: the engine runs
  in-process (reconcile.ts `inspect` hook), file access locked before any SQL.
- Bank (config/domain-packs/finance/rcm/dental/queries.json): 25 SQL queries over exceptions, matches, unmatched_*, group_totals,
  file_checks and the sources; 14 model questions, each naming its fact sections.
- Fact sheet (src/facts.ts): T (totals by category), G (group totals), F (one per exception: category, code, date, signed amount, payer,
  group, payment IDs, statement lines, action from reconcile.json `actions`). Categories by code: watch -> timing; negative -> loss;
  positive -> extra; neutral -> posting.
- Check: every amount, payment ID, cause code and date must belong to the fact the line cites; a line naming one category speaks for
  every fact it cites; every F fact mentioned (a cited T total covers its category); no leftover placeholder. Failure -> computed facts.
- Masking (VERIFIED on the owner PC with /v1/privacy/scan): "bank"/"account" near numbers -> BANK_ACCOUNT; tag "F4" -> US_DRIVER_LICENSE;
  "2024-09-13" near BANK_UNPOSTED -> BANK_ACCOUNT; "-164.00" -> PHONE_NUMBER ("-$164.00" clean). Sheet writes no context words, F_4,
  2024/09/13, -$164.00; 14/14 clean. The gateway benches a model 30 s after 2 failures (DeepSeek-R1 once returned no visible answer after
  160 s); dental.ts waits out one cooldown.
- Result (owner PC, local/deepseek-r1-8b, NEG-ALL): 5/5 verified and correct, 8.8-29.5 s each. Generic-evidence baseline the same night:
  5/5 passed the old check, 2/5 correct, 32 s-2 min.
- Open: the model mostly copies fact lines (correct, little rewording); two answers omitted a field the question asked for (payment IDs,
  the action) -> per-question required fields; a scorecard over all 10 scenarios; the 4c-2 items in §5.
