# ChainAim Private AI: Outcome AI

**Pay for verified outcomes, not tokens. Private by design, proven on NEAR.**

A business can ask AI about its own books without handing over its data, trusting numbers a model made up, or signing an
open-ended bill. Every step leaves proof that anyone can check: an attested model call, a signed price, a signed
receipt and a settlement on NEAR.

Built at **NEAR HACKATHON** (1 to 14 Nov 2026). What existed before the window and what was built in it, release by
release: [NEAR-HACKATHON-DISCLOSURE.md](NEAR-HACKATHON-DISCLOSURE.md). Architecture, step by step:
[docs/judge/outcome-ai-architecture.html](docs/judge/outcome-ai-architecture.html). Companion repo (live operations):
[chainaim-adminUI-NEAR](https://github.com/chainaimdev/chainaim-adminUI-NEAR).

## What makes it different

- **Unmasked only on your own machine.** The gateway, Presidio, the analyst and the console run in Docker on your PC,
  reachable on `127.0.0.1` only (Presidio not even that). Your files and your raw question never leave it: Presidio plus
  ChainAim's own patterns find names, accounts, IDs, health data and cards, and mask them **on your PC** before any text
  leaves. A residual check refuses (HTTP 422) anything that still looks personal; if the scanner is down, nothing is sent
  (fail closed). Only masked text goes to a model, and the real values are put back on your PC.
- **Numbers you can trust.** The analyst (DuckDB) computes the answer with one exact, read-only query on your files; the
  model only writes the query from column names and words the result, and every figure in its wording is checked
  against the computed result.
- **A firm price before any work.** Estimate first: ChainAim's signer sets the price from the files' sizes and signs it
  (AP2 merchant authorization), and the job runs only after payment. A failed job is never charged. Template questions cost
  0.01 to 0.02 USDC.
- **Proof, not promises.** The masked text that leaves your PC goes to NEAR AI, where each call runs in a hardware-sealed
  enclave (Intel TDX, NVIDIA GPU) and its attestation is verified for the job. Every paid job ends with an Ed25519-signed receipt that binds the files, query,
  result, model calls, price and NEAR settlement, as hashes only: the receipt never holds the data. It also lists what left
  your PC for each model call (where it went, what was masked, the hash of the exact bytes sent), and that hash is the one
  NEAR AI's enclave signed. A job whose NEAR AI attestation is not proven is refunded, not delivered.
- **AI agents that buy safely, on a two-sided deal.** A company's AI agent checks ChainAim's signed quote against its own
  spending mandate (per job, per day, auto-approve limit, attested route only), then signs its permission as an AP2
  Checkout Mandate with the tenant's own key, bound to that exact quote and that one payment, and pays in USDC on NEAR.
  ChainAim's signer verifies the mandate before the job runs; nothing settles without both signatures, and the receipt
  records both. Its own model sees the question only masked. Offered a route that is not attested, it refuses before
  anything is signed or paid.
- **Paid before the work, refunded if it fails.** The agent pays upfront in USDC on NEAR; a job that is then refused
  (attestation not proven, folder changed, outside the signed limits) is refunded on NEAR automatically, with a refund
  record signed by ChainAim. Right before paying, the agent re-checks the folder's size against the estimate.
- **A counter-offer, not a lost sale.** When a quote is above the tenant's auto-approve limit, the agent asks ChainAim for
  a smaller job at that limit. ChainAim's signer prices each smaller step (fewer answer rows, fewer tokens, fewer SQL
  tries) with the same fees and margin: **the price is never discounted, only the job shrinks**. Live: quoted 0.02,
  countered, paid 0.01, and the receipt says which offer it countered. If no smaller job fits, nothing is signed or paid.
- **Our signer never sees your data; your machine never holds our keys.** ChainAim's signing keys live in a separate
  service, `ca-control-signer` (the control plane), in its own runtime with its own keys folder. It receives sizes, ids,
  hashes and amounts only, and refuses any other field by name. Today it runs beside your stack on the same PC
  (separation by design, not by hardware); the same image runs on a cloud server (`docs/deploy/signer-cloud.md`).
