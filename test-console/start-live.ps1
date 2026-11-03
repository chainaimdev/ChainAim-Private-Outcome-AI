<#
Starts everything Live Ops needs, in order, so the console at http://127.0.0.1:8800 shows real, validated XRPL
activity the moment it opens: ledger-watch (the feeds), the admin console, and the payment stream (real RLUSD
payments on Testnet and TUSD payments on Devnet, from the tenants' own wallets). Safe to run again: whatever is
already running is kept unless a -Restart... switch says otherwise.

  .\test-console\start-live.ps1                         start what is missing, then open the console
  .\test-console\start-live.ps1 -RestartStream          also restart the payment stream (after a code change)
  .\test-console\start-live.ps1 -RestartLedgerWatch     also restart ledger-watch (after a code or watch-list change)
  .\test-console\start-live.ps1 -RestartConsole         also rebuild-free restart of the console
  .\test-console\start-live.ps1 -NoStream               watch only: start no payments
  .\test-console\start-live.ps1 -NoBrowser              do not open the browser

  -SecretsDir     folder with the env files (default C:\PRIV-AI-SECRETS): ledger-watch.env, rig-testnet.env,
                  rig-devnet.env (written by "stream.ts setup-devnet"), lending-devnet.env (services/lending accounts)
  -LendingEnv     the lending secrets file (default <SecretsDir>\lending-devnet.env)
  -WatchFile      extra --watch specs, one per line (default test-console\live-ops.watch.txt)
  -RatePerMin     payments per minute per lane (default 6)      -Mode  auto | x402 | direct (default auto)
  -Lanes          rlusd,tusd (default both)                     -TestnetWs  a Testnet wss:// server (default: the stream's)
  -PayTo rADDRESS  the paywall's pay-to (the RLUSD Seller Wallet). Default: XRPL_PAY_TO_TESTNET from the running
                  ca-paywall container (the address the paywall really quotes), else from ledger-watch.env
  -LedgerWatchPort 8790   -ConsolePort 8800   -PaywallPort 8080   -WaitSec 90
  -BackfillLedgers 60000  (ledger-watch's first-start history)

Steps:
  1. The secrets files exist (never read here: only passed to node with --env-file).
  2. Docker and the paywall (ca-paywall) are up; a stopped container is started. Without the paywall the stream
     still pays (mode auto falls back to direct RLUSD payments), so this is a warning, not a stop.
  3. ledger-watch runs on -LedgerWatchPort (own window + log in data\live\), with Devnet's token TUSD read from
     data\lending\devnet-run.json; waits for /healthz.
  4. The console runs on -ConsolePort (needs "npm run build" once in apps\admin-console); waits until it answers.
  5. The payment stream runs (own window + log); its process id is kept in data\live\stream.pid.
  6. Opens the console.
It never asks for, reads or prints a seed or a key. ASCII only (Windows PowerShell 5.1).
#>
param(
  [string]$SecretsDir = "C:\PRIV-AI-SECRETS",
  [string]$LendingEnv = "",
  [string]$WatchFile = "test-console\live-ops.watch.txt",
  [double]$RatePerMin = 6,
  [ValidateSet("auto", "x402", "direct")][string]$Mode = "auto",
  [string]$Lanes = "rlusd,tusd",
  [string]$TestnetWs = "",
  [string]$PayTo = "",
  [int]$LedgerWatchPort = 8790,
  [int]$ConsolePort = 8800,
  [int]$PaywallPort = 8080,
  [int]$WaitSec = 90,
  [int]$BackfillLedgers = 60000,
  [switch]$RestartLedgerWatch,
  [switch]$RestartConsole,
  [switch]$RestartStream,
  [switch]$NoStream,
  [switch]$NoBrowser
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
if (-not $LendingEnv) { $LendingEnv = Join-Path $SecretsDir "lending-devnet.env" }
$liveDir = Join-Path $repo "data\live"
New-Item -ItemType Directory -Force -Path $liveDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Say([string]$tag, [string]$text) { Write-Host ("{0,-6} {1}" -f $tag, $text) }
function Stop-Here([string]$text) { Say "STOP" $text; exit 1 }
function Listening([int]$port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Stop-Port([int]$port) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { & taskkill /PID $_.OwningProcess /T /F *> $null }
  Start-Sleep -Seconds 2
}
function Wait-Http([string]$url, [string]$what, [int]$sec = $WaitSec) {
  $deadline = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -lt 500) { Say "OK" "$what answers ($url)"; return $true } } catch { }
    Start-Sleep -Seconds 2
  }
  Say "FAIL" "$what did not answer at $url within $sec s"
  return $false
}
# A window running one command, its output also kept in a log file; returns the window's process. Values this shell
# may hold from earlier manual runs are cleared in the window first, so the --env-file values are the ones used
# (node's --env-file never overrides a variable that is already set).
# The pay-to (a public address, -PayTo or the paywall container's) is set in the window after the clear, so it wins
# over the env file and over anything stale.
function Start-Window([string]$title, [string]$dir, [string]$command, [string]$log) {
  $clear = "Remove-Item Env:ADMIN_API_KEY, Env:LEDGER_WATCH_INGEST_KEY, Env:XRPL_PAY_TO_TESTNET -ErrorAction SilentlyContinue"
  $set = ""
  if ($script:PayTo) { $set = "`$env:XRPL_PAY_TO_TESTNET = '$($script:PayTo)'; " }
  $inner = "`$Host.UI.RawUI.WindowTitle = '$title'; $clear; $set Set-Location '$dir'; $command 2>&1 | Tee-Object -FilePath '$log'"
  return Start-Process powershell -PassThru -WorkingDirectory $dir -ArgumentList @("-NoExit", "-NoProfile", "-Command", $inner)
}

