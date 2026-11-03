# xrplh-25 — Decoupling Phase 1 (packages/actus), Phase 1 close, corrections to xrplh-24, Phase 2 plan

Session: 2026-11-01 13:45 to 14:55 (UTC-05:00). Repository: CreditSeal (branch main). Continues xrplh-24.
Status legend: **BUILT** = files exist and were tested (where and by whom stated). **DESIGN** = agreed, nothing built.
**VERIFIED** = read from a file. **ASSUMED** = inference, to be confirmed.

## 1. Summary
- Phase 1 (packages/actus) BUILT and committed: 6767de1, 52e4121 (tag `phase-1-done`). Pre-move tag `phase-1-pre` = d03a68a.
- Phase 1 close BUILT and verified on the PC: analyst routes golden master (46 calls, analyst 59/59 twice), record updates, every suite baselined.
- Found: the ACTUS-dates item (§5). Next after Phase 1 close, by owner decision.
- Phase 2 (packages/crossask + scripts/check-deps.ts) planned (§7), not approved yet.

## 2. Environment (VERIFIED)
- Owner PC: Windows, Node v24.22.0. Claude's device shell: Linux VM, Node v22.23.4; npm registry blocked there (403).
- services/analyst/node_modules has only the Windows DuckDB build: the analyst server and its full suite run on the PC only.
- services/paywall and packages/route-engine had no node_modules on the PC. After `npm ci` (owner, 14:43-14:46):
  paywall 221/221 (ARCH-011 passes: the earlier failure WAS the missing packages), route-engine typecheck + 107/107 + build.
  Later item: npm audit 17 findings (paywall), 6 (route-engine); esbuild install script not covered by allowScripts.

## 3. Phase 1 — BUILT
| Path | What |
|---|---|
| packages/actus/src/index.ts | old services/analyst/src/actus.ts byte for byte, sha256 d91e044a8021cba2a97e612897599cbb6ac9607cc41352fe2fd9bf6c7b8323d9 |
| packages/actus/{package.json, README.md} | `@chainaim/actus`, no runtime dependencies, same layout as underwrite/xls66 |
| packages/actus/scripts/golden.ts | `--mode record|check --module --cases --golden --skip --force`; refuses an export without a case |
| packages/actus/test/golden/{cases.json, actus.golden.json}, test/golden.test.ts | 46 synthetic cases + 3 constants, recorded from the old file before the move |

Repointed (7): packages/underwrite/{src/loan.ts, src/underwrite.ts, test/underwrite.test.ts}; services/lending/{src/stages.ts,
scripts/cockpit.ts}; services/analyst/{scripts/contract-cashflows.ts, test/actus.test.ts}. services/lending/tsconfig.json
include and package.json `test` now cover packages/actus. Shim removed after all suites passed.

Tests: Linux workspace — golden identical for old path, shim and package; a mutated copy fails (exit 1, names the case);
analyst actus.test.ts 10/10; lending 77/77; tsc clean. PC (owner) — packages/actus 1/1, analyst 58/58, lending 77/77,
typecheck clean, gateway 330/330, after the move and again after removing the shim.

## 4. Corrections to xrplh-24 (VERIFIED by reading the code)
- §6 / §7: `services/analyst/scripts/actus-schedule.ts` does NOT import actus.ts (imports node:fs, node:util only; builds
  its own contract — BUILD_LOG.md:457 backlog). Folding it onto packages/actus would change behaviour: not done.
- §6: crossask.ts has 5 importers, not 1: test-console/console/server.ts:61, scripts/probe-openrouter-chat.ts:22
  (ANSWER_SYSTEM), services/analyst/{scripts/ask.ts:30, scripts/contract-cashflows.ts:36, test/relations.test.ts:17}.
- crossask.ts imports `verifyAnswer` from services/analyst/src/report.ts (pure; also used by main.ts:67 /verify and
  test/analyst.test.ts:18). Moving crossask to packages/ requires moving verifyAnswer with it.
- Full scan of relative imports crossing units (static, export-from, import(), require; both quote styles), 2026-11-01:

