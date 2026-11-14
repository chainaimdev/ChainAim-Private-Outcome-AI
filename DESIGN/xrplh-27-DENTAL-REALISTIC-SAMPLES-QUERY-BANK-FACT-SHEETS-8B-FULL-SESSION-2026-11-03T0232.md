# xrplh-27 — Dental reconciliation on realistic samples, one script, query bank, DuckDB fact sheets for a local 8B: full session

Session: 2026-11-02 23:32 to 2026-11-03 02:32 (UTC-05:00). Repository: CreditSeal (branch main). Continues xrplh-25 §13.
Phase records: DESIGN/xrplh-26 (§1-5 Phase 4c-1, §6 Phase 4c-1b). This file is the session narrative: what was asked, found, decided,
built and measured, in order. It is a structured record written at the end of the session, not a verbatim transcript.
Paths are relative to `<your-folder>/FINAGENTS/CreditSeal/CreditSeal/`.

Status legend: **BUILT** = files exist and were tested (where stated). **DESIGN** = agreed, nothing built.
**VERIFIED** = read from a file, a test or the owner's PC output. **ASSUMED** = inference, to be confirmed.

---

## 1. Goals (owner, in order of the session)

1. Why `git status` did not show files deleted under `data/` (23:32), and whether ignored data reaches others (23:33).
2. Read the new realistic samples, look at previous chats, refactor dental reconciliation and revenue leaks for POS and NEG scenarios;
   keep data git-ignored; show the plan before changing anything (23:42).
3. "Any invoice paid should be easily matched to the bank totals" (00:10).
4. The samples are only for generating good POS/NEG test cases for reconciliations and revenue leaks (00:29).
5. Short commands instead of full paths; then everything in one script, including starting containers and the analyst (00:49-00:56).
6. Many model queries around reconciliation and revenue leaks, not one (01:05).
7. "The whole point was to manage DuckDB to produce the right summarizations and data snippets useful to the 8B model, on time" (01:14).
8. Save this chat with a timestamp in DESIGN (02:32).

## 2. Timeline

