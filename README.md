# ChainAim CreditSeal — private loan orchestration for XRPL lending vaults (XLS-65 / XLS-66)

**Private books, private models, public proof.** Borrowers keep their books, lenders keep their models, and the
ledger keeps the proof.

XLS-66 lends from pooled vaults **without collateral** and leaves underwriting off-chain by design. CreditSeal is the
orchestration layer between the parties on a vault: it turns a borrower's private books into curated, verified facts
and stress-scenario results for the **lender's own risk policy**, checks identity against the public **GLEIF** API,
cross-checks the loan schedule on **ACTUS** (open contract standard), writes a SHA-256 fingerprint of the analysis and
its evidence into the loan's `LoanSet.Data`, and then services and monitors the loan for the lender, the depositors and
any bank or supervisor that reads ACTUS. ChainAim never signs a loan; the borrower and the broker do.

Network: **XRPL Devnet** (LendingProtocol, LendingProtocolV1_1, SingleAssetVault, fixCleanup3_4_0). Asset: a
self-issued test dollar **TUSD** (not RLUSD).

**Where the demo data is, and how to test it from the UI and the terminal:** [docs/DATA-AND-TESTING.md](docs/DATA-AND-TESTING.md)

## Who does what

| Party | Role | Pays ChainAim for |
|---|---|---|
| Borrower (CFO) — e.g. Orion Ceramics, Jupiter Knitting | keeps its books; shares computed facts; signs `LoanSet` | private AI questions on its own books (console, x402) |
| Broker = lender & vault operator — e.g. Harbor Credit | runs the vault, posts first-loss cover, applies its private policy, co-signs | underwriting, monitoring |
| Depositor — e.g. Northbay Savings Fund | funds the vault | risk view ("if this loan defaulted now") |
| Bank / supervisor | reads the loan as an ACTUS contract | (roadmap) reports |
| ChainAim (CreditSeal) | curated data, identity and schedule evidence, attestation, pre-flight, monitoring | — |

## What runs today (Devnet, verified)

- Private underwriting from the borrower's books: cash projection, 5 stress scenarios, counter-offers, verdict
  (Orion Ceramics: APPROVE · Jupiter Knitting: APPROVE · Mercury Textiles: DECLINE).
- **GLEIF identity, live:** Jupiter Knitting declares LEI 3358004DXAMRWRUIYJ05; checked against
  `https://api.gleif.org/api/v1/lei-records/<LEI>` (entity ACTIVE, registration ISSUED, ISO 17442 check digits,
  legal name). *Identity: real public GLEIF record. Financials: synthetic demo books.*
- **ACTUS cross-check, live:** the loan as an `ANN` contract posted to an ACTUS server (`/eventsBatch`); installments
  equal the XLS-66 schedule to the cent. Exact request and response saved per run.
- Evidence hashes (GLEIF response, ACTUS request/response) inside the underwriting pack; `sha256(pack)` in
  `LoanSet.Data`; the broker re-hashes and checks the terms before counter-signing (a forged request is refused).
- Servicing and monitoring: pre-flight for every transaction (phase gates, timing, late payments, funds), ledger vs
  engine reconciliation, ACTUS status PF → DL → DQ → DF → MA, impair/default, depositor view; V1.1 vaults use
  cash-basis accounting (exposure = principal outstanding), as the ledger books it.
- **CreditSeal Desk** (`services/lending/scripts/cockpit.ts`): a 17-step guided demo with the ChainAim wallet
  collecting fees from each party, the LEI-verified badge, the ACTUS live call, and the bank view (ACTUS terms + live
  schedule linked to XRPL transactions).

In this demo the borrower-side and lender-side computations run on one machine; in production the lender's model and
cut-offs run only on the lender's side (see `DESIGN/xrplh-17` and the confidentiality notes in `BUILD_LOG.md`).

## Run the Desk (Windows, from `services/lending`)

```powershell
npm install
node scripts/lending.ts accounts --secrets-out C:\PRIV-AI-SECRETS\lending-devnet.env   # seeds live OUTSIDE the repo
node scripts/lending.ts issue --env-file C:\PRIV-AI-SECRETS\lending-devnet.env
node scripts/make-borrower-books.ts --profile orion   --out ..\..\data\lending\books\orion
node scripts/make-borrower-books.ts --profile jupiter --out ..\..\data\lending\books\jupiter-knitting
powershell -ExecutionPolicy Bypass -File .\demo\start-demo.ps1 -FreshVault          # vault + broker + Desk at http://127.0.0.1:8750
```

