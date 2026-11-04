# dental-synth: synthetic Curve + BofA data sets for payment reconciliation

Generates and checks **synthetic** dental-practice data in the exact layouts of the Curve Hero
and Bank of America sample exports in `sample-data/prms/dent-prms-c-sample/sample-prms-fin/` (Phase 4c layouts: patient key `PTn` in
every Curve file, name columns filled with synthetic names, 4-column BofA statement, `GB PY DES:GLOBAL DEP` card credits). The sets are test fixtures
for the reconciliation engine (Curve postings vs. bank deposits vs. payer remits).
All names, IDs, amounts and bank descriptions are made up.

## Files

| File | Purpose |
|---|---|
| `gen_dental_set.py` | Writes one data set plus its answer key. Every knob is a flag; same seed = same files. |
| `verify_set.py` | Re-reads a set by column header and checks it reconciles against its answer key. Exit code 0 = pass. |

Related, committed reference (not generated):

| File | Purpose |
|---|---|
| `config/prms/curve-bofa-835-schema.csv` | Every column in the Curve and BofA samples (format, canonical field, join key, privacy), plus X12 835 fields (from the standard; not yet checked against a real 835) |
| `config/prms/header-crosswalk.csv` | One row per concept: which column in each file holds it and the rule that links them |

## Output (git-ignored: `data/` is in `.gitignore`)

```
sample-data/prms/dent-prms-c-sample/<SET>/<SCENARIO>/   (SET-2 = Phase 4c layouts; tests read DENTAL_DATA_ROOT, default sample-data/prms/dent-prms-c-sample)
  BankDep-Det-<TAG>.csv        Curve payments (bank deposit detail layout)
  Per-Sum-<TAG>.csv            Curve transaction ledger
  SPR-patientlist-<TAG>.csv    Curve patient list
  BANK-ST-<TAG>.csv            BofA statement with preamble totals
  _answer-key/expected-matches.csv   bank credit -> Curve payment IDs
  _answer-key/truth.json             totals per group, seed and every flag used
```

`<TAG>` = `<--set-name>-<SCENARIO>`, e.g. `SET1-POS`.

## Run (from the repo root, Python 3.9+)

```powershell
python tools\dental-synth\gen_dental_set.py --out sample-data\prms\dent-prms-c-sample\SET-2\POS
python tools\dental-synth\verify_set.py --dir sample-data\prms\dent-prms-c-sample\SET-2\POS --tag SET1-POS
```

Expected: the verifier prints `ALL CHECKS PASS` (SET-2/POS: 159 deposit IDs, 45 bank credits, 45 matches; files keep the tag SET1, set by --set-name).

`python tools\dental-synth\gen_dental_set.py --help` lists every flag.

## Scenarios

| Scenario | Status | Meaning |
|---|---|---|
| `pos` | built | Everything reconciles; the engine must report zero exceptions |
| `neg-all` | built | The POS base with all 8 leaks, each on its own day/payment |
| `neg-<leak>` | built | The POS base with one leak: `undeposited-check`, `eft-missing`, `card-batch-short`, `cash-short`, `ref-mismatch`, `posted-twice`, `bank-unposted`, `hfd-lag` |

NEG leaks are planted after the base set is built, with their own random stream (`--leak-seed`, default 1), so the base is
byte-for-byte the POS set. `truth.json` lists `expected_exceptions` (code, severity, group, date, cents, payment_ids, payer,
detail), `affected_payment_ids` (in no exact match) and `unmatched_bank_credits`; `expected-matches.csv` lists only the exact
matches left. Flags: `--hfd-lag-extra-days` (5), `--short-max` (50.00). `verify_set.py` checks a NEG set against those lists.

| Leak | Planted | The engine must report |
|---|---|---|
| UNDEPOSITED_CHECK | an Insurance Check posted, left out of the next ATM deposit | that check (ID, amount) |
| EFT_MISSING | a payer remittance posted, no bank credit | the payer-day sum and IDs |
| CARD_BATCH_SHORT | a GLOBAL DEP credit below the day's card sum (never equal to one payment) | the short amount |
| CASH_SHORT | an ATM deposit short of the day's cash (never equal to one payment) | the short amount |
| REF_MISMATCH | a check's deposit-detail Ref. ID differs from the ledger reference | that check |
| POSTED_TWICE | a card payment posted twice (same patient, amount, method, day); banked once | both IDs |
| BANK_UNPOSTED | an MH (COMM OF MASS) EFT credit with no Curve posting | the credit |
| HFD_LAG | an HFD funding --hfd-lag-extra-days after the card lag, as its own credit | watch (timing), not a loss |

