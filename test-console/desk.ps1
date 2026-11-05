<#
One command for the whole Private AI Desk on this PC (privateAI-design-31 s5): Docker containers, gateway, paywall (with
paid jobs), analyst, chain-query, near-watch + the NEAR admin UI (chainaim-adminUI-NEAR), and the test console (tab 03 with
"Pay with USDC - NEAR", the job feed and the run log). Every setting comes from ONE per-PC file, config\local\desk.json
(git-ignored; copy config\local\desk.example.json). Keys are read by NAME from the secrets folder and never printed.
Services run hidden; each writes its own log in test-console\runs\desk\, so an error is never lost with a closed window.

  .\test-console\desk.ps1                 start what is missing, check everything, print the READY table, open the pages
  .\test-console\desk.ps1 -Restart        clean restart: docker restart of the 4 containers, then every service
  .\test-console\desk.ps1 -Stop           stop the services this script runs (containers keep running)
  .\test-console\desk.ps1 -Check          report only: containers, services, paywall paid-jobs settings, model set
  .\test-console\desk.ps1 -Test           run the terminal test suites (they start their own servers; nothing else needed)
  .\test-console\desk.ps1 -RebuildPaywall rebuild the paywall image with the paid-jobs settings (also done automatically
                                          when the running paywall does not have them)
  -Settings PATH settings file (default config\local\desk.json)    -WaitSec N  seconds to wait per service (default 60)
  -NoBrowser     do not open the pages

Models: with console.modelsFile "auto" the console gets the config\local-models*.json whose model set equals what the
gateway serves now (config\generated\summary.json, written by switch-models.ps1), and its default model. No mismatch.
The gateway itself is created by switch-models.ps1 (it asks for the model keys); this script never creates or re-keys it.
ASCII only (Windows PowerShell 5.1).
#>
param(
  [switch]$Restart,
  [switch]$Stop,
  [switch]$Check,
  [switch]$Test,
  [switch]$RebuildPaywall,
  [switch]$NoBrowser,
  [string]$Settings = "config\local\desk.json",
  [int]$WaitSec = 60
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$inv = [Globalization.CultureInfo]::InvariantCulture
$script:fails = @()

function Say([string]$tag, [string]$text) { Write-Host ("{0,-7} {1}" -f $tag, $text) }
function Stop-Here([string]$text) { Say "STOP" $text; exit 1 }
function Fail([string]$text) { Say "FAIL" $text; $script:fails += $text }
function Listening([int]$port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Stop-Port([int]$port) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
function HttpStatus([string]$url) {
  try { return [int](Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } return 0 }
}
function Answers([string]$url) { $c = HttpStatus $url; return ($c -gt 0 -and $c -lt 500) }
# -AnyStatus: the process answers at all (near-watch's /healthz is 503 until its NEAR feed is live, which can take a while)
function Wait-Answers([string]$url, [switch]$AnyStatus) {
  $deadline = (Get-Date).AddSeconds($WaitSec)
  while ((Get-Date) -lt $deadline) {
    $c = HttpStatus $url
    if ($c -gt 0 -and ($AnyStatus -or $c -lt 500)) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
# The JSON body of a URL, also from an error answer (PowerShell 5.1 throws on 503), or $null
function HttpJson([string]$url) {
  try { return ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json) }
  catch {
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); return ($sr.ReadToEnd() | ConvertFrom-Json) } catch { return $null } }
    return $null
  }
}
function Q([string]$s) { '"' + $s + '"' }

# ---------------------------------------------------------------- -Test needs no settings
if ($Test) {
  Say "TEST" "terminal suites (each starts its own servers; near-watch path from config\local\repos.json)"
  & node --test "packages/crossask/test/*.test.ts" "scripts/test/*.test.ts" "services/gateway/test/*.test.ts" "test-console/test/*.test.ts"
  $a = $LASTEXITCODE
  & npm --prefix services\analyst test
  $b = $LASTEXITCODE
  if ($a -eq 0 -and $b -eq 0) { Say "OK" "all terminal suites passed"; exit 0 }
  Say "FAIL" "a suite failed (root suites exit $a, analyst exit $b): see the not ok lines above"; exit 1
}