The Mercury Textiles (declined) books come from `services/analyst/scripts/make-finance-fixtures.ts --kind smb` with
`services/lending/demo/mercury-textiles/*.json`. Data, seeds and keys are git-ignored.

## Where the data is, and how to test

[docs/DATA-AND-TESTING.md](docs/DATA-AND-TESTING.md): every data folder (original demo books and packs, the split
borrower / lender / exchange folders, keys, config, secrets), the Desk's 17 steps with what each should show, the
Isolation and Applications cards, and the terminal commands (tests, proofs, split flow, reapply policy, sealed
exchange with the expected refusals, Devnet commands).

## Dental reconciliation and revenue leaks: run it on your own PC

Everything below runs on a fresh clone. Your test data is generated on your PC (git-ignored, under `data/`); no real
patient data is needed or shared. One command does it all: `npm run dental -- <command>`
(`services/analyst/scripts/dental.ts`; details in `tools/dental-synth/README.md`, design in `DESIGN/xrplh-26` and `xrplh-27`).
Commands are for Windows PowerShell, run from the repository folder.

### Tier 1: test data, reconciliation, 25 SQL queries (Node only, no Docker)

You need Git and Node.js 22.22 or newer (`node --version`).

```powershell
git clone https://github.com/chainaim-sathya/CreditSeal.git
cd CreditSeal
npm ci --prefix services/analyst
```
`npm ci` installs the analyst's only dependency (DuckDB).

