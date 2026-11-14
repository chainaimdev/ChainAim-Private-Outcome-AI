# cmd.md — every command to run ChainAim Private AI (Windows PowerShell)

Backend in Docker, the 8730 UI on your PC. Run every command from the repository folder in a **standalone PowerShell
window** (not the VS Code terminal: it corrupts pasted secrets). Never paste a key, a seed, `docker inspect` or
`docker compose config` output into a chat.

The NEAR admin UI is a separate repo, **chainaim-adminUI-NEAR**. Both repos run together.

| Part | When | What |
|---|---|---|
| **PART 1 — One-time setup** | once per PC | tools, clone, packages, keys, secrets files, model mode, first start |
| **PART 2 — Run all containers and both UIs** | every day | two commands, admin UI repo first, then this repo |
| PART 3 — Check, stop, tests, troubleshooting | as needed | |

---

# PART 1 — One-time setup (once per PC)

Do the admin UI's one-time setup first (its `cmd.md`, PART 1: build the UI and create
`C:\PRIV-AI-SECRETS\near-watch.env`), then A1 to A6 below.

## A. One time on a new PC

### A1. Tools

Git, Node.js 24 (22.22+), Docker Desktop running with at least 4 GB memory. Ollama, for the local models of the team's
model mode (a PC without Ollama: see A5).

