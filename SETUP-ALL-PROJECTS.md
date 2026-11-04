# Run all three ChainAim projects on a new Windows PC (start to end)

Projects, in dependency order:

| # | Repo | UI | Depends on |
|---|---|---|---|
| 1 | chainiam-private-ai | http://127.0.0.1:8730 | Docker |
| 2 | chainaim-creditseal | http://127.0.0.1:8750 | Project 1's folder (fixture script) |
| 3 | chainaim-liveops | http://127.0.0.1:8800 | Project 1 paywall (8080) + Project 2 Desk (8750) |

All commands are **Windows PowerShell**, run in a **standalone PowerShell window**
(not the VS Code terminal — it corrupts pasted secrets; see RUN-ON-ANOTHER-PC.md trap 2).

---

## 0. Prerequisites (install once)

- Git
- Node.js 24 (22.22+ minimum)
- Docker Desktop, running, with at least 4 GB memory (Presidio needs ~2 GB)
- Free ports: 5004, 8080, 8720, 8730, 8740, 8750, 8790, 8800
- Optional: Ollama (only for local models), an OpenRouter key (only for real hosted answers)

```powershell
node --version
docker version --format "{{.Server.Version}}"
git --version
```

Allow local scripts for this window:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---

## 1. Clone the three repos side by side

They MUST be siblings: CreditSeal calls a script from chainiam-private-ai by relative path.

```powershell
$ROOT = "$HOME\chainaim"
$SECRETS = "$HOME\chainaim-secrets"
New-Item -ItemType Directory -Force -Path $ROOT, $SECRETS | Out-Null
cd $ROOT
git clone https://github.com/chainaimdev/chainiam-private-ai.git
git clone https://github.com/chainaimdev/chainaim-creditseal.git
git clone https://github.com/chainaimdev/chainaim-liveops.git
```

`$SECRETS` replaces the author's `C:\PRIV-AI-SECRETS`. Every script below receives it as a flag.
Never put it inside a repo. If you open a new window later, set `$ROOT` and `$SECRETS` again.

---

## 2. Project 1 — Private AI (privacy gateway + paywall + test console)

### 2.1 One time

```powershell
cd $ROOT\chainiam-private-ai
docker network create chainaim-test
node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))"
npm --prefix services\paywall ci
npm --prefix services\analyst ci
copy config\data-sources.example.json config\data-sources.json
```

Do not regenerate `local-gateway-key.txt` after the gateway container exists (causes HTTP 401).

### 2.2 XRPL Testnet pay-to address (manual)

You need an XRPL Testnet classic address (`r...`), funded, with an RLUSD trust line.
Follow `MANUAL_SETUP.md` in this repo. Keep the seed in a password manager; only the `r...` address is used below.

### 2.3 Build and start the containers

```powershell
cd $ROOT\chainiam-private-ai
.\test-console\stack.ps1 -Rebuild all -XrplNetwork testnet -PayTo rYOUR_TESTNET_ADDRESS
.\test-console\use-stand-in.cmd
.\test-console\stack.ps1 -Check
```

`use-stand-in.cmd` = echo models, no Ollama or OpenRouter needed. Alternatives:
- Local models (needs Ollama + models pulled): `.\test-console\switch-models.ps1 -To ollama-cpu-8gb-all`
- Real hosted models: see RUN-ON-ANOTHER-PC.md section 10, then `.\test-console\use-real-models.cmd`

### 2.4 Verify, then start the UI

```powershell
curl.exe -s http://127.0.0.1:8720/healthz
curl.exe -s http://127.0.0.1:8080/healthz
.\test-console\start-ui.ps1
```

Both health checks must print `{"status":"ok"}` (the gateway can take up to ~120 s on first start).
Open http://127.0.0.1:8730

---

## 3. Project 2 — CreditSeal Desk (XRPL Devnet lending)

### 3.1 One time: packages and demo books

```powershell
cd $ROOT\chainaim-creditseal\services\lending
npm ci
node scripts/make-borrower-books.ts --out ..\..\data\lending\books\orion
node scripts/make-borrower-books.ts --profile jupiter --out ..\..\data\lending\books\jupiter-knitting
node ..\..\..\chainiam-private-ai\services\analyst\scripts\make-finance-fixtures.ts --kind smb --out ..\..\data\lending\books\mercury-textiles
copy demo\mercury-textiles\*.json ..\..\data\lending\books\mercury-textiles\
```

### 3.2 One time: Devnet accounts, token, vault

Creates new Devnet accounts and writes their seeds to `$SECRETS\lending-devnet.env`.

```powershell
node scripts/lending.ts accounts --secrets-out $SECRETS\lending-devnet.env
node scripts/lending.ts issue --env-file $SECRETS\lending-devnet.env
node scripts/lending.ts cycle --env-file $SECRETS\lending-devnet.env
node scripts/lending.ts mint --env-file $SECRETS\lending-devnet.env --to borrower --amount 1000
```

### 3.3 Start the Desk

