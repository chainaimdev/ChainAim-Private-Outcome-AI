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

Git, Node.js 24 (22.22+), Docker Desktop running with at least 4 GB memory.

```powershell
node --version
docker version --format "{{.Server.Version}}"
git --version
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### A2. Clone both repos side by side, and the two private folders

```powershell
$ROOT = "C:\SATHYA\CHAINAIM3003\mcp-servers"
New-Item -ItemType Directory -Force -Path $ROOT, C:\PRIV-AI-SECRETS, C:\PRIV-AI-DATA | Out-Null
cd $ROOT
git clone https://github.com/chainaimdev/chainaim-private-ai.git chainiam-private-ai
git clone https://github.com/chainaimdev/chainaim-adminUI-NEAR.git
cd $ROOT\chainiam-private-ai
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

### A5. Presidio image and the gateway's model mode (once; again only to change the mode)

```powershell
.\test-console\stack.ps1 -Rebuild presidio,gateway
.\test-console\switch-models.ps1 -To ollama-cpu-8gb-all
```

The first Presidio build takes several minutes (about 1.6 GB). `stack.ps1` ends with FAIL lines for the paywall and the
stand-in on a new PC; that is expected here. `switch-models.ps1` starts the gateway in the current team mode (local +
OpenRouter + Bedrock; `chainaim/auto` and health data stay local) and writes `config\generated\catalog.local.json`,
the catalog the paid-job prices use.

**PC without Ollama:** add `-OllamaVariants off -SkipTest`. Bedrock and OpenRouter answer when named; `chainaim/auto`
needs a local model. (Not yet verified on a PC without Ollama.)

### A6. First start of the Docker stack

Start the admin UI first (its `cmd.md`, section B), then:

```powershell
.\test-console\up.ps1 -ReplaceRunning -Build -PayTo rn5hSy7QvsrQLpGb3k5dp4h8Yrk9J7gBej
```

`-ReplaceRunning` replaces the containers A5 made with the compose ones. `-PayTo` is the team's public XRPL TestNet
pay-to address; it is needed only this first time (later runs read it from the running paywall).

Expected, in order: `OK` lines for Docker, the gateway mode, the NEAR rail, `paid jobs on: prices from
...config\paid-jobs-prices.conf`, claims and job feed to near-watch, `compose configuration is valid`, `REPLACE` lines,
the image build, `OK gateway / analyst / chain-query / console-api / UI answers`, then
`READY  http://127.0.0.1:8730` and a browser window.

---

# PART 2 — Run all containers and both UIs (every day)

## B. Start everything: two commands, in this order

```powershell
# 1. Admin UI repo: near-watch container + admin UI (8800)
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainaim-adminUI-NEAR
.\up.ps1

# 2. This repo: the six backend containers + the console UI (8730)
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainiam-private-ai
.\test-console\up.ps1
```

| Command | Containers it starts | UI it starts |
|---|---|---|
| 1. admin UI `.\up.ps1` | `ca-near-watch` | admin UI http://127.0.0.1:8800 (own window) |
| 2. private-ai `.\test-console\up.ps1` | `ca-presidio`, `ca-gateway`, `ca-paywall`, `ca-analyst`, `ca-chain-query`, `ca-console-api` | console UI http://127.0.0.1:8730 (own window, opens the browser) |

Open http://127.0.0.1:8730 and http://127.0.0.1:8800 (`127.0.0.1`, not `localhost`).

Stop both (PART 3, D): `.\test-console\down.ps1` here, then `.\down.ps1` in the admin UI repo.

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
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainiam-private-ai
.\test-console\down.ps1

# 2. Admin UI repo: admin UI + ca-near-watch
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainaim-adminUI-NEAR
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

Expected (2026-11-06): 427, 274, 30, 133, 11, analyst 177 pass and 1 known failure (Windows exit crash in
reconcile-explain). Run tests in a fresh window, never one with `NEAR_*` values loaded.

---

## F. Logs and troubleshooting

| What | Command / fix |
|---|---|
| One service's log | `docker logs ca-<name> --tail 40` (gateway, paywall, console-api, analyst, chain-query, presidio) |
| `STOP port 8740 / 8750 / 8730 is in use` | An old `start-ui.ps1` window (analyst, chain-query, console) is open: close it, run `up.ps1` again |
| `STOP these containers were started by stack.ps1 / switch-models.ps1` | Run `.\test-console\up.ps1 -ReplaceRunning` |
| `STOP no ca-gateway to take the model mode from` | Run A5 (`switch-models.ps1 -To ollama-cpu-8gb-all`), then `up.ps1 -ReplaceRunning` |
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