```powershell
node --version
docker version --format "{{.Server.Version}}"
git --version
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### A2. Clone both repos side by side, and the two private folders

```powershell
$ROOT = "<your-folder>"   # any folder; both repos are cloned side by side in it
New-Item -ItemType Directory -Force -Path $ROOT, C:\PRIV-AI-SECRETS, C:\PRIV-AI-DATA | Out-Null
cd $ROOT
git clone https://github.com/chainaimdev/ChainAim-Private-Outcome-AI.git chainaim-private-ai
git clone https://github.com/chainaimdev/chainaim-adminUI-NEAR.git
cd $ROOT\chainaim-private-ai
```

`C:\PRIV-AI-SECRETS` holds keys (never in git). `C:\PRIV-AI-DATA` holds your data files (mounted read-only).

### A3. Packages for the UI and the tests, and the local gateway key

```powershell
npm --prefix services\web ci
npm --prefix services\web run build:near-wallet
npm --prefix services\paywall ci
npm --prefix services\analyst ci
node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))"
```

Run the key line **once only**. Running it again after the gateway exists makes every call fail with HTTP 401.
The Docker images install their own packages; these installs are for the UI on the PC and for the tests.

### A4. Secrets files (values are shared privately; only names are listed here)

```powershell
Copy-Item test-console\near-testnet.env.example C:\PRIV-AI-SECRETS\near-testnet.env
notepad C:\PRIV-AI-SECRETS\near-testnet.env
```
Fill `NEAR_PAY_TO_TESTNET`, `NEAR_RELAYER_ACCOUNT_TESTNET`, `NEAR_RELAYER_KEY_TESTNET` (and `NEAR_RPC_URL_TESTNET` if
you were given one). Leave the USDC contract and decimals as they are.

The paid-jobs key, generated straight into its file and never printed:

```powershell
$k = node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
"PAID_JOBS_KEY=$k" | Set-Content -Encoding ascii C:\PRIV-AI-SECRETS\paid-jobs.env
Remove-Variable k
```

Model keys (optional file; without it, `switch-models.ps1` asks at hidden prompts — paste with a RIGHT-CLICK):

```powershell
notepad C:\PRIV-AI-SECRETS\chainaim.env
```
Lines: `OPENROUTER_API_KEY=...` and `BEDROCK_API_KEY=...`.

`C:\PRIV-AI-SECRETS\near-watch.env` is made by the admin UI's `cmd.md` (its `NEAR_WATCH_INGEST_KEY` is shared with
this stack).

Keep `chainaim.env` filled: after `down.ps1` no gateway container is left to take the model keys from, so `up.ps1`
reads them from this file (it prints `WARN` naming a key it cannot find, and `-Agent on` stops without `BEDROCK_API_KEY`).

**Agent mode only (optional):** the tenants' NEAR keys, copied from `near-testnet.env` into their own file without
showing them (the owner adds `NEAR_BUYER_KEY_TESTNET`, `NEAR_T02_KEY_TESTNET`, `NEAR_T03_KEY_TESTNET` to
`near-testnet.env` first; the relayer key is never copied):

```powershell
Get-Content C:\PRIV-AI-SECRETS\near-testnet.env | Where-Object { $_ -match '^\s*(NEAR_NETWORK|NEAR_RPC_URL_TESTNET|NEAR_USDC_CONTRACT_TESTNET|NEAR_BUYER_KEY_TESTNET|NEAR_T02_KEY_TESTNET|NEAR_T03_KEY_TESTNET)\s*=' } | Set-Content -Encoding ascii C:\PRIV-AI-SECRETS\agent-tenants.env
Get-Content C:\PRIV-AI-SECRETS\agent-tenants.env | ForEach-Object { ($_ -split '=')[0] }
```

The second line prints names only: the three key names (and the network settings), never `NEAR_RELAYER_KEY_...`.
Each key must be a full-access key of its tenant's account (MANUAL_SETUP.md, Tab 03 agent mode, M1).

### A5. Presidio image and the gateway's model mode (once; again only to change the mode)

```powershell
.\test-console\stack.ps1 -Rebuild presidio,gateway
.\test-console\switch-models.ps1 -To ollama-cpu-8gb-all
```

The first Presidio build takes several minutes (about 1.6 GB). `stack.ps1` ends with FAIL lines for the paywall and the
stand-in on a new PC; that is expected here. `switch-models.ps1` starts the gateway in the current team mode (local +
OpenRouter + Bedrock; `chainaim/auto` and health data stay local) and writes `config\generated\catalog.local.json`,
the catalog the paid-job prices use.

Optional, with a NEAR AI key (PLAN-private-ai-nearai-attestation.md): `.\test-console\switch-models.ps1 -To
ollama-cpu-8gb-all-nearai` is the same mode plus `nearai/deepseek-v4.1-flash` (DeepSeek V4.1 Flash in NEAR AI's TEE, zone
private-cloud, $0.30 / $1.20 per 1M tokens; it answers only when named in tab 03). It asks for `NEARAI_API_KEY` too
(hidden), unless it is in `C:\PRIV-AI-SECRETS\chainaim.env`; then `.\test-console\up.ps1 -ReplaceRunning`. The mode above
needs no NEAR AI key and is unchanged. Not live-tested yet: MANUAL_SETUP.md, "NEAR AI model + attestation".

**PC without Ollama:** add `-OllamaVariants off -SkipTest`. Bedrock and OpenRouter answer when named; `chainaim/auto`
needs a local model. (Not yet verified on a PC without Ollama.)

### A6. First start of the Docker stack

Start the admin UI first (its `cmd.md`, section B), then:

```powershell
.\test-console\up.ps1 -ReplaceRunning -Build -PayTo rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej
```

`-ReplaceRunning` replaces the containers A5 made with the compose ones. `-PayTo` is the team's public XRPL TestNet
pay-to address; it is needed only this first time. Later runs read it from the running paywall or, after `down.ps1`,
from `runtime\compose\last-start.json`, which `up.ps1` saves after every successful start (the gateway's model mode
and the XRPL pay-to; public values only, no keys, git-ignored).

The first start can take longer than 90 s while Presidio loads; if a service `did not answer`, see F.

Expected, in order: `OK` lines for Docker, the gateway mode, the NEAR rail, `paid jobs on: prices from
...config\paid-jobs-prices.conf`, claims and job feed to near-watch, `compose configuration is valid`, `REPLACE` lines,
the image build, `OK gateway / analyst / chain-query / console-api / UI answers`, then
`READY  http://127.0.0.1:8730` and a browser window.

---

# PART 2 — Run all containers and both UIs (every day)

## B. Start everything: two commands, in this order

```powershell
# 1. Admin UI repo: near-watch container + admin UI (8800)
cd <your-folder>\chainaim-adminUI-NEAR
.\nearadminup.ps1

# 2. This repo: the six backend containers + the console UI (8730)
cd <your-folder>\chainaim-private-ai
.\test-console\up.ps1
```

| Command | Containers it starts | UI it starts |
|---|---|---|
| 1. admin UI `.\nearadminup.ps1` | `ca-near-watch` | admin UI http://127.0.0.1:8800 (own window) |
| 2. private-ai `.\test-console\up.ps1` | `ca-presidio`, `ca-gateway`, `ca-paywall`, `ca-analyst`, `ca-chain-query`, `ca-console-api` | console UI http://127.0.0.1:8730 (own window, opens the browser) |

Open http://127.0.0.1:8730 and http://127.0.0.1:8800 (`127.0.0.1`, not `localhost`).

