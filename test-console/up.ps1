<#
Starts the whole backend in Docker (docker-compose.yml at the repository root, DOCKERIZE-PLAN.md) and the 8730 UI on
this PC (server.ts --mode ui, which forwards every call to the console API in Docker on 127.0.0.1:8735).

  .\test-console\up.ps1 -DryRun                 check everything and write runtime\compose\commands.yml; start nothing
  .\test-console\up.ps1 -ReplaceRunning         stop the containers started by stack.ps1 / switch-models.ps1 (same
                                                names) and start the compose stack in their place, then the UI
  .\test-console\up.ps1                         the same once the compose stack owns the containers
  .\test-console\up.ps1 -Build                  rebuild the images first (gateway, paywall, presidio, analyst,
                                                chain-query, console)
  .\test-console\up.ps1 -Test                   also the OpenRouter stand-in (compose profile "test")
  .\test-console\up.ps1 -PaidJobs off           tab 03 free only (no paid-job settings needed)
  .\test-console\down.ps1                       stop the UI and the compose stack (volumes kept)

What it takes, from files outside the repository (NAME=value; values are never printed or written anywhere):
  -NearEnvFile         paywall NEAR settings, the same allowlist as stack.ps1 -NearEnvFile (buyer keys are ignored)
                       (default C:\PRIV-AI-SECRETS\near-testnet.env; "none" = XRPL only)
  -PaidJobsKeyFile     PAID_JOBS_KEY, shared by the paywall and the console (default C:\PRIV-AI-SECRETS\paid-jobs.env)
  -PaidJobsSettings    the console's paid-job prices file (NAME=value, not secret). Unset (default): -PaidJobsOverride
                       when that file exists, else the team defaults in -PaidJobsDefaults (committed)
  -PaidJobsOverride    this PC's own prices, used instead of the team defaults when present
                       (default C:\PRIV-AI-SECRETS\paid-jobs-settings.env)
  -PaidJobsDefaults    the team's shared prices, repo-relative (default config\paid-jobs-prices.conf)
  -NearWatchEnvFile    NEAR_WATCH_INGEST_KEY: the paywall's claims (PAYMENT_LOG_KEY) and the console's job feed
                       (default C:\PRIV-AI-SECRETS\near-watch.env; "none" = no claims and no job feed)
  -SecretsFile         the gateway's model keys OPENROUTER_API_KEY, BEDROCK_API_KEY (as switch-models.ps1); when a key
                       is not in it, the one the running ca-gateway holds is kept (default C:\PRIV-AI-SECRETS\chainaim.env)