| Time (UTC-5) | Event |
|---|---|
| 23:32 | `data/` is git-ignored (`.gitignore` line 6), 0 tracked files, 0 commits ever touched it: deletions there are invisible to git; others never get it (caveat: `git add -f`) |
| 23:42 | Owner adds 8 samples in `data/pms/dent-pms-c-sample/sample-pms-fin/`. Read all 8 + adapters + generator + xrplh-25 + previous chats. Every adapter header had changed; plan proposed (Phase 4c) |
| 23:46-23:51 | Config impact listed (5 of 20 files in `config/`). `SB MTOT DEP … FIRST LINE DENTAL` quoted from lines 10/85/196/226; owner had already re-saved the file as `INDN:FOOBAR`; flagged remaining identifiers (ES WEB_PAY name, ATM branch locations) |
| 23:59 | Owner: SB MTOT DEP = a bank deposit; replace old layouts; procedure report in scope, leaks "you suggest" |
| 00:10 | Owner: proceed; adds `pms-2025-CC-sample.csv`. Read: it is a 2025 BofA statement excerpt (Jan + Dec), not card-processor detail |
| 00:16-00:20 | Owner: the GLOBAL-* files are the Global Payments exports; money arrives as shown in the bank statement, the GLOBAL files are its detail |
| 00:16 | Stage 1 adapters + financing.json; tests 8/8 + 8/8 incl. the owner's 12 real financing rows |
| 00:26 | Owner: park the CC file; payers case-insensitive. CC file moved to `data/pms/dent-pms-c-sample/_parked/` (a folder may hold one bank statement) |
| 00:26 | First reconcile of the real samples: 227385 REF_MISMATCH and 225388 found; 0 bank matches because the card group expected `GLOBAL PAYMENTS` but the bank writes `GB PY` |
| 00:29 | Generator moved ahead of the trace. 4a layout migration: Python + TS port, `GB PY`, 4-column statement; compare_port 2,240/2,240 |
| 00:41-00:43 | Owner PC: 10 SET-2 sets ALL CHECKS PASS; analyst 152/152; root 340/340, check-deps OK (363 files) |
| 00:44-00:45 | 28 files committed; tag taxonomy read (`phase-*` lightweight, `vX.Y.Z` annotated, semver); suggested `phase-4c1-done` + `v2.0.0` (breaking: input layouts replaced) |
| 00:47 | Summary of tests (502 + 2,240 sweep) and of reconciliations/leaks; first sample queries |
| 00:49 | `node scripts/reconcile-check.ts` failed from the repo root (path relative to services/analyst) -> owner asked for a better solution |
| 00:49-00:54 | `npm run dental -- sets|gen|check|explain` (scripts/dental.ts); owner PC: sets 10/10 |
| 00:54-00:56 | Query bank (25 SQL + 6 model questions), `status`, `up` (containers + wait), temporary analyst on 8741 with a generated data config (the console's config only allowed the PRIVAI2 folder) |
| 01:00 | Owner PC: `up` starts ca-presidio, ca-openrouter-stub, ca-gateway; gateway healthy |
| 01:02 | First model answer (served `local/qwen2.5-3b`): figure check caught an invented -1,000.00 |
| 01:04-01:07 | Asking for `local/deepseek-r1-8b` still served qwen: the gateway (cpu profile) did not have it and silently fell back. Fix: explain refuses a substituted model; status lists the gateway's models |
| 01:09-01:10 | Owner ran `use-ollama.cmd` (GPU profile, default `local/deepseek-r1-8b`); status lists it |
| 01:12-01:19 | Baseline batch, 8B, generic evidence (4,742 chars): 5/5 passed the old check, 2/5 correct, 32 s to 2 min each |
| 01:14-01:20 | Owner: DuckDB must produce the summaries and snippets for the 8B. Design agreed: DuckDB decides every fact, the model only words it; owner: "continue here" |
| 01:21-01:23 | Owner: do we not need the analyst? Answer: the engine yes (in-process), the HTTP server no; owner: proceed |
| 01:45 | Fact sheets run 1: 3/5 verified; one wrong answer passed (codes and dates shuffled) -> codes/dates bound, category words per line, (F7) tags, totals cover categories, placeholders fail |
| 02:01-02:11 | Run 2: 0/5 (gateway `cooling_down`). Gateway ledger: one attempt 160,445 ms, `upstream_error` status 200 (no visible answer), then 30 s bench; also BANK_ACCOUNT/PHONE/licence masks on every sheet |
| 02:14-02:27 | Privacy investigation: wording without context words; `--scan` (per-entity text), `probe`; triggers found and fixed; 14/14 inputs clean |
| 02:30 | Run 3: 5/5 verified and correct, 8.8-29.5 s each |
| 02:32 | Records written (BUILD_LOG, xrplh-26 §6, this file) |

## 3. Owner decisions

- Replace old Curve layouts; no dual support. Samples define layouts and realism; the generator defines POS/NEG truth.
- `SB DES:MTOT DEP` is a bank deposit: listed as a known credit outside Curve, never paired, never BANK_UNPOSTED.
- Global Payments = the GLOBAL-CareCredit/Cherry/HFD exports; no card settlement report exists.
- Payers compare case-insensitively. `pms-2025-CC-sample.csv` parked.
- Procedure report in scope; the 5 new leaks are Claude's proposal (§9).
- One script for everything; many queries; DuckDB produces the facts, the local 8B words them.
- Tags follow the existing taxonomy; 4c-1 = `phase-4c1-done` + `v2.0.0` (breaking).

## 4. Facts VERIFIED this session

- Curve layouts: deposit detail `…,Payer,RP,Responsible Party,…` (12 cols); ledger `…,Patient,Patient-LM,Patient-FM,…`; patient list leads with
  `Patient` (PTn; PT1 twice, one per plan; PT36 carries PT38's name); procedure report has no key column, only `Full Name`.
- Financing rows: Cherry Net Sale = Gross - Refunds - Fees (3/3); HFD Amount = Treatment - Discount (6/6); HFD Discount = Treatment x Rate
  (6/6), rate by Grade A 4%, D 15%, E 22%; HFD Type Origination +, Cancellation -, Adjustment -; CareCredit date `MM/DD/YYYY h:mm AM ET`.
- Bank sample: 65 `GB PY DES:GLOBAL DEP`, 24 Counter Credit, 3 Cherry Funding, 2 HATCH HCFD, 4 SB MTOT DEP, 1 GLOBAL CBK debit; artefacts:
  every running balance $20.00 below previous + amount; summary column 1 is 100,000 below column 2.
- Real leaks in the samples: 227385 REF_MISMATCH (020587066 vs 40699078); 225388 ledger-only. False positives found: 227384 and 227605
  REF_MISMATCH when the ledger row is absent (to fix, §10).
- `reconcileFolder` refuses a folder with two files of one layout. The analyst server reads only `allowedRoots` of `config/data-sources.json`.
- Gateway (services/gateway): a pinned model name it does not know falls back to automatic choice silently; `--unhealthy-after 2`,
  `--cooldown-ms 30000` defaults; ollama mode `--attempt-timeout-ms 240000 --max-attempts 2`; an answer with no content is an upstream error.
- Gateway masking (owner PC `/v1/privacy/scan`): a 6-18 digit or dash/space-grouped number near `bank`, `account`, `routing`, `sort`, … is
  BANK_ACCOUNT; `F4` was US_DRIVER_LICENSE (0.65); `2024-09-13` next to BANK_UNPOSTED was BANK_ACCOUNT (0.45); `-164.00` was PHONE_NUMBER (0.40),
  `-$164.00` clean, `-164.00 USD` and `USD -164.00` masked.

## 5. BUILT

**Phase 4c-1** (commit by the owner, 28 files; xrplh-26 §4): adapters for the new layouts + `procedures.ts`; `knownCredits`; case-insensitive
payers; config (financing.json partly verified, reconcile.json `GB PY`, payer-aliases AETNA, config/pms reference CSVs); generator Python +
byte-identical TS port on the new layouts; `test/data-root.ts` (DENTAL_DATA_ROOT, SET-2).

**Phase 4c-1b** (12 files, uncommitted at 02:32; xrplh-26 §6):

| File | What |
|---|---|
| `services/analyst/scripts/dental.ts` (new) | `npm run dental -- sets|gen|check|query|explain|status|up|probe` |
| `config/domain-packs/finance/rcm/dental/queries.json` (new) | 25 SQL queries, 14 model questions with `facts` sections |
| `services/analyst/src/facts.ts` (new) | fact sheet render, fact-bound check, plain fallback; model-facing format F_4, 2024/09/13, -$164.00 |
| `services/analyst/test/facts.test.ts` (new) | 8 tests built from the owner's 8B answers |
| `services/analyst/src/reconcile.ts` | optional `inspect` hook (tables + report before the DB closes) |
| `services/analyst/scripts/reconcile-explain.ts` | refuses an answer from a model other than `--model` |
| `packages/crossask/src/index.ts` | `gatewayChat` optional `maxTokens` (omitted when unset) |
| `config/domain-packs/finance/rcm/dental/reconcile.json` | `actions` playbook per cause code |
| `package.json` | `"dental"` script |
| `tools/dental-synth/README.md`, `BUILD_LOG.md`, `DESIGN/xrplh-26…` | docs and records |

## 6. Test evidence

| Run | Result |
|---|---|
| Owner PC 00:41-00:43 | 10 SET-2 sets ALL CHECKS PASS; analyst 152/152 (0 skipped, routes golden identical); root 340/340; check-deps OK (363 files, 66 cross-unit) |
| Linux workspace | compare_port 2,240/2,240 identical; analyst 160/160 after 4c-1b; crossask 8/8 (golden unchanged); check-deps OK |
| Owner PC `npm run dental -- sets` | 10/10 PASS |
| Owner PC `--scan` | 4/14 clean -> 14/14 clean after the format fixes |

## 7. Model runs (owner PC, SET-2/NEG-ALL, 5 questions)

| Run | Input | Model | Old/new check | Actually correct | Time per question |
|---|---|---|---|---|---|
| 01:02 | generic evidence 4,742 chars | qwen2.5-3b | caught -1,000.00 | no | — |
| 01:05 | same, `--model deepseek-r1-8b` | qwen2.5-3b (silent fallback) | passed | no (+863.57 "loss") | — |
| 01:12-01:19 | generic evidence | deepseek-r1-8b | 5/5 passed | 2/5 | 32 s - 2 min 13 s |
| 01:45 | fact sheets v1 | deepseek-r1-8b | 3/5 verified | 2 right, 1 wrong passed, 2 caught | 4.4 - 153.6 s |
| 02:01 | fact sheets v2 | deepseek-r1-8b | 0/5 (no answer after 160 s, then 30 s bench) | facts shown | — |
| 02:30 | fact sheets v3, 14/14 unmasked | deepseek-r1-8b | **5/5 verified** | **5/5** | **8.8 - 29.5 s** |

What the 8B got wrong on generic evidence: called +863.57 (extra money) a loss, borrowed payment IDs from the match trail, ranked smallest
first, filed HFD_LAG under the wrong group, left MassHealth out of a per-payer answer, wrote a date where a bank row belonged.

## 8. Design: DuckDB decides, the model words (agreed 01:14-01:23)

Per question: the bank names fact sections -> DuckDB SQL over the reconciliation tables classifies (watch -> timing, negative -> loss,
positive -> extra, neutral -> posting), totals, ranks, attaches the configured action -> tagged sheet (~0.4-2.5K chars) -> model through the
gateway (masks, routes local) -> check: each amount, payment ID, cause code and date belongs to the cited fact; one category word on a line
speaks for every fact it cites; every fact mentioned (a cited total covers its category); no placeholder -> pass: the model's words; fail:
the computed facts. The engine never calls a model; the script is the caller; no analyst server on this path.

## 9. Proposed leaks for 4c-2 (DESIGN)

PROCEDURE_NOT_INVOICED (`--invoice-window-days 14`), FINANCING_UNFUNDED, FINANCING_CANCELLATION_UNPOSTED, CHARGEBACK_UNPOSTED (GLOBAL CBK),
FINANCING_DISCOUNT_OVER (rate vs contract per Grade; rates unverified until the owner confirms).

## 10. Open items

1. Commit 4c-1b and tag `phase-4c1b-done` + `v2.1.0` (commands given at 02:30).
2. The 8B mostly copies fact lines; per-question required fields (payment IDs, actions) and a rewording instruction with one example.
3. Scorecard: every model question over all 10 scenarios, per model (verified, correct, seconds).
4. 4c-2: invoice -> payment -> deposit -> bank trace; several bank credits against one day's total (Counter Credits); the 5 leaks;
   REF_MISMATCH only when the ledger row exists; generator content (Counter Credits, financing exports and fundings, procedure report).
5. Owner to confirm: what HATCH HCFD pays; contract discount rates per Grade; AETNA's real ACH originator.
6. `config/data-sources.json` (console analyst) allows only the PRIVAI2 books; the dental path does not need it.
