# chainaim-analyst

Exact cross-file analysis of a folder of CSV/TSV files, for the test console's **03 Private chat + analysis** tab.
It reads every row of every file with [DuckDB](https://duckdb.org) (in memory), finds what does and does not add up,
and returns a small **evidence pack** that the console sends to the model through the gateway. The model reasons over
exact, masked results instead of raw rows.

**Compute only.** The analyst never calls a model, holds no keys, listens on `127.0.0.1` only, and reads only inside the
`allowedRoots` of `config/data-sources.json`. After loading a folder's files it switches DuckDB's file access off and
locks that setting, so nothing afterwards can read or write any file. See `docs/adr/0003-analyst-service-duckdb.md`.

## Run

```powershell
test-console\start-analyst.cmd          # installs DuckDB once, then serves http://127.0.0.1:8740
```

or by hand, from this folder: `npm ci` (or `npm install` the first time, which creates `package-lock.json`; commit
it), then `node src/main.ts [flags]`. Node ≥ 22.22. DuckDB ships prebuilt binaries for Windows, Linux and macOS.

## How a folder is analyzed

1. **Profile** (`POST /profile {folder}`): every CSV/TSV in the folder (not sub-folders), its columns and their types
   (date, number or text, from a sample), row counts and date ranges, plus a **proposed recipe**.
2. **Recipe** (`POST /recipe {folder, recipe}`), confirmed once by a person and saved in
   `<work-dir>/recipes/<folder-id>.json` (column names and settings only, no data):
   - per file: `kind` (production, billing, income, collections, deposits, ledger, tax, adjustments, other),
     `roles` (`date`, `amount` or `debit`+`credit`, `party`, `reference`, `category`), `measure` (`net`, `inflows`,
     `outflows`, `abs`), optional `dateFormat` (strptime syntax), `include`;
   - `flow`: the order money moves through the files, e.g. production → collections → deposits;
   - optional `settings` overriding the thresholds below for this folder.
3. **Analyze** (`POST /analyze {folder}`): for each file, totals per period, possible duplicates, unusually large
   amounts and empty periods; for each adjacent pair in the flow (plus first → last), a judgement per period, the
   onset of the latest run of "off" periods, and row matching. Findings are ranked by money impact. A manifest
   (file sizes, hashes, row counts, timings; no data) is written to `<work-dir>/runs/<folder-id>/`.
4. **Evidence** (`POST /evidence {runId, budget?}`): the text for the model, within `min(budget, --evidence-max-chars)`.
   It narrows instead of truncating (older periods, then example rows, then the smallest findings) and refuses when
   even the file list does not fit.
5. **Verify** (`POST /verify {runId, answer, evidence}`): numbers in the model's answer that are not in the evidence
   (a figure the model derived itself is listed as "not found", not as wrong).
6. **Status** (`POST /status {folder}`): have the files changed (size or modified time) since the last analysis?

### Judging a pair, per period

- **tie** — the later stage should equal the earlier one (collections vs deposits). gap = B − A.
- **ratio** — the later stage should keep a stable share of the earlier one (payments are a fraction of charges).
  The first period is warm-up; expected = A × the median B/A of the other periods; the band widens to 3 × the median
  absolute deviation of those ratios when they are noisy. A falling collection rate shows; a normal shortfall does not.
  If a problem spans more than half the periods, pin the ratio with `settings.expectedRatio` in the recipe.
- **off** = beyond the band AND over `--variance-amount`; **watch** = beyond half the band AND over that amount.

### Row matching

- **By reference** when both files have a `reference` role (claim, invoice, check number). Unmatched rows of the
  earlier file older than `--aging-days` at the later file's last date are the ones that count (e.g. claims never paid).
- **By amount and date** otherwise: one-to-one, then many-to-one (all unmatched rows of a day summing to one row, a
  daily batch deposit).
- Unmatched amounts are broken down by party and compared with each party's normal share (e.g. "42% of unpaid claims
  vs 19% of all charges: 2.2× its normal share") when parties repeat.
- Under 20% (reference) or 50% (amount) matched on both sides, the pair is not row-for-row comparable; matching is then
  reported as not informative and produces no findings.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--port` | 8740 | listens on 127.0.0.1 only |
| `--data-config` | `../../config/data-sources.json` | allowed data folders (shared with the console) |
| `--work-dir` | `<first allowedRoot>/_analyst` | recipes and manifests; refused as an analysis folder |
| `--period` | month | week, month or quarter |
| `--baseline-periods` | 3 | periods before a run shown as its baseline (tie pairs) |
| `--variance-pct` | 2 | band, % of the earlier stage (minimum for ratio pairs) |
| `--variance-amount` | 100 | gaps at or under this never count |
| `--pair-mode` | auto | auto (tie when the median \|ratio − 1\| ≤ 10%), tie, ratio |
| `--match` | auto | auto, one-to-one, many-to-one, none |
| `--date-window-days` | 3 | amount matching |
| `--amount-tolerance` | 0.01 | amount matching |
| `--aging-days` | 30 | unmatched rows older than this count |
| `--evidence-max-chars` | 16000 | ceiling for an evidence pack |
| `--evidence-rows-per-finding` | 3 | example rows per finding |
| `--max-findings` | 12 | |
| `--max-bytes` | 500000000 | largest file analyzed |
| `--max-files` | 20 | most data files in one folder |
| `--keep-findings` | off | also write findings.json (holds real amounts and names) next to each manifest |
| `--runs-in-memory` | 10 | analyses kept for evidence and verify calls |
| `--pack` | finance-generic | domain pack for recipes that name none (an unknown id stops the analyst, exit 2) |
| `--print-pack <id>` | — | print the effective pack (its `extends` chain and which pack each rule comes from) and exit |
| `--reconcile-pack` | finance/rcm/dental | pack for POST /reconcile when the request names none |
| `--config-root` | `../../config` | where pack configs live (e.g. `domain-packs/finance/rcm/dental/reconcile.json`) |
| `--reconcile-tolerance-cents` | from the pack config (0) | amount tolerance for bank-credit matching |
| `--patient-name-format` | last_first | order of a patient-list name without a comma (`first_last` swaps) |

**Domain packs** (Phase 3 of the decoupling plan, DESIGN/xrplh-24 §5.3, xrplh-25 §8). A pack owns a domain's file kinds and
the rules that propose a recipe (header and file-name patterns, party priority, flow order, measure per kind, fallback kind,
kinds kept out of the flow). Role names and measures are engine terms and stay in core. `src/core/ports.ts` defines
`DomainPack`; `src/core/registry.ts` resolves `extends` explicitly (at most 3 levels; a child field replaces the parent's
whole); `src/domain-packs/` holds the packs, registered only in `main.ts`. `finance-generic` is the analyst's behaviour before
packs, value for value. A recipe may set `"pack": "<id>"` (unknown -> 400); without it the `--pack` default applies and is
never written into the recipe, so saved recipes and every route answer stay as they were.

## Tests and test data

```powershell
npm test                                                  # 16 tests on generated data with planted problems
node scripts/make-fixtures.ts --out C:\PRIV-AI-DATA\demo\clinic-a   # synthetic production, collections, bank CSVs
```

**Routes golden master** (`test/golden-routes.test.ts`, run by `npm test`): `scripts/golden-routes.ts` generates seeded
synthetic folders, starts `src/main.ts` on a free port with a temporary data config, calls every route (refusals
included) and compares the answers with `test/golden/routes.golden.json`. Run IDs, folder IDs, the temporary root and
the values of `ranAt`, `lastRanAt`, `modified` and `ms` are normalized. Record it again only after an intended change:

```powershell
node scripts/golden-routes.ts --mode check            # exit 0 identical, 1 different (names the calls), 2 setup
node scripts/golden-routes.ts --mode record --force   # flags: --analyst --pm-seed --production-rows --months --fin-seed --fin-max-rows --timeout-ms --keep-dir
```

The generator plants a card-deposit leak from 2026-06, a payer that stops paying from 2026-07 and duplicated payment
rows (flags: `--production-rows --months --start --leak-start --leak-rate --payer-drop-start --duplicates --seed`).

**Measured** (cloud VM, 2 cores, 7 GB): 19,705 rows in 0.6 s; 243,353 rows (14 MB) in 6 s; 2,433,334 rows (132 MB)
in 39 s at 1.3 GB peak memory. Evidence packs stay at about 8,000 characters whatever the row count.

## Limits (known)

- CSV/TSV only (PDF text is handled by the console's raw "Chat with files" path).
- Day-first dates are tried after US dates; set `dateFormat` in the recipe for day-first files.
- Thousands separators must be commas (`1,240.50`); European `1.240,50` is not parsed yet.
- One folder level; sub-folders are not read.
- The proposal is made by rules on column names and types; an LLM-assisted proposal (via the gateway) is not built.

## Questions across files (no recipe needed)

- **Relations** (`POST /relations {folder}`): every file becomes a typed table named after the file (number columns
  DOUBLE, date columns DATE). Columns of DIFFERENT files are related when their distinct values (upper, trimmed)
  overlap: `overlap` = shared values / distinct values of the smaller side (>= `--relation-min-overlap`, and at least
  `--relation-min-shared` values). `key` when one side is unique per row or both have many values, else `category`.
  The header names only break ties (Claim # = Claim No, Patient ID = pt_id); money and date columns are never related.
  The answer includes `schema`: the text a model gets, with headers, types and relations and no data values.
- **Query** (`POST /sql {folder, sql}`): one SELECT (or WITH ... SELECT), checked (no comments, one statement, no
  file/setting/extension functions), run after file access is locked, at most `--sql-max-rows` rows, stopped after
  `--sql-timeout-ms`. 400 with the reason when refused.
- **The whole question** (`packages/crossask`, moved there in Phase 2; used by the console's POST /crossask and by `scripts/ask.ts`):
  relations -> the model writes the query from the headers -> this service runs it -> optionally the model words the
  answer from the result rows (through the gateway, which masks and applies its zone rules) -> numbers checked.

```powershell
node scripts\ask.ts --folder C:\PRIV-AI-DATA\pm\clinic-a --relations
node scripts\ask.ts --folder C:\PRIV-AI-DATA\pm\clinic-a --question "Paid amount per payer for billed claims?" [--model local/qwen2.5-3b] [--phrase none] [--sql "SELECT ..."]
```


## Deposit reconciliation (finance/rcm/dental, Phase 4a)

`POST /reconcile {"folder": "<abs>", "pack"?: "finance/rcm/dental"}` detects each file's layout with the source adapters
(`src/sources/`: `bank/bofa`, `prms/curve-hero/{deposit-detail, ledger, patient-list}`), loads every row, locks file access
and runs `src/engines/deposit-match.ts`:

1. ledger <-> deposit detail: exact by payment ID, amounts with the crosswalk's sign rule (Account Credit rows are internal);
2. deposit detail -> bank: payments summed per method group and key (date; payer + date for insurance EFT) and matched to one
   bank credit of that group, equal amount, within the group's lag window. EFT credits are tied to a payer only through
   `config/domain-packs/finance/rcm/payer-aliases.csv`; each match reports that row's `basis` and `owner_confirmed`.

Reported, never guessed: unmapped payment methods (e.g. Care Credit in the owner's sample), unmatched Curve sums and bank
credits, ACH credits without an alias, credits outside every group. Real patient names are not loaded (pseudonyms only).
The BofA adapter checks its own file: summary adds up, detail totals equal the summary, running balance continuous.
Then `src/engines/deposit-diagnose.ts` (Phase 4b-1) gives every unmatched item a cause, amount, date and payment IDs:
HFD_LAG (watch), UNDEPOSITED_CHECK, POSTED_TWICE, CASH_SHORT, CARD_BATCH_SHORT, DEPOSIT_SHORT/OVER (batch groups only:
`partialDeposits` in the pack config), EFT_MISSING, DEPOSIT_MISSING, BANK_UNPOSTED, REF_MISMATCH, ID_NOT_IN_LEDGER,
ID_NOT_IN_DEPOSIT, LEDGER_AMOUNT_MISMATCH, UNMAPPED_METHOD. Method names and the late-funding window are in the config's
`diagnose` section. `scripts/reconcile-check.ts` compares matches AND diagnosed exceptions with a scenario's answer key.
Not covered yet: X12 835 remittances and the Global Payments settlement report (no samples in the repo).

```powershell
node scripts/reconcile-check.ts --folder C:\...\sample-data\prms\dent-prms-c-sample\SET-2\POS   # PASS = answer key reproduced
```

### Synthetic dental sets without Python (Phase 4b-2)

`scripts/make-dental-fixtures.ts` is a byte-identical port of `tools/dental-synth/gen_dental_set.py` (same flags; see that
README). `src/synth/` holds the Python-compatibility pieces it needs: `pyrandom.ts` (random.Random), `pydecimal.ts`
(decimal.Decimal slice, str(float)), `pycsv.ts` (csv.writer). `test/dental-synth-port.test.ts` checks them against Python's
own outputs (`test/golden/dental-port.golden.json`) and runs the L5 sweep: every scenario x seed generated into a temp
folder, reconciled, compared with its answer key. Widen it with `DENTAL_SWEEP_SEEDS=1-10 DENTAL_SWEEP_LEAK_SEEDS=1-3`.

### Explaining a reconciliation (Phase 4b-3)

`POST /reconcile` also stores the run and returns its `runId` (one store with the analyses, `--runs-in-memory`). Then:

- `POST /evidence {runId, budget?}`: the pack for a model. Every exception with its code, date, **signed amount** (bank
  minus Curve: `-45.00` = money missing from the bank, `+12.00` = extra money in the bank, unsigned = no bank difference; per
  cause code in the pack's `evidence.directions`), payment IDs and bank rows; totals per group; a match trail
  (`--reconcile-trail-rows`, default the pack's `evidence.trailRows`). No names and no raw bank descriptions (an ACH
  originator only as a known payer code). It narrows the trail, then the file checks, and **never drops an exception**: if the
  exceptions alone exceed the budget it refuses with 413.
- `POST /verify {runId, answer, evidence}`: for a reconcile run, the strict money check (`verifyMoney` in packages/crossask):
  `notFound` (a figure not in the evidence, or with more than 2 decimals), `signMismatch` (e.g. "over by $45.00" when the
  evidence says `-45.00`), `signUnclear` (a size held with both signs and no direction word). Analysis runs keep `verifyAnswer`.

The caller (the analyst never calls a model):

    node scripts/reconcile-explain.ts --folder <abs folder> [--model chainaim/auto] [--key-env NAME | --key-file PATH] [--json]

It runs reconcile -> evidence -> gateway (masking, zones) -> verify, prints the answer and every flagged figure, and exits 1
unless every figure verified.

### Patient-financing exports: CareCredit, Cherry, HFD (Phase 4a.2, rules UNVERIFIED)

Three adapters (`financing/carecredit`, `financing/cherry`, `financing/hfd`) recognise the exports by their **exact header
signature** (read from the owner's header-only GLOBAL-*.csv; CareCredit's trailing empty header cells are allowed). They
load into one canonical table: `row, date, funding_date, ref, patient_ref, gross_cents, fee_cents, bank_cents, kind`.
Names, phones, applicant, bank-account and routing digits are never loaded and cannot be mapped.

Every rule is in `config/domain-packs/finance/rcm/dental/financing.json`, item by item as `{ value, verified, basis }`:
accepted date formats (a value that parses to different dates under two formats is **ambiguous** and fails, never guessed),
year range, amount format (currency symbols, parentheses / trailing minus), which column is gross / fee / bank, Type -> kind
(`sale` | `refund`; the CareCredit and HFD maps start **empty**, so every row fails "every Type is mapped" until the owner
names the values), sign per kind, and arithmetic identities (Cherry Net Sale = Gross Sales - Refunds - Fees; HFD Treatment
Amount - Discount = Amount; an empty term fails the row). While any item is `verified: false`, every loaded file fails
"rules verified against real-format rows" with the UNVERIFIED item list, so reports always show it.

The pack reaches the adapters through `sourceConfigs` (pack field: key -> JSON under the config root; read in
`reconcileFolder`, handed over as `SourceOptions.configs`); core never interprets it. Reconciling financing fundings to bank
credits is not built yet (follow-up once the bank-amount rules are verified).