- **Privacy you can check, edge included.** No question, file, query, result or answer ever goes on chain. The payment
  is an ordinary NEAR USDC transfer, so, as with any on-chain payment, its payer, amount and time are public; tab 03's
  "What the chain shows" displays exactly that for each job, read from public NEAR RPC.
- **Pay per use in USDC on NEAR.** x402 over USDC on **NEAR** (Intear wallet or an AI agent; a relayer pays the gas).
  An XRPL/RLUSD rail from the version before the hackathon is still in the code
  ([NEAR-HACKATHON-DISCLOSURE.md](NEAR-HACKATHON-DISCLOSURE.md)); paid jobs are NEAR only.
- **Any model, by name or by zone.** NEAR AI (attested), local models, OpenRouter, or Amazon Bedrock. Health data and
  `chainaim/auto` can be pinned to local zones only.
- **Live operations.** Every payment and paid job is reported to the NEAR admin UI
  ([chainaim-adminUI-NEAR](https://github.com/chainaimdev/chainaim-adminUI-NEAR)), which reconciles it with the chain.

**What runs where today, honestly:** the paywall and the relayer key still run on the buyer's PC with the data plane;
ChainAim's signer is a separate project (own network, own keys folder) on the same PC. The full desk needs Docker and
keys from the owner; the judge path below needs neither.

## Roadmap

- **Hosted mode, same guarantee.** Today the gateway runs on your PC. For businesses that want ChainAim to host it, the
  gateway moves into a confidential VM (Intel TDX) built reproducibly; your client checks the hardware-signed measurement
  against the published build before sending any raw text, and "no logs" becomes part of the measured code.
- **ChainAim's signer in a TEE.** The control plane's signer moved into a TEE whose code a NEAR contract approves
  (NEAR Shade Agents, Intel TDX), so its signing code is provable, not only separate.
- **Settle remotely, release locally.** The paywall and relayer move to the control plane and return a signed settlement;
  your PC releases the result itself, so the result never reaches a ChainAim server.
- **Spending mandate on NEAR.** The tenant's limits (per job, per day, attested route only) enforced by a NEAR contract,
  not only by the agent's code.
- **Unlinkable credits.** Prepaid credits spent as unlinkable tokens, so the chain no longer shows each job's payment.
- **Model proxy.** ChainAim holds the NEAR AI key and forwards, byte for byte, only the calls a paid, signed job allows,
  so the attested request hash still matches (built together with the hosted gateway, so the control plane still never
  sees text).
- **ChainAim Apprentice (next, design stage).** A local model learns from NEAR AI's attested model on synthetic data only,
  keeps only answers that pass deterministic checks, and is used only once it scores well: fewer calls leave your PC,
  and the receipt says which model answered.
- **ZK-PRET.** Verifiable outcomes extended to trade-finance processes and risk models (BPMN, ACTUS).

## Judges: verify it yourself, no keys

Needs only Node.js 22.22 or later and this repository: no `npm install`, no Docker, no account, no key. Run from the
repository root. Each step says what you will see.

**The sample** is a real paid job from 14 Nov 2026, 07:29Z on NEAR testnet: tenant t02's AI agent was quoted 0.02 USDC
for "Cash flow vs installment" (dataset smb-fin-1), its spending policy (auto-approve 0.01) asked for a smaller job,
ChainAim's signer offered one at 0.01 (answer rows 20, 1024 tokens), the agent signed its checkout mandate and paid
0.01 **before** the work, and the result was released only after ca-attest verified the NEAR AI call.

```powershell
# 1. The signed receipt, checked offline against the pinned public keys in config/ (receipt key, ChainAim's AP2 key,
#    the tenants' mandate keys): signature, settlement, signed quote and limits, mandate, money trail, attestation, egress.
node scripts/verify-receipt.ts --file docs/judge/sample-receipt-2026-11-14T0729Z.json --result none
#    you will see, among the details:
#            job        0ed4fe96d007925a695c7ad6226189af · quote 0ed4fe96… · counter of 043fe341c45a64c07a9c860752a30de5
#    and the last four lines:
#    OK      receipt valid: signed by the pinned key d27d1e9f17a0104e34c46cf3e5233f23, settlement signed too, signed quote matches, checkout mandate matches, signed limits match
#    OK      money trail: paid 0.010000 USDC (upfront, tx 8E6m…) · NEAR AI cost 0.000322 · gas 0.002000 · cost 0.002322 · margin 0.007678 · overrun absorbed 0.000000 (costs at ChainAim's catalog prices)
#    OK      attestation bundle matches evidenceBundleSha256 (1/1 NEAR AI calls verified)
#    OK      egress: 1 call left the PC → cloud-api.near.ai (private-cloud), masked nothing to mask, sent-bytes hash = the attested request hash on 1/1 NEAR AI call

# 2. The same payment, read from public NEAR testnet RPC (needs internet): who paid, how much and when, and what is NOT on chain.
node scripts/observe-receipt.ts --file docs/judge/sample-receipt-2026-11-14T0729Z.json
#    last line: OK      the chain shows this receipt's payment (0.01, as the receipt's price for job 0ed4fe96d007925a695c7ad6226189af)

# 3. The receipt, AP2 quote and mandate, offer pricing, observer, signer, spending-policy, console and masking-gateway tests.
node --test "packages/receipt/test/*.test.ts" "packages/ap2/test/*.test.ts" "packages/offer/test/*.test.ts" "packages/observer/test/*.test.ts" "packages/signer/test/*.test.ts" "packages/agent-policy/test/*.test.ts" "services/signer/test/*.test.ts" "test-console/test/*.test.ts" "services/gateway/test/*.test.ts"
#    you will see: # pass 565 and # fail 0 (v2.3.0; a few minutes)
```

`--result none`: the released answer is not published; with the result file, step 1 also checks the result hash. The
sample data is synthetic (no real company). Earlier samples: `docs/judge/older/` (the 1716Z receipt still verifies).

### Judges' map: claim, proof, how to check

| Claim | Proof | Check |
|---|---|---|
| Your raw data and question stay on your PC | Masking before any model; the receipt's egress lists what left (host, masked counts, bytes hash) | Step 1 `OK egress`; gateway tests in step 3 |
| Every NEAR AI call is attested | ca-attest's verdict per call (Intel TDX + NVIDIA GPU), its bundle hashed into the receipt; egress hash = the request hash the enclave signed | Step 1 `OK attestation`, `OK egress`; chat id at cloud.near.ai/verify |
| A firm price before any work | ChainAim's AP2 signed quote with **signed limits** (models, calls, tokens, files) | Step 1 `signed quote matches`, `signed limits match` |
| The buyer's agent spends only within its mandate | Tenant policy (per job, per day, auto-approve, attested only) and an AP2 checkout mandate signed with the tenant's key for this quote and one payment | Step 1 `checkout mandate matches`; `packages/agent-policy` tests |
| Negotiation without discounting | One counter round: a smaller job at the tenant's limit, priced by ChainAim's signer | Step 1 `counter of 043fe341…`, `max 1024 tokens`; `test-console/test/counter.test.ts` |
| Paid before the work, refunded if it fails | Upfront USDC on NEAR; refused job = signed refund record (live refund EyD53Bnv… in BUILD_LOG.md) | Step 1 `flow upfront`; step 2 |
| Real money, fair to both sides | Money trail: price, NEAR AI cost, gas, fees, margin | Step 1 `OK money trail` |
| Nothing about the content goes on chain | Only the USDC transfer is on NEAR | Step 2 `PRIVATE not on the chain: …` |
| Reconciled live | The admin UI matches every claim with the chain transfer | [chainaim-adminUI-NEAR](https://github.com/chainaimdev/chainaim-adminUI-NEAR) "Do X → see Y" |

Demo video (2:30): [DEMO/outcome-ai-near-demo-2m30.mp4](DEMO/outcome-ai-near-demo-2m30.mp4) · its script:
[DEMO/script-outcome-mp4-2.5min-Nov14-1.md](DEMO/script-outcome-mp4-2.5min-Nov14-1.md) · narrated walk-through:
[docs/judge/demo-script-player-v11.html](docs/judge/demo-script-player-v11.html).

## Built with: AI assistance and libraries

**AI assistance.** Claude (Anthropic) was used throughout to design, write, test and document the code, under the team's
direction and review; every change was run and tested before it was released (BUILD_LOG.md). At runtime the product
calls models by name: NEAR AI Cloud (attested), Amazon Bedrock, OpenRouter or local models.

**Libraries and components** (versions in each `package.json` / Dockerfile):

| Where | What |
|---|---|
| NEAR payments | `@x402/core`, `@x402/hono`, `@x402/near`, `@x402/extensions`; `@near-js/*` (crypto, providers, signers, transactions, utils); `borsh`; `@hot-labs/near-connect` (web wallet) |
| Paywall and web | `hono`, `@hono/node-server`; `esbuild` (wallet bundles) |
| Buyer agent | `@strands-agents/sdk`, `@aws-sdk/client-bedrock-runtime`, `zod` |
| Documents | `exceljs`, `mammoth`, `unpdf` |
| Analyst | `@duckdb/node-api` (DuckDB) |
| Privacy | Microsoft Presidio analyzer (Docker image `presidio-analyzer:2.2.362`) |
| Attestation | NEAR AI's official verifier, `nearai-cloud-verifier` (built in the ca-attest image) |
| Routing | `packages/route-engine`: a fork of `router-core` (see its `NOTICE` and `docs/adr/0001`) |
| XRPL rail (pre-hackathon) | `xrpl`, `x402-xrpl`, `@x402/xrpl`, `ripple-address-codec`, `@crossmarkio/sdk` |
| Runtime | Node.js 24 (`node:24-slim`), Docker Compose |

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
| agent (optional) | `ca-agent`, only with `up.ps1 -Agent on` | 127.0.0.1:8760 | Tab 03 agent mode: masks the question, asks a Strands agent on Bedrock, runs the paid job, signs the tenant's AP2 checkout mandate and pays it from the tenant's NEAR account |
| **control plane:** signer | `ca-control-signer`, its own compose project `chainaim-control-plane`, network `chainaim-control` | 127.0.0.1:8780 | ChainAim's signer: prices each job from sizes, signs the AP2 quote, verifies the agent's checkout mandate before the run, signs the receipt and its settlement. Holds ChainAim's two signing keys (from its own keys folder); sees sizes, ids, hashes and amounts only |

Every container above it is the **data plane**: your files, your question, the result and the unmasking stay there, and
none of them holds a ChainAim signing key (`.\test-console\desk.ps1 -Planes` checks this by variable name). The paywall
still runs on your PC too (moving it is on the roadmap).

```
Browser ── 8730 UI (PC) ──▶ console-api ──▶ analyst            (exact numbers from your files)
                               │      └────▶ gateway ──▶ Presidio (mask) ──▶ model (masked text only)
                               └──▶ paywall (x402: NEAR USDC / XRPL RLUSD) ──▶ gateway
paywall, console-api ──▶ near-watch (claims, job events) ──▶ admin UI 8800
console-api ──▶ ca-control-signer (control plane: price, AP2 quote, mandate check, receipt; sizes and hashes only)
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

Last full run (v2.3.0, 14 Nov 2026, Windows `desk.ps1 -Test`): all terminal suites pass, including the paywall's 384
and the analyst's 249. `npm test` first runs a dependency check that has known, older findings, so the first line above
runs the same suites without it.

## More

| File | What |
|---|---|
| [cmd.md](cmd.md) | Every command to set up, run, check and stop |
| [DOCKERIZE-PLAN.md](DOCKERIZE-PLAN.md) | Why and how the backend moved into Docker |
| [MANUAL_SETUP.md](MANUAL_SETUP.md) | Owner steps, dated |
| [architecture.md](architecture.md) | Paid jobs (tab 03) requirements |
| [STATE.md](STATE.md), [BUILD_LOG.md](BUILD_LOG.md) | Status and the record of what ran |

Never paste `docker inspect` or `docker compose config` output anywhere: both print secret values.