# 1. Secrets files (names only; their contents are read by node, never by this script)
$lwEnv = Join-Path $SecretsDir "ledger-watch.env"
$testnetEnv = Join-Path $SecretsDir "rig-testnet.env"
$devnetEnv = Join-Path $SecretsDir "rig-devnet.env"
if (-not (Test-Path $lwEnv)) { Stop-Here "$lwEnv is missing (ADMIN_API_KEY, LEDGER_WATCH_INGEST_KEY, XRPL_PAY_TO_TESTNET)." }
$laneSet = @($Lanes.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if (-not $NoStream) {
  if ($laneSet -contains "rlusd" -and -not (Test-Path $testnetEnv)) { Stop-Here "$testnetEnv is missing (the tenants' Testnet seeds)." }
  if ($laneSet -contains "tusd") {
    if (-not (Test-Path $LendingEnv)) { Stop-Here "$LendingEnv is missing (LENDING_ISSUER_SEED_DEVNET, LENDING_CHAINAIM_SEED_DEVNET). Pass -LendingEnv <file> or -Lanes rlusd." }
    if (-not (Test-Path $devnetEnv)) { Stop-Here "$devnetEnv is missing: run once, in services\paywall:  node --env-file=$testnetEnv --env-file=$LendingEnv scripts/stream.ts setup-devnet --secrets-out $devnetEnv   (then run this again)" }
  }
}
Say "OK" "secrets files present in $SecretsDir (not read here)"

# Devnet's token for ledger-watch, from the lending demo's state (public: code, currency, issuer).
$stateFile = Join-Path $repo "data\lending\devnet-run.json"
$assetFlag = ""
if (Test-Path $stateFile) {
  $asset = (Get-Content $stateFile -Raw | ConvertFrom-Json).asset
  if ($asset -and $asset.code -and $asset.issuer) { $assetFlag = "--asset devnet=$($asset.code):$($asset.issuer)"; Say "OK" "Devnet token $($asset.code) from $($asset.issuer)" }
}
if (-not $assetFlag) { Say "WARN" "no asset in ${stateFile}: ledger-watch counts RLUSD on Devnet too (run services\lending 'lending.ts issue' first for TUSD)" }

# 2. Docker and the paywall
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
& docker info *> $null; $dockerOk = ($LASTEXITCODE -eq 0)
if ($dockerOk) {
  $state = (& docker inspect -f "{{.State.Status}}" ca-paywall 2>$null)
  if ($state -and $state -ne "running") { & docker start ca-paywall *> $null; Say "OK" "started ca-paywall (was $state)" }
}
$ErrorActionPreference = $prev
$paywallUp = $false
if ($dockerOk) { $paywallUp = Wait-Http "http://127.0.0.1:$PaywallPort/healthz" "paywall" 30 } else { Say "WARN" "Docker is not running: no paywall, so RLUSD lanes pay direct (mode auto) until it is" }
if (-not $paywallUp -and $Mode -eq "x402" -and -not $NoStream) { Stop-Here "-Mode x402 needs the paywall on port $PaywallPort." }

# The pay-to: -PayTo, else the paywall container's XRPL_PAY_TO_TESTNET (public address), else ledger-watch.env.
$payToFrom = "-PayTo"
if (-not $PayTo -and $dockerOk) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $envLines = & docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" ca-paywall 2>$null
  $ErrorActionPreference = $prev
  $line = @($envLines) | Where-Object { $_ -like "XRPL_PAY_TO_TESTNET=*" } | Select-Object -First 1
  if ($line) { $PayTo = $line.Substring("XRPL_PAY_TO_TESTNET=".Length).Trim(); $payToFrom = "the ca-paywall container" }
}
if ($PayTo) {
  if ($PayTo -notmatch '^r[1-9A-HJ-NP-Za-km-z]{24,34}$') { Stop-Here "pay-to '$PayTo' (from $payToFrom) is not an XRPL classic address" }
  Say "OK" "pay-to $PayTo (from $payToFrom)"
} else {
  Say "WARN" "no pay-to from -PayTo or ca-paywall: ledger-watch.env must hold XRPL_PAY_TO_TESTNET"
}

