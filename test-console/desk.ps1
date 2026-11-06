<#
ONE command for the whole Private AI Desk on this PC (privateAI-design-31 s5, rewritten 2026-11-06 as a conductor).
It does not start any service itself: it checks, then runs each repository's own Docker launcher in order, then prints
one READY table across both. Neither launcher is changed or renamed; each team keeps owning its own.

  1. chainaim-adminUI-NEAR  nearadminup.ps1      near-watch in Docker (ca-near-watch) + the NEAR admin UI on 8800
  2. chainaim-private-ai    test-console\up.ps1  gateway, paywall, presidio, analyst, chain-query, console API in Docker
                                                 + the 8730 page (tab 03, NEAR pay box)
  Both use the Docker network chainaim-test, so the paywall and console API reach near-watch as http://near-watch:8790.

  .\test-console\desk.ps1            check, stop leftovers of the old PC-process setup, start both, READY table
  .\test-console\desk.ps1 -Check     report only (changes nothing)
  .\test-console\desk.ps1 -Stop      both repositories' down.ps1 (volumes kept)
  .\test-console\desk.ps1 -Test      the terminal test suites (they start their own servers)
  -Build        rebuild the private images first (up.ps1 -Build)
  -WithStub     also the OpenRouter stand-in (up.ps1 -Test)
  -Agent        require tab 03 agent mode (up.ps1 -Agent on). Without it, agent.enabled decides: "auto" (default) lets
                up.ps1 switch it on when <secretsDir>\agent-tenants.env and a Bedrock key exist, "on" requires it, "off" skips it
  -NoBrowser    do not open the pages
  -Settings     settings file (default config\local\desk.json; copy config\local\desk.example.json)