## What the verifier checks

1. Each deposit-file payment ID exists in the ledger with the same amount (sign rule) and method.
2. Bank preamble foots: beginning + credits + debits = ending.
3. Every running balance = previous balance + amount; detail totals = preamble totals.
4. Each bank credit = sum of its Curve payments in the answer key (minus fee when daily-net).
5. Each banked Curve payment appears in exactly one bank credit.
6. Each insurance EFT trace appears in its bank description (`TRN*1*<trace>*`).

## Assumptions (all flags; not verified against Curve, BofA or Global Payments)

- Patient card and HFD payments post as `Deposit #id, <method>` (+), applied as `Payment #id, Account Credit` (-), as seen in the ledger sample.
- Cash posts directly as `Payment #id, Cash`.
- Visa, Mastercard, HFD (Healthcare Finance Direct, via Global Payments) and Ins VCC settle in one daily `GLOBAL PAYMENTS DES:GLOBAL DEP` credit, `--card-lag-days` after posting (default 1).
- Card fees: `--card-fee-mode monthly` = gross daily deposits + one `GLOBAL STL` debit next month; `daily-net` = net daily deposits.
- Insurance EFT: one ACH per payer remittance on the remit date, posted in Curve the next day.
- Insurance checks and cash posted on day d are deposited together at an ATM on day d+1.
- Patient list `Full Name` format is unknown from the sample: `--patient-name-format last_first|first_last`.

## TypeScript port (Phase 4b-2): no Python needed

`services/analyst/scripts/make-dental-fixtures.ts` takes the same flags and writes the same files: every CSV byte-identical,
`truth.json` equal as JSON (apart from `flags.out`, the output folder; float formatting such as `120000.0` vs `120000` also
differs in the raw bytes).

    node services/analyst/scripts/make-dental-fixtures.ts --out <dir> --scenario neg-all --seed 3 --leak-seed 2

Proof and maintenance (both need Python 3 and Node):

    python tools/dental-synth/compare_port.py [--seeds 1-10] [--leak-seeds 1-3] [--scenarios all] [--variants all] [--jobs 4]
    python tools/dental-synth/compare_port.py --write-golden services/analyst/test/golden/dental-port.golden.json

Change gen_dental_set.py and the port together, run compare_port.py, then re-write the golden file.

## Layout check against real exports (before L9)

    python tools/dental-synth/shape.py --real <folder of real exports> --synth <generated set folder> [--json]

Compares BOM, line endings, preamble, header, column count and per-column shape (empty/int/money/date/text). It prints no
values. Exit 1 when layouts differ.

## Quick commands (repo root, no full paths)

`npm run dental -- <command>` resolves set names under the data root (`DENTAL_DATA_ROOT`, default
`sample-data/prms/dent-prms-c-sample`) and runs the existing scripts (`services/analyst/scripts/dental.ts`; the TypeScript generator is
byte-identical to `gen_dental_set.py`, so no Python is needed):

```
npm run dental -- sets                                                   # generate + check all 10 scenarios into SET-2
npm run dental -- sets --set SET-3 --seed 4 --leak-seed 2                # another full set, other seeds
npm run dental -- gen --set SET-2/TRY-1 --scenario neg-eft-missing --seed 7
npm run dental -- check --set SET-2/NEG-ALL                              # PASS/FAIL against the answer key, with the exceptions
npm run dental -- explain --set SET-2/NEG-ALL --question "Which leaks lose money, and what should the office do first?"
npm run dental -- query --set SET-2/NEG-ALL                              # every SQL query in the bank (exact, no model)
npm run dental -- query --set SET-2/NEG-ALL --id money-at-risk,top-leaks # chosen queries; --list shows the bank
npm run dental -- query --set SET-2/NEG-ALL --sql "SELECT code, sum(amount) FROM exceptions GROUP BY 1"
npm run dental -- query --set SET-2/NEG-ALL --with-ask                   # also the model questions (starts what they need)
npm run dental -- status                                                 # containers, gateway, analysts, key file
npm run dental -- up                                                     # start ca-presidio, ca-openrouter-stub, ca-gateway
```
The query bank is `config/domain-packs/finance/rcm/dental/queries.json`: add an entry with `sql` (one SELECT over the tables
listed in its notes) or `question` (sent through reconcile-explain). `explain` and model questions start the containers when
the gateway is down and run their own analyst on port 8741, confined to the data root, stopped when the run ends; the test
console's analyst (8740) and `config/data-sources.json` are not touched.
`--folder <dir>` replaces `--set` (relative to where you ran npm); every other flag goes to the script unchanged.
