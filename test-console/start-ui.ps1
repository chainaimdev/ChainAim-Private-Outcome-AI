<#
Starts everything the test console UI needs, in order, and opens it. Safe to run again: whatever is
already running is kept (use -RestartConsole / -RestartAnalyst to replace those two).

  .\test-console\start-ui.ps1                       start what is missing, then open http://127.0.0.1:8730
  .\test-console\start-ui.ps1 -RestartConsole       also restart the console (after a code change)
  .\test-console\start-ui.ps1 -RestartAnalyst       also restart the analyst (after a code change)
  .\test-console\start-ui.ps1 -RestartChainQuery    also restart chain-query (after a code change)
  .\test-console\start-ui.ps1 -NoChainQuery         do not start chain-query (the Blockchain queries twisty then says so)
  .\test-console\start-ui.ps1 -NoBrowser            do not open the browser
  .\test-console\start-ui.ps1 -RestartAll           restart everything: docker restart of the four containers (same
                                                    settings; use stack.ps1 -Recreate to change settings), then the
                                                    analyst, chain-query and console windows
  .\test-console\start-ui.ps1 -RunLog full -RestartConsole
                                                    save every "Ask across files" run with its result rows, answer and
                                                    model replies in test-console\runs\crossask-YYYY-MM-DD.jsonl (synthetic
                                                    data only). -RunLog meta (default): no data values; -RunLog off: nothing.
                                                    -RunLogDir PATH to save elsewhere (privateAI-design-31 s3).
  .\test-console\start-ui.ps1 -NearWallet intear-wallet -RestartConsole
                                                    start the console with the "Pay with USDC - NEAR" box
                                                    (--near-wallet; MANUAL_SETUP.md "Test console: pay in USDC on NEAR").
                                                    The paywall must offer NEAR too (PAY_RAILS=xrpl,near), which the
                                                    ca-paywall container created by stack.ps1 does not set today.

  -ModelsFile    the model list the console shows (default config\local-models.cpu-all.json)
  -ConsolePort   default 8730       -AnalystPort  default 8740      -GatewayPort  default 8720      -ChainQueryPort default 8750
  -WaitSec       how long to wait for each service to answer (default 40)

Steps:
  1. Docker Desktop is running (else: stop with what to do).
  2. The four containers exist; any that are stopped are started (docker start). A missing ca-gateway is NOT
     created here: it needs the model keys at hidden prompts -> run switch-models.ps1 -To ollama-cpu-8gb-all.
  3. The gateway answers /healthz.
  4. The analyst (port 8740) and the console (port 8730) run, each in its own window; started if not running.
  5. Opens the browser.
It never asks for, reads or prints a key. ASCII only (Windows PowerShell 5.1).
#>
param(
  [string]$ModelsFile = "config\local-models.cpu-all.json",
  [int]$ConsolePort = 8730,
  [int]$AnalystPort = 8740,
  [int]$GatewayPort = 8720,
  [int]$WaitSec = 40,
  [switch]$RestartConsole,
  [switch]$RestartAnalyst,
  [int]$ChainQueryPort = 8750,
  [switch]$RestartChainQuery,
  [switch]$NoChainQuery,
  [switch]$NoBrowser,
  [switch]$RestartAll,
  [ValidateSet("", "intear-wallet")][string]$NearWallet = "",
  [ValidateSet("off", "meta", "full")][string]$RunLog = "meta",
  [string]$RunLogDir = ""
)
$ErrorActionPreference = "Stop"
if ($RestartAll) { $RestartConsole = $true; $RestartAnalyst = $true; $RestartChainQuery = $true }
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
function Say([string]$tag, [string]$text) { Write-Host ("{0,-6} {1}" -f $tag, $text) }
function Stop-Here([string]$text) { Say "STOP" $text; exit 1 }
function Listening([int]$port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Stop-Port([int]$port) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}
function Wait-Http([string]$url, [string]$what) {
  $deadline = (Get-Date).AddSeconds($WaitSec)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -lt 500) { Say "OK" "$what answers ($url)"; return $true } } catch { }
    Start-Sleep -Seconds 2
  }
  Say "FAIL" "$what did not answer at $url within $WaitSec s"
  return $false
}

# 1. Docker
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
& docker info *> $null; $dockerOk = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prev
if (-not $dockerOk) { Stop-Here "Docker Desktop is not running. Start it, wait for 'Engine running', then run this again." }
Say "OK" "Docker is running"

