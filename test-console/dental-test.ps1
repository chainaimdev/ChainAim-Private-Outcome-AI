<#
One command for the dental reconciliation tests (Phase 4c data): generate the sets, check one scenario,
run the SQL query bank, then the model reasoning questions for one or more models, with a log and a summary.
It only calls the existing entry point (npm run dental -- ..., services/analyst/scripts/dental.ts); no logic of its own.

  .\test-console\dental-test.ps1                                   all steps, SET-2/NEG-ALL, model from the profile (see -Model)
  .\test-console\dental-test.ps1 -Kind sql                         no model: sets, check, SQL bank only
  .\test-console\dental-test.ps1 -Model local/deepseek-r1-8b,bedrock/nemotron-nano-3-30b
  .\test-console\dental-test.ps1 -Ids ask-priorities,top-leaks     only these entries (SQL ids go to the SQL step, ask-* to the model step)
  .\test-console\dental-test.ps1 -Scenario POS -SkipSets           another scenario, no regeneration
  .\test-console\dental-test.ps1 -Regenerate                       rebuild the set even if it exists

  -Set              set folder under the data root (default SET-2)
  -Scenario         scenario folder inside the set (default NEG-ALL; POS, NEG-EFT-MISSING, ...)
  -Model            model id(s) for the reasoning questions; must be served by the running gateway (dental.ts refuses a
                    substituted model). Resolved in this order: -Model, env CHAINAIM_DENTAL_MODEL (comma-separated),
                    defaults.dental in -ProfileFile, else local/deepseek-r1-8b.
  -ProfileFile      per-PC settings, git-ignored (default config\local\ai-profile.json; example: config\local\ai-profile.example.json)
  -Kind             sql | model | all (default all)
  -Ids              comma-separated ids from -Bank (default: every entry of the chosen kind)
  -Bank             query bank (default config\domain-packs\finance\rcm\dental\queries.json)
  -DataRoot         data root; default env DENTAL_DATA_ROOT, else <repo>\data\pms\dent-pms-c-sample (git-ignored)
  -Regenerate       run "sets" even when the scenario folder exists
  -SkipSets         never run "sets" (fails if the scenario folder is missing)
  -TimeoutSec       per model question (default 600)
  -CooldownWaitSec  wait once when the gateway benches a model (default 35; 0 = do not wait)
  -NoDocker         never start containers (model questions fail if the gateway is down)
  -LogDir           where the run log goes (default data\pms\_runs, git-ignored with data/)
  -GatewayMode      switch-models.ps1 mode that serves -Model (default: gatewayMode in -ProfileFile, else ollama). Before the
                    model step the script asks the running gateway for its models; only when one of -Model is missing
                    does it run switch-models.ps1 -To <mode> -SkipTest (recreates ca-gateway).
  -ForceSwitch      always run switch-models.ps1 first;  -NoSwitch  never (fail if the gateway lacks a model)
  -GatewayUrl       default http://127.0.0.1:8720
  -Progress         while a model works: spinner (default: animated line with seconds waited; the model steps then write
                    to this window directly, so their output is on screen but not in the log) | lines (a line every 15 s;
                    everything also goes to the log)