```powershell
powershell -ExecutionPolicy Bypass -File .\start-desk.ps1 -NoChat -EnvFile $SECRETS\lending-devnet.env
```

If the bank view hangs, the default ACTUS server (`-ActusUrl http://34.203.247.32:8083`) is unreachable from
this PC; add `-ActusUrl ""` to turn it off.

Open http://127.0.0.1:8750 and keep this window open. Check from another window:

```powershell
Invoke-RestMethod http://127.0.0.1:8750/api/state
```

---

## 4. Project 3 — Live Ops (ledger-watch + admin console + payment stream)

Needs Project 1 (paywall on 8080) and Project 2 (Desk on 8750) running.

### 4.1 One time: packages and console build

```powershell
cd $ROOT\chainaim-liveops
npm --prefix services\ledger-watch ci
npm --prefix services\stream ci
npm --prefix apps\admin-console ci
npm --prefix apps\admin-console run build
```

### 4.2 One time: secrets files

`$SECRETS\ledger-watch.env` — two random keys (24+ chars, must differ) plus your pay-to address:

```powershell
$k1 = node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
$k2 = node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
Set-Content -Encoding ascii -Path $SECRETS\ledger-watch.env -Value @(
  "ADMIN_API_KEY=$k1",
  "LEDGER_WATCH_INGEST_KEY=$k2",
  "XRPL_PAY_TO_TESTNET=rYOUR_TESTNET_ADDRESS"
)
```

Optional in the same file: `QUICKNODE_XRPL_WSS_TESTNET=` and `QUICKNODE_XRPL_HTTP_TESTNET=`
(ledger-watch runs with `--fallback-public on`, so public servers are used without them).

`$SECRETS\rig-testnet.env` — Testnet seeds for the three tenants (only for the RLUSD payment lane):

```
XRPL_SEED_T01_TESTNET=s...
XRPL_SEED_T02_TESTNET=s...
XRPL_SEED_T03_TESTNET=s...
```

Each seed must belong to the `address` in `rig/tenants/t0N/tenant.json`. With new accounts, update those
`address` fields (and fund them with XRP + RLUSD trust lines).

Your own Devnet addresses go in `test-console\live-ops.watch.txt` (the committed ones are the author's):
take them from `chainaim-creditseal\data\lending\devnet-run.json`.

### 4.3 Connect the paywall's payment log to ledger-watch (in Project 1)

```powershell
cd $ROOT\chainiam-private-ai
.\test-console\stack.ps1 -Recreate paywall -PaymentLogUrl http://host.docker.internal:8790/ingest/claim -PaymentLogKeyFile $SECRETS\ledger-watch.env
```

### 4.4 First start (writes the Devnet token file), then the TUSD lane setup

```powershell
cd $ROOT\chainaim-liveops
.\test-console\start-live.ps1 -SecretsDir $SECRETS
```

The first run stops at "rig-devnet.env is missing" after saving `data\live\devnet-asset.json`. Then:

```powershell
cd $ROOT\chainaim-liveops\services\stream
node --env-file=$SECRETS\rig-testnet.env --env-file=$SECRETS\lending-devnet.env scripts/stream.ts setup-devnet --asset-file $ROOT\chainaim-liveops\data\live\devnet-asset.json --secrets-out $SECRETS\rig-devnet.env
cd $ROOT\chainaim-liveops
.\test-console\start-live.ps1 -SecretsDir $SECRETS
```

Open http://127.0.0.1:8800

Variants:

```powershell
.\test-console\start-live.ps1 -SecretsDir $SECRETS -Lanes rlusd     # no TUSD lane (skips 4.4 setup-devnet)
.\test-console\start-live.ps1 -SecretsDir $SECRETS -NoStream        # watch only, no payments
.\test-console\start-live.ps1 -SecretsDir $SECRETS -RestartLedgerWatch -RestartConsole -RestartStream
```

---

## 5. Daily start (after the one-time steps)

```powershell
$ROOT = "$HOME\chainaim"; $SECRETS = "$HOME\chainaim-secrets"
cd $ROOT\chainiam-private-ai; .\test-console\stack.ps1 -Check; .\test-console\start-ui.ps1
# new window:
cd $ROOT\chainaim-creditseal\services\lending; powershell -ExecutionPolicy Bypass -File .\start-desk.ps1 -NoChat -EnvFile $SECRETS\lending-devnet.env
# new window:
cd $ROOT\chainaim-liveops; .\test-console\start-live.ps1 -SecretsDir $SECRETS
```

Containers do not auto-start after a reboot: `stack.ps1 -Check` names the fix for each FAIL.

## 6. Stop / remove

```powershell
docker stop ca-paywall ca-gateway ca-presidio ca-openrouter-stub
# close the Desk window (Ctrl+C) and the three Live Ops windows
docker rm -f ca-paywall ca-gateway ca-openrouter-stub ca-presidio
docker volume rm chainaim-test-ledger
docker network rm chainaim-test
```