| From -> to | Imports | Target |
|---|---|---|
| services/paywall -> services/web | 9 | Phase 5 |
| services/web -> services/paywall | 1 (cycle) | Phase 5 |
| services/ledger-watch -> services/web | 1 (test) | Phase 5 |
| test-console -> services/web | 1 | Phase 5 |
| services/paywall -> services/gateway | 4 | Phase 6 |
| apps/admin-console -> services/ledger-watch | 12 (tests) | owner decision (declared integration tests vs contract package) |
| test-console -> services/analyst | 1 | Phase 2 |
| scripts (root) -> services/analyst | 1 | Phase 2 |
| scripts (root) <-> services/gateway | 9 / 20 | not a violation: the root package is the gateway (chainaim-router); declared one unit |
| packages/underwrite -> packages/actus, packages/xls66; services/* -> packages/* | — | allowed direction |

- Baseline command list (now in PROJECT_CONTEXT.md "Run and test") adds `npm --prefix packages/actus test`,
  `npm --prefix services/lending test` and `npm --prefix services/lending run typecheck`.

## 5. Phase 1b — ACTUS dates — PARKED by owner decision (2026-11-01 14:57); Phase 2 went first
packages/actus computes ACTUS inputs with plain JavaScript date arithmetic (`addMonths`; 2026-01-31 + 1 = 2026-03-03,
2024-02-29 + 12 = 2025-03-01): maturityDate from termMonths (index.ts:20), ANN cycleAnchorDateOfInterestPayment /
cycleAnchorDateOfPrincipalRedemption = start + 1 month (:48), the Mentor request text (:60), the derived-maturity check in
termsInDocument (:176). Cash flows themselves come from the ACTUS engine (runDirect -> /eventsBatch).
Owner rule: dates and cash-flow logic follow the ACTUS spec and engine; the AI never invents them.
Plan: (1) AI reads the official ACTUS documentation (documentation.actusfrf.org, cited in xrplh-17:42) for
endOfMonthConvention, maturityDate, cycleAnchorDateOfInterestPayment, cycleAnchorDateOfPrincipalRedemption,
cycleOfPrincipalRedemption, businessDayConvention, and quotes it; no rule from memory; if unreachable, stop and ask.
(2) AI proposes the change, preferring ACTUS terms the engine derives dates from. (3) Owner runs start-on-29/30/31 cases on
the ACTUS server; its output is the reference. (4) Golden re-recorded with --force as an intended change, diff shown.

VERIFIED from the official term pages (documentation.actusfrf.org/docs/contract-terms/<term>, read 2026-11-01):
- endOfMonthConvention (EOMC): Enum, default SD. Anchor at a month end with a monthly/quarterly cycle: EOM keeps the
  last day of each month (Apr 30 -> May 31, Jun 30 ...); SD keeps the same day number, except in February.
- cycleOfPrincipalRedemption (PRCL): `[ISO8601 Duration]L[s={0,1}]` (our P1ML0 fits); the interval is adjusted by EOMC and BDC.
- cycleAnchorDateOfPrincipalRedemption (PRANX) / cycleAnchorDateOfInterestPayment (IPANX): the schedule is calculated
  from this date; the first principal / interest event takes place on it.
- maturityDate (MD): contractual end, normally the last cash flows; no default; for ANN the scheduled end can instead be
  deduced from the periodic payment amount (PRNXT).
Reading: after the anchor the engine builds the schedule; the anchors and MD are ours (JS addMonths), so a 2026-01-31
start gets anchor 2026-03-03. We never send EOMC, so the engine uses SD silently.
OPEN (not in the term pages): (a) does the engine derive IPANX/PRANX (and MD for ANN) when omitted? (b) SD for an anchor on
the 31st followed by February. Next: the official ANN contract-type page and the reference engine's schedule code; then
the owner's ACTUS runs (starts 01-31, 01-30, 02-29, a mid-month control; anchors sent/omitted; EOMC SD/EOM).
Exposure while parked: only loans starting on the 29th-31st (and leap-day cases); current lending demo data starts 2026-11-02.

## 6. Phase 1 close — BUILT and verified on the PC
- services/analyst/scripts/golden-routes.ts: black box over HTTP. Generates seeded folders (make-fixtures seed 42,
  make-finance-fixtures smb seed 7), temporary data config, starts src/main.ts on a free port, 39 calls: healthz, wrong
  Host, GET on a POST route, non-JSON, outside roots, relative folder, unknown route; per folder: status before/after,
  analyze without recipe, profile, recipe (the proposal), analyze, evidence (default, 4000, 50), verify, verify with
  non-strings, relations, COUNT(*) per table, a refused DELETE; unknown runId for verify and evidence.
  Normalizes runId/lastRunId, folderId, the port, temp roots (native realpath), and ranAt/lastRanAt/modified/ms/confirmedAt.
  Calls go through node:http (fetch drops a caller-set Host header, so the Host refusal would not be tested).
  Flags: --mode --golden --analyst --pm-seed --production-rows --months --fin-seed --fin-max-rows --timeout-ms --keep-dir --force.
- services/analyst/test/golden-routes.test.ts runs the check in `npm test` (analyst 58 -> 59 tests).
- Verified in the Linux workspace against a stand-in analyst (random ids, times, paths): record + 2 checks identical;
  a one-cent change caught, naming the 6 affected calls.
- First real runs (PC) found three harness gaps, fixed: confirmedAt not normalized; refused.wrong-host got 200 via fetch;
  the port in the 403 message. Then: recorded 46 calls, check identical twice, analyst npm test 59/59 twice (~12.8 s golden).
- Windows is the reference platform for routes.golden.json (DuckDB number formatting across platforms not checked).

## 7. Phase 2 — BUILT and verified on the PC (approved 14:58; 96cf091 + shim removal, tag phase-2-done)
packages/crossask (crossask.ts with one import line changed to its own verify.ts; verifyAnswer moved byte for byte),
golden master for its pure exports, generic tools/golden/golden.ts (actus's runner promoted: second user),
scripts/check-deps.ts + config/deps/rules.json + scripts/test/check-deps.test.ts in root `npm test`: fails on
package -> service/app, service -> service, cycles, unresolved relative imports, and stale allowlist entries (ratchet);
allowlist = the §4 table with reasons and target phases. Repoint the 5 crossask importers and verifyAnswer's 2 users.
Built: packages/crossask/src/index.ts differs from the old crossask.ts only at line 17 (import ./verify.ts); verify.ts
holds verifyAnswer byte for byte. Golden masters recorded from the old files before the move (17 crossask cases + 2
prompts; 7 verifyAnswer cases); identical through the package and through the shims. tools/golden/golden.ts reproduces
the actus golden (46 cases). check-deps: clean on the repo (6 allowlisted couplings: 9/1/1/1/4/12 imports, as in §4);
on the pre-Phase-2 commit it fails on exactly the 2 crossask couplings, on phase-1-pre also on the 5 actus ones.
Rules file adds "ignoreFiles" (check-deps' own test holds import text as data). Workspace: root npm test 340/340
(330 gateway + 10 check-deps), crossask 2/2, actus 1/1, lending 77/77 + tsc, analyst actus.test 10/10.
Shims services/analyst/src/crossask.ts and the report.ts re-export were removed after the PC run. PC (owner): with shims
actus 1/1, crossask 2/2, analyst 59/59 (routes golden identical), lending 77/77 + tsc, root 340/340; after removal analyst
59/59, crossask 2/2, root check-deps OK (64 cross-unit imports) + 340/340.

## 8. Next steps
Done: paywall and route-engine baselined; routes golden master recorded and stable. Remaining: owner commits Phase 1
close and tags `phase-1-closed` (done: c34a3ff). Phase 2 done (§7). Next: Phase 3 (analyst seams); Phase 1b parked (§5).

## 8. Phase 3 — analyst seams (approved 18:07) — BUILT and verified on the PC (tag phase-3-done)
Read first (VERIFIED): the finance-specific parts of the analyst were all module constants in profile.ts (KINDS, NAME_HINTS,
KIND_HINTS, FLOW_ORDER, DEFAULT_MEASURE, party priority, the "adjustments" exclusion, the "other" fallback). analyze.ts and
report.ts only carry `kind` through; analyze.ts reads role names and measures by name, so those are ENGINE terms and stay in
core. Refinement of the approved design: the pack owns kinds + proposal rules, not roles/measures; profile.ts takes the pack
as a parameter (core must not import a plugin), so test/analyst.test.ts passes it (9th file).
Built: src/core/ports.ts (DomainPack, ResolvedPack; SourceAdapter/Engine deferred to Phase 4a by the rule of two),
src/core/registry.ts (PackRegistry: register, resolve with explicit extends, max depth 3, cycle/unknown/duplicate/missing-field
refusals, provenance `from`; describe for --print-pack), src/domain-packs/finance/pack.ts (finance-generic, values copied
programmatically and checked identical to the old constants), src/domain-packs/index.ts (built-in list, default pack),
profile.ts (pack parameter; Kind = string; KINDS export removed — no other user), config.ts (--pack, --print-pack),
main.ts (composition root: registry, default pack check at start-up exit 2, packFor -> 400 on an unknown recipe pack;
an explicit saved pack is carried into the proposal; the default is never stamped in), test/packs.test.ts (6 tests).
Workspace: packs.test 6/6 with a DuckDB stand-in loaded by an import hook in scratch (these tests never query a database);
check-deps OK. Not runnable here: the analyst suite and routes golden master (Windows DuckDB) — the proof of no change.
PC (owner, 18:13): analyst 65/65 (59 + 6 pack tests; routes golden master identical: proposals, recipes, analyses and
evidence unchanged through the pack), root check-deps OK (64 cross-unit imports) + 340/340.
Next: Phase 4a (dental sources + rcm/dental packs + config); SourceAdapter/Engine ports arrive with it.

## 9. Phase 4a — dental build (approved 18:19) — BUILT and verified on the PC (tag phase-4a-done)
Owner decisions: proceed with BofA + Curve Hero; 835 and Global Payments settlement report deferred until samples exist
(VERIFIED: the repo has no Global Payments file; only bank lines GLOBAL DEP x65 / GLOBAL STL x4 in the BofA sample, the owner's
note that HFD runs through Global Payments, and the crosswalk's "Ext. ID needs the settlement report"). Defaults taken: keep
config/pms/* as reference; new config/domain-packs/*; alias rows labelled by basis.
VERIFIED from the samples: BofA CSV = summary block + header on line 7; ACH descriptions carry originator/DES/ID/INDN/CO ID/TRN;
Curve deposit detail has no EFT trace (Ref. ID empty for Direct Deposit: 0/94 real, 0/57 SET-1) -> EFT matched by payer+sum+lag;
real sample has a "Care Credit" method the generator does not map (reported as unmapped, not guessed).
Built: core/ports.ts (SourceAdapter, LoadedSource, SourceCheck; DomainPack.reconcile optional), core/registry.ts (SourceRegistry;
optional pack fields with provenance), sources/{lines.ts, index.ts, bank/bofa.ts, pms/curve-hero/{deposit-detail,ledger,
patient-list}.ts} (canonical tables, cents as BIGINT, real patient names not loaded), engines/deposit-match.ts, reconcile.ts,
domain-packs/finance/rcm/{pack.ts, dental/pack.ts}, config/domain-packs/finance/rcm/{payer-aliases.csv, dental/reconcile.json},
main.ts (POST /reconcile), config.ts (--reconcile-pack --config-root --reconcile-tolerance-cents --patient-name-format),
scripts/reconcile-check.ts (answer-key comparison, exit 0/1/2), test/sources-smoke.test.ts (3, skip without SET-1), README.
Independent check (Python re-implementation of the same rules and config, Linux workspace): SET-1/POS 45/45 bank credits with
exact payment-ID sets, 0 missing/extra/exceptions; ledger<->deposit 159/159; bank summary/totals/running balance OK on SET-1
AND on the real BofA sample (300 rows). Real Curve samples: 152/154 IDs agree; 2 genuine data exceptions the engine will
report: ID 225388 (ledger "Insurance Check - 22311492", -489.00, not in the deposit detail) and ID 227368 (deposit 227.00 vs
ledger -117.00). Workspace (DuckDB stand-in): packs.test 6/6, --print-pack finance/rcm/dental chain + provenance, check-deps OK.
First PC run (19:21): matching correct (45/45, ledger 159/159, 0 exceptions, routes golden identical) but the ledger's own check
failed: 93 SET-1 rows (26 in the real sample) are "Adjustment #<id>, <type>" — the parser expected "Adjustment , <type>" (an
earlier summary had stripped the ID). Fixed in sources/pms/curve-hero/ledger.ts (ID optional, kept as entry_id); 0 unrecognised
in both files. PC (19:22): analyst 68/68 (routes golden identical; smoke 3/3: layouts recognised, every file check ok,
reconcile-check PASS 45/45, ledger 159/159).

Owner added at 19:16 (data/pms/dental-curve-sample/, git-ignored), VERIFIED by reading: GLOBAL-CareCredit.csv, GLOBAL-Cherry.csv,
GLOBAL-HFD.csv = HEADER ONLY (0 data rows); pms-2025-CC-sample.csv.xlsx = the BofA statement layout for 2025 saved as Excel
(1 sheet, ~20 rows, Excel serial dates, debit-card purchases; its "Beginning balance" row carries 20.00 = the gap between its two
running-balance columns). Phase 4a.2 (not started): financing-vendor adapters (CareCredit, Cherry, HFD) once each file has a few
rows in the vendor's real format, ideally with one funding traceable to a BofA credit; analyst reads CSV/TSV/JSON only, so the
2025 statement needs a CSV export (or an xlsx loader, owner's choice).

## 10. Phase 4b-1 — NEG scenarios + diagnosis + L2/L3/L4 (approved 19:25) — BUILT and verified on the PC (tag phase-4b1-done)
4b split (owner approved 4b-1 first): 4b-1 NEG generator + diagnosis engine + L2/L3/L4; 4b-2 TS generator port + L5 in npm
test + shape.py; 4b-3 reconcile evidence pack + LLM explanation + L6/L7.
Generator: 8 leaks (xrplh-24 §8 list), --scenario neg-all|neg-<leak>, --leak-seed, --hfd-lag-extra-days, --short-max;
leaks planted after the base with their own random stream. VERIFIED: the modified generator's POS output is byte-identical to
the unmodified generator's. The owner's SET-1/POS copy differs from both only in line endings (LF on disk, CRLF generated);
content identical in all 5 files — kept as an L2 case. verify_set.py extended for NEG (affected_payment_ids,
unmatched_bank_credits); all 10 scenarios ALL CHECKS PASS.
Diagnosis rules prototyped in Python (scratch, not committed) against the 10 answer keys (10/10), then a sweep of 40 sets
(seeds 1-10 x leak seeds 1-3, POS + neg-all): 37/40 — the 3 failures were a real rule flaw (an EFT_MISSING and a
BANK_UNPOSTED of the same payer within 3 days were paired as one DEPOSIT_OVER). Fix: per-group `partialDeposits` (card, ATM
true; EFT false: one ACH per remittance, exact or missing). Then 40/40 + 10/10. Ported to engines/deposit-diagnose.ts.
Config: reconcile.json gains partialDeposits per group and a `diagnose` section (method names, late-funding window, watch codes).
Tests: test/sources-l2.test.ts (8, inline made-up files incl. CRLF vs LF, failing checks), test/dental-scenarios.test.ts (one
per generated SET-1/<scenario> with an answer key). Pending on the PC: generate the NEG sets, analyst suite.

PC run 2026-11-01: 9 NEG sets ALL CHECKS PASS; analyst 86/86; root 340/340. Two DuckDB parse fixes in deposit-diagnose.ts
(implicit aliases `min(method) method`, `min(ref) ref` rejected by the parser -> every alias written `AS "<name>"`).

## 11. Phase 4b-2 — TypeScript port of the dental generator, byte-identical (approved 20:02) — BUILT and verified on the PC (tag phase-4b2-done)

Goal: generate the dental sets with no Python (tests, CI, PC), byte-for-byte what gen_dental_set.py writes.

Sources read verbatim (CPython v3.10.12; Rule 4):
- Modules/_randommodule.c: random_seed (int -> abs value, 32-bit words from the right, little-endian, init_by_array),
  init_genrand, init_by_array (19650218, 1664525, 1566083941, mt[0]=0x80000000), genrand_uint32 (MT19937 + tempering),
  random() = (a*67108864.0+b)*(1.0/9007199254740992.0) with a=genrand>>5, b=genrand>>6, getrandbits (k<=32: >>(32-k)).
- Lib/random.py: _randbelow_with_getrandbits (k = n.bit_length(), redraw while r >= n), randrange, randint = randrange(a, b+1),
  choice, shuffle (i from len-1 down to 1, j = _randbelow(i+1)), choices (accumulate, total+0.0, bisect(cum, random()*total, 0, n-1)),
  uniform = a + (b-a)*random().
- Lib/_pydecimal.py: DefaultContext(prec=28, rounding=ROUND_HALF_EVEN); __str__; __neg__ (zero -> +0 unless FLOOR); __add__
  (zero + zero sign = min(signs)); quantize; __format__.
- Objects/floatobject.c float_repr -> PyOS_double_to_string(x, 'r', 0, Py_DTSF_ADD_DOT_0); Python/pystrtod.c format_float_short
  ('r': shortest digits; exponent when decpt <= -4 or decpt > 16, "%+.02d"; ".0" on integers).
- Modules/_csv.c join_append_data / csv_writerow: quote a field holding the delimiter, quotechar (doubled) or any lineterminator
  character; None -> empty; a lone empty field -> "".
ECMA-262 was not cited: JS shortest digits (toExponential()) are instead proven equal to Python's repr over 60,015 floats.

Correction to the handoff: the generator's `.quantize(Decimal("1"))` (line 304/308) passes no rounding, so whole units round
HALF_EVEN (context default), not HALF_UP; cents (D()) are HALF_UP.

Files: services/analyst/src/synth/{pyrandom.ts, pydecimal.ts (Dec, pyFloatStr), pycsv.ts, dental-gen.ts};
scripts/make-dental-fixtures.ts (same 30 flags/defaults; exit 1 = the script's SystemExit message, 2 = bad flags);
test/dental-synth-port.test.ts + test/golden/dental-port.golden.json; tools/dental-synth/{compare_port.py, shape.py}.
Dec throws wherever Python would round to 28 digits, so a silent difference is impossible.

Proof in the workspace (Python 3.10.12 vs Node 22): random streams 75,600 values (189 seeds); str(float) 60,015 floats;
Decimal 20,000 generator-shaped chains; csv 3,000 rows: 0 differences. compare_port.py: seeds 1-10 x leak seeds 1-3 x 10
scenarios x 8 flag variants = 2,240 cases, every CSV byte-identical and truth.json equal as JSON (flags.out removed:
it records the output folder; owner decision 20:07). Same check on the owner's PC sets (NEG-ALL, NEG-HFD-LAG): CSVs identical.
In npm test (no Python): golden vectors + SHA-256 of three reference sets + L5 sweep (scenarios x DENTAL_SWEEP_SEEDS "1-3" x
DENTAL_SWEEP_LEAK_SEEDS "1" -> reconcile-check reproduces each answer key; 30 tests by default; needs DuckDB, so PC only).

shape.py on the owner's samples vs SET-1/NEG-ALL: BankDep-Det, Per-Sum and BANK-ST same layout; SPR-patientlist-sample.csv
has a header and 8,896 blank rows, so there is no real patient-list layout to compare yet (needed before L9).

## 12. Phase 4b-3 — reconcile evidence pack + LLM explanation + L6 /verify + L7 privacy (approved 21:02) — BUILT and verified on the PC (tag phase-4b3-done)

Read first (facts): callers reach the gateway through packages/crossask gatewayChat (POST /v1/chat/completions, Bearer key from
--key-file or --key-env NAME); the analyst never calls a model. verifyAnswer normalises to cents but ignores the sign (evidence
figures added as +v and -v), rounds away a third decimal and never checks small whole amounts ("$45").
Exception.cents is a magnitude; the direction lived only in the cause code. BANK_UNPOSTED.detail is the raw bank description.

Owner decisions (20:59, 21:02): one run store tagged analysis | reconcile, not persisted; signed evidence (bank minus Curve) +
direction-aware strict money mode for reconcile runs (analysis unchanged; moving it is a later approved step with a golden
re-record); A direction table in config (negative: UNDEPOSITED_CHECK, POSTED_TWICE, CASH_SHORT, CARD_BATCH_SHORT,
DEPOSIT_SHORT, EFT_MISSING, DEPOSIT_MISSING, HFD_LAG; positive: DEPOSIT_OVER, BANK_UNPOSTED; neutral: REF_MISMATCH,
ID_NOT_IN_LEDGER, ID_NOT_IN_DEPOSIT, LEDGER_AMOUNT_MISMATCH, UNMAPPED_METHOD); B no raw bank descriptions (an originator only as a
known payer code); C exceptions never dropped, refuse instead; D orchestration in packages/crossask, thin CLI.

Built: packages/crossask/src/verify.ts verifyMoney; index.ts explainReconcile (+ analystClient takes any route);
test/verify-money.test.ts; golden.test.ts skips the two new functions (own tests) and both golden files were re-recorded with
additions only (diffed: only the new names in functions/skipped/constants changed; every existing case output identical).
services/analyst: src/reconcile-evidence.ts; main.ts (run store, /reconcile runId, /evidence and /verify by kind);
config.ts --reconcile-trail-rows; engines/deposit-match.ts EvidenceConfig + validation; config reconcile.json "evidence";
scripts/reconcile-explain.ts (exit 0 verified, 1 flagged or failed, 2 bad flags); src/synth/dental-gen.ts exports FIRST/LAST
(L7); test/reconcile-evidence.test.ts. golden-routes.ts never calls /reconcile, so the runId field leaves that master unchanged.

## 13. Phase 4a.2 — financing adapters, header-only (approved 2026-11-01 23:48) — BUILT and verified on the PC (tag phase-4a2-done)

**Approved scope:** CareCredit, Cherry and HFD adapters detected by exact header signature; every unknown rule in
`config/domain-packs/finance/rcm/dental/financing.json`, each item `{ value, verified: false, basis }` until real-format rows
arrive. Decisions: (a) bank amount = CareCredit "Amount", Cherry "Net Sale", HFD "Amount" (assumptions); (b) unknown Type and
ambiguous or unparseable dates fail the file's check, never guessed; (c) matching financing fundings to bank credits is out of
scope.

**Built:** `src/sources/financing/{spec,layouts,load,carecredit,cherry,hfd}.ts` (`spec` and `layouts` have no DuckDB import);
`src/core/source-configs.ts` + optional pack field `sourceConfigs` + `SourceOptions.configs` (read once in `reconcileFolder`;
`main.ts` and `reconcile-check.ts` unchanged); dental pack names financing.json; `sources/index.ts` registers 7 adapters;
`test/sources-financing.test.ts` (8 tests, every data row synthetic). Files are read by position, because HFD repeats "Bank
Account Last 4".

**Choices beyond the approved list (reported 2026-11-02):** HFD's Type column is treated like CareCredit's (empty map,
unmapped rows fail) rather than defaulted; HFD bank-account and routing digits are forbidden as well as names, phones and
applicant; every file fails "rules verified" while any item is unverified; a year-range check (2000-2100) catches a 2-digit
year read as year 0025; identity terms that are empty fail the row (`emptyAsZero: false`).

**UNVERIFIED (all three providers, every item):** dateFormats (`%m/%d/%Y`, `%Y-%m-%d`), dateYearRange, amountFormat,
columns (gross / fee / bank mapping), kind (CareCredit and HFD Type maps empty; Cherry every row "sale"), expectSign
(sale positive, refund negative; Cherry none), identities. To verify: the owner's 2-3 anonymized rows per GLOBAL file
(Notepad; keep formats, Type values and amount relationships), then flip `verified` item by item.

**Findings:** (1) `pms-2025-CC-sample.csv` is detected by `bank/bofa` only, but its rows do not agree with its summary block
(detail credits, detail debits and running balance checks fail; summary itself adds up), and its "Beginning balance" row has
an Amount. Owner 2026-11-02: layouts are decided by headers and sample rows are illustrative, so the test pins detection and
a clean load only; `bofa.ts` unchanged. (2) `off` is a reserved word in DuckDB's parser (aliases are quoted). (3) The L2
"unrelated header" example was the CareCredit header; it now ends in `Status`. (4) DuckDB `list_distinct` drops NULLs
(proven on the PC by the ambiguous / unparseable date tests).

**PC run 2026-11-02:** analyst 149/149 (141 + 8 financing), routes golden identical; root 340/340, check-deps OK (360 files, 66 cross-unit imports, unchanged).
