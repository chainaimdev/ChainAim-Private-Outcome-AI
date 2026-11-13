# ChainAim Private AI: Outcome AI

**Pay for verified outcomes, not tokens. Private by design, proven on NEAR.**

A business can ask AI about its own books without handing over its data, trusting numbers a model made up, or signing an
open-ended bill. Every step leaves proof that anyone can check: an attested model call, a signed price, a signed
receipt and a settlement on NEAR.

## What makes it different

- **Your data never reaches a model in the clear.** Presidio plus ChainAim's own patterns find names, accounts, IDs,
  health data and cards, and mask them before any model sees the text. A residual check refuses (HTTP 422) anything that
  still looks personal; if the scanner is down, nothing is sent (fail closed). Real values are put back only on your side.
- **Numbers you can trust.** The analyst (DuckDB) computes the answer with one exact, read-only query on your files; the
  model only writes the query from column names and words the result, and every figure in its wording is checked
  against the computed result.
- **A firm price before any work.** Estimate first: the price is set from the files' sizes, signed by ChainAim (AP2
  merchant authorization), and the job runs only after payment. A failed job is never charged. Template questions cost
  0.01 to 0.02 USDC.
- **Proof, not promises.** Each NEAR AI call runs in a hardware-sealed enclave (Intel TDX, NVIDIA GPU) and its
  attestation is verified for the job. Every paid job ends with an Ed25519-signed receipt that binds the files, query,
  result, model calls, price and NEAR settlement, as hashes only: the receipt never holds the data.
- **AI agents that buy safely.** A company's AI agent checks ChainAim's signed quote against its own spending mandate
  (per job, per day, auto-approve limit, attested route only), pays in USDC on NEAR and verifies the receipt. Offered a
  route that is not attested, it refuses before anything is signed or paid.
- **Privacy you can check, edge included.** No question, file, query, result or answer ever goes on chain. The payment
  is an ordinary NEAR USDC transfer, so, as with any on-chain payment, its payer, amount and time are public; tab 03's
  "What the chain shows" displays exactly that for each job, read from public NEAR RPC.
- **Pay per use, on NEAR or the XRP Ledger.** USDC on **NEAR** (Intear wallet or an AI agent; a relayer pays the gas) or
  RLUSD on the **XRP Ledger**, over x402.
- **Any model, by name or by zone.** NEAR AI (attested), local models, OpenRouter, or Amazon Bedrock. Health data and
  `chainaim/auto` can be pinned to local zones only.