The gateway key is test-console\local-gateway-key.txt, mounted as a compose secret (as the console reads it today).
The gateway runs the command the current ca-gateway runs (its model mode, from switch-models.ps1): change the mode with
switch-models.ps1 first, or after (it then owns ca-gateway again).
ASCII only (Windows PowerShell 5.1).
#>
param(
  [switch]$DryRun,
  [switch]$ReplaceRunning,
  [switch]$Build,
  [switch]$Test,
  [switch]$NoUi,
  [switch]$NoBrowser,
  [ValidateSet("on", "off")][string]$PaidJobs = "on",
  [string]$NearEnvFile = "C:\PRIV-AI-SECRETS\near-testnet.env",
  [string]$PaidJobsKeyFile = "C:\PRIV-AI-SECRETS\paid-jobs.env",
  [string]$PaidJobsSettings = "",
  [string]$PaidJobsOverride = "C:\PRIV-AI-SECRETS\paid-jobs-settings.env",
  [string]$PaidJobsDefaults = "config\paid-jobs-prices.conf",
  [string]$NearWatchEnvFile = "C:\PRIV-AI-SECRETS\near-watch.env",
  [string]$SecretsFile = "C:\PRIV-AI-SECRETS\chainaim.env",
  [string]$PaymentLogUrl = "http://near-watch:8790/ingest/claim",
  [string]$JobFeedUrl = "http://near-watch:8790/ingest/job",
  [ValidateSet("testnet", "mainnet")][string]$XrplNetwork = "testnet",
  [string]$PayTo,
  [ValidateSet("intear-wallet")][string]$NearWallet = "intear-wallet",
  [string]$PrivDataDir = "C:\PRIV-AI-DATA",
  [string]$SampleDataDir = "",
  [string]$ModelsFile = "config/local-models.cpu-all.json",
  [int]$UiPort = 8730,
  [int]$ApiPort = 8735,
  [int]$WaitSec = 90
)
$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location $repo
function Say([string]$tag, [string]$text) { Write-Host ("{0,-6} {1}" -f $tag, $text) }
function Stop-Here([string]$text) { Say "STOP" $text; exit 1 }
function Invoke-Quiet([string[]]$a) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & docker @a 2>$null; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  return [pscustomobject]@{ Code = $code; Out = ((@($out) | ForEach-Object { [string]$_ }) -join "`n").Trim() }
}
function Listening([int]$port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Wait-Http([string]$url, [hashtable]$headers, [string]$what) {
  $deadline = (Get-Date).AddSeconds($WaitSec)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -lt 500) { Say "OK" "$what answers"; return $true } } catch { }
    Start-Sleep -Seconds 2
  }
  Say "FAIL" "$what did not answer at $url within $WaitSec s"; return $false
}
# NAME=value lines of a file; only names matching $allowed are kept. Values are never printed.
function Read-EnvFile([string]$path, [string]$allowed) {
  $map = [ordered]@{}; $ignored = @()
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { throw "$path : a line is not NAME=value (line not printed)" }
    $n = $Matches[1]; $v = $Matches[2].Trim().Trim('"').Trim("'")
    if ($n -notmatch $allowed) { $ignored += $n; continue }
    if ($v -ne "") { $map[$n] = $v }
  }
  return [pscustomobject]@{ Values = $map; Ignored = $ignored }
}
function Get-ContainerEnv([string]$name) {
  $r = Invoke-Quiet @("inspect", "--format", "{{json .Config.Env}}", $name)
  $map = @{}
  if ($r.Code -eq 0 -and $r.Out) { foreach ($e in (ConvertFrom-Json -InputObject $r.Out)) { $ix = ([string]$e).IndexOf("="); if ($ix -gt 0) { $map[([string]$e).Substring(0, $ix)] = ([string]$e).Substring($ix + 1) } } }
  return $map
}
$set = New-Object System.Collections.Generic.List[string]   # env names set in this process, cleared at the end
function Set-Secret([string]$name, [string]$value) { Set-Item -Path "env:$name" -Value $value; $set.Add($name) | Out-Null }

