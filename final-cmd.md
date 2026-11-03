# Project 1 - Private AI

## One time

```powershell
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainiam-private-ai
docker network create chainaim-test
node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))"
npm --prefix services\paywall ci
npm --prefix services\analyst ci
copy config\data-sources.example.json config\data-sources.json
```

## Docker

```powershell
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainiam-private-ai
.\test-console\stack.ps1 -Rebuild all -XrplNetwork testnet -PayTo rYOUR_TESTNET_ADDRESS
.\test-console\switch-models.ps1 -To ollama-cpu-8gb-all
.\test-console\stack.ps1 -Check
```

## Docker (with Live Ops)

```powershell
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainiam-private-ai
.\test-console\stack.ps1 -Recreate paywall -PaymentLogUrl http://host.docker.internal:8790/ingest/claim -PaymentLogKeyFile C:\PRIV-AI-SECRETS\ledger-watch.env
```

## UI

```powershell
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainiam-private-ai
.\test-console\start-ui.ps1
```

http://127.0.0.1:8730

## Stop

```powershell
docker stop ca-paywall ca-gateway ca-presidio ca-openrouter-stub
```