# 2. Containers
foreach ($name in @("ca-presidio", "ca-openrouter-stub", "ca-gateway", "ca-paywall")) {
  $ErrorActionPreference = "Continue"
  $state = (& docker inspect --format "{{.State.Status}}" $name 2>$null)
  $exists = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = "Stop"
  if (-not $exists) {
    if ($name -eq "ca-gateway") { Stop-Here "ca-gateway does not exist. Run: .\test-console\switch-models.ps1 -To ollama-cpu-8gb-all  (it asks for the model keys), then run this again." }
    Stop-Here "$name does not exist. Run: .\test-console\stack.ps1 -Rebuild all  (or see DESIGN\README.md section 1), then run this again."
  }
  if ($RestartAll -and $state -eq "running") {
    Say "RESTART" "$name (docker restart; same settings)"
    & docker restart $name | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Here "docker restart $name failed; see the message above." }
  } elseif ($state -ne "running") {
    Say "START" "$name was $state"
    & docker start $name | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Here "docker start $name failed; see the message above." }
  } else { Say "OK" "$name running" }
}

# 3. Gateway
if (-not (Wait-Http "http://127.0.0.1:$GatewayPort/healthz" "gateway")) { Stop-Here "Check: docker logs ca-gateway --tail 30" }

# 4. Analyst and console, each in its own window
if ($RestartAnalyst -and (Listening $AnalystPort)) { Say "STOP" "analyst on $AnalystPort (restart asked)"; Stop-Port $AnalystPort }
if (Listening $AnalystPort) { Say "OK" "analyst already running on $AnalystPort" }
else { Say "START" "analyst (its own window; keep it open)"; Start-Process (Join-Path $PSScriptRoot "start-analyst.cmd") -WorkingDirectory $PSScriptRoot }
if (-not (Wait-Http "http://127.0.0.1:$AnalystPort/healthz" "analyst")) { Stop-Here "Look at the analyst window for the error." }

# 4b. chain-query (read-only chain queries for the Blockchain queries twisty), its own window
if (-not $NoChainQuery) {
  if ($RestartChainQuery -and (Listening $ChainQueryPort)) { Say "STOP" "chain-query on $ChainQueryPort (restart asked)"; Stop-Port $ChainQueryPort }
  if (Listening $ChainQueryPort) { Say "OK" "chain-query already running on $ChainQueryPort" }
  else { Say "START" "chain-query (its own window; keep it open)"; Start-Process (Join-Path $PSScriptRoot "start-chain-query.cmd") -ArgumentList @("--port", "$ChainQueryPort") -WorkingDirectory $PSScriptRoot }
  if (-not (Wait-Http "http://127.0.0.1:$ChainQueryPort/healthz" "chain-query")) { Say "WARN" "chain-query did not start; the console still works without the Blockchain queries twisty. Look at its window." }
}

if (-not (Test-Path (Join-Path $repo $ModelsFile))) { Stop-Here "model list not found: $ModelsFile" }
if ($RestartConsole -and (Listening $ConsolePort)) { Say "STOP" "console on $ConsolePort (restart asked)"; Stop-Port $ConsolePort }
if (Listening $ConsolePort) { Say "OK" "console already running on $ConsolePort" }
else {
  Say "START" "console (its own window; keep it open), models from $ModelsFile"
  $near = if ($NearWallet) { " --near-wallet $NearWallet" } else { "" }
  if ($NearWallet) { Say "INFO" "console with NEAR wallet $NearWallet (bundle: services\web\public\near-wallet.js)" }
  $runLogArgs = " --run-log $RunLog" + $(if ($RunLogDir) { " --run-log-dir '$RunLogDir'" } else { "" })
  Say "INFO" "run log: $RunLog$(if ($RunLog -ne 'off') { ' -> ' + $(if ($RunLogDir) { $RunLogDir } else { 'test-console\runs' }) })"
  $cmd = "Set-Location '$repo'; node test-console\console\server.ts --models-file '$ModelsFile' --port $ConsolePort --chain-query http://127.0.0.1:$ChainQueryPort$near$runLogArgs"
  Start-Process powershell -ArgumentList @("-NoExit", "-Command", $cmd)
}
if (-not (Wait-Http "http://127.0.0.1:$ConsolePort/" "console")) { Stop-Here "Look at the console window for the error." }

# 5. Browser
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$ConsolePort" }
Say "READY" "http://127.0.0.1:$ConsolePort  (keep the analyst and console windows open; close them to stop)"
