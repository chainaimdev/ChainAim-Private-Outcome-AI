# chiro-synth: synthetic chiropractic data sets (ChiroTouch or Jane + ERA 835 + Bank of America)

Generates and checks **synthetic** chiropractic-practice data for the reconciliation engine (privateAI-design-30 §8-12).
One canonical model (patients, visits, claims, remittances, payments, deposits) is written in the layout family of one
PRMS, so the same `--seed` gives the same business events in `chiro-1-chirotouch` and `chiro-2-jane`. All names, IDs,
amounts and bank descriptions are made up.

## Files

| File | Purpose |
|---|---|
| `gen_chiro_set.py` | Writes one set plus its answer key. Every knob is a flag (`--help`); same seed = same files. |
| `verify_chiro_set.py` | Re-reads a set by header and checks it (bank totals and running balance, answer key, ERA vs EFT by TRN, batches vs bank, PRMS payments vs deposit report, care plans). `--compare` checks the other PRMS folder for the same seed. Exit 0 = pass. |

## Output (git-ignored: `sample-data/` is in `.gitignore`)

```
sample-data/prms/chiro-1-chirotouch/SET-1/POS/        sample-data/prms/chiro-2-jane/SET-1/POS/
  CT-PATIENTS / CT-DAYSHEET / CT-DEPOSITS -<TAG>.csv     JANE-PATIENTS / JANE-TRANSACTIONS -<TAG>.csv
  CTPAY-<TAG>.csv          (CT Payments batches)         JANE-PAYMENTS-REFUNDS-FEES-<TAG>.csv
  CASHPRAC-<TAG>.csv       (Cash Practice auto-debits)   JANEPAY-PAYOUTS-<TAG>.csv
  shared: ERA-<TAG>.835, BANK-ST-<TAG>.csv, FEESCHED-<TAG>.csv, PI-CASES-<TAG>.csv, CAREPLANS-<TAG>.csv
  _answer-key/expected-matches.csv   every bank credit -> group and source refs (ERA trace, batch ID, payment IDs)
  _answer-key/truth.json             counts, payer mix, group totals, unearned plan revenue, every flag used
```

Layout status is in the docstring of `gen_chiro_set.py`: BofA and 835 verified; Jane payment/payout columns from Jane's
public guides; ChiroTouch and the other Jane files canonical (UNVERIFIED) until real header lines arrive.

## Run (from the repo root, Python 3.9+)

```powershell
python tools\chiro-synth\gen_chiro_set.py --prms chirotouch --out sample-data\prms\chiro-1-chirotouch\SET-1\POS
python tools\chiro-synth\gen_chiro_set.py --prms jane       --out sample-data\prms\chiro-2-jane\SET-1\POS
python tools\chiro-synth\verify_chiro_set.py --dir sample-data\prms\chiro-1-chirotouch\SET-1\POS --tag SET1-POS --compare sample-data\prms\chiro-2-jane\SET-1\POS
```

Expected (seed 1): 150 patients, 723 visits, 622 claims, 16 ERA payments; `ALL CHECKS PASS` for both folders.

## Scenarios

| Scenario | Status |
|---|---|
| `pos` | built: everything reconciles; Medicare CMT lines carry AT; no denials |
| `neg-<leak>`, `neg-all` | not built yet (16 leak types, design-30 §10 #10); the generator refuses them by name |