Stop both (PART 3, D): `.\test-console\down.ps1` here, then `.\down.ps1` in the admin UI repo.

**Or the same with ONE command** (from this repo): `.\test-console\desk.ps1`. It runs the admin repo's
`nearadminup.ps1`, then `.\test-console\up.ps1 -ReplaceRunning` (team prices, agent mode when possible, the gateway's
model mode from the running gateway or `runtime\compose\last-start.json`), then prints one READY table across both.
`-Stop` stops both, `-Check` reports only, `-Build` rebuilds the images, `-Agent` requires agent mode. No settings file is
needed (`config\local\desk.json` is optional). It stops with the fix named when there are no model keys (no
`chainaim.env` and no gateway container): run A5 once, or fill `chainaim.env` (A4).

| Situation | Command |
|---|---|
| After pulling code changes | `.\test-console\up.ps1 -Build` |
| After `switch-models.ps1` (it recreates ca-gateway outside compose) | `.\test-console\up.ps1 -ReplaceRunning` |
| Tab 03 free only (no paid jobs) | `.\test-console\up.ps1 -PaidJobs off` |
| Check everything without starting anything | `.\test-console\up.ps1 -DryRun` |
| Backend only, no UI window | `.\test-console\up.ps1 -NoUi` |
| With the OpenRouter stand-in (testing) | `.\test-console\up.ps1 -Test` |

### Paid-job prices: fixed by the run

`up.ps1` passes these to the console on every start; nothing to set by hand.

| Setting | Value |
|---|---|
| `PRICING_CATALOG` | `config/generated/catalog.local.json` |
| `FEE_PER_MODEL_CALL_USD` | 0.001 |
| `FEE_ANALYST_USD` | 0.002 |
| `NEAR_GAS_FEE_USD` | 0.002 |
| `MARGIN_PCT` | 20 |
| `MIN_PRICE_USD` | 0.01 |

Source: `config\paid-jobs-prices.conf` (committed, the team default). To change them for everyone, edit that file and
run `up.ps1` again. For one PC only, put a file with the same names at `C:\PRIV-AI-SECRETS\paid-jobs-settings.env`
(it wins when present), or pass `-PaidJobsSettings <file>`. The start-up line `paid jobs on: prices from ...` says which
file was used.

### Tab 03 agent mode (optional; off unless `-Agent on`)

An AI agent per tenant (t01, t02, t03) runs the tab 03 paid job and pays it by itself in USDC on NEAR from the tenant's
own account (architecture-tab03-agent-mode.md). One-time: MANUAL_SETUP.md, "Tab 03 agent mode" (M1 to M4). Then:

```powershell
# 1. Admin UI repo: near-watch with a buyer card per tenant (the list is in config\near-watch-watch.conf; add the t02/t03 lines there once)
cd <your-folder>\chainaim-adminUI-NEAR
.\nearadminup.ps1

# 2. This repo: the six containers plus ca-agent, and the console UI
cd <your-folder>\chainaim-private-ai
.\test-console\up.ps1 -Agent on -Build
```

In tab 03 tick "Pay with USDC · NEAR", then "Who pays? ( ) Me — Intear Wallet · ( ) AI agent [t02 ▾]". The agent's
steps show live (masked, job run, quoted, signed, settled, released), then the result. "Me" is the Intear flow, unchanged.
Without `-Agent on` (the default) there is no ca-agent container and no "Who pays?" choice. `.\test-console\down.ps1`
stops ca-agent too.

---

# PART 3 — Check, stop, tests, troubleshooting

