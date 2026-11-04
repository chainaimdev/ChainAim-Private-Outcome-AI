# Private AI — setup and run commands (Windows PowerShell)

Run in a standalone PowerShell window (not the VS Code terminal).
Prerequisites: Git, Node.js 24 (22.22+), Docker Desktop running with 4 GB+ memory.

## 0. Check tools

```powershell
node --version
docker version --format "{{.Server.Version}}"
git --version
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## 1. Clone (all three repos must sit side by side)

```powershell
$ROOT = "$HOME\chainaim"
$SECRETS = "$HOME\chainaim-secrets"
New-Item -ItemType Directory -Force -Path $ROOT, $SECRETS | Out-Null
cd $ROOT
git clone https://github.com/chainaimdev/chainiam-private-ai.git
cd $ROOT\chainiam-private-ai
```

## 2. One time

```powershell
docker network create chainaim-test
node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))"
npm --prefix services\paywall ci
npm --prefix services\analyst ci
copy config\data-sources.example.json config\data-sources.json
```

Do not run the key command again once the `ca-gateway` container exists (it causes HTTP 401).

## 3. Build and start the containers

Replace `rYOUR_TESTNET_ADDRESS` with your XRPL Testnet address (funded, RLUSD trust line; see MANUAL_SETUP.md).

```powershell
.\test-console\stack.ps1 -Rebuild all -XrplNetwork testnet -PayTo rYOUR_TESTNET_ADDRESS
.\test-console\use-stand-in.cmd
.\test-console\stack.ps1 -Check
```

Model modes (pick one):

```powershell
.\test-console\use-stand-in.cmd                              # echo models, nothing else needed
.\test-console\switch-models.ps1 -To ollama-cpu-8gb-all      # needs Ollama installed with the models
.\test-console\use-real-models.cmd                           # needs $env:OPENROUTER_API_KEY set first
```

## 4. Verify

```powershell
curl.exe -s http://127.0.0.1:8720/healthz
curl.exe -s http://127.0.0.1:8080/healthz
```

Both must print `{"status":"ok"}` (the gateway can take up to 120 s on first start).

## 5. Start the UI

```powershell
.\test-console\start-ui.ps1
```

Open http://127.0.0.1:8730

## 6. Optional: send payment logs to Live Ops (after chainaim-liveops is set up)

```powershell
.\test-console\stack.ps1 -Recreate paywall -PaymentLogUrl http://host.docker.internal:8790/ingest/claim -PaymentLogKeyFile $SECRETS\ledger-watch.env
```

## 7. Tests (optional)

```powershell
npm test
npm run test:paywall
npm --prefix services\analyst test
```

## Daily start

```powershell
cd $HOME\chainaim\chainiam-private-ai
.\test-console\stack.ps1 -Check
.\test-console\start-ui.ps1
```

## Stop / remove

```powershell
docker stop ca-paywall ca-gateway ca-presidio ca-openrouter-stub
docker rm -f ca-paywall ca-gateway ca-openrouter-stub ca-presidio
docker volume rm chainaim-test-ledger
docker network rm chainaim-test
```