- **Live operations.** Every payment and paid job is reported to the NEAR admin UI
  ([chainaim-adminUI-NEAR](https://github.com/chainaimdev/chainaim-adminUI-NEAR)), which reconciles it with the chain.

## Judges: verify it yourself, no keys

Needs only Node.js 22.22 or later and this repository (no `npm install`, no account, no key). Run from the repository root.

```powershell
# 1. A real paid job (testnet, 2026-11-13: an AI agent paid 0.02 USDC for "Credit limit exposure"): its signed receipt,
#    checked offline against the pinned public key (config/receipt-public-key.pem), with the AP2 signed quote it points at
#    (config/ap2-public-key.jwk.json).
node scripts/verify-receipt.ts --file docs/judge/sample-receipt-2026-11-13T0214Z.json --result none
#    expected last line: OK      receipt valid: signed by the pinned key d27d1e9f..., settlement signed too, signed quote matches

# 2. The same job's payment, read from NEAR the way anyone can: who paid, how much and when, and that the content is not there.
node scripts/observe-receipt.ts --file docs/judge/sample-receipt-2026-11-13T0214Z.json
#    expected last line: OK      the chain shows this receipt's payment (0.02, as the receipt's price for job 81ad24c5...)

# 3. The masking, pricing, receipt, AP2 and observer tests (no service needed; 471 pass on 2026-11-13).
node --test "packages/receipt/test/*.test.ts" "packages/ap2/test/*.test.ts" "packages/offer/test/*.test.ts" "packages/observer/test/*.test.ts" "test-console/test/*.test.ts" "services/gateway/test/*.test.ts"
```

The demo scenes (a paid outcome; the agent refusing a route that is not attested) and the 1-minute video script:
[docs/judge/demo-script-2026-11-13T0230Z.md](docs/judge/demo-script-2026-11-13T0230Z.md).

`--result none`: the released result (the answer) is not published; with it, step 1 also checks the receipt's result
hash. The sample receipt names the dataset `smb-erp-fin` and the template "Credit limit exposure": the demo ERPNext books in
`sample-data/smb-2-erp-fin/erpnext/orion` (demo customers, no real company).

## How to run it

Full commands with expected output: **[cmd.md](cmd.md)**. This repo runs together with
[chainaim-adminUI-NEAR](https://github.com/chainaimdev/chainaim-adminUI-NEAR).

**1. One-time setup (once per PC):** [cmd.md PART 1](cmd.md) — tools, clone both repos, packages, the local gateway key,
the secrets files in your secrets folder (outside the repository), the gateway's model mode, and the first start
(`.\test-console\up.ps1 -ReplaceRunning -Build -PayTo <XRPL pay-to>`). The admin UI repo's one-time setup comes first.

**2. Run all containers and both UIs (every day):** two commands, in this order.

```powershell
cd <your-folder>\chainaim-adminUI-NEAR
.\nearadminup.ps1              # ca-near-watch + admin UI http://127.0.0.1:8800
cd <your-folder>\chainaim-private-ai
.\test-console\up.ps1          # six backend containers + console UI http://127.0.0.1:8730
```

Stop: `.\test-console\down.ps1` here, then `.\down.ps1` in the admin UI repo.

**Or one command for both repos** (runs `nearadminup.ps1`, then `test-console\up.ps1` with the team prices, agent mode
and the saved model mode, then prints one READY table): `.\test-console\desk.ps1` · stop: `.\test-console\desk.ps1 -Stop` ·
report only: `-Check` · rebuild images: `-Build`. It needs no settings file; `config\local\desk.json` is optional.

Tab 03 agent mode (on by default when `agent-tenants.env` and a Bedrock key exist; `-Agent off` skips it) adds `ca-agent`, and tab 03 offers
"Who pays? Me — Intear Wallet / AI agent" ([cmd.md](cmd.md), "Tab 03 agent mode").

## What a teammate needs

The code, the team prices and the watch list are in the two repos. Keys and data are **not** (by design): the owner
shares the values privately, each teammate puts them in their own secrets folder, outside the repository (names in [cmd.md](cmd.md) A4).

| Need | For | Where |
|---|---|---|
| Git, Node.js 24, Docker Desktop (4 GB+) | everything | installed on the PC |
| Ollama with the team's local models | the default model mode (`ollama-cpu-8gb-all`); without it, see cmd.md A5 | installed on the PC |
| `near-testnet.env`: NEAR pay-to, relayer account and key | every NEAR payment (the relayer pays the gas) | shared by the owner |
| `chainaim.env`: `OPENROUTER_API_KEY`, `BEDROCK_API_KEY` | hosted and Bedrock models, and agent mode | shared by the owner |
| `paid-jobs.env`, `near-watch.env` | paid jobs, payment claims, job feed | generated on the PC (cmd.md A4, admin UI cmd.md A3) |
| An Intear Wallet TestNet account with TestNet USDC | paying by hand ("Me — Intear Wallet") | wallet.intear.tech, USDC from faucet.circle.com |
| `agent-tenants.env`: the tenants' NEAR keys | agent mode only | shared by the owner (cmd.md A4) |
| Data files in your data folder (`up.ps1 -PrivDataDir`) | tab 03 on your own data | copied by the teammate |

Everything below is what runs and why.

## What runs where

The backend runs in Docker (one `docker-compose.yml`); only the 8730 UI runs on your PC. All ports are published on
`127.0.0.1` only.

| Part | Container | Port on your PC | Role |
|---|---|---|---|
| 8730 UI | none (Node, `server.ts --mode ui`) | **127.0.0.1:8730** | The page and the two wallet bundles; forwards every call to console-api. Holds no key, reads no data |
| console-api | `ca-console-api` | 127.0.0.1:8735 | The console backend: files, "Ask across files", paid jobs (internal listener 8731, Docker network only), job feed |
| gateway | `ca-gateway` | 127.0.0.1:8720 | Masking, routing, model calls (Bedrock / OpenRouter / local), restore, decision ledger (no text) |
| Presidio | `ca-presidio` | none | Entity detection for the gateway |
| paywall | `ca-paywall` | 127.0.0.1:8080 | x402: quotes, verifies and settles payments (NEAR USDC, XRPL RLUSD), then proxies to the gateway |
| analyst | `ca-analyst` | 127.0.0.1:8740 | DuckDB relations and read-only SQL on your data folder |
| chain-query | `ca-chain-query` | 127.0.0.1:8750 | Read-only blockchain queries for the "Blockchain queries" panel |
| near-watch | `ca-near-watch` (from chainaim-adminUI-NEAR) | 127.0.0.1:8790 | Receives payment claims and job events; reconciles them with NEAR |
| agent (optional) | `ca-agent`, only with `up.ps1 -Agent on` | 127.0.0.1:8760 | Tab 03 agent mode: masks the question, asks a Strands agent on Bedrock, runs the paid job and pays it from the tenant's NEAR account |

```
Browser ── 8730 UI (PC) ──▶ console-api ──▶ analyst            (exact numbers from your files)
                               │      └────▶ gateway ──▶ Presidio (mask) ──▶ model (masked text only)
                               └──▶ paywall (x402: NEAR USDC / XRPL RLUSD) ──▶ gateway
paywall, console-api ──▶ near-watch (claims, job events) ──▶ admin UI 8800
```

Your data folder (`up.ps1 -PrivDataDir`) is mounted **read-only** into console-api and the analyst; the folder picker shows
it as `/data/priv-ai-data/...`. Data, secrets and program output are never in git or in an image.

## Prices

| What | Price | Where it is set |
|---|---|---|
| Paid chat, scan, mask | $0.01 each (default) | paywall `PRICE_CHAT`, `PRICE_SCAN`, `PRICE_MASK` |
| Tab 03 paid job | model cost + fees + margin, at least the minimum | `config/paid-jobs-prices.conf` (team default, committed) |

Team paid-job prices (`config/paid-jobs-prices.conf`), used automatically by `test-console\up.ps1`:

| Setting | Value |
|---|---|
| `PRICING_CATALOG` | `config/generated/catalog.local.json` (made by `switch-models.ps1`) |
| `FEE_PER_MODEL_CALL_USD` | 0.001 |
| `FEE_ANALYST_USD` | 0.002 |
| `NEAR_GAS_FEE_USD` | 0.002 |
| `MARGIN_PCT` | 20 |
| `MIN_PRICE_USD` | 0.01 |

One PC can use other prices with `paid-jobs-settings.env` in its secrets folder (same names; it wins when present).

## Repository layout

| Path | What |
|---|---|
| `services/gateway` | Masking gateway (Node built-ins only) |
| `services/presidio` | Presidio image with the extra recognizers |
| `services/paywall` | x402 paywall (NEAR and XRPL rails, paid jobs); buyer scripts in `scripts/` |
| `services/analyst` | DuckDB analysis, relations, read-only SQL |
| `services/chain-query` | Read-only chain queries |
| `services/web` | Browser wallet bundles (`wallet.js`, `near-wallet.js`) and the PrivacyBuddy page |
| `test-console` | The console (`console/server.ts`), `up.ps1` / `down.ps1`, and the older scripts (`stack.ps1`, `switch-models.ps1`, `start-ui.ps1`, `desk.ps1`) |
| `packages/crossask` | "Ask across files" and paid-job pricing (`cost.ts`) |
| `config` | Model catalogs and registries, data-folder settings, team prices |
| `docker-compose.yml` | The backend stack |

## Tests

```powershell
node --test "services/gateway/test/*.test.ts" "scripts/test/*.test.ts" "test-console/test/*.test.ts"
npm run test:paywall
npm --prefix packages\crossask test
npm --prefix services\web test
npm --prefix services\chain-query test
npm --prefix services\analyst test
```

Expected on 2026-11-06 (with tab 03 agent mode): 442, 292, 30, 133, 11, and analyst 177 pass with 1 known failure (a Windows-only crash when
the reconcile-explain test process exits; the check itself passes). `npm test` first runs a dependency check that has 5
known, older findings, so the first line above runs the same suites without it.

## More

| File | What |
|---|---|
| [cmd.md](cmd.md) | Every command to set up, run, check and stop |
| [DOCKERIZE-PLAN.md](DOCKERIZE-PLAN.md) | Why and how the backend moved into Docker |
| [MANUAL_SETUP.md](MANUAL_SETUP.md) | Owner steps, dated |
| [architecture.md](architecture.md) | Paid jobs (tab 03) requirements |
| [STATE.md](STATE.md), [BUILD_LOG.md](BUILD_LOG.md) | Status and the record of what ran |
| [docs/creditseal-README.md](docs/creditseal-README.md) | The CreditSeal lending README that used to be here |

Never paste `docker inspect` or `docker compose config` output anywhere: both print secret values.