# ---------------------------------------------------------------- settings
$profilePath = Join-Path $repo $Settings
if (-not (Test-Path $profilePath)) { Stop-Here "no $Settings. Copy config\local\desk.example.json to $Settings and edit it (it is git-ignored)." }
try { $P = Get-Content -Raw $profilePath | ConvertFrom-Json } catch { Stop-Here "$Settings is not valid JSON: $($_.Exception.Message)" }
function Need($obj, [string]$path) {
  $v = $obj
  foreach ($part in $path.Split(".")) { if ($null -eq $v) { break }; $v = $v.$part }
  if ($null -eq $v -or "$v" -eq "") { Stop-Here "$Settings needs $path (see config\local\desk.example.json)" }
  return $v
}
$secrets = Need $P "secretsDir"
$ports = @{ gateway = 8720; paywall = 8080; analyst = 8740; chainQuery = 8750; console = 8730; jobs = 8731; nearWatch = 8790; adminUi = 8800 }
if ($P.ports) { foreach ($k in @($ports.Keys)) { if ($P.ports.$k) { $ports[$k] = [int]$P.ports.$k } } }
$paid = [bool]($P.paidJobs -and $P.paidJobs.enabled)
$admin = [bool]($P.adminUi -and $P.adminUi.enabled)
$feed = [bool]($admin -and $P.adminUi.jobFeed)
$runLog = if ($P.console.runLog) { [string]$P.console.runLog } else { "meta" }
if (@("off", "meta", "full") -notcontains $runLog) { Stop-Here "$Settings console.runLog must be off, meta or full" }
$logDir = Join-Path $repo "test-console\runs\desk"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ---------------------------------------------------------------- the adminUI checkout (same order as the near-watch tests)
function NearWatchDir {
  if ($env:NEAR_WATCH_DIR) { return [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($env:NEAR_WATCH_DIR)) { $env:NEAR_WATCH_DIR } else { Join-Path $repo $env:NEAR_WATCH_DIR })) }
  $f = Join-Path $repo "config\local\repos.json"
  if (Test-Path $f) {
    $j = Get-Content -Raw $f | ConvertFrom-Json
    if ($j.nearWatchDir) { return [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($j.nearWatchDir)) { $j.nearWatchDir } else { Join-Path $repo $j.nearWatchDir })) }
  }
  return [IO.Path]::GetFullPath((Join-Path $repo "..\chainaim-adminUI-NEAR\services\near-watch"))
}

# ---------------------------------------------------------------- secrets: by name, into this process only, never printed
function Import-Names([string]$file, [string[]]$names) {
  $path = Join-Path $secrets $file
  if (-not (Test-Path $path)) { Stop-Here "missing $path (see MANUAL_SETUP.md, 'One command for the desk')" }
  $found = @{}
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$' -and $names -contains $Matches[1] -and $Matches[2].Trim() -ne "") {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim(), "Process"); $found[$Matches[1]] = $true
    }
  }
  $missing = @($names | Where-Object { -not $found[$_] })
  if ($missing.Count) { Stop-Here "$path has no value for: $($missing -join ', ') (names only shown)" }
}

