<#
Starts the whole backend in Docker (docker-compose.yml at the repository root, DOCKERIZE-PLAN.md) and the 8730 UI on
this PC (server.ts --mode ui, which forwards every call to the console API in Docker on 127.0.0.1:8735).

  .\test-console\up.ps1 -DryRun                 check everything and write runtime\compose\commands.yml; start nothing
  .\test-console\up.ps1 -ReplaceRunning         stop the containers started by stack.ps1 / switch-models.ps1 (same
                                                names) and start the compose stack in their place, then the UI
  .\test-console\up.ps1                         the same once the compose stack owns the containers
  .\test-console\up.ps1 -Build                  kept for old habits: every start now rebuilds the images (gateway, paywall,
                                                presidio, analyst, chain-query, console, agent, attest) with Docker's cache,
                                                seconds when nothing changed, so an image never runs older code than the
                                                flags this script writes (seen 2026-11-06: "Unknown option '--attest-url'")
  .\test-console\up.ps1 -NoBuild                skip that rebuild (offline, or to start exactly the images already built)
  .\test-console\up.ps1 -Test                   also the OpenRouter stand-in (compose profile "test")
  .\test-console\up.ps1 -PaidJobs off           tab 03 free only (no paid-job settings needed)
  .\test-console\up.ps1 -Agent on               also tab 03 agent mode (architecture-tab03-agent-mode.md ARCH-312): the agent
                                                container ca-agent (compose profile "agent"), and the console API relays
                                                /agent/* to it. Needs -PaidJobs on. Default on (owner decision 2026-11-06):
                                                without -Agent it is switched off, with an INFO line, when -PaidJobs is off,
                                                -AgentEnvFile does not exist or no BEDROCK_API_KEY is found; -Agent on
                                                stops instead, -Agent off turns it off.
  .\test-console\up.ps1 -Attest on              also NEAR AI model attestation (PLAN-private-ai-nearai-attestation.md ARCH-411):
                                                ca-attest (compose profile "attest", services\attest) and the console API
                                                asks it about every quoted job (--attest-url). Default on: without -Attest it
                                                is switched off, with an INFO line, when -PaidJobs is off, no NEARAI_API_KEY
                                                is found, or the running catalog (config\generated\catalog.local.json) has no
                                                "attest": "nearai" model; -Attest on stops instead, -Attest off turns it off.
                                                -AttestGpuCheck on|off (default on): require NVIDIA's GPU verdict.
  .\test-console\up.ps1 -Receipts on            signed Job Evidence Receipts (privateAI-design-32 ARCH-614/615): the console API
                                                runs with --receipts on, the signing key passed to it by name as
                                                RECEIPT_SIGNING_KEY, receipts kept on the volume chainaim-console-receipts
                                                (/receipts). Default on: without -Receipts it is switched off, with an INFO
                                                line, when -PaidJobs is off or no key is found (desk.ps1 -ReceiptKey makes
                                                one); -Receipts on stops instead, -Receipts off turns it off.
                                                -ReceiptKeyName NAME: the key's name in -SecretsFile (default
                                                RECEIPT_SIGNING_KEY); inside the container it is always RECEIPT_SIGNING_KEY.
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
                       is not in it, the one the running ca-gateway holds is kept (default C:\PRIV-AI-SECRETS\chainaim.env).
                       Optional NEARAI_API_KEY (mode ollama-cpu-8gb-all-nearai) the same way; nothing is said when absent.
  -AgentEnvFile        -Agent on only: the agent's env file, mounted read-only into ca-agent and read by Node's --env-file
                       (default C:\PRIV-AI-SECRETS\agent-tenants.env; MANUAL_SETUP.md M2). Checked to exist, never read here.
                       The Bedrock key the agent uses is BEDROCK_API_KEY (from -SecretsFile or the running ca-gateway, as
                       above), passed to ca-agent by name as AWS_BEARER_TOKEN_BEDROCK.
  -AgentTenants, -AgentRegion, -AgentModelId, -AgentTimeoutSec, -AgentPort   the agent's tenants, Bedrock region and
                       model, run timeout and port (defaults t01,t02,t03 / ap-southeast-2 / nvidia.nemotron-nano-3-30b / 300 / 8760)
The gateway key is test-console\local-gateway-key.txt, mounted as a compose secret (as the console reads it today).
The gateway runs the command the current ca-gateway runs (its model mode, from switch-models.ps1): change the mode with
switch-models.ps1 first, or after (it then owns ca-gateway again).
  -StateFile           after each successful start the gateway command and the XRPL pay-to (public values, no keys) are
                       saved here, and used only when no ca-gateway / ca-paywall is left to read them from (after
                       down.ps1). Default runtime\compose\last-start.json (git-ignored). Model keys are never saved.
A container counts as this stack's own only when compose created it (labels com.docker.compose.project and
com.docker.compose.config-hash); one run by hand from a compose-built image (switch-models.ps1) is replaced by
-ReplaceRunning.
ASCII only (Windows PowerShell 5.1).
#>
param(
  [switch]$DryRun,
  [switch]$ReplaceRunning,
  [switch]$Build,
  [switch]$NoBuild,
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
  [int]$WaitSec = 180,
  [ValidateSet("on", "off")][string]$Agent = "on",
  [string]$AgentEnvFile = "C:\PRIV-AI-SECRETS\agent-tenants.env",
  [string]$AgentTenants = "t01,t02,t03",
  [string]$AgentRegion = "ap-southeast-2",
  [string]$AgentModelId = "nvidia.nemotron-nano-3-30b",
  [int]$AgentTimeoutSec = 300,
  [int]$AgentPort = 8760,
  [string]$DefaultAnswerModel = "",
  [ValidateSet("me", "agent")][string]$DefaultPayer = "me",
  [ValidateSet("on", "off")][string]$Attest = "on",
  [ValidateSet("on", "off")][string]$AttestGpuCheck = "on",
  [ValidateSet("on", "off")][string]$Receipts = "on",
  [string]$ReceiptKeyName = "RECEIPT_SIGNING_KEY",
  [int]$AttestPort = 8770,
  [string]$AttestCatalog = "config\generated\catalog.local.json",
  [string]$StateFile = "runtime\compose\last-start.json"
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
# The last successful start (public values only), used when no container is left to read them from.
$statePath = if ([IO.Path]::IsPathRooted($StateFile)) { $StateFile } else { Join-Path $repo $StateFile }
$saved = $null
if (Test-Path $statePath) { try { $saved = Get-Content -Raw $statePath | ConvertFrom-Json } catch { Say "WARN" "$statePath is not valid JSON; not used" } }

try {
  # 1. Docker, network, ledger volume
  if ((Invoke-Quiet @("version", "--format", "{{.Server.Version}}")).Code -ne 0) { Stop-Here "Docker is not answering. Start Docker Desktop, wait for 'Engine running', then run this again." }
  if ((Invoke-Quiet @("compose", "version")).Code -ne 0) { Stop-Here "docker compose is not available (Docker Desktop includes it)." }
  Say "OK" "Docker is running"
  if ((Invoke-Quiet @("network", "inspect", "chainaim-test")).Code -ne 0) { if ($DryRun) { Say "INFO" "network chainaim-test would be created" } else { & docker network create chainaim-test | Out-Null; Say "OK" "created network chainaim-test" } }
  if ((Invoke-Quiet @("volume", "inspect", "chainaim-test-ledger")).Code -ne 0) { if ($DryRun) { Say "INFO" "volume chainaim-test-ledger would be created" } else { & docker volume create chainaim-test-ledger | Out-Null; Say "OK" "created volume chainaim-test-ledger" } }

  # 2. Containers with the compose names that compose does not own (started by stack.ps1 / switch-models.ps1)
  $names = @("ca-presidio", "ca-gateway", "ca-paywall", "ca-analyst", "ca-chain-query", "ca-console-api") + $(if ($Test) { @("ca-openrouter-stub") } else { @() }) + $(if ($Agent -eq "on") { @("ca-agent") } else { @() }) + $(if ($Attest -eq "on") { @("ca-attest") } else { @() })
  $foreign = @()
  foreach ($n in $names) {
    # Labels as JSON: Windows PowerShell 5.1 drops quotes inside a native argument, so no quoted template here.
    $r = Invoke-Quiet @("inspect", "--format", "{{json .Config.Labels}}", $n)
    if ($r.Code -ne 0) { continue }
    $labels = if ($r.Out -and $r.Out -ne "null") { ConvertFrom-Json -InputObject $r.Out } else { $null }
    $project = if ($labels) { $labels.'com.docker.compose.project' } else { $null }
    # Only compose puts config-hash on a container it created. A container run by hand from a compose-built image
    # (switch-models.ps1's ca-gateway) inherits the image's project and service labels, but not this one.
    $hash = if ($labels) { $labels.'com.docker.compose.config-hash' } else { $null }
    if ($project -ne "chainaim-private-ai" -or -not $hash) { $foreign += $n }
  }

  # 3. The gateway's current mode: the command switch-models.ps1 gave ca-gateway, kept exactly.
  $gwCmd = $null
  $gwFrom = "ca-gateway"
  $r = Invoke-Quiet @("inspect", "--format", "{{json .Config.Cmd}}", "ca-gateway")
  # Windows PowerShell 5.1 hands a parsed JSON array over as ONE object; foreach walks its items (as stack.ps1 does).
  if ($r.Code -eq 0 -and $r.Out -and $r.Out -ne "null") { $parsed = ConvertFrom-Json -InputObject $r.Out; $gwCmd = [string[]]@(foreach ($x in $parsed) { [string]$x }) }
  if (-not $gwCmd -and $saved -and $saved.gatewayCmd) { $gwCmd = [string[]]@(foreach ($x in $saved.gatewayCmd) { [string]$x }); $gwFrom = "the last start ($statePath)" }
  if (-not $gwCmd) { Stop-Here "no ca-gateway to take the model mode from, and no saved last start ($statePath). Run .\test-console\switch-models.ps1 -To <mode> once (it asks for the model keys), then run this again." }
  Say "OK" "gateway mode from ${gwFrom}: $((@($gwCmd) | Where-Object { $_ -like '/config/*' }) -join ' ')"
  $gwEnv = Get-ContainerEnv "ca-gateway"
  $fromFile = @{}
  if (Test-Path $SecretsFile) { $fromFile = (Read-EnvFile $SecretsFile '^(OPENROUTER_API_KEY|BEDROCK_API_KEY)$').Values }
  foreach ($k in @("OPENROUTER_API_KEY", "BEDROCK_API_KEY")) {
    if ($fromFile[$k]) { Set-Secret $k $fromFile[$k]; Say "OK" "$k from $SecretsFile" }
    elseif ($gwEnv[$k]) { Set-Secret $k $gwEnv[$k]; Say "OK" "$k kept from the running ca-gateway (not printed)" }
    elseif ($gwFrom -ne "ca-gateway" -and -not (Get-Item -Path "env:$k" -ErrorAction SilentlyContinue)) { Say "WARN" "$k is not in $SecretsFile and no ca-gateway holds it: models that need it will not answer (add it to $SecretsFile, or run switch-models.ps1)" }
  }
  # NEARAI_API_KEY (PLAN-private-ai-nearai-attestation.md ARCH-403): optional, only the ollama-cpu-8gb-all-nearai mode uses it.
  # Passed on when found, by name only; when absent nothing is said or set, so every other mode starts exactly as before.
  $k = "NEARAI_API_KEY"
  $nearaiFile = if (Test-Path $SecretsFile) { (Read-EnvFile $SecretsFile '^NEARAI_API_KEY$').Values[$k] } else { $null }
  if ($nearaiFile) { Set-Secret $k $nearaiFile; Say "OK" "$k from $SecretsFile" }
  elseif ($gwEnv[$k]) { Set-Secret $k $gwEnv[$k]; Say "OK" "$k kept from the running ca-gateway (not printed)" }
  # Receipt signing key (ARCH-614): read by name from -SecretsFile, else kept from the running ca-console-api; held in this
  # process only and set (by name, for compose) further down, only when receipts are on. Never printed or written.
  if ($ReceiptKeyName -notmatch '^[A-Z_][A-Z0-9_]*$') { Stop-Here "-ReceiptKeyName must be an environment variable name such as RECEIPT_SIGNING_KEY" }
  $receiptKey = if (Test-Path $SecretsFile) { (Read-EnvFile $SecretsFile ('^' + $ReceiptKeyName + '$')).Values[$ReceiptKeyName] } else { $null }
  $receiptKeyFrom = $SecretsFile
  if (-not $receiptKey) { $receiptKey = (Get-ContainerEnv "ca-console-api")["RECEIPT_SIGNING_KEY"]; $receiptKeyFrom = "the running ca-console-api" }
  $keyFile = Join-Path $PSScriptRoot "local-gateway-key.txt"
  if (-not (Test-Path $keyFile)) { Stop-Here "Missing $keyFile (the gateway key the console, gateway and paywall share)." }
  Set-Secret "CHAINAIM_GATEWAY_KEY" ((Get-Content -Raw $keyFile).Trim())

  # 4. Paywall: XRPL pay-to (public), NEAR settings (allowlist), paid jobs, payment log
  $payName = "XRPL_PAY_TO_" + $XrplNetwork.ToUpper()
  $pay = $PayTo
  if (-not $pay) { $pay = [Environment]::GetEnvironmentVariable($payName) }
  if (-not $pay) { $pay = (Get-ContainerEnv "ca-paywall")[$payName] }
  if (-not $pay -and $saved -and $saved.xrplPayTo -and $saved.xrplPayTo.$XrplNetwork) { $pay = [string]$saved.xrplPayTo.$XrplNetwork; Say "INFO" "XRPL pay-to from the last start ($statePath)" }
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
  # Tab 03 defaults (owner 2026-11-07): only added when set, so the command is otherwise exactly as before.
  if ($DefaultAnswerModel) {
    if ($DefaultAnswerModel -notmatch '^[\w.-]+/[\w.:-]+$') { Stop-Here "-DefaultAnswerModel must look like provider/name, e.g. nearai/deepseek-v4.1-flash" }
    $consoleCmd += "--default-answer-model=$DefaultAnswerModel"
  }
  if ($DefaultPayer -ne "me") { $consoleCmd += "--default-payer=$DefaultPayer" }
  if ($PaidJobs -eq "on") {
    $consoleCmd += @("--paid-jobs=on", "--jobs-internal-host=0.0.0.0", "--jobs-internal-port=8731", "--pricing-catalog=/app/$cat",
      "--fee-per-model-call-usd=$($ps['FEE_PER_MODEL_CALL_USD'])", "--fee-analyst-usd=$($ps['FEE_ANALYST_USD'])", "--near-gas-fee-usd=$($ps['NEAR_GAS_FEE_USD'])",
      "--margin-pct=$($ps['MARGIN_PCT'])", "--min-price-usd=$($ps['MIN_PRICE_USD'])")
    if ($ps["JOB_TTL_MIN"]) { $consoleCmd += "--job-ttl-min=$($ps['JOB_TTL_MIN'])" }
    if ($ps["JOB_MAX"]) { $consoleCmd += "--job-max=$($ps['JOB_MAX'])" }
    if ($ingest -and $JobFeedUrl -ne "none") { $consoleCmd += "--job-feed-url=$JobFeedUrl" }
  }
  # Tab 03 agent mode (ARCH-311, ARCH-312): only with -Agent on; without it the commands file is exactly as before.
  $agentCmd = $null
  # Default on: when -Agent was not passed, a PC without what agent mode needs runs without it (manual pay still works).
  if ($Agent -eq "on" -and -not $PSBoundParameters.ContainsKey("Agent")) {
    $why = if ($PaidJobs -ne "on") { "-PaidJobs off" } elseif (-not (Test-Path $AgentEnvFile)) { "no $AgentEnvFile" } elseif (-not $env:BEDROCK_API_KEY) { "no BEDROCK_API_KEY" } else { $null }
    if ($why) { Say "INFO" "agent mode off: $why (pass -Agent on to require it, -Agent off to skip this check)"; $Agent = "off" }
  }
  if ($Agent -eq "on") {
    if ($PaidJobs -ne "on") { Stop-Here "-Agent on needs -PaidJobs on: the agent runs and pays the paid job" }
    if (-not (Test-Path $AgentEnvFile)) { Stop-Here "-AgentEnvFile $AgentEnvFile does not exist: create it with the tenants' NEAR keys (MANUAL_SETUP.md, Tab 03 agent mode, M2)" }
    if (-not $env:BEDROCK_API_KEY) { Stop-Here "-Agent on needs BEDROCK_API_KEY (in $SecretsFile, or held by the running ca-gateway) for the agent's Bedrock model" }
    if ($AgentTenants -notmatch '^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$') { Stop-Here "-AgentTenants must be tenant ids separated by commas, e.g. t01,t02,t03" }
    if ($AgentTimeoutSec -lt 1) { Stop-Here "-AgentTimeoutSec must be at least 1" }
    Set-Secret "AWS_BEARER_TOKEN_BEDROCK" $env:BEDROCK_API_KEY
    Set-Secret "AGENT_ENV_FILE" ($AgentEnvFile.Replace("\", "/"))
    $consoleCmd += @("--agent-service=http://agent:$AgentPort", "--agent-forward-timeout-sec=$($AgentTimeoutSec + 30)",
      "--allowed-hosts=127.0.0.1:$ApiPort,localhost:$ApiPort,console-api:$ApiPort")
    $agentCmd = @("--host=0.0.0.0", "--port=$AgentPort", "--allowed-hosts=agent:$AgentPort,127.0.0.1:$AgentPort,localhost:$AgentPort",
      "--tenants=/app/rig/tenants", "--agent-tenants=$AgentTenants", "--console=http://console-api:$ApiPort", "--paywall=http://paywall:8080",
      "--region=$AgentRegion", "--model-id=$AgentModelId", "--aws-auth=bearer", "--presidio-url=http://presidio.railway.internal:3000",
      "--run-timeout-sec=$AgentTimeoutSec")
    Say "OK" "agent mode on: tenants $AgentTenants, Bedrock $AgentModelId in $AgentRegion; keys from $AgentEnvFile (mounted, not read here); Bedrock key passed by name"
  }
  # NEAR AI model attestation (ARCH-411): ca-attest reads the models to attest from the catalog the gateway runs with.
  $attestCmd = $null
  $attCatPath = if ([IO.Path]::IsPathRooted($AttestCatalog)) { $AttestCatalog } else { Join-Path $repo $AttestCatalog }
  $attCatHas = (Test-Path $attCatPath) -and ((Get-Content -Raw $attCatPath) -match '"attest"\s*:\s*"nearai"')
  # A catalog generated before its registry last changed (seen 2026-11-06: no "attest" after ARCH-407) is stale: say so.
  if ((Test-Path $attCatPath) -and ((Get-Content -Raw $attCatPath) -match 'GENERATED from (config/[A-Za-z0-9._/-]+\.json)')) {
    $srcReg = Join-Path $repo ($Matches[1].Replace("/", "\"))
    if ((Test-Path $srcReg) -and (Get-Item $srcReg).LastWriteTimeUtc -gt (Get-Item $attCatPath).LastWriteTimeUtc) {
      Say "WARN" "$AttestCatalog is older than $($Matches[1]), which it was generated from: run .\test-console\switch-models.ps1 again for the current mode to regenerate it"
    }
  }
  if ($Attest -eq "on" -and -not $PSBoundParameters.ContainsKey("Attest")) {
    $why = if ($PaidJobs -ne "on") { "-PaidJobs off" } elseif (-not $env:NEARAI_API_KEY) { "no NEARAI_API_KEY" } elseif (-not $attCatHas) { "no attested model in $AttestCatalog (switch-models.ps1 -To ollama-cpu-8gb-all-nearai)" } else { $null }
    if ($why) { Say "INFO" "model attestation off: $why (pass -Attest on to require it, -Attest off to skip this check)"; $Attest = "off" }
  }
  if ($Attest -eq "on") {
    if ($PaidJobs -ne "on") { Stop-Here "-Attest on needs -PaidJobs on: only quoted jobs are attested" }
    if (-not $env:NEARAI_API_KEY) { Stop-Here "-Attest on needs NEARAI_API_KEY (in $SecretsFile, or held by the running ca-gateway)" }
    if (-not $attCatHas) { Stop-Here "-Attest on needs a model with `"attest`": `"nearai`" in $attCatPath (switch-models.ps1 generates it)" }
    $consoleCmd += "--attest-url=http://attest:$AttestPort"
    $attestCmd = @("--host=0.0.0.0", "--allow-non-loopback", "--port=$AttestPort", "--allowed-hosts=attest:$AttestPort,127.0.0.1:$AttestPort,localhost:$AttestPort",
      "--catalog=/config/generated/catalog.local.json", "--gpu-check=$AttestGpuCheck")
    Say "OK" "model attestation on: ca-attest on port $AttestPort, GPU check $AttestGpuCheck; NEAR AI key passed by name"
  }
  # Signed receipts (ARCH-614/615): only with paid jobs; the key goes to compose by name (RECEIPT_SIGNING_KEY), never into
  # commands.yml. Default on: without -Receipts, a PC with no key yet runs without receipts (desk.ps1 -ReceiptKey makes one).
  if ($Receipts -eq "on" -and -not $PSBoundParameters.ContainsKey("Receipts")) {
    $why = if ($PaidJobs -ne "on") { "-PaidJobs off" } elseif (-not $receiptKey) { "no $ReceiptKeyName in $SecretsFile (run .\test-console\desk.ps1 -ReceiptKey once)" } else { $null }
    if ($why) { Say "INFO" "receipts off: $why (pass -Receipts on to require them, -Receipts off to skip this check)"; $Receipts = "off" }
  }
  if ($Receipts -eq "on") {
    if ($PaidJobs -ne "on") { Stop-Here "-Receipts on needs -PaidJobs on: a receipt is for a paid job" }
    if (-not $receiptKey) { Stop-Here "-Receipts on needs $ReceiptKeyName in ${SecretsFile}: run .\test-console\desk.ps1 -ReceiptKey once" }
    Set-Secret "RECEIPT_SIGNING_KEY" $receiptKey
    $consoleCmd += @("--receipts=on", "--receipt-key-env=RECEIPT_SIGNING_KEY", "--receipt-dir=/receipts")
    Say "OK" "receipts on: the console signs one after each paid job; key from $receiptKeyFrom (not printed), kept on volume chainaim-console-receipts"
  }
  $receiptKey = $null
  $port = "127.0.0.1:${ApiPort}:${ApiPort}"
  $override = [ordered]@{ services = [ordered]@{ gateway = [ordered]@{ command = @($gwCmd) }; "console-api" = [ordered]@{ command = $consoleCmd; ports = @($port) } } }
  if ($agentCmd) { $override.services["agent"] = [ordered]@{ command = $agentCmd; ports = @("127.0.0.1:${AgentPort}:${AgentPort}") } }
  if ($attestCmd) { $override.services["attest"] = [ordered]@{ command = $attestCmd; ports = @("127.0.0.1:${AttestPort}:${AttestPort}") } }
  $outDir = Join-Path $repo "runtime\compose"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $cmdFile = Join-Path $outDir "commands.yml"
  # JSON is YAML: compose reads this file as an override of docker-compose.yml.
  [IO.File]::WriteAllText($cmdFile, ($override | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  Say "OK" "wrote $cmdFile (commands only, no secrets)"
  $composeArgs = @("compose", "-f", "docker-compose.yml", "-f", $cmdFile) + $(if ($Test) { @("--profile", "test") } else { @() }) + $(if ($agentCmd) { @("--profile", "agent") } else { @() }) + $(if ($attestCmd) { @("--profile", "attest") } else { @() })
  $check = Invoke-Quiet ($composeArgs + @("config", "-q"))
  if ($check.Code -ne 0) { Stop-Here "docker compose rejected the configuration; run: docker compose -f docker-compose.yml -f runtime\compose\commands.yml config -q   (do NOT run it without -q: it prints the values)" }
  Say "OK" "compose configuration is valid"

  # 6. Ports this stack publishes must be free, or held by this stack's own containers
  foreach ($p in @(8740, 8750, $ApiPort) + $(if ($agentCmd) { @($AgentPort) } else { @() }) + $(if ($attestCmd) { @($AttestPort) } else { @() })) {
    $own = (Invoke-Quiet @("ps", "--filter", "label=com.docker.compose.project=chainaim-private-ai", "--filter", "publish=$p", "-q")).Out
    if ((Listening $p) -and -not $own) { Stop-Here "port $p is in use on this PC (the analyst / chain-query / console windows of start-ui.ps1?). Close that window, then run this again." }
  }
  if ($foreign.Count -and -not $ReplaceRunning -and -not $DryRun) { Stop-Here "these containers were started by stack.ps1 / switch-models.ps1: $($foreign -join ', '). Add -ReplaceRunning to stop them and start the compose stack in their place (rollback: DOCKERIZE-PLAN.md section 8)." }
  if ($DryRun) { Say "DRYRUN" "everything checked; nothing started.$(if ($foreign.Count) { " -ReplaceRunning would replace: $($foreign -join ', ')" })"; exit 0 }

  # 7. Start
  if ($foreign.Count) { foreach ($n in $foreign) { Say "REPLACE" "$n (docker rm -f; its volume and image are kept)"; & docker rm -f $n | Out-Null } }
  # Attestation off this time: a ca-attest left from an earlier start would keep running with the NEAR AI key; remove it.
  if (-not $attestCmd -and (Invoke-Quiet @("inspect", "--format", "{{.Name}}", "ca-attest")).Code -eq 0) { Say "INFO" "model attestation off: removing the ca-attest left from an earlier start"; & docker rm -f ca-attest | Out-Null }
  # Always --build (Docker's cache makes it quick) unless -NoBuild: the images then match this checkout's code.
  if ($Build -and $NoBuild) { Stop-Here "-Build and -NoBuild together: pick one" }
  if ($NoBuild) { Say "INFO" "-NoBuild: starting the images already built; they may hold older code than this checkout" }
  $upArgs = $composeArgs + @("up", "-d") + $(if (-not $NoBuild) { @("--build") } else { @() })
  & docker @upArgs
  if ($LASTEXITCODE -ne 0) { Stop-Here "docker compose up failed; see the message above. Rollback: DOCKERIZE-PLAN.md section 8." }
  # The console API reads the price catalog once, at start: restart it when switch-models.ps1 rewrote the catalog since
  # (otherwise a newly added model is quoted as "no price in the pricing catalog", seen 2026-11-06).
  if ($PaidJobs -eq "on") {
    $catPath = Join-Path $repo $cat
    $started = (Invoke-Quiet @("inspect", "--format", "{{.State.StartedAt}}", "ca-console-api")).Out
    if ($started -and (Test-Path $catPath)) {
      try {
        $startedAt = [DateTimeOffset]::Parse(($started -replace '(\.\d{7})\d+', '$1')).UtcDateTime
        if ((Get-Item $catPath).LastWriteTimeUtc -gt $startedAt) { Say "INFO" "the price catalog changed after ca-console-api started: restarting it"; & docker restart ca-console-api | Out-Null }
      } catch { Say "INFO" "could not compare the catalog time with ca-console-api's start time; restart it by hand after a model switch: docker restart ca-console-api" }
    }
  }
  # ca-attest reads the attested models from the catalog once, at start: the same restart after a model switch.
  if ($attestCmd) {
    $started = (Invoke-Quiet @("inspect", "--format", "{{.State.StartedAt}}", "ca-attest")).Out
    if ($started) {
      try {
        $startedAt = [DateTimeOffset]::Parse(($started -replace '(\.\d{7})\d+', '$1')).UtcDateTime
        if ((Get-Item $attCatPath).LastWriteTimeUtc -gt $startedAt) { Say "INFO" "the model catalog changed after ca-attest started: restarting it"; & docker restart ca-attest | Out-Null }
      } catch { Say "INFO" "could not compare the catalog time with ca-attest's start time; restart it by hand after a model switch: docker restart ca-attest" }
    }
  }
  $ok = (Wait-Http "http://127.0.0.1:8720/healthz" @{} "gateway") -and
        (Wait-Http "http://127.0.0.1:8740/healthz" @{} "analyst") -and
        (Wait-Http "http://127.0.0.1:8750/healthz" @{} "chain-query") -and
        (Wait-Http "http://127.0.0.1:$ApiPort/data/config" @{} "console-api")
  if ($ok -and $agentCmd) { $ok = Wait-Http "http://127.0.0.1:$AgentPort/healthz" @{} "agent" }
  if ($ok -and $attestCmd) { $ok = Wait-Http "http://127.0.0.1:$AttestPort/healthz" @{} "ca-attest" }
  if (-not $ok) { Stop-Here "a service did not come up: docker compose logs --tail 40 <service>" }
  # Saved for the next start (public values only, no keys): read only when no ca-gateway / ca-paywall is left.
  $newState = [ordered]@{ note = "Written by test-console\up.ps1 after a successful start. Public values only: the gateway command and the XRPL pay-to. No keys."; gatewayCmd = @($gwCmd); xrplPayTo = [ordered]@{} }
  if ($saved -and $saved.xrplPayTo) { foreach ($kv in $saved.xrplPayTo.PSObject.Properties) { $newState.xrplPayTo[$kv.Name] = [string]$kv.Value } }
  $newState.xrplPayTo[$XrplNetwork] = $pay
  New-Item -ItemType Directory -Force -Path (Split-Path $statePath -Parent) | Out-Null
  [IO.File]::WriteAllText($statePath, ($newState | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
  Say "OK" "saved the gateway mode and XRPL pay-to for the next start: $statePath (no secrets)"
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