try {
  # 1. Docker, network, ledger volume
  if ((Invoke-Quiet @("version", "--format", "{{.Server.Version}}")).Code -ne 0) { Stop-Here "Docker is not answering. Start Docker Desktop, wait for 'Engine running', then run this again." }
  if ((Invoke-Quiet @("compose", "version")).Code -ne 0) { Stop-Here "docker compose is not available (Docker Desktop includes it)." }
  Say "OK" "Docker is running"
  if ((Invoke-Quiet @("network", "inspect", "chainaim-test")).Code -ne 0) { if ($DryRun) { Say "INFO" "network chainaim-test would be created" } else { & docker network create chainaim-test | Out-Null; Say "OK" "created network chainaim-test" } }
  if ((Invoke-Quiet @("volume", "inspect", "chainaim-test-ledger")).Code -ne 0) { if ($DryRun) { Say "INFO" "volume chainaim-test-ledger would be created" } else { & docker volume create chainaim-test-ledger | Out-Null; Say "OK" "created volume chainaim-test-ledger" } }

  # 2. Containers with the compose names that compose does not own (started by stack.ps1 / switch-models.ps1)
  $names = @("ca-presidio", "ca-gateway", "ca-paywall", "ca-analyst", "ca-chain-query", "ca-console-api") + $(if ($Test) { @("ca-openrouter-stub") } else { @() })
  $foreign = @()
  foreach ($n in $names) {
    # Labels as JSON: Windows PowerShell 5.1 drops quotes inside a native argument, so no quoted template here.
    $r = Invoke-Quiet @("inspect", "--format", "{{json .Config.Labels}}", $n)
    if ($r.Code -ne 0) { continue }
    $labels = if ($r.Out -and $r.Out -ne "null") { ConvertFrom-Json -InputObject $r.Out } else { $null }
    $project = if ($labels) { $labels.'com.docker.compose.project' } else { $null }
    if ($project -ne "chainaim-private-ai") { $foreign += $n }
  }

  # 3. The gateway's current mode: the command switch-models.ps1 gave ca-gateway, kept exactly.
  $gwCmd = $null
  $r = Invoke-Quiet @("inspect", "--format", "{{json .Config.Cmd}}", "ca-gateway")
  # Windows PowerShell 5.1 hands a parsed JSON array over as ONE object; foreach walks its items (as stack.ps1 does).
  if ($r.Code -eq 0 -and $r.Out -and $r.Out -ne "null") { $parsed = ConvertFrom-Json -InputObject $r.Out; $gwCmd = [string[]]@(foreach ($x in $parsed) { [string]$x }) }
  if (-not $gwCmd) { Stop-Here "no ca-gateway to take the model mode from. Run .\test-console\switch-models.ps1 -To <mode> once (it asks for the model keys), then run this again." }
  Say "OK" "gateway mode from ca-gateway: $((@($gwCmd) | Where-Object { $_ -like '/config/*' }) -join ' ')"
  $gwEnv = Get-ContainerEnv "ca-gateway"
  $fromFile = @{}
  if (Test-Path $SecretsFile) { $fromFile = (Read-EnvFile $SecretsFile '^(OPENROUTER_API_KEY|BEDROCK_API_KEY)$').Values }
  foreach ($k in @("OPENROUTER_API_KEY", "BEDROCK_API_KEY")) {
    if ($fromFile[$k]) { Set-Secret $k $fromFile[$k]; Say "OK" "$k from $SecretsFile" }
    elseif ($gwEnv[$k]) { Set-Secret $k $gwEnv[$k]; Say "OK" "$k kept from the running ca-gateway (not printed)" }
  }
  $keyFile = Join-Path $PSScriptRoot "local-gateway-key.txt"
  if (-not (Test-Path $keyFile)) { Stop-Here "Missing $keyFile (the gateway key the console, gateway and paywall share)." }
  Set-Secret "CHAINAIM_GATEWAY_KEY" ((Get-Content -Raw $keyFile).Trim())

  # 4. Paywall: XRPL pay-to (public), NEAR settings (allowlist), paid jobs, payment log
  $payName = "XRPL_PAY_TO_" + $XrplNetwork.ToUpper()
  $pay = $PayTo
  if (-not $pay) { $pay = [Environment]::GetEnvironmentVariable($payName) }
  if (-not $pay) { $pay = (Get-ContainerEnv "ca-paywall")[$payName] }
  if (-not $pay) { Stop-Here "No ${payName}: pass -PayTo r..., or set it in this window (stack.ps1 uses the same)." }
  if ($pay -notmatch '^r[1-9A-HJ-NP-Za-km-z]{24,34}$') { Stop-Here "Pay-to '$pay' is not an XRPL classic address." }
  Set-Secret "XRPL_NETWORK" $XrplNetwork; Set-Secret $payName $pay
  Say "OK" "XRPL $XrplNetwork pay-to $pay"
  foreach ($n in @("FACILITATOR_URL_TESTNET", "FACILITATOR_URL_MAINNET", "RLUSD_ISSUER_TESTNET", "RLUSD_ISSUER_MAINNET", "PRICE_SCAN", "PRICE_MASK", "PRICE_CHAT", "PUBLIC_BASE_URL")) {
    if ([Environment]::GetEnvironmentVariable($n)) { Say "INFO" "passing $n from this window" }
  }
  if ($NearEnvFile -ne "none") {
    if (-not (Test-Path $NearEnvFile)) { Stop-Here "-NearEnvFile $NearEnvFile does not exist (or pass -NearEnvFile none for XRPL only)" }
    $near = Read-EnvFile $NearEnvFile '^(PAY_RAILS|NEAR_NETWORK|NEAR_MAX_GAS|NEAR_(PAY_TO|USDC_CONTRACT|USDC_DECIMALS|RPC_URL|RPC_FALLBACK_URL|FACILITATOR_URL|RELAYER_ACCOUNT|RELAYER_KEY)_(TESTNET|MAINNET))$'
    foreach ($k in $near.Values.Keys) { Set-Secret $k $near.Values[$k] }
    if (-not $env:PAY_RAILS) { Set-Secret "PAY_RAILS" "xrpl,near"; Say "INFO" "PAY_RAILS not in ${NearEnvFile}: xrpl,near (as the running ca-paywall)" }
    Say "OK" "NEAR rail: $($near.Values.Keys.Count) setting(s) from $NearEnvFile (values not printed); ignored: $($near.Ignored -join ', ')"
  }
  if ($PaidJobs -eq "on") {
    if (-not $env:PAY_RAILS -or ($env:PAY_RAILS -split ",") -notcontains "near") { Stop-Here "-PaidJobs on needs the NEAR rail (-NearEnvFile), or pass -PaidJobs off" }
    if (-not (Test-Path $PaidJobsKeyFile)) { Stop-Here "-PaidJobsKeyFile $PaidJobsKeyFile does not exist" }
    $k = (Read-EnvFile $PaidJobsKeyFile '^PAID_JOBS_KEY$').Values["PAID_JOBS_KEY"]
    if (-not $k -or $k.Length -lt 24) { Stop-Here "$PaidJobsKeyFile has no PAID_JOBS_KEY of at least 24 characters" }
    Set-Secret "PAID_JOBS" "on"; Set-Secret "PAID_JOBS_KEY" $k
    if (-not $PaidJobsSettings) { $PaidJobsSettings = if (Test-Path $PaidJobsOverride) { $PaidJobsOverride } else { Join-Path $repo $PaidJobsDefaults } }
    if (-not (Test-Path $PaidJobsSettings)) { Stop-Here "the paid-job prices file $PaidJobsSettings does not exist (team defaults: config\paid-jobs-prices.conf; MANUAL_SETUP.md, Backend in Docker)" }
    $ps = (Read-EnvFile $PaidJobsSettings '^(PRICING_CATALOG|FEE_PER_MODEL_CALL_USD|FEE_ANALYST_USD|NEAR_GAS_FEE_USD|MARGIN_PCT|MIN_PRICE_USD|JOB_TTL_MIN|JOB_MAX)$').Values
    foreach ($need in @("PRICING_CATALOG", "FEE_PER_MODEL_CALL_USD", "FEE_ANALYST_USD", "NEAR_GAS_FEE_USD", "MARGIN_PCT", "MIN_PRICE_USD")) { if (-not $ps[$need]) { Stop-Here "$PaidJobsSettings has no $need (never defaulted)" } }
    $cat = $ps["PRICING_CATALOG"].Replace("\", "/")
    if ($cat -notmatch '^config/[A-Za-z0-9._/-]+\.json$' -or -not (Test-Path (Join-Path $repo $cat))) { Stop-Here "PRICING_CATALOG must be a catalog file under config/, e.g. config/catalog.bedrock.json; got $cat" }
    Say "OK" "paid jobs on: prices from $PaidJobsSettings, catalog $cat"
  } else { $ps = @{} }
  $ingest = $null
  if ($NearWatchEnvFile -ne "none") {
    if (-not (Test-Path $NearWatchEnvFile)) { Stop-Here "-NearWatchEnvFile $NearWatchEnvFile does not exist (or pass -NearWatchEnvFile none)" }
    $ingest = (Read-EnvFile $NearWatchEnvFile '^NEAR_WATCH_INGEST_KEY$').Values["NEAR_WATCH_INGEST_KEY"]
    if (-not $ingest -or $ingest.Length -lt 24) { Stop-Here "$NearWatchEnvFile has no NEAR_WATCH_INGEST_KEY of at least 24 characters" }
    Set-Secret "PAYMENT_LOG_URL" $PaymentLogUrl; Set-Secret "PAYMENT_LOG_KEY" $ingest
    if ($PaidJobs -eq "on" -and $JobFeedUrl -ne "none") { Set-Secret "NEAR_WATCH_INGEST_KEY" $ingest }
    Say "OK" "claims to $PaymentLogUrl$(if ($PaidJobs -eq 'on' -and $JobFeedUrl -ne 'none') { "; job feed to $JobFeedUrl" }) (key from $NearWatchEnvFile, not printed)"
  }

  # 5. Data folders and the generated command file (no secrets in it)
  $sample = if ($SampleDataDir) { $SampleDataDir } else { Join-Path $repo "sample-data" }
  if (-not (Test-Path $sample)) { if ($DryRun) { Say "INFO" "$sample would be created (empty) for the sample-data mount" } else { New-Item -ItemType Directory -Force -Path $sample | Out-Null } }
  if (-not (Test-Path $PrivDataDir)) { Stop-Here "-PrivDataDir $PrivDataDir does not exist" }
  Set-Secret "SAMPLE_DATA_DIR" $sample; Set-Secret "PRIV_AI_DATA_DIR" $PrivDataDir; Set-Secret "CHAINAIM_SOURCE" $repo
  $consoleCmd = @("--mode=api", "--bind=0.0.0.0", "--port=$ApiPort", "--gateway-key-file=/run/secrets/gateway-key", "--run-log-dir=/runs",
    "--gateway=http://gateway.railway.internal:8700", "--paywall=http://paywall:8080", "--analyst=http://analyst:8740", "--chain-query=http://chain-query:8750",
    "--spy=http://openrouter-stub:5004", "--data-config=/app/config/data-sources.docker.json", "--ledger-source=dir:/gateway-data/ledger",
    "--dataset-root=private=/data/priv-ai-data/chainaim3003", "--models-file=/app/$($ModelsFile.Replace('\', '/'))", "--near-wallet=$NearWallet")
  if ($PaidJobs -eq "on") {
    $consoleCmd += @("--paid-jobs=on", "--jobs-internal-host=0.0.0.0", "--jobs-internal-port=8731", "--pricing-catalog=/app/$cat",
      "--fee-per-model-call-usd=$($ps['FEE_PER_MODEL_CALL_USD'])", "--fee-analyst-usd=$($ps['FEE_ANALYST_USD'])", "--near-gas-fee-usd=$($ps['NEAR_GAS_FEE_USD'])",
      "--margin-pct=$($ps['MARGIN_PCT'])", "--min-price-usd=$($ps['MIN_PRICE_USD'])")
    if ($ps["JOB_TTL_MIN"]) { $consoleCmd += "--job-ttl-min=$($ps['JOB_TTL_MIN'])" }
    if ($ps["JOB_MAX"]) { $consoleCmd += "--job-max=$($ps['JOB_MAX'])" }
    if ($ingest -and $JobFeedUrl -ne "none") { $consoleCmd += "--job-feed-url=$JobFeedUrl" }
  }
  $port = "127.0.0.1:${ApiPort}:${ApiPort}"
  $override = [ordered]@{ services = [ordered]@{ gateway = [ordered]@{ command = @($gwCmd) }; "console-api" = [ordered]@{ command = $consoleCmd; ports = @($port) } } }
  $outDir = Join-Path $repo "runtime\compose"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $cmdFile = Join-Path $outDir "commands.yml"
  # JSON is YAML: compose reads this file as an override of docker-compose.yml.
  [IO.File]::WriteAllText($cmdFile, ($override | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  Say "OK" "wrote $cmdFile (commands only, no secrets)"
  $composeArgs = @("compose", "-f", "docker-compose.yml", "-f", $cmdFile) + $(if ($Test) { @("--profile", "test") } else { @() })
  $check = Invoke-Quiet ($composeArgs + @("config", "-q"))
  if ($check.Code -ne 0) { Stop-Here "docker compose rejected the configuration; run: docker compose -f docker-compose.yml -f runtime\compose\commands.yml config -q   (do NOT run it without -q: it prints the values)" }
  Say "OK" "compose configuration is valid"

  # 6. Ports this stack publishes must be free, or held by this stack's own containers
  foreach ($p in @(8740, 8750, $ApiPort)) {
    $own = (Invoke-Quiet @("ps", "--filter", "label=com.docker.compose.project=chainaim-private-ai", "--filter", "publish=$p", "-q")).Out
    if ((Listening $p) -and -not $own) { Stop-Here "port $p is in use on this PC (the analyst / chain-query / console windows of start-ui.ps1?). Close that window, then run this again." }
  }
  if ($foreign.Count -and -not $ReplaceRunning -and -not $DryRun) { Stop-Here "these containers were started by stack.ps1 / switch-models.ps1: $($foreign -join ', '). Add -ReplaceRunning to stop them and start the compose stack in their place (rollback: DOCKERIZE-PLAN.md section 8)." }
  if ($DryRun) { Say "DRYRUN" "everything checked; nothing started.$(if ($foreign.Count) { " -ReplaceRunning would replace: $($foreign -join ', ')" })"; exit 0 }

  # 7. Start
  if ($foreign.Count) { foreach ($n in $foreign) { Say "REPLACE" "$n (docker rm -f; its volume and image are kept)"; & docker rm -f $n | Out-Null } }
  $upArgs = $composeArgs + @("up", "-d") + $(if ($Build) { @("--build") } else { @() })
  & docker @upArgs
  if ($LASTEXITCODE -ne 0) { Stop-Here "docker compose up failed; see the message above. Rollback: DOCKERIZE-PLAN.md section 8." }
  $ok = (Wait-Http "http://127.0.0.1:8720/healthz" @{} "gateway") -and
        (Wait-Http "http://127.0.0.1:8740/healthz" @{} "analyst") -and
        (Wait-Http "http://127.0.0.1:8750/healthz" @{} "chain-query") -and
        (Wait-Http "http://127.0.0.1:$ApiPort/data/config" @{} "console-api")
  if (-not $ok) { Stop-Here "a service did not come up: docker compose logs --tail 40 <service>" }
} finally {
  foreach ($n in $set) { Remove-Item "env:$n" -ErrorAction SilentlyContinue }
}

# 8. The UI on this PC (holds no key, reads no data)
if ($NoUi) { Say "READY" "backend in Docker; console API http://127.0.0.1:$ApiPort (UI not started: -NoUi)"; exit 0 }
if (Listening $UiPort) { Stop-Here "port $UiPort is in use (an old console window?). Close it, then: .\test-console\up.ps1" }
$pageFlags = " --near-wallet $NearWallet" + $(if ($PaidJobs -eq "on") { " --paid-jobs-page on" } else { "" })
$cmd = "Set-Location '$repo'; node test-console\console\server.ts --mode ui --port $UiPort --api http://127.0.0.1:$ApiPort$pageFlags"
Start-Process powershell -ArgumentList @("-NoExit", "-Command", $cmd)
if (-not (Wait-Http "http://127.0.0.1:$UiPort/" @{} "UI")) { Stop-Here "Look at the UI window for the error." }
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$UiPort" }
Say "READY" "http://127.0.0.1:$UiPort  (backend in Docker; stop with .\test-console\down.ps1)"