# 3. ledger-watch
$lwDir = Join-Path $repo "services\ledger-watch"
if ($RestartLedgerWatch -and (Listening $LedgerWatchPort)) { Say "INFO" "stopping ledger-watch on $LedgerWatchPort"; Stop-Port $LedgerWatchPort }
if (Listening $LedgerWatchPort) {
  Say "OK" "ledger-watch already listening on $LedgerWatchPort (kept; -RestartLedgerWatch to replace it)"
} else {
  $watch = @()
  if (Test-Path $WatchFile) { $watch = @(Get-Content $WatchFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") } | ForEach-Object { "--watch $_" }) }
  $paywallLog = Join-Path $repo "data\paywall-log\payments.log"
  $lwCmd = "node --env-file=$lwEnv src/main.ts --network testnet,devnet --fallback-public on --backfill-ledgers $BackfillLedgers --port $LedgerWatchPort --store ..\..\data\ledger-watch\live-ops.sqlite --paywall-log-file $paywallLog $assetFlag $($watch -join ' ')"
  $p = Start-Window "ledger-watch" $lwDir $lwCmd (Join-Path $liveDir "ledger-watch-$stamp.log")
  Say "OK" "ledger-watch starting (window pid $($p.Id), log data\live\ledger-watch-$stamp.log)"
}
if (-not (Wait-Http "http://127.0.0.1:$LedgerWatchPort/healthz" "ledger-watch")) { Stop-Here "ledger-watch is not up: read its window or data\live\ledger-watch-*.log" }

# 4. The console
$consoleDir = Join-Path $repo "apps\admin-console"
if ($RestartConsole -and (Listening $ConsolePort)) { Say "INFO" "stopping the console on $ConsolePort"; Stop-Port $ConsolePort }
if (Listening $ConsolePort) {
  Say "OK" "console already listening on $ConsolePort (kept; -RestartConsole to replace it)"
} else {
  if (-not (Test-Path (Join-Path $consoleDir ".next\BUILD_ID"))) { Stop-Here "the console has no production build: in apps\admin-console run  npm run build  then run this again" }
  $p = Start-Window "admin-console" $consoleDir "node --env-file=$lwEnv scripts/console.ts --mode start --port $ConsolePort" (Join-Path $liveDir "console-$stamp.log")
  Say "OK" "console starting (window pid $($p.Id), log data\live\console-$stamp.log)"
}
if (-not (Wait-Http "http://127.0.0.1:$ConsolePort/" "console")) { Stop-Here "the console is not up: read its window or data\live\console-*.log" }

# 5. The payment stream
$pidFile = Join-Path $liveDir "stream.pid"
$streamPid = $null
if (Test-Path $pidFile) { $streamPid = [int](Get-Content $pidFile -Raw).Trim(); if (-not (Get-Process -Id $streamPid -ErrorAction SilentlyContinue)) { $streamPid = $null } }
if ($RestartStream -and $streamPid) { Say "INFO" "stopping the stream (window pid $streamPid)"; & taskkill /PID $streamPid /T /F *> $null; Start-Sleep -Seconds 2; $streamPid = $null }
if ($NoStream) {
  Say "INFO" "-NoStream: no payments started; the console only watches"
} elseif ($streamPid) {
  Say "OK" "the stream is already running (window pid $streamPid; -RestartStream to replace it)"
} else {
  $envFiles = @("--env-file=$lwEnv")
  if ($laneSet -contains "rlusd") { $envFiles += "--env-file=$testnetEnv" }
  if ($laneSet -contains "tusd") { $envFiles += "--env-file=$LendingEnv"; $envFiles += "--env-file=$devnetEnv" }
  $wsPart = ""
  if ($TestnetWs) { $wsPart = "`$env:XRPL_WS_URL_TESTNET = '$TestnetWs'; " }
  $streamCmd = "${wsPart}node $($envFiles -join ' ') scripts/stream.ts run --lanes $Lanes --mode $Mode --url http://127.0.0.1:$PaywallPort --trace-url http://127.0.0.1:$LedgerWatchPort/ingest/trace --rate-per-min $RatePerMin"
  $p = Start-Window "payment-stream" (Join-Path $repo "services\paywall") $streamCmd (Join-Path $liveDir "stream-$stamp.log")
  Set-Content -Path $pidFile -Value $p.Id -Encoding ascii
  Say "OK" "payment stream starting: lanes $Lanes, mode $Mode, $RatePerMin/min per lane (window pid $($p.Id), log data\live\stream-$stamp.log)"
}

# 6. Open the console
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$ConsolePort/" }
Say "DONE" "Live Ops: http://127.0.0.1:$ConsolePort/  (stop everything: close the three windows, or run with -Restart... to replace one)"