```powershell
npm run dental -- sets
```
Generates the 10 test scenarios (1 positive, 9 with planted leaks) into `data\pms\dent-pms-c-sample\SET-2\` and checks each
against its answer key. Expected: ten `PASS` lines, then `dental sets: 10/10 scenarios pass`.

```powershell
npm run dental -- check --set SET-2/NEG-ALL
npm run dental -- query --set SET-2/NEG-ALL
npm run dental -- query --set SET-2/NEG-ALL --id money-at-risk,top-leaks
npm run dental -- query --list
```
`check` lists the 8 leaks found in NEG-ALL; `query` answers the 25 SQL queries of the bank
(`config/domain-packs/finance/rcm/dental/queries.json`) exactly, with no model. Expected from `money-at-risk`:
`missing_from_bank 1678.47`, `in_bank_not_posted 863.57`, `timing_watch 1600.00`. Analyst tests: `npm --prefix services/analyst test`
(161 pass).

### Tier 2: model questions (one-time setup), on a local model or on Amazon Bedrock

The 14 model questions send a fact sheet (computed by DuckDB) through the masking gateway to a model. Choose where the
model runs: **option A** a local model on your PC (Ollama; nothing leaves the PC), or **option B** Amazon Bedrock with
masking (no GPU needed).

**What reaches the model, in both options:** only the fact sheet: cause codes, dates, signed amounts, payer codes, payment IDs
and the action per code (`--facts-only` prints it). Patient names are never loaded from the files. The gateway then scans
the text with Presidio and replaces anything that looks personal with a placeholder before it leaves the gateway, and puts
the values back in the answer. `--scan` shows what it would replace; for the generated sets it is nothing (14/14, data
class `none`).

Both options need **Docker Desktop** running with at least 4 GB memory (Presidio's image is about 1.6 GB),
**Ollama for Windows** (ollama.com; option B uses it for the local fallback) and free ports **8720, 5004, 11434**.
Option A: an NVIDIA GPU with 8 GB makes the 8B model answer in seconds; on CPU only, see step 5.

**Steps 1-2: both options**

1. **Gateway key**, once per PC (git ignores it; never copy anyone else's):
   ```powershell
   node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))"
   ```
   Expected: the file `test-console\local-gateway-key.txt` exists. Do not run it again once `ca-gateway` exists.
2. **Build and start Presidio and the stand-in** (the first Presidio build takes several minutes):
   ```powershell
   powershell -ExecutionPolicy Bypass -File test-console\stack.ps1 -Rebuild presidio,stub,gateway
   ```
   Expected: it creates the `chainaim-test` network, builds the images and starts `ca-presidio` and `ca-openrouter-stub`;
   the check at the end may warn that `ca-gateway` and `ca-paywall` are missing (step 4 makes the gateway; the paywall is not needed here).
**Option A: local model (Ollama), steps 3-6**

3. **Local models**: with Ollama running, pull the models named in `config\local-models.json`:
   ```powershell
   ollama pull deepseek-r1:8b
   ollama pull qwen2.5:3b
   ollama pull deepseek-r1:1.5b
   ```
4. **Start the gateway on those models**:
   ```powershell
   test-console\use-ollama.cmd
   ```
   Expected: it lists the three models, then answers a test question from `local/deepseek-r1-8b`; press a key to close.
5. **Check**:
   ```powershell
   npm run dental -- status
   ```
   Expected: the three containers `running`, `gateway … healthy`, `gateway key file present`, and
   `gateway models (--model)` listing `local/deepseek-r1-8b`. **CPU only (no NVIDIA GPU):** in step 3 pull
   `qwen2.5:3b`, `qwen2.5:1.5b-instruct` and `deepseek-r1:1.5b`, in step 4 run
   `powershell -ExecutionPolicy Bypass -File test-console\switch-models.ps1 -To ollama-cpu-8gb` (models from
   `config\local-models.cpu.json`, default `local/qwen2.5-3b`), and use `--model local/qwen2.5-3b` below. Smaller models
   fail the answer check more often; you then get the computed facts, which are always correct.
6. **Privacy check** (no model is called):
   ```powershell
   npm run dental -- query --set SET-2/NEG-ALL --kind model --scan
   ```
   Expected: `== privacy scan: 14/14 model inputs reach the model unmasked`.

**Option B: Amazon Bedrock with masking** (NOT YET VERIFIED on the dental questions; the gateway modes are in
`test-console\modes\`)

Bedrock serves **`bedrock/nemotron-nano-3-30b`** (NVIDIA Nemotron Nano 3 30B, AWS region ap-southeast-2, Sydney; zone
`private-cloud`) through the same masking gateway. You need Docker (steps 1-2 above), Ollama with the CPU models for the
local fallback, and **your own Bedrock API key** with access to that model in that region (from your AWS account owner;
never share or commit it). Configured price: $0.0618 per million input tokens, $0.2472 per million output tokens.

B1. Local fallback models, once (Ollama running):
   ```powershell
   ollama pull qwen2.5:3b
   ollama pull qwen2.5:1.5b-instruct
   ollama pull deepseek-r1:1.5b
   powershell -ExecutionPolicy Bypass -File test-console\switch-models.ps1 -To ollama-cpu-8gb
   ```
B2. Switch the gateway to Bedrock. It asks for `BEDROCK_API_KEY` (hidden; paste with a right-click), recreates `ca-gateway`
   and answers a test question:
   ```powershell
   powershell -ExecutionPolicy Bypass -File test-console\switch-models.ps1 -To bedrock
   ```
   Expected: the test answer names the model that served it. `npm run dental -- status` then lists
   `bedrock/nemotron-nano-3-30b` under `gateway models (--model)`.
   Mode `bedrock` tries Bedrock first and falls back to local Qwen, for every request. For **real practice data**, use mode
   `ollama-cpu-8gb-all` instead (`-To ollama-cpu-8gb-all`; asks for `OPENROUTER_API_KEY` and `BEDROCK_API_KEY`): there
   `chainaim/auto` and anything the gateway classes as health data stay local (`--auto-zones local --phi-zones local`), and
   Bedrock answers only when named with `--model`.
B3. Privacy check, as step 6 above (`--scan`); then the questions with `--model bedrock/nemotron-nano-3-30b` (below).
   Each answer reports `SERVED bedrock/nemotron-nano-3-30b (zone private-cloud)`. If the gateway serves another model
   (Bedrock unreachable, key refused), the answer is not counted as Bedrock's: it says `asked for … but the gateway served …`.

To go back to the local GPU models: `test-console\use-ollama.cmd`.

### Every day

```powershell
npm run dental -- up
npm run dental -- query --set SET-2/NEG-ALL --model local/deepseek-r1-8b --id ask-priorities,ask-missing-money,ask-extra-money,ask-loss-vs-timing,ask-eft-followup
npm run dental -- query --set SET-2/NEG-ALL --model local/deepseek-r1-8b --kind model
npm run dental -- query --set SET-2/NEG-ALL --model bedrock/nemotron-nano-3-30b --kind model
```
The last line is option B (gateway switched to `bedrock` or `ollama-cpu-8gb-all`).
`up` starts the three containers and waits for the gateway (after a reboot or a Docker restart). Each answer is checked
against the facts it cites; a failed check shows the computed facts instead, and the run ends with
`== model answers: N/5 verified`. Reference run (8B on an RTX 3070 Ti, 2026-11-03): 5/5 verified, 9-30 s per question.
Other useful commands: `npm run dental -- query … --facts-only` (what the model receives),
`npm run dental -- probe "text"` (what the gateway would mask), `npm run dental -- gen --set SET-2/TRY-1 --scenario neg-eft-missing --seed 7`
(a new case). If a question reports `cooling_down`, the gateway benched the model for 30 s after a failure; the script waits once.

## Rest of this repository

CreditSeal reuses ChainAim's private-AI stack (masking gateway, Presidio, paywall with x402 on XRPL, analyst, test
console) for the CFO's private questions. Its original README is kept at `docs/privacy-gateway-README.md`.

---

## Why this fits the Lending & Borrowing track

| # | Highlight | What in this code proves it |
|---|---|---|
| 1 | **Fills the gap XLS-66 leaves on purpose.** The spec relies on off-chain underwriting and skips collateral and liquidation; first-loss cover absorbs only a slice of a default (10 % × 50 % = 5 % of debt in our config). Savers' real protection is *whether the loan should be made*. | `packages/underwrite` — cash projection, 5 stress scenarios, rules → APPROVE / REFER / DECLINE |
| 2 | **It says no.** On the demo data it **declines** the stressed borrower (Mercury Textiles: burns ~27k/month, 90 % of collections from one late payer) and **approves** the healthy one (Orion Ceramics: lowest cash 154.6k, 2.38× coverage, passes every stress). | `scripts/underwrite.ts` on both demo borrowers |
| 3 | **Private by construction.** The books never leave the PC; customer and supplier names never enter the pack (IDs only); the AI, if used, gets numbers only. | `books.ts` keeps IDs only; test "no names in the facts" |
| 4 | **Every number is computed, not generated.** The XLS-66 amortisation, default and cover formulas are copied from the spec; the AI only explains, and any number in its text that was not computed is flagged. | `packages/xls66/engine.ts` (tests: term-sheet installment 17,001.11; equipment loan 3,843.95 matches the bank statement), `unverifiedNumbers` |
| 5 | **Interoperable loan maths.** ANN 30E360 monthly maps *exactly* to XLS-66 `PaymentInterval` 2,628,000 s (rate r/12 per period on both sides), so an ACTUS schedule — an open standard any institution can run — reconciles with the ledger. | `packages/underwrite/loan.ts`, optional `--actus-url` cross-check |
| 6 | **Provable on-chain.** `LoanSet.Data` (≤256 B) carries `sha256(pack)`, verdict, policy and request id; the broker refuses to counter-sign if the hash, terms or verdict don't match. | `attest.ts`, `lending.ts loan` broker checks, `reconcile` |
| 7 | **No failed transactions.** Before sending, every command evaluates the spec's failure conditions (V1.1 phase gates, the 60 s redemption buffer, cover minimum, exclusive impair/default boundaries) and names the code and spec clause. | `packages/xls66/gates.ts` (boundary tests at ±1 s) |
| 8 | **Savers see the downside.** The depositor view shows, per loan, what the cover pays and what depositors lose if it defaulted now, with XLS-66's own default formula. | `lending.ts view` |
| 9 | **A business model that matches XLS-66.** Borrower pays an underwriting fee on-chain (demo); roadmap: broker pays from `LoanOriginationFee`, monitoring from `LoanServiceFee`. | `lending.ts fee`, `src/fee.ts` (validated, delivered amount, memo, no reuse) |

---

## What is where

| Path | Role | Runs where |
|---|---|---|
| `packages/xls66/` | XLS-66 / XLS-65 units, formulas, pre-flight gates, attestation, transaction drafts. No dependencies. | anywhere |
| `packages/underwrite/` | Books → facts; cash projection; scenarios; rules; counter-offers; the PII-free pack | borrower's PC |
| `config/underwriting.json` | The lender's policy: thresholds, scenarios, run-rate haircut, loan defaults, broker cover settings | — |
| `services/analyst/src/actus.ts` | (existing) ACTUS contracts and the check that every term is in its own document | borrower's PC |
| `services/lending/scripts/make-borrower-books.ts` | Synthetic books for the healthy demo borrower (Orion Ceramics) | — |
| `services/lending/scripts/underwrite.ts` | Underwriting command: verdict, pack, attestation, XLS-66 fields | borrower's PC, offline |
| `services/lending/scripts/lending.ts` | Devnet: accounts, asset, vault, broker, deposit, fee, loan, drill, pay, manage, reconcile, view | lender / demo machine |
| `services/lending/demo/mercury-textiles/` | Loan request and declared facilities for the stressed borrower (books from the analyst's fixtures) | — |

---

## Run it

```bash
cd services/lending && npm install          # xrpl 5.3.0 (isolated from the paywall's 4.7.0)
npm test                                    # 29 tests: engine, underwriting, offline signing
```

**1. Demo books (offline, deterministic)**

```bash
node scripts/make-borrower-books.ts --out ../../data/lending/books/orion
node ../analyst/scripts/make-finance-fixtures.ts --kind smb --out ../../data/lending/books/mercury-textiles
cp demo/mercury-textiles/*.json ../../data/lending/books/mercury-textiles/
```

**2. Underwrite (offline, on the borrower's PC)**

```bash
node scripts/underwrite.ts --books ../../data/lending/books/orion            # → APPROVE
node scripts/underwrite.ts --books ../../data/lending/books/mercury-textiles    # → DECLINE
# optional: --actus-url <ACTUS server>   --ai-url <gateway> --ai-model <model>
```

**3. Devnet setup (before the demo; the vault takes deposits only during Subscription)**

```bash
node scripts/lending.ts accounts --secrets-out <private folder>/lending-devnet.env
E="--env-file <private folder>/lending-devnet.env"
node scripts/lending.ts issue   $E
node scripts/lending.ts vault   $E --subscription-sec 900 --investment-days 120
node scripts/lending.ts broker  $E --cover 12000
node scripts/lending.ts deposit $E --amount 150000
# fast re-setup for test cycles (every wait <= 2 minutes): archives the old vault/broker/loans in the state file,
# then vault (60 s subscription) + broker + cover + deposit, and waits until Investment opens
node scripts/lending.ts cycle   $E                                  # [--subscription-sec 60] [--no-wait]
node scripts/lending.ts mint    $E --to borrower --amount 1000      # the borrower needs > 20,367.78 for installment 1
```

**4. Live (about 3 minutes)**

```bash
node scripts/underwrite.ts --books ../../data/lending/books/orion            # verdict + attestation
node scripts/lending.ts fee       $E --request-id <requestId from step 2>
node scripts/lending.ts loan      $E --pack ../../data/lending/packs/<requestId>.pack.json
node scripts/lending.ts pay       $E --name loanA                            # early installment = on time
node scripts/lending.ts reconcile $E --name loanA                            # ledger = engine; Data = sha256(pack)
node scripts/lending.ts drill     $E                                         # 60 s interval, 60 s grace (spec minimum)
node scripts/lending.ts pay       $E --name loanB --mode on-time             # after 61 s: refused by pre-flight, tecEXPIRED §3.11.4.2 #11
node scripts/lending.ts manage    $E --name loanB --action impair  --wait-max-sec 120   # waits until overdue, then sends
node scripts/lending.ts manage    $E --name loanB --action default --wait-max-sec 120   # waits until due + grace, then sends
node scripts/lending.ts view      $E                                         # depositor view
```

Every command accepts `--dry-run` (build + pre-flight, print, send nothing) and `--state <file>` (default
`data/lending/devnet-run.json`). Seeds are only ever in the `--secrets-out` file.

---

## Verified vs not yet verified

- **Verified here:** engine formulas against two independent figures; V1.1 gates at exact boundaries; xrpl.js 5.3.0
  validation and binary encoding of every draft; borrower-sign → broker-counter-sign producing both signatures with the
  attestation intact; determinism of the pack hash; strict TypeScript against xrpl 5.3.0 types.
- **Run on Devnet 2026-10-25 (01:00–01:14 UTC-5), every transaction tesSUCCESS:** accounts, issue, vault, broker,
  deposit, fee, Loan A (broker re-hash ✓), early installment, `reconcile` (6/6 ✓ to 6 decimals, Data = sha256(pack)),
  drill: impair refused before the due date by pre-flight (nothing sent), impair, default (cover paid, depositors lost 0),
  depositor view. DefaultRipple lets TUSD move through the vault. Run record: `BUILD_LOG.md`.
- **Still open:** whether `InterestDue` in the cover check (§3.8.5.2 #20) is gross or net of the management fee (the
  engine uses gross); the default amount moved 1,000.00 where the engine expected 1,000.002072 — likely `LoanScale`
  rounding (XLS-66 §3.6 field `LoanScale`), to confirm with the `ledger raw:` line `reconcile` now prints.
- **Specs:** XLS-65, XLS-66, XLS-66.1.2, XLS-66.2 — Draft, updated 2026-09-15 (XRPLF/XRPL-Standards).