## C. Check that it works

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
.\test-console\stack.ps1 -Check
foreach ($u in "http://127.0.0.1:8720/healthz","http://127.0.0.1:8740/healthz","http://127.0.0.1:8750/healthz","http://127.0.0.1:8735/data/config","http://127.0.0.1:8730/","http://127.0.0.1:8790/healthz") { try { $r = Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 5; "$($r.StatusCode)  $u" } catch { "FAIL  $u  $($_.Exception.Message)" } }
```

Expected: `ca-console-api`, `ca-paywall`, `ca-gateway`, `ca-presidio` (healthy), `ca-analyst`, `ca-chain-query`,
`ca-near-watch` all Up on 127.0.0.1; `All checks passed.`; six lines `200`.

Containers reach each other by name:

```powershell
docker exec ca-paywall node -e "fetch('http://near-watch:8790/healthz').then(r=>console.log('near-watch',r.status),e=>console.log('FAIL',e.message))"
docker exec ca-paywall node -e "fetch('http://console-api:8731/internal/jobs/x').then(r=>console.log('console-api internal',r.status),e=>console.log('FAIL',e.message))"
```

Expected: `near-watch 200`, `console-api internal 401` (reachable; refuses without the key).

End to end in the browser (http://127.0.0.1:8730):
1. Tab 03, "Ask across files" on a `/data/priv-ai-data/...` folder: an answer.
2. "Pay with USDC · NEAR": approve in Intear: an answer and a receipt.
3. Tab 03 with the pay box ticked: a quote, pay in Intear, the result is released.
4. Admin UI (http://127.0.0.1:8800): the job `quoted` → `released`; Reconcile `matched`.

Proof in the logs (no secrets in these):

```powershell
docker logs ca-paywall --since 15m 2>&1 | Select-String "payment_settled"
docker logs ca-console-api --since 15m 2>&1 | Select-String "paid-job|paid-chat"
```

---

## D. Stop

```powershell
# 1. This repo: console UI + six containers
cd <your-folder>\chainaim-private-ai
.\test-console\down.ps1

# 2. Admin UI repo: admin UI + ca-near-watch
cd <your-folder>\chainaim-adminUI-NEAR
.\down.ps1
```

The first stops the UI window and every container of this stack. Volumes (gateway ledger, analyst work, console run log), the
network and the images are kept. `-KeepUi` stops only the containers.

---

## E. Tests

```powershell
node --test "services/gateway/test/*.test.ts" "scripts/test/*.test.ts" "test-console/test/*.test.ts"
npm run test:paywall
npm --prefix packages\crossask test
npm --prefix services\web test
npm --prefix services\chain-query test
npm --prefix services\analyst test
```

Expected (2026-11-06, with tab 03 agent mode): 442, 292, 30, 133, 11, analyst 177 pass and 1 known failure (Windows
exit crash in reconcile-explain). Run tests in a fresh window, never one with `NEAR_*` values loaded.

---

## F. Logs and troubleshooting

| What | Command / fix |
|---|---|
| One service's log | `docker logs ca-<name> --tail 40` (gateway, paywall, console-api, analyst, chain-query, presidio) |
| `STOP port 8740 / 8750 / 8730 is in use` | An old `start-ui.ps1` window (analyst, chain-query, console) is open: close it, run `up.ps1` again |
| `STOP these containers were started by stack.ps1 / switch-models.ps1` | Run `.\test-console\up.ps1 -ReplaceRunning` |
| `STOP no ca-gateway to take the model mode from, and no saved last start` | Only before the first successful start: run A5 (`switch-models.ps1 -To ollama-cpu-8gb-all`), then `up.ps1 -ReplaceRunning` |
| `FAIL gateway did not answer ... within 90 s` | Usually Presidio still loading. `docker ps --filter name=ca-presidio` until `(healthy)`, then `.\test-console\up.ps1 -WaitSec 180` (add `-Agent on` if you use it) |
| `ca-presidio` `(unhealthy)`, its log (`docker logs --tail 30 ca-presidio`) stops at `Control socket listening` with no Presidio banner | Its first start hung: `docker restart ca-presidio`, wait until `(healthy)`, then `up.ps1 -WaitSec 180` |
| `switch-models.ps1`: `Presidio ... did not answer within 120000 ms` | Presidio is not running: `docker compose up -d presidio`, wait until `(healthy)`, run `switch-models.ps1` again |
| `WARN OPENROUTER_API_KEY / BEDROCK_API_KEY is not in ...chainaim.env` | After `down.ps1` the keys come from `C:\PRIV-AI-SECRETS\chainaim.env` only (A4): add them there |
| `HTTP 401` from the gateway | The key file changed after the gateway was made: do not regenerate it; run `switch-models.ps1` again, then `up.ps1 -ReplaceRunning` |
| Paid-job prices not what you expect | Read the `paid jobs on: prices from ...` line; a file at `C:\PRIV-AI-SECRETS\paid-jobs-settings.env` overrides the team file |
| Admin UI page does not open | Use `http://127.0.0.1:8800`, not `localhost` |

## G. Back to the old way (no Docker for the console, analyst and chain-query)

```powershell
.\test-console\down.ps1
.\test-console\desk.ps1 -Restart -RebuildPaywall
```

`desk.ps1` needs `config\local\desk.json` (copy `config\local\desk.example.json` and set its fees). `start-ui.ps1`,
`stack.ps1` and `switch-models.ps1` also still work as before.