Settings (config\local\desk.json, git-ignored): secretsDir, paidJobs.enabled, adminUi.enabled / watch / gasPerPaymentNear.
Prices are NOT here: up.ps1 reads its own price files (config\paid-jobs-prices.conf, or <secretsDir>\paid-jobs-settings.env).
The adminUI checkout is found like the near-watch tests do: env NEAR_WATCH_DIR, config\local\repos.json nearWatchDir, sibling.
Secrets are only checked to exist (by name); this script never reads or prints a value.
NEAR RPC: the paywall and near-watch take theirs from near-testnet.env (NEAR_RPC_URL_TESTNET) and near-watch.env
(NEAR_RPC_FALLBACK_URL_TESTNET). FastNEAR's free tier rate-limits when both use it (seen 2026-11-05); this script checks
from inside the paywall that its RPC answers and says which line to set if not. It never edits a secrets file.
ASCII only (Windows PowerShell 5.1).
#>
param(
  [switch]$Check,
  [switch]$Stop,
  [switch]$Test,
  [switch]$Build,
  [switch]$WithStub,
  [switch]$Agent,
  [switch]$NoBrowser,
  [string]$Settings = "config\local\desk.json"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$script:problems = 0

function Say([string]$tag, [string]$text) { Write-Host ("{0,-7} {1}" -f $tag, $text) }
function Stop-Here([string]$text) { Say "STOP" $text; exit 1 }
function Problem([string]$text) { Say "FAIL" $text; $script:problems++ }
function HttpStatus([string]$url) {
  try { return [int](Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } return 0 }
}
function HttpJson([string]$url) {
  try { return ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json) }
  catch {
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); return ($sr.ReadToEnd() | ConvertFrom-Json) } catch { return $null } }
    return $null
  }
}
function Quiet([scriptblock]$block) { $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"; try { & $block } finally { $ErrorActionPreference = $prev } }

# ---------------------------------------------------------------- -Test needs nothing else
if ($Test) {
  Say "TEST" "terminal suites (each starts its own servers; near-watch path from config\local\repos.json)"
  & node --test "packages/crossask/test/*.test.ts" "scripts/test/*.test.ts" "services/gateway/test/*.test.ts" "test-console/test/*.test.ts"
  $a = $LASTEXITCODE
  & npm --prefix services\analyst test
  $b = $LASTEXITCODE
  if ($a -eq 0 -and $b -eq 0) { Say "OK" "all terminal suites passed"; exit 0 }
  Say "FAIL" "a suite failed (root suites exit $a, analyst exit $b): see the not ok lines above"; exit 1
}

# ---------------------------------------------------------------- settings and paths
$settingsPath = Join-Path $repo $Settings
if (Test-Path $settingsPath) {
  try { $P = Get-Content -Raw $settingsPath | ConvertFrom-Json } catch { Stop-Here "$Settings is not valid JSON: $($_.Exception.Message)" }
} else {
  # No settings file (a fresh clone): the defaults below, the same as an empty desk.json.
  Say "NOTE" "no ${Settings}: defaults (secrets C:\PRIV-AI-SECRETS, paid jobs on, admin UI on, agent auto, watch list from the admin repo's config\near-watch-watch.conf). To change them copy config\local\desk.example.json to $Settings."
  $P = [pscustomobject]@{}
}
$secrets = if ($P.secretsDir) { [string]$P.secretsDir } else { "C:\PRIV-AI-SECRETS" }
$paid = -not ($P.paidJobs -and $P.paidJobs.enabled -eq $false)
$admin = -not ($P.adminUi -and $P.adminUi.enabled -eq $false)
$agentMode = if ($Agent) { "on" } elseif ($P.agent -and $P.agent.enabled -is [bool]) { $(if ($P.agent.enabled) { "on" } else { "off" }) } elseif ($P.agent -and $P.agent.enabled) { [string]$P.agent.enabled } else { "auto" }
if (@("auto", "on", "off") -notcontains $agentMode) { Stop-Here "$Settings agent.enabled must be auto, on or off" }
if ($agentMode -eq "on" -and -not $paid) { Stop-Here "agent mode needs paid jobs on (paidJobs.enabled in $Settings)" }
$agentOn = ($agentMode -ne "off") -and $paid -and (Test-Path (Join-Path $secrets "agent-tenants.env"))
if ($P.paidJobs -and $P.paidJobs.feePerModelCallUsd) { Say "NOTE" "$Settings has paidJobs fees: they are no longer used (prices come from up.ps1's price files)" }

function AdminRoot {
  $nw = $null
  if ($env:NEAR_WATCH_DIR) { $nw = $env:NEAR_WATCH_DIR }
  else {
    $f = Join-Path $repo "config\local\repos.json"
    if (Test-Path $f) { $j = Get-Content -Raw $f | ConvertFrom-Json; if ($j.nearWatchDir) { $nw = [string]$j.nearWatchDir } }
  }
  if (-not $nw) { $nw = "..\chainaim-adminUI-NEAR\services\near-watch" }
  if (-not [IO.Path]::IsPathRooted($nw)) { $nw = Join-Path $repo $nw }
  return [IO.Path]::GetFullPath((Join-Path $nw "..\.."))
}
$adminRoot = AdminRoot
$adminUp = Join-Path $adminRoot "nearadminup.ps1"
$adminDown = Join-Path $adminRoot "down.ps1"
$privUp = Join-Path $repo "test-console\up.ps1"
$privDown = Join-Path $repo "test-console\down.ps1"

# ---------------------------------------------------------------- the paywall's NEAR RPC, tested from inside ca-paywall
$DefaultNearRpc = "https://rpc.testnet.fastnear.com"   # the paywall's own default when NEAR_RPC_URL_TESTNET is unset
function PaywallRpc {
  $lines = @(Quiet { & docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" ca-paywall 2>$null })
  $hit = @($lines | Where-Object { $_ -like "NEAR_RPC_URL_TESTNET=*" }); $lines = $null
  if ($hit.Count) { return $hit[0].Substring(21) }
  return $DefaultNearRpc
}
function RpcAnswers([string]$url) {
  $js = "fetch('" + $url + "',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'block',params:{finality:'final'}}),signal:AbortSignal.timeout(8000)}).then(r=>r.json()).then(j=>console.log(j.result&&j.result.header?'OK':'NO')).catch(()=>console.log('NO'))"
  $out = Quiet { & docker exec ca-paywall node -e $js 2>$null }
  return ("$out".Trim() -eq "OK")
}

# ---------------------------------------------------------------- the READY table across both repositories
function Report {
  Write-Host ""
  Write-Host "Private AI Desk on this PC"
  $rows = @(
    @("gateway", "http://127.0.0.1:8720/healthz", $true),
    @("paywall", "http://127.0.0.1:8080/healthz", $true),
    @("analyst", "http://127.0.0.1:8740/healthz", $true),
    @("chain-query", "http://127.0.0.1:8750/healthz", $true),
    @("console API", "http://127.0.0.1:8735/", $true),
    @("console page (03)", "http://127.0.0.1:8730/", $true),
    @("near-watch", "http://127.0.0.1:8790/healthz", $admin),
    @("NEAR admin UI", "http://127.0.0.1:8800/", $admin),
    @("agent (tab 03)", "http://127.0.0.1:8760/healthz", $agentOn))
  $notes = @(); $bad = 0
  foreach ($r in $rows) {
    if (-not $r[2]) { Write-Host ("  {0,-20} off in {1}" -f $r[0], $Settings); continue }
    if ($r[0] -eq "near-watch") {
      $h = HttpJson $r[1]
      if ($h -and $h.ok) { Write-Host ("  {0,-20} {1,-5} {2}" -f $r[0], "OK", $r[1]); continue }
      if ($h -and $h.feeds) {
        $states = @($h.feeds.PSObject.Properties | ForEach-Object { "feed $($_.Name): $($_.Value.state)" }) -join ", "
        Write-Host ("  {0,-20} {1,-5} {2}" -f $r[0], "RUN", "$($r[1])  ($states)")
        $notes += "Honesty note: near-watch is running but its NEAR feed is not live yet ($states): it is catching up, or its RPC is rate-limited (set NEAR_RPC_FALLBACK_URL_TESTNET in $secrets\near-watch.env). Payments still work; the admin UI shows them as reconciled once the feed is live. Log: docker logs ca-near-watch --tail 20"
        continue
      }
    }
    $c = HttpStatus $r[1]; $ok = ($c -gt 0 -and $c -lt 500)
    if (-not $ok -and $r[0] -eq "agent (tab 03)" -and $agentMode -eq "auto") { Write-Host ("  {0,-20} {1,-5} {2}" -f $r[0], "off", "up.ps1 switched agent mode off (see its INFO line above)"); continue }
    if (-not $ok) { $bad++ }
    Write-Host ("  {0,-20} {1,-5} {2}" -f $r[0], $(if ($ok) { "OK" } else { "DOWN" }), $r[1])
  }
  if ((Quiet { & docker inspect -f "{{.State.Running}}" ca-paywall 2>$null }) -eq "true") {
    $rpc = PaywallRpc
    if (RpcAnswers $rpc) { Write-Host ("  {0,-20} {1,-5} {2}" -f "paywall NEAR RPC", "OK", $rpc) }
    else {
      Write-Host ("  {0,-20} {1,-5} {2}" -f "paywall NEAR RPC", "DOWN", $rpc); $bad++
      $notes += "The paywall's NEAR RPC does not answer (rate-limited or down), so NEAR payments would be refused (nothing is charged). Fix once: add NEAR_RPC_URL_TESTNET=https://near-testnet.drpc.org to $secrets\near-testnet.env, then run this again."
    }
  }
  foreach ($n in $notes) { Write-Host "  $n" }
  return $bad
}

# ================================================================= -Stop / -Check
if ($Stop) {
  if (Test-Path $privDown) { Say "STOP" "private stack (test-console\down.ps1)"; & $privDown; if ($LASTEXITCODE) { Problem "test-console\down.ps1 exit $LASTEXITCODE" } }
  if ($admin -and (Test-Path $adminDown)) { Say "STOP" "admin stack ($adminDown)"; try { & $adminDown } catch { Problem "$adminDown : $($_.Exception.Message)" } }
  exit $(if ($script:problems) { 1 } else { 0 })
}
if ($Check) { $bad = Report; exit $(if ($bad) { 1 } else { 0 }) }

# ================================================================= start
# 1. pre-flight: checks only
if (-not ((Quiet { & docker info *> $null; $LASTEXITCODE }) -eq 0)) { Stop-Here "Docker Desktop is not running. Start it, wait for 'Engine running', then run this again." }
Say "OK" "Docker is running"
if (-not (Test-Path $privUp)) { Stop-Here "missing $privUp (git pull in chainaim-private-ai)" }
if ($admin -and -not (Test-Path $adminUp)) { Stop-Here "missing ${adminUp}; set nearWatchDir in config\local\repos.json to the adminUI checkout's services\near-watch, or git pull there" }
$need = @("near-testnet.env")
# Model keys: chainaim.env, or the existing ca-gateway (up.ps1 keeps the keys it holds). Neither = no keys to start with.
if (-not (Test-Path (Join-Path $secrets "chainaim.env"))) {
  if ((Quiet { & docker inspect ca-gateway *> $null; $LASTEXITCODE }) -eq 0) { Say "NOTE" "no $secrets\chainaim.env: the model keys are kept from the existing ca-gateway (after -Stop they are gone; put them in chainaim.env, cmd.md A4)" }
  else { Stop-Here "no ca-gateway and no $secrets\chainaim.env, so no model keys: run .\test-console\switch-models.ps1 -To ollama-cpu-8gb-all once (it asks for them), or create chainaim.env (cmd.md A4), then run this again" }
}
if ($paid) { $need += "paid-jobs.env" }
if ($admin -or $paid) { $need += "near-watch.env" }
if ($agentMode -eq "on") { $need += "agent-tenants.env" }
foreach ($f in $need) { if (-not (Test-Path (Join-Path $secrets $f))) { Stop-Here "missing $secrets\$f (MANUAL_SETUP.md; values are never read by this script)" } }
Say "OK" "secrets files present in $secrets (names only checked)"
$rpcLine = @(Select-String -Path (Join-Path $secrets "near-testnet.env") -Pattern '^\s*NEAR_RPC_URL_TESTNET\s*=\s*\S' -ErrorAction SilentlyContinue)
if (-not $rpcLine.Count) { Say "NOTE" "near-testnet.env has no NEAR_RPC_URL_TESTNET: the paywall uses FastNEAR, which rate-limits (set it to https://near-testnet.drpc.org)" }

# 2. leftovers of the old PC-process setup (desk.ps1 v1.3.4, start-ui.ps1, start-live.ps1): node processes only, never Docker
foreach ($port in @(8730, 8740, 8750, 8790, 8800)) {
  foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq "node") { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Say "STOP" "old PC process on $port (node pid $($p.Id))" }
  }
}

# 3. the admin side: near-watch in Docker + the 8800 admin UI, with this PC's watch list
if ($admin) {
  $adminArgs = @{ Secrets = $secrets }
  $watch = @(@($P.adminUi.watch) | Where-Object { $_ })
  if ($watch.Count) { $adminArgs.Watch = $watch }
  if ($P.adminUi.gasPerPaymentNear) { $adminArgs.GasPerPaymentNear = [string]$P.adminUi.gasPerPaymentNear }
  Say "RUN" "$adminUp (watch: $(if ($watch.Count) { $watch -join ', ' } else { 'its config\near-watch-watch.conf' }))"
  Push-Location $adminRoot
  try { & $adminUp @adminArgs } catch { Pop-Location; Stop-Here "nearadminup.ps1 stopped: $($_.Exception.Message)" }
  Pop-Location
}

# 4. the private side: the compose stack + the 8730 page (replaces containers that stack.ps1 / switch-models.ps1 started)
$privArgs = @{ ReplaceRunning = $true; NoBrowser = $true; PaidJobs = $(if ($paid) { "on" } else { "off" }) }
if ($Build) { $privArgs.Build = $true }
if ($WithStub) { $privArgs.Test = $true }
if ($agentMode -ne "auto") { $privArgs.Agent = $agentMode }
if ($agentMode -ne "off" -and $P.agent -and $P.agent.tenants) { $privArgs.AgentTenants = [string]$P.agent.tenants }
Say "RUN" "test-console\up.ps1 -ReplaceRunning -PaidJobs $($privArgs.PaidJobs)$(if ($Build) { ' -Build' })$(if ($WithStub) { ' -Test' })$(if ($agentMode -ne 'auto') { ' -Agent ' + $agentMode })"
& $privUp @privArgs
if ($LASTEXITCODE) { Stop-Here "test-console\up.ps1 stopped (exit $LASTEXITCODE): its STOP line above names the fix" }

# 5. one table across both
$bad = Report
if ($bad) { Write-Host ""; Say "NOT READY" "$bad problem(s) above; each names its fix"; exit 1 }
Write-Host ""; Say "READY" "console http://127.0.0.1:8730$(if ($admin) { '   NEAR admin UI http://127.0.0.1:8800/#jobs' })   stop: .\test-console\desk.ps1 -Stop"
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:8730"; if ($admin) { Start-Process "http://127.0.0.1:8800/#jobs" } }