Exit code 0 only when every step exits 0. ASCII only (Windows PowerShell 5.1).
#>
param(
  [string]$Set = "SET-2",
  [string]$Scenario = "NEG-ALL",
  [string[]]$Model = @(),
  [string]$ProfileFile = "config\local\ai-profile.json",
  [ValidateSet("sql", "model", "all")][string]$Kind = "all",
  [string]$Ids = "",
  [string]$Bank = "config\domain-packs\finance\rcm\dental\queries.json",
  [string]$DataRoot = "",
  [switch]$Regenerate,
  [switch]$SkipSets,
  [int]$TimeoutSec = 600,
  [int]$CooldownWaitSec = 35,
  [switch]$NoDocker,
  [string]$LogDir = "data\pms\_runs",
  [ValidateSet("spinner", "lines")][string]$Progress = "spinner",
  [string]$GatewayMode = "",
  [switch]$ForceSwitch,
  [switch]$NoSwitch,
  [string]$GatewayUrl = "http://127.0.0.1:8720"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$builtInModel = "local/deepseek-r1-8b"

if ($Regenerate -and $SkipSets) { throw "-Regenerate and -SkipSets contradict each other; pass one." }
if ($ForceSwitch -and $NoSwitch) { throw "-ForceSwitch and -NoSwitch contradict each other; pass one." }
function Split-List($v) { @($v | ForEach-Object { "$_" -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

# Model: flag, then environment, then the per-PC profile, then the built-in default.
$Model = Split-List $Model
$modelFrom = "-Model"
if ($Model.Count -eq 0 -and $env:CHAINAIM_DENTAL_MODEL) { $Model = Split-List $env:CHAINAIM_DENTAL_MODEL; $modelFrom = "env CHAINAIM_DENTAL_MODEL" }
if ($Model.Count -eq 0) {
  $pf = Join-Path $repo $ProfileFile
  if (Test-Path $pf) {
    try { $prof = Get-Content -Raw $pf | ConvertFrom-Json } catch { throw "$pf is not valid JSON: $($_.Exception.Message)" }
    if ($prof.defaults -and $prof.defaults.dental) { $Model = Split-List $prof.defaults.dental; $modelFrom = $ProfileFile }
  }
}
# Gateway mode: flag, then the profile, then ollama (the GPU registry config\local-models.json, default local/deepseek-r1-8b).
$modeFrom = "-GatewayMode"
if (-not $GatewayMode) {
  $pf = Join-Path $repo $ProfileFile
  if (Test-Path $pf) { $p2 = Get-Content -Raw $pf | ConvertFrom-Json; if ($p2.gatewayMode) { $GatewayMode = [string]$p2.gatewayMode; $modeFrom = $ProfileFile } }
}
if (-not $GatewayMode) { $GatewayMode = "ollama"; $modeFrom = "built-in default" }

# The models the running gateway serves (empty when it is down or the key is missing). Never prints the key.
function Get-GatewayModels {
  $keyFile = Join-Path $PSScriptRoot "local-gateway-key.txt"
  if (-not (Test-Path $keyFile)) { return @() }
  try {
    $r = Invoke-RestMethod -Uri "$($GatewayUrl.TrimEnd('/'))/v1/models" -Headers @{ authorization = "Bearer $((Get-Content -Raw $keyFile).Trim())" } -TimeoutSec 5
    return @($r.data | ForEach-Object { $_.id })
  } catch { return @() }
}
if ($Model.Count -eq 0) { $Model = @($builtInModel); $modelFrom = "built-in default" }

# Ids: split into the SQL step and the model step by what the bank says each entry is.
$bankPath = Join-Path $repo $Bank
if (-not (Test-Path $bankPath)) { throw "Query bank not found: $bankPath" }
$entries = @((Get-Content -Raw $bankPath | ConvertFrom-Json).queries)
$sqlAll = @($entries | Where-Object { $_.sql } | ForEach-Object { $_.id })
$askAll = @($entries | Where-Object { $_.question } | ForEach-Object { $_.id })
$want = Split-List $Ids
$unknown = @($want | Where-Object { $_ -notin $sqlAll -and $_ -notin $askAll })
if ($unknown.Count -gt 0) { throw "Not in the query bank: $($unknown -join ', '). List them with: npm run dental -- query --set $Set/$Scenario --list" }
$sqlIds = @($want | Where-Object { $_ -in $sqlAll })
$askIds = @($want | Where-Object { $_ -in $askAll })
$runSql = ($Kind -in @("sql", "all")) -and ($want.Count -eq 0 -or $sqlIds.Count -gt 0)
$runAsk = ($Kind -in @("model", "all")) -and ($want.Count -eq 0 -or $askIds.Count -gt 0)

# Data root: flag, else environment, else the repository default. The flag is set for this process only.
if ($DataRoot) { $env:DENTAL_DATA_ROOT = [IO.Path]::GetFullPath((Join-Path $repo $DataRoot)) }
$root = if ($env:DENTAL_DATA_ROOT) { $env:DENTAL_DATA_ROOT } else { Join-Path $repo "data\pms\dent-pms-c-sample" }
$scenarioDir = Join-Path $root (Join-Path $Set $Scenario)
$target = "$Set/$Scenario"

$logPath = Join-Path $repo $LogDir
New-Item -ItemType Directory -Force -Path $logPath | Out-Null
$logFile = Join-Path $logPath ("dental-{0}-{1}-{2}.log" -f $Set, $Scenario, (Get-Date -Format "yyyy-MM-ddTHHmmss"))
Start-Transcript -Path $logFile | Out-Null

$results = New-Object System.Collections.Generic.List[object]
function Run-Step([string]$name, [string[]]$dentalArgs, [switch]$Live) {
  Write-Host ""
  Write-Host ("==== {0}: npm run dental -- {1}" -f $name, ($dentalArgs -join " "))
  $t = [Diagnostics.Stopwatch]::StartNew()
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    if ($Live) {
      # Writes straight to this window (a real terminal), so the spinner can animate; not captured by the transcript.
      $quoted = @("run", "dental", "--") + @($dentalArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
      # Read .Handle before waiting: Windows PowerShell otherwise can report an empty ExitCode for a -NoNewWindow process.
      $p = Start-Process -FilePath "npm.cmd" -ArgumentList $quoted -NoNewWindow -PassThru
      $null = $p.Handle; $p.WaitForExit(); $code = $p.ExitCode
    } else {
      # Out-Host: show npm's output now (and in the transcript) instead of returning it as this function's value.
      & npm run dental -- @dentalArgs 2>&1 | Out-Host; $code = $LASTEXITCODE
    }
  } finally { $ErrorActionPreference = $prev }
  $t.Stop()
  $results.Add([pscustomobject]@{ Step = $name; Exit = $code; Seconds = [math]::Round($t.Elapsed.TotalSeconds, 1) })
  return [int]$code
}

try {
  Write-Host "Data root: $root"
  Write-Host "Target:    $target    Kind: $Kind"
  Write-Host "Models:    $($Model -join ', ')   (from $modelFrom)"
  Write-Host "Ids:       $(if ($want.Count) { "sql: $(if ($sqlIds.Count) { $sqlIds -join ',' } else { '-' })  model: $(if ($askIds.Count) { $askIds -join ',' } else { '-' })" } else { 'all' })"

  # 0. Gateway: make sure it serves every model asked for; switch modes only when it does not (or -ForceSwitch).
  if ($runAsk) {
    $served = Get-GatewayModels
    $missing = @($Model | Where-Object { $_ -notin $served })
    Write-Host "Gateway:   mode $GatewayMode (from $modeFrom); serves $(if ($served.Count) { $served -join ', ' } else { 'nothing (down or no key)' })"
    if ($ForceSwitch -or ($missing.Count -gt 0 -and -not $NoSwitch)) {
      Write-Host ""
      Write-Host "==== gateway: switch-models.ps1 -To $GatewayMode -SkipTest$(if ($missing.Count) { "  (missing: $($missing -join ', '))" })"
      $t = [Diagnostics.Stopwatch]::StartNew()
      $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
      try { & (Join-Path $PSScriptRoot "switch-models.ps1") -To $GatewayMode -SkipTest 2>&1 | Out-Host; $sw = if ($?) { 0 } else { 1 } } finally { $ErrorActionPreference = $prev }
      $t.Stop(); $results.Add([pscustomobject]@{ Step = "gateway $GatewayMode"; Exit = $sw; Seconds = [math]::Round($t.Elapsed.TotalSeconds, 1) })
      $missing = @($Model | Where-Object { $_ -notin (Get-GatewayModels) })
    }
    if ($missing.Count -gt 0) { throw "The gateway does not serve $($missing -join ', ') (mode $GatewayMode). Pick a mode that has it (-GatewayMode) or another -Model." }
  }

  # 1. Sets: generate and check every scenario against its answer key.
  $haveScenario = Test-Path $scenarioDir
  if ($SkipSets) {
    if (-not $haveScenario) { throw "$scenarioDir does not exist and -SkipSets was given. Run without -SkipSets once." }
    Write-Host "Sets: skipped (-SkipSets)."
  } elseif ($Regenerate -or -not $haveScenario) {
    if ((Run-Step "sets" @("sets", "--set", $Set)) -ne 0) { throw "sets failed; see above." }
  } else { Write-Host "Sets: $scenarioDir exists, not regenerated (-Regenerate to rebuild)." }

  # 2. Reconcile the chosen scenario against its answer key.
  [void](Run-Step "check" @("check", "--set", $target))

  # 3. SQL query bank: exact answers, no model.
  if ($runSql) {
    $a = @("query", "--set", $target, "--kind", "sql")
    if ($sqlIds.Count) { $a += @("--id", ($sqlIds -join ",")) }
    [void](Run-Step "sql" $a)
  } elseif ($Kind -in @("sql", "all")) { Write-Host "SQL: none of -Ids is a SQL entry; skipped." }

  # 4. Model reasoning questions, once per model; every figure is checked against the DuckDB facts.
  if ($runAsk) {
    $s = @("status"); if ($NoDocker) { $s += "--no-docker" }
    [void](Run-Step "status" $s)
    foreach ($m in $Model) {
      $a = @("query", "--set", $target, "--kind", "model", "--model", $m, "--timeout-sec", "$TimeoutSec", "--cooldown-wait-sec", "$CooldownWaitSec")
      if ($askIds.Count) { $a += @("--id", ($askIds -join ",")) }
      if ($NoDocker) { $a += "--no-docker" }
      $a += @("--progress", $Progress)
      [void](Run-Step "model $m" $a -Live:($Progress -eq "spinner"))
    }
  } elseif ($Kind -in @("model", "all")) { Write-Host "Model: none of -Ids is a model question; skipped." }
} finally {
  Write-Host ""
  Write-Host "==== Summary ($target)"
  $results | Format-Table -AutoSize | Out-String | Write-Host
  Stop-Transcript | Out-Null
  Write-Host "Log: $logFile"
}
$failed = @($results | Where-Object { $_.Exit -ne 0 })
if ($failed.Count -gt 0) { Write-Host "$($failed.Count) step(s) failed."; exit 1 }
Write-Host "All steps passed."
exit 0