# ---------------------------------------------------------------- the model set the gateway serves now
function ModelSet {
  $mf = if ($P.console.modelsFile) { [string]$P.console.modelsFile } else { "auto" }
  $dm = if ($P.console.defaultModel) { [string]$P.console.defaultModel } else { "auto" }
  $sumPath = Join-Path $repo "config\generated\summary.json"
  if ($mf -eq "auto" -or $dm -eq "auto") {
    if (-not (Test-Path $sumPath)) { Stop-Here "config\generated\summary.json is missing: run .\test-console\switch-models.ps1 once (it sets up the gateway's models)" }
    $sum = Get-Content -Raw $sumPath | ConvertFrom-Json
    $want = (@($sum.models | ForEach-Object { $_.id }) | Sort-Object) -join ","
  }
  if ($mf -eq "auto") {
    $mf = $null
    foreach ($f in Get-ChildItem (Join-Path $repo "config") -Filter "local-models*.json" | Sort-Object Name) {
      $j = Get-Content -Raw $f.FullName | ConvertFrom-Json
      if (((@($j.models | ForEach-Object { $_.id }) | Sort-Object) -join ",") -eq $want) { $mf = "config\" + $f.Name; break }
    }
    if (-not $mf) { Stop-Here "no config\local-models*.json has the gateway's model set ($want); set console.modelsFile in $Settings" }
  }
  if ($dm -eq "auto") { $dm = [string]$sum.defaultModel }
  return @{ file = $mf; default = $dm }
}

# ---------------------------------------------------------------- services this script runs
$nwDir = NearWatchDir
$adminRoot = [IO.Path]::GetFullPath((Join-Path $nwDir "..\.."))
$svc = [ordered]@{
  analyst    = @{ port = $ports.analyst;    health = "http://127.0.0.1:$($ports.analyst)/healthz";    on = $true }
  chainQuery = @{ port = $ports.chainQuery; health = "http://127.0.0.1:$($ports.chainQuery)/healthz"; on = $true }
  nearWatch  = @{ port = $ports.nearWatch;  health = "http://127.0.0.1:$($ports.nearWatch)/healthz";  on = $admin }
  adminUi    = @{ port = $ports.adminUi;    health = "http://127.0.0.1:$($ports.adminUi)/";           on = $admin }
  console    = @{ port = $ports.console;    health = "http://127.0.0.1:$($ports.console)/";           on = $true }
}
function Stop-Services { foreach ($k in $svc.Keys) { Stop-Port $svc[$k].port }; Stop-Port $ports.jobs; Start-Sleep -Seconds 1 }

function Start-DeskService([string]$name, [string]$exe, [string]$argLine, [string]$dir, [switch]$AnyStatus) {
  $s = $svc[$name]
  if (-not $s.on) { return }
  if (Listening $s.port) { Say "OK" "$name already running on $($s.port)" }
  else {
    $out = Join-Path $logDir "$name.log"; $err = Join-Path $logDir "$name.err.log"
    foreach ($f in @($out, $err)) { if (Test-Path $f) { Move-Item -Force $f "$f.prev" } }
    Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
    Say "START" "$name on $($s.port) (log test-console\runs\desk\$name.log)"
  }
  if (-not (Wait-Answers $s.health -AnyStatus:$AnyStatus)) {
    Fail "$name did not answer at $($s.health) within $WaitSec s. Last lines of its log:"
    foreach ($f in @((Join-Path $logDir "$name.err.log"), (Join-Path $logDir "$name.log"))) { if (Test-Path $f) { Get-Content $f -Tail 12 | ForEach-Object { Write-Host "        | $_" } } }
  }
}

# ---------------------------------------------------------------- the paywall's paid-jobs settings (compared in memory, never printed)
function PaywallPaidJobsOk {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $lines = @(& docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" ca-paywall 2>$null)
  $ErrorActionPreference = $prev
  $ok = ($lines -contains "PAID_JOBS=on") -and ($lines -contains "PAID_JOBS_KEY=$env:PAID_JOBS_KEY") -and ($lines -contains "PAID_JOBS_RESULT_URL=$env:PAID_JOBS_RESULT_URL")
  $lines = $null
  return $ok
}

# ---------------------------------------------------------------- the paywall's NEAR RPC (tested from inside the container)
# The paywall reads NEAR testnet's block height when it checks a payment; a rate-limited RPC (FastNEAR -429, seen 2026-11-05:
# near-watch on the same PC uses FastNEAR too) makes it refuse payments (invalid_exact_near_current_block_height_unavailable).
# paywall.nearRpcCandidates lists RPCs in order of preference (docs.near.org/api/rpc/providers); the first that answers wins.
$PaywallDefaultNearRpc = "https://rpc.testnet.fastnear.com"  # the paywall's own default when NEAR_RPC_URL_TESTNET is unset (its start line)
function PaywallEnvValue([string]$name) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $lines = @(& docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" ca-paywall 2>$null)
  $ErrorActionPreference = $prev
  $hit = @($lines | Where-Object { $_ -like "$name=*" })
  $lines = $null
  if ($hit.Count) { return $hit[0].Substring($name.Length + 1) }
  return ""
}
function RpcAnswers([string]$url) {
  $js = "fetch('" + $url + "',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'block',params:{finality:'final'}}),signal:AbortSignal.timeout(8000)}).then(r=>r.json()).then(j=>console.log(j.result&&j.result.header?'OK':'NO')).catch(()=>console.log('NO'))"
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $out = (& docker exec ca-paywall node -e $js 2>$null)
  $ErrorActionPreference = $prev
  return ("$out".Trim() -eq "OK")
}
function CurrentPaywallRpc { $v = PaywallEnvValue "NEAR_RPC_URL_TESTNET"; if ($v) { return $v }; return $PaywallDefaultNearRpc }

function Report {
  Write-Host ""
  Write-Host "Private AI Desk on this PC"
  $rows = @(
    @("gateway", "http://127.0.0.1:$($ports.gateway)/healthz", $true),
    @("paywall", "http://127.0.0.1:$($ports.paywall)/healthz", $true),
    @("analyst", $svc.analyst.health, $true),
    @("chain-query", $svc.chainQuery.health, $true),
    @("console (tab 03)", "http://127.0.0.1:$($ports.console)/", $true),
    @("paid jobs listener", "http://127.0.0.1:$($ports.jobs)/internal/jobs/x", $paid),
    @("near-watch", $svc.nearWatch.health, $admin),
    @("NEAR admin UI", "http://127.0.0.1:$($ports.adminUi)/", $admin))
  $bad = 0
  $notes = @()
  foreach ($r in $rows) {
    if (-not $r[2]) { Write-Host ("  {0,-20} off in {1}" -f $r[0], $Settings); continue }
    if ($r[0] -eq "near-watch") {
      $h = HttpJson $r[1]
      if ($h -and $h.ok) { Write-Host ("  {0,-20} {1,-5} {2}" -f $r[0], "OK", $r[1]); continue }
      if ($h -and $h.feeds) {
        $states = @($h.feeds.PSObject.Properties | ForEach-Object { "feed $($_.Name): $($_.Value.state)" }) -join ", "
        Write-Host ("  {0,-20} {1,-5} {2}" -f $r[0], "RUN", "$($r[1])  ($states)")
        $notes += "Honesty note: near-watch is running, but its NEAR feed is not live yet ($states): it is catching up, or a provider is rate-limited. Payments still work; the admin UI shows them as reconciled once the feed is live. Its log: test-console\runs\desk\nearWatch.log"
        continue
      }
    }
    $ok = Answers $r[1]; if (-not $ok) { $bad++ }
    Write-Host ("  {0,-20} {1,-5} {2}" -f $r[0], $(if ($ok) { "OK" } else { "DOWN" }), $r[1])
  }
  foreach ($n in $notes) { Write-Host "  $n" }
  Write-Host "  logs                 test-console\runs\desk\<service>.log (previous run: .prev)"
  return $bad
}

# ================================================================= -Stop / -Test / -Check
if ($Stop) { Stop-Services; Say "OK" "stopped analyst, chain-query, near-watch, admin UI and console (containers keep running)"; exit 0 }


if ($paid) { Import-Names (Need $P "paidJobs.secretsFile") @("PAID_JOBS", "PAID_JOBS_KEY", "PAID_JOBS_RESULT_URL") }
if ($feed) { Import-Names (Need $P "adminUi.secretsFile") @("NEAR_WATCH_INGEST_KEY") }
$models = ModelSet

if ($Check) {
  Say "INFO" "models: $($models.file), default $($models.default) (the gateway's current set)"
  if ($paid) { if (PaywallPaidJobsOk) { Say "OK" "paywall has the paid-jobs settings of $(Join-Path $secrets $P.paidJobs.secretsFile)" } else { Say "FAIL" "paywall lacks or differs in the paid-jobs settings: run .\test-console\desk.ps1 (it rebuilds the paywall)" } }
  $r = CurrentPaywallRpc
  if (RpcAnswers $r) { Say "OK" "paywall NEAR RPC answers ($r)" } else { Say "FAIL" "paywall NEAR RPC $r does not answer (rate-limited or down): run .\test-console\desk.ps1 (it switches to the first answering paywall.nearRpcCandidates entry)" }
  $bad = Report
  exit $(if ($bad) { 1 } else { 0 })
}

# ================================================================= start / restart
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
& docker info *> $null; $dockerOk = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prev
if (-not $dockerOk) { Stop-Here "Docker Desktop is not running. Start it, wait for 'Engine running', then run this again." }
Say "OK" "Docker is running"

if ($Restart) { Say "STOP" "services (restart asked)"; Stop-Services }

foreach ($name in @("ca-presidio", "ca-openrouter-stub", "ca-gateway", "ca-paywall")) {
  $ErrorActionPreference = "Continue"
  $state = (& docker inspect --format "{{.State.Status}}" $name 2>$null); $exists = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = "Stop"
  if (-not $exists) {
    if ($name -eq "ca-gateway") { Stop-Here "ca-gateway does not exist: run .\test-console\switch-models.ps1 -To all (it asks for the model keys), then this again." }
    Stop-Here "$name does not exist: run .\test-console\stack.ps1 -Rebuild all, then this again."
  }
  if ($Restart -and $state -eq "running") { Say "RESTART" $name; & docker restart $name | Out-Null }
  elseif ($state -ne "running") { Say "START" "$name (was $state)"; & docker start $name | Out-Null }
  else { Say "OK" "$name running" }
  if ($LASTEXITCODE -ne 0) { Stop-Here "docker could not start $name; see the message above" }
}

# the paywall: paid-jobs settings and a working NEAR RPC, fixed together in ONE rebuild when either is off
$reasons = @()
if ($RebuildPaywall) { $reasons += "asked (-RebuildPaywall)" }
if ($paid) { if (PaywallPaidJobsOk) { Say "OK" "paywall has the paid-jobs settings" } else { $reasons += "paid-jobs settings" } }
$rpcNow = CurrentPaywallRpc
$rpcWant = $rpcNow
$cands = @(@($P.paywall.nearRpcCandidates) | Where-Object { $_ })
if ($cands.Count) {
  $rpcWant = $null
  foreach ($u in $cands) { if (RpcAnswers $u) { $rpcWant = $u; break } }
  if (-not $rpcWant) { Fail "no NEAR RPC in paywall.nearRpcCandidates answers from the paywall ($($cands -join ', ')): NEAR payments would be refused (nothing is charged)"; $rpcWant = $rpcNow }
  elseif ($rpcWant -ne $rpcNow) { Say "SWITCH" "paywall NEAR RPC $rpcNow -> $rpcWant (first candidate that answers)"; $reasons += "NEAR RPC" }
  else { Say "OK" "paywall NEAR RPC answers ($rpcNow)" }
} elseif (RpcAnswers $rpcNow) { Say "OK" "paywall NEAR RPC answers ($rpcNow)" }
else { Fail "the paywall's NEAR RPC $rpcNow does not answer (rate-limited or down): add paywall.nearRpcCandidates to $Settings" }
# keep the chosen RPC on any rebuild (passed by name like the other settings; a public URL, not a secret)
if ($rpcWant -ne $PaywallDefaultNearRpc) { [Environment]::SetEnvironmentVariable("NEAR_RPC_URL_TESTNET", $rpcWant, "Process") }
if ($reasons.Count) {
  Say "BUILD" "paywall ($($reasons -join ', '); keys passed by name, never printed)"
  $near = Join-Path $secrets (Need $P "paywall.nearEnvFile")
  & (Join-Path $PSScriptRoot "stack.ps1") -Rebuild paywall -NearEnvFile $near -PassEnv FACILITATOR_URL_TESTNET, FACILITATOR_URL_MAINNET, RLUSD_ISSUER_TESTNET, RLUSD_ISSUER_MAINNET, PRICE_SCAN, PRICE_MASK, PRICE_CHAT, PUBLIC_BASE_URL, PAID_JOBS, PAID_JOBS_KEY, PAID_JOBS_RESULT_URL, NEAR_RPC_URL_TESTNET
  if ($paid -and -not (PaywallPaidJobsOk)) { Stop-Here "the rebuilt paywall still lacks the paid-jobs settings; see stack.ps1's output above" }
  if ((CurrentPaywallRpc) -ne $rpcWant) { Stop-Here "the rebuilt paywall uses $(CurrentPaywallRpc), not ${rpcWant}; $near sets NEAR_RPC_URL_TESTNET itself (it wins); change that line to $rpcWant or remove it" }
  Say "OK" "paywall rebuilt: NEAR RPC $rpcWant$(if ($paid) { ', paid jobs on' })"
}

if (Wait-Answers "http://127.0.0.1:$($ports.gateway)/healthz") { Say "OK" "gateway answers" } else { Fail "gateway did not answer on $($ports.gateway): docker logs ca-gateway --tail 20" }
if (Wait-Answers "http://127.0.0.1:$($ports.paywall)/healthz") { Say "OK" "paywall answers" } else { Fail "paywall did not answer on $($ports.paywall): docker logs ca-paywall --tail 20" }

# analyst (installs DuckDB once, like start-analyst.cmd)
$aDir = Join-Path $repo "services\analyst"
if (-not (Test-Path (Join-Path $aDir "node_modules\@duckdb\node-api\package.json"))) { Say "INSTALL" "analyst dependencies (npm ci)"; & npm --prefix $aDir ci; if ($LASTEXITCODE -ne 0) { Stop-Here "npm ci in services\analyst failed" } }
Start-DeskService "analyst" "node" ("src\main.ts --port $($ports.analyst) --work-dir " + (Q (Join-Path $repo "runtime\analyst"))) $aDir
Start-DeskService "chainQuery" "node" "src\main.ts --port $($ports.chainQuery)" (Join-Path $repo "services\chain-query")

if ($admin) {
  if (-not (Test-Path (Join-Path $nwDir "src\server.ts"))) { Stop-Here "near-watch is not at ${nwDir}; set nearWatchDir in config\local\repos.json" }
  if (-not (Test-Path (Join-Path $adminRoot "apps\admin-console\.next"))) { Stop-Here "the NEAR admin UI is not built: npm --prefix $adminRoot\apps\admin-console install; npm --prefix $adminRoot\apps\admin-console run build" }
  $nwEnv = Join-Path $secrets (Need $P "adminUi.secretsFile")
  $nwArgs = "--env-file=" + (Q $nwEnv) + " src\main.ts --port $($ports.nearWatch)"
  foreach ($w in @($P.adminUi.watch)) { if ($w) { $nwArgs += " --watch " + (Q $w) } }
  if ($P.adminUi.gasPerPaymentNear) { $nwArgs += " --gas-per-payment-near $($P.adminUi.gasPerPaymentNear)" }
  # near-watch's rpc road: adminUi.rpcFallbackUrl, else the paywall's working NEAR RPC (keeps both off a rate-limited provider)
  $nwRpc = if ($P.adminUi.rpcFallbackUrl) { [string]$P.adminUi.rpcFallbackUrl } else { $rpcWant }
  if ($nwRpc) { $nwArgs += " --rpc-fallback-url " + (Q $nwRpc); Say "INFO" "near-watch rpc road: $nwRpc" }
  Start-DeskService "nearWatch" "node" $nwArgs $nwDir -AnyStatus
  Start-DeskService "adminUi" "node" ("--env-file=" + (Q $nwEnv) + " scripts\console.ts --mode start --port $($ports.adminUi) --near-watch-url http://127.0.0.1:$($ports.nearWatch)") (Join-Path $adminRoot "apps\admin-console")
}

$cArgs = "test-console\console\server.ts --models-file " + (Q $models.file) + " --default-model $($models.default) --port $($ports.console) --analyst http://127.0.0.1:$($ports.analyst) --chain-query http://127.0.0.1:$($ports.chainQuery) --run-log $runLog"
if ($P.console.nearWallet) { $cArgs += " --near-wallet $($P.console.nearWallet)" }
if ($paid) {
  $pj = $P.paidJobs
  foreach ($k in @("feePerModelCallUsd", "feeAnalystUsd", "nearGasFeeUsd", "marginPct", "minPriceUsd")) {
    if ("$($pj.$k)" -notmatch '^[0-9]+(\.[0-9]+)?$') { Stop-Here "$Settings paidJobs.$k must be a number written as text, e.g. ""0.001"" (you choose it)" }
  }
  $cArgs += " --paid-jobs on --jobs-internal-port $($ports.jobs) --pricing-catalog " + (Q (Need $P "paidJobs.pricingCatalog"))
  $cArgs += " --fee-per-model-call-usd $($pj.feePerModelCallUsd) --fee-analyst-usd $($pj.feeAnalystUsd) --near-gas-fee-usd $($pj.nearGasFeeUsd) --margin-pct $($pj.marginPct) --min-price-usd $($pj.minPriceUsd)"
}
if ($feed) { $cArgs += " --job-feed-url http://127.0.0.1:$($ports.nearWatch)/ingest/job" }
Say "INFO" "console models: $($models.file), default $($models.default)"
Start-DeskService "console" "node" $cArgs $repo

if ($paid) {
  if (Wait-Answers "http://127.0.0.1:$($ports.jobs)/internal/jobs/x") { Say "OK" "paid-jobs listener answers on $($ports.jobs)" } else { Fail "paid-jobs listener did not answer on $($ports.jobs) (see console.log)" }
  $ErrorActionPreference = "Continue"
  $code = (& docker exec ca-paywall node -e "fetch('http://host.docker.internal:$($ports.jobs)/internal/jobs/x').then(r=>console.log(r.status)).catch(e=>console.log('ERR '+e.message))" 2>&1)
  $ErrorActionPreference = "Stop"
  if ("$code".Trim() -eq "401") { Say "OK" "the paywall reaches the console's paid-jobs listener (401 without key, as designed)" } else { Fail "the paywall cannot reach the console's paid-jobs listener (got: $code); check Windows firewall for port $($ports.jobs)" }
}

$bad = Report
if ($script:fails.Count -or $bad) {
  Write-Host ""; Say "NOT READY" "$($script:fails.Count + $bad) problem(s) above; each names its log or fix"; exit 1
}
Write-Host ""; Say "READY" "console http://127.0.0.1:$($ports.console)$(if ($admin) { "   NEAR admin UI http://127.0.0.1:$($ports.adminUi)/#jobs" })"
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$($ports.console)"; if ($admin) { Start-Process "http://127.0.0.1:$($ports.adminUi)/#jobs" } }
