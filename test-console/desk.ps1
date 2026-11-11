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
  -Build        kept for old habits: up.ps1 now rebuilds the private images on every start (Docker's cache, seconds when
                nothing changed), so they always match this checkout's code
  -WithStub     also the OpenRouter stand-in (up.ps1 -Test)
  -Agent        require tab 03 agent mode (up.ps1 -Agent on). Without it, agent.enabled decides: "auto" (default) lets
                up.ps1 switch it on when <secretsDir>\agent-tenants.env and a Bedrock key exist, "on" requires it, "off" skips it
  -Attest       require NEAR AI model attestation (up.ps1 -Attest on, container ca-attest). Without it, attest.enabled decides:
                "auto" (default) lets up.ps1 switch it on when NEARAI_API_KEY is in chainaim.env (or the running ca-gateway)
                and the current model mode has a model marked "attest": "nearai"; "on" requires it, "off" skips it.
                attest.gpuCheck "on" (default) / "off" goes to up.ps1 -AttestGpuCheck.
  -Receipts     require signed Job Evidence Receipts (privateAI-design-32 ARCH-614/615; up.ps1 -Receipts on). Without it,
                receipts.enabled decides: "auto" (default) lets up.ps1 switch them on when <secretsDir>\chainaim.env holds
                the signing key (-ReceiptKeyName, default RECEIPT_SIGNING_KEY), "on" requires it, "off" skips it.
  -ReceiptKey [-ReceiptKeyRotate] [-ReceiptKeyName RECEIPT_SIGNING_KEY]
                create the console's Ed25519 receipt signing key in <secretsDir>\chainaim.env (scripts\receipt-key.ts) and
                stop. Prints the key id and the PUBLIC key only. A valid key already there is kept (safe to run twice);
                -ReceiptKeyRotate replaces it (receipts signed before verify only with the old public key). This script
                still never reads a secret: the Node script does the file work. Runs on its own. Also writes the PUBLIC
                key to config\receipt-public-key.pem (committed; the agent and -VerifyReceipt pin it).
  -Ap2Key [-Ap2KeyRotate] [-Ap2KeyName AP2_SIGNING_KEY]
                create the console's ES256 (EC P-256) AP2 signing key in <secretsDir>\chainaim.env (scripts\receipt-key.ts
                --alg ES256; privateAI-design-33 ARCH-627) and stop. The console signs each paid job's quote with it as a
                UCP AP2 merchant_authorization. Prints the key id and the PUBLIC key only; a valid key already there is
                kept; -Ap2KeyRotate replaces it. Writes the PUBLIC key as a JWK Set to config\ap2-public-key.jwk.json
                (committed; the agent pins it). Runs on its own.
  -RejudgeReceiver ACCOUNT  -RejudgeReason "TEXT"
                after the start, clear FALSE reconcile mismatches in the NEAR admin UI (near-watch src/rejudge.ts
                --all-mismatches; chainaim-adminUI-NEAR src/reconcile.ts rejudge). ACCOUNT is the pay-to you checked the
                transfers went to (on the explorer). Each mismatch row is checked on its own and turns matched only when
                its stored transfer went to exactly ACCOUNT, ACCOUNT is near-watch's pay-to now, and amount, payer and
                token agree with the paywall's claim; any other row stays a mismatch and is listed. TEXT (1-200
                characters, no double quotes) is kept in each re-judged row's detail. The admin key stays inside ca-near-watch.
  -Logs NAME[,NAME]  [-LogLines 40]
                print the last lines of these services' logs and stop (changes nothing). NAME is one of: gateway, paywall,
                presidio, analyst, chain-query, console-api, agent, attest, near-watch. Logs carry ids, model names, error
                kinds and counts, not keys; still look before pasting them anywhere.
  -Memory  [-MemoryModel deepseek-r1:8b] [-MemoryNeedGb 7]
                print this PC's memory and stop (changes nothing): total and free RAM, Docker's VM limit and each
                container's use, the models Ollama has loaded (ollama ps: size and CPU/GPU split), whether MemoryModel is
                pulled, and whether free RAM covers MemoryNeedGb. 7 GB: deepseek-r1:8b at numCtx 12288 loaded at 6.0 GB
                (q8_0 K/V) and 7.2 GB (f16) in DESIGN/2026-10-17T1948-0500_local-gpu-models-session.md D14.
  -AgentAsk -Tenant t01 [-Dataset smb-fin-1] [-Template 1|LABEL] [-AgentQuestion "TEXT"] [-AgentSet NAME]
           [-AgentAnswerModel default|none|ID]
                one tab 03 "AI agent" run from the terminal, no browser (privateAI-design-32 step C; scripts\agent-ask.ts):
                the same console relay, agent, spending policy, NEAR payment and receipt check as the page. Prints each
                step with who did it and the result; saves the receipt and the result in runtime\agent-ask\ for
                -VerifyReceipt. Needs the desk running with the agent (desk.ps1 -All). Runs on its own.
                Exit 0 = paid and receipt verified; 1 = refused, error or receipt check failed; 2 = not reachable / usage.
  -VerifyReceipt FILE [-VerifyResult auto|none|FILE]
                check a receipt offline with the pinned key config\receipt-public-key.pem (privateAI-design-32 step D;
                scripts\verify-receipt.ts): tab 03's downloaded chainaim-receipt-<jobId>.json or -AgentAsk's. Signature,
                settlement signature and, when the released result is at hand (-VerifyResult; auto = the
                chainaim-result-<jobId>.json beside it), the result's hash. No service needed. Runs on its own.
                Exit 0 = valid; 1 = not valid (reason printed); 2 = usage or unreadable file.
  -Smoke  [-SmokeModel bedrock/nemotron-nano-3-30b] [-SmokeSets default|all] [-SmokeDatasets all|ID,ID]
         [-SmokeAnswerModel none|ID] [-SmokeCheckAnswers on|off] [-SmokeDryRun]
         -SmokeCheckAnswers on (default): results with a rule in config\answer-checks.json are compared with the
         set's _answer-key, so PASS means correct; a different figure is FAIL
                UI template smoke check (scripts\ui-smoke.ts): every tab-03 template of config\datasets.json, run against its
                sample-data folder through the running console API with the page's own requests; one line per template,
                PASS/WARN/SKIP/FAIL, a report in test-console\runs (no rows or answers), exit 1 on any FAIL. Needs the desk
                started; changes nothing. Sample root only. A local/ model must be pulled first (-Memory shows it).
  -SmbSample  [-SmbSeed 1]
  -ChiroSample [-ChiroSeed 1] [-ChiroLeakSeed 1]
         regenerate every chiro sample set (sample-data\prms\chiro-1-chirotouch and chiro-2-jane, SET-1\<scenario>) with
         tools\chiro-synth and verify each one (cross-checked with the other PRMS); the answer keys then carry query_answers
                write the synthetic open receivables and payables of smb-fin-1 (tools\smb-synth\gen_ar_ap.py --force, tied
                to the sample bank statement's deposits) into sample-data\smb-fin\statements, then check them
                (verify_ar_ap.py). Same seed, same files. Changes only those two files and their _answer-key.
  Stray words are refused (no positional parameters), so a typo such as "-Check memor" stops instead of running -Logs.
  -All  [-AllSkipTests] [-AllSkipSmoke] [-AllSmbSample [-SmbSeed 1]] [-Windows analyst,console-api] [the -Smoke... options]
        [-Agent] [-Attest] [-Build]
                everything in one command (owner, 2026-11-07), in this order, stopping at the first failure:
                1. terminal suites: scripts\check-deps.ts and the -Test suites (no containers needed);
                   with -AllSmbSample, then this script's own -SmbSample (smb-fin-1 receivables, payables and answer key
                   regenerated and verified, so the smoke check compares with a current key; owner 2026-11-07);
                2. the normal start: both repositories' Docker launchers (images rebuilt only when the code changed,
                   Docker's cache), the READY table;
                3. log windows: one PowerShell window per -Windows service following its container log (docker logs -f;
                   default analyst); close a window to stop watching, the service keeps running;
                4. the browser pages, console 8730 and NEAR admin UI 8800 (unless -NoBrowser), as soon as READY;
                5. the UI template smoke check (-Smoke, same options) against the running console API. A smoke FAIL is
                   a result check: the stack keeps running and both UIs stay open. Exit 0 only when every step passed.
  -Windows NAME[,NAME]  also usable with a plain start: open these log windows after READY (names as for -Logs).
  -Ship -ShipMessage "TEXT"  [-ShipFiles a,b] [-ShipBranch NAME] [-ShipRemote origin] [-ShipTrailer "TEXT"]
         [-ShipTag vX.Y.Z [-ShipTagMessage "TEXT"]] [-ShipSkipTests] [-ShipNoPush] [-ShipDryRun]
                -ShipTag (owner 2026-11-07): an annotated tag on the new commit (message -ShipTagMessage, else -ShipMessage),
                pushed after the branch and checked on the remote. Refused before any test when the tag already exists
                here or on the remote; never moves or deletes a tag. With -ShipNoPush the tag is made here only.
                test, commit and push this checkout's changes in one command (owner, 2026-11-07). Refuses a detached HEAD,
                a branch behind its remote (git fetch first; pull yourself, never done here) and a clean tree. Commits
                every changed or new file git status shows, or only -ShipFiles (each must have a change; the rest is
                listed as left out). Runs the -Test suites plus scripts\check-deps.ts first: any failure commits nothing.
                Stages and commits only those paths (git commit -- paths, so nothing staged earlier rides along), then
                git push REMOTE BRANCH and checks nothing is left unpushed. Never force-pushes, pulls, resets or checks out.
                -ShipTrailer: an extra message paragraph (e.g. Co-Authored-By lines). -ShipDryRun: tests and the file
                list only. -ShipNoPush: commit, no push. Runs on its own: no other mode switches with it.
  -RequireModels local,bedrock,nearai   model families that must be in the tab 02 / tab 03 pick lists (the gateway's
                /v1/models via the console API); one missing is a READY-table problem naming the switch-models.ps1 fix.
  -NoBrowser    do not open the pages
  -Settings     settings file (default config\local\desk.json; copy config\local\desk.example.json)

Settings (config\local\desk.json, git-ignored): secretsDir, paidJobs.enabled, agent.enabled / tenants, attest.enabled / gpuCheck,
adminUi.enabled / watch / gasPerPaymentNear.
Prices are NOT here: up.ps1 reads its own price files (config\paid-jobs-prices.conf, or <secretsDir>\paid-jobs-settings.env).
The adminUI checkout is found like the near-watch tests do: env NEAR_WATCH_DIR, config\local\repos.json nearWatchDir, sibling.
Secrets are only checked to exist (by name); this script never reads or prints a value.
NEAR RPC: the paywall and near-watch take theirs from near-testnet.env (NEAR_RPC_URL_TESTNET) and near-watch.env
(NEAR_RPC_FALLBACK_URL_TESTNET). FastNEAR's free tier rate-limits when both use it (seen 2026-11-05); this script checks
from inside the paywall that its RPC answers and says which line to set if not. It never edits a secrets file.
ASCII only (Windows PowerShell 5.1).
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Check,
  [switch]$Stop,
  [switch]$Test,
  [switch]$Build,
  [switch]$WithStub,
  [switch]$Agent,
  [switch]$Attest,
  [switch]$Receipts,
  [switch]$ReceiptKey,
  [switch]$ReceiptKeyRotate,
  [string]$ReceiptKeyName = "RECEIPT_SIGNING_KEY",
  [switch]$Ap2Key,
  [switch]$Ap2KeyRotate,
  [string]$Ap2KeyName = "AP2_SIGNING_KEY",
  [switch]$NoBrowser,
  [string[]]$Logs = @(),
  [int]$LogLines = 40,
  [switch]$Memory,
  [string]$MemoryModel = "deepseek-r1:8b",
  [double]$MemoryNeedGb = 7,
  [switch]$Smoke,
  [string]$SmokeModel = "bedrock/nemotron-nano-3-30b",
  [string]$SmokeSets = "default",
  [string[]]$SmokeDatasets = @("all"),
  [string]$SmokeAnswerModel = "none",
  [string]$SmokeCheckAnswers = "on",
  [switch]$SmokeDryRun,
  [switch]$SmbSample,
  [int]$SmbSeed = 1,
  [switch]$ChiroSample,
  [int]$ChiroSeed = 1,
  [int]$ChiroLeakSeed = 1,
  [string]$RejudgeReceiver = "",
  [string]$RejudgeReason = "",
  [switch]$All,
  [switch]$AllSkipTests,
  [switch]$AllSkipSmoke,
  [switch]$AllSmbSample,
  [string[]]$Windows = @(),
  [switch]$Ship,
  [string]$ShipMessage = "",
  [string[]]$ShipFiles = @(),
  [string]$ShipBranch = "",
  [string]$ShipRemote = "origin",
  [string]$ShipTrailer = "",
  [string]$ShipTag = "",
  [string]$ShipTagMessage = "",
  [switch]$ShipSkipTests,
  [switch]$ShipNoPush,
  [switch]$ShipDryRun,
  [switch]$AgentAsk,
  [string]$Tenant = "t01",
  [string]$Dataset = "smb-fin-1",
  [string]$Template = "1",
  [string]$AgentQuestion = "",
  [string]$AgentSet = "",
  [string]$AgentAnswerModel = "default",
  [string]$VerifyReceipt = "",
  [string]$VerifyResult = "auto",
  [string[]]$RequireModels = @("local", "bedrock", "nearai"),
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
# Service name -> container, shared by -Logs and -Windows.
$LogContainers = [ordered]@{ "gateway" = "ca-gateway"; "paywall" = "ca-paywall"; "presidio" = "ca-presidio"; "analyst" = "ca-analyst"; "chain-query" = "ca-chain-query"; "console-api" = "ca-console-api"; "agent" = "ca-agent"; "attest" = "ca-attest"; "near-watch" = "ca-near-watch" }

# Re-judge options are checked before anything starts.
if ($RejudgeReceiver -or $RejudgeReason) {
  if (-not ($RejudgeReceiver -and $RejudgeReason)) { Stop-Here "-RejudgeReceiver and -RejudgeReason go together" }
  if ($RejudgeReceiver -notmatch '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$') { Stop-Here "-RejudgeReceiver must be a NEAR account id, e.g. chainaim-payto-seller.testnet" }
  if ($RejudgeReason.Length -gt 200 -or $RejudgeReason -match '["\x00-\x1f]') { Stop-Here "-RejudgeReason must be 1-200 characters on one line, without double quotes" }
  if ($Check -or $Stop -or $Test) { Stop-Here "-RejudgeReceiver runs after a start; leave out -Check, -Stop and -Test" }
}

# Node, npm and docker print UTF-8 (test marks, middle dots, ellipses). Windows PowerShell 5.1's console decodes them with
# the old OEM code page and shows junk (owner run 2026-11-10: three odd characters for each test tick); UTF-8 output here
# shows them as written.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# -ReceiptKey options are checked before anything else runs.
if ($ReceiptKeyName -notmatch '^[A-Z_][A-Z0-9_]*$') { Stop-Here "-ReceiptKeyName must be an environment variable name such as RECEIPT_SIGNING_KEY" }
if ($ReceiptKeyRotate -and -not $ReceiptKey) { Stop-Here "-ReceiptKeyRotate needs -ReceiptKey" }
if ($ReceiptKey -and ($Check -or $Stop -or $Test -or $Build -or $WithStub -or $Agent -or $Attest -or $Receipts -or $Ap2Key -or $All -or $Ship -or $Logs.Count -or $Memory -or $Smoke -or $SmbSample -or $ChiroSample -or $RejudgeReceiver)) { Stop-Here "-ReceiptKey runs on its own: leave out the other mode switches" }
# -Ap2Key options (privateAI-design-33 ARCH-627) are checked before anything else runs.
if ($Ap2KeyName -notmatch '^[A-Z_][A-Z0-9_]*$') { Stop-Here "-Ap2KeyName must be an environment variable name such as AP2_SIGNING_KEY" }
if ($Ap2KeyName -eq $ReceiptKeyName) { Stop-Here "-Ap2KeyName and -ReceiptKeyName must differ: the AP2 key (ES256) and the receipt key (Ed25519) are two keys" }
if ($Ap2KeyRotate -and -not $Ap2Key) { Stop-Here "-Ap2KeyRotate needs -Ap2Key" }
if ($Ap2Key -and ($Check -or $Stop -or $Test -or $Build -or $WithStub -or $Agent -or $Attest -or $Receipts -or $ReceiptKey -or $All -or $Ship -or $Logs.Count -or $Memory -or $Smoke -or $SmbSample -or $ChiroSample -or $RejudgeReceiver)) { Stop-Here "-Ap2Key runs on its own: leave out the other mode switches" }

# -Ship options are checked before anything else runs.
if ($Ship -and ($Check -or $Stop -or $Test -or $Build -or $WithStub -or $Agent -or $Attest -or $Receipts -or $Logs.Count -or $Memory -or $Smoke -or $SmbSample -or $ChiroSample -or $RejudgeReceiver)) { Stop-Here "-Ship runs on its own: leave out the other mode switches" }
# -All and -Windows options are checked before anything else runs.
if ($All -and ($Check -or $Stop -or $Test -or $Ship -or $Logs.Count -or $Memory -or $Smoke -or $SmbSample -or $ChiroSample)) { Stop-Here "-All runs the tests, the start and the smoke check itself: leave out -Check, -Stop, -Test, -Ship, -Logs, -Memory, -Smoke, -SmbSample and -ChiroSample" }
if (-not $All -and ($AllSkipTests -or $AllSkipSmoke -or $AllSmbSample)) { Stop-Here "-AllSkipTests, -AllSkipSmoke and -AllSmbSample need -All" }
# -AgentAsk / -VerifyReceipt (privateAI-design-32 steps C and D) each run on their own; checked before anything runs.
$otherModes = $Check -or $Stop -or $Test -or $Build -or $WithStub -or $Agent -or $Attest -or $Receipts -or $ReceiptKey -or $Ap2Key -or $All -or $Ship -or $Logs.Count -or $Memory -or $Smoke -or $SmbSample -or $ChiroSample -or $RejudgeReceiver
if ($AgentAsk -and ($otherModes -or $VerifyReceipt)) { Stop-Here "-AgentAsk runs on its own: leave out the other mode switches" }
if ($VerifyReceipt -and $otherModes) { Stop-Here "-VerifyReceipt runs on its own: leave out the other mode switches" }
$WindowNames = @($Windows | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($All -and -not $WindowNames.Count) { $WindowNames = @("analyst") }
foreach ($n in $WindowNames) { if (-not $LogContainers.Contains($n)) { Stop-Here "-Windows $n is not a service here; use one of: $($LogContainers.Keys -join ', ')" } }
if ($WindowNames.Count -and ($Check -or $Stop -or $Test -or $Ship -or $Logs.Count -or $Memory -or $Smoke -or $SmbSample -or $ChiroSample)) { Stop-Here "-Windows opens log windows after a start: use it with a plain start or -All" }
if ($All -and -not $AllSkipSmoke) {
  if (@("default", "all") -notcontains $SmokeSets) { Stop-Here "-SmokeSets must be default or all" }
  if (@("on", "off") -notcontains $SmokeCheckAnswers) { Stop-Here "-SmokeCheckAnswers must be on or off" }
  if ($SmokeModel -notmatch '^[\w.-]+/[\w.:-]+$') { Stop-Here "-SmokeModel must look like provider/name, e.g. bedrock/nemotron-nano-3-30b" }
}
if (-not $Ship -and ($ShipMessage -or $ShipFiles.Count -or $ShipBranch -or $ShipTrailer -or $ShipTag -or $ShipTagMessage -or $ShipSkipTests -or $ShipNoPush -or $ShipDryRun)) { Stop-Here "the -Ship... options need -Ship" }
if ($ShipTag -and $ShipTag -notmatch '^v\d+\.\d+\.\d+$') { Stop-Here "-ShipTag must look like v1.4.8" }
if ($ShipTagMessage -and -not $ShipTag) { Stop-Here "-ShipTagMessage needs -ShipTag" }

# ---------------------------------------------------------------- -Logs: read-only, needs nothing else
if ($Logs.Count) {
  $known = $LogContainers
  $names = @($Logs | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  foreach ($n in $names) { if (-not $known.Contains($n)) { Stop-Here "-Logs $n is not a service here; use one of: $($known.Keys -join ', ')" } }
  if ($LogLines -lt 1 -or $LogLines -gt 2000) { Stop-Here "-LogLines must be 1-2000" }
  foreach ($n in $names) {
    Write-Host ""
    Say "LOGS" "$n ($($known[$n]), last $LogLines lines)"
    $lines = @(Quiet { & docker logs --tail $LogLines $known[$n] 2>&1 })
    if ($LASTEXITCODE) { Say "FAIL" "no container $($known[$n]) (is the stack running? .\test-console\desk.ps1 -Check)"; continue }
    foreach ($l in $lines) { Write-Host "  $l" }
  }
  exit 0
}

# ---------------------------------------------------------------- -Memory: read-only, needs nothing else
if ($Memory) {
  if ($MemoryNeedGb -le 0 -or $MemoryNeedGb -gt 512) { Stop-Here "-MemoryNeedGb must be above 0 and at most 512" }
  if ($MemoryModel -notmatch '^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?$') { Stop-Here "-MemoryModel must be an Ollama model name, e.g. deepseek-r1:8b" }
  $cs = Get-CimInstance Win32_ComputerSystem
  $os = Get-CimInstance Win32_OperatingSystem
  $totalGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  $idleGb = [math]::Round(($os.FreePhysicalMemory * 1KB) / 1GB, 1)
  # Available = free + standby cache (what Task Manager calls Available): what a new model can actually get. The WMI
  # class name is the same on every Windows language, unlike Get-Counter's counter names.
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction SilentlyContinue
  $freeGb = if ($perf -and $perf.AvailableBytes) { [math]::Round([double]$perf.AvailableBytes / 1GB, 1) } else { $idleGb }
  Say "MEM" "this PC: $totalGb GB total, $freeGb GB available now ($idleGb GB completely unused; the rest of available is cache Windows gives back)"
  $vm = @(Get-Process -Name vmmem, vmmemWSL -ErrorAction SilentlyContinue)
  if ($vm.Count) { Say "MEM" ("Docker's VM process ({0}) holds {1} GB (containers below plus the VM's own cache)" -f (($vm | ForEach-Object { $_.ProcessName }) -join ", "), [math]::Round((($vm | Measure-Object WorkingSet64 -Sum).Sum) / 1GB, 1)) }
  Say "MEM" "largest users now (process name, GB, all its processes together):"
  $top = Get-Process -ErrorAction SilentlyContinue | Group-Object ProcessName | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Gb = [math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum) / 1GB, 2) } } | Sort-Object Gb -Descending | Select-Object -First 8
  foreach ($t in $top) { Write-Host ("  {0,-28} {1,6} GB" -f $t.Name, $t.Gb) }
  $dockerMem = "$(Quiet { & docker info --format '{{.MemTotal}}' 2>$null })".Trim()
  if ($dockerMem -match '^\d+$') {
    Say "MEM" ("Docker VM limit: {0} GB; containers now (docker stats):" -f [math]::Round([double]$dockerMem / 1GB, 1))
    foreach ($l in @(Quiet { & docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}' 2>$null })) { if ("$l".Trim()) { Write-Host "  $l" } }
  } else { Say "NOTE" "Docker is not answering: no container figures" }
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Say "NOTE" "ollama is not on PATH here: no loaded-model figures" }
  else {
    Say "MEM" "Ollama models loaded now (ollama ps: SIZE is memory in use, PROCESSOR the CPU/GPU split; a loaded model is already in use above)"
    foreach ($l in @(Quiet { & ollama ps 2>&1 })) { Write-Host "  $l" }
    $have = @(@(Quiet { & ollama list 2>$null }) | Where-Object { "$_" -match ('^' + [regex]::Escape($MemoryModel) + '\s') })
    if ($have.Count) { Say "OK" "$MemoryModel is pulled" } else { Say "NOTE" "$MemoryModel is not pulled yet" }
  }
  if ($freeGb -ge $MemoryNeedGb) { Say "OK" "$freeGb GB available covers the $MemoryNeedGb GB $MemoryModel needs next to what runs now" }
  else { Say "WARN" "$freeGb GB available is under the $MemoryNeedGb GB $MemoryModel needs: close some of the largest users above before loading it, or it will swap and time out" }
  exit 0
}

# ---------------------------------------------------------------- -SmbSample: synthetic receivables and payables for smb-fin-1
if ($SmbSample) {
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Stop-Here "python is not on PATH (tools\smb-synth needs Python 3)" }
  if ($SmbSeed -lt 0) { Stop-Here "-SmbSeed must be 0 or more" }
  $smbDir = Join-Path $repo "sample-data\smb-fin\statements"
  if (-not (Test-Path $smbDir)) { Stop-Here "no folder $smbDir (the smb-fin-1 sample bank statement goes there first)" }
  Say "RUN" "synthetic receivables and payables for smb-fin-1 (tools\smb-synth, seed $SmbSeed)"
  & python tools\smb-synth\gen_ar_ap.py --out-dir $smbDir --seed $SmbSeed --force
  if ($LASTEXITCODE) { Stop-Here "gen_ar_ap.py failed (exit $LASTEXITCODE): its message is above" }
  & python tools\smb-synth\verify_ar_ap.py --dir $smbDir
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------- -ChiroSample: regenerate and verify every chiro sample set
if ($ChiroSample) {
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Stop-Here "python is not on PATH (tools\chiro-synth needs Python 3)" }
  if ($ChiroSeed -lt 0 -or $ChiroLeakSeed -lt 0) { Stop-Here "-ChiroSeed and -ChiroLeakSeed must be 0 or more" }
  $chiroRoot = Join-Path $repo "sample-data\prms"
  $chiroOf = @{ chirotouch = "chiro-1-chirotouch"; jane = "chiro-2-jane" }
  $chiroSets = @()
  foreach ($p in @("chirotouch", "jane")) {
    # the scenarios come from the generator (Jane has no AUTODEBIT_RETURNED), never from a list here
    $scs = @(& python tools\chiro-synth\gen_chiro_set.py --prms $p --list-scenarios)
    if ($LASTEXITCODE -or $scs.Count -eq 0) { Stop-Here "gen_chiro_set.py --list-scenarios failed for $p (exit $LASTEXITCODE)" }
    Say "RUN" ("{0}: {1} set(s), seed {2}, leak seed {3}" -f $p, $scs.Count, $ChiroSeed, $ChiroLeakSeed)
    foreach ($sc in $scs) {
      $out = Join-Path $chiroRoot ("{0}\SET-1\{1}" -f $chiroOf[$p], $sc.ToUpper())
      & python tools\chiro-synth\gen_chiro_set.py --prms $p --scenario $sc --seed $ChiroSeed --leak-seed $ChiroLeakSeed --out $out | Out-Null
      if ($LASTEXITCODE) { Stop-Here "gen_chiro_set.py failed for $p $sc (exit $LASTEXITCODE): its message is above" }
      $chiroSets += ,@($p, $sc.ToUpper(), $out)
    }
  }
  $chiroFailed = 0
  foreach ($x in $chiroSets) {
    $other = Join-Path $chiroRoot ("{0}\SET-1\{1}" -f $chiroOf[$(if ($x[0] -eq "chirotouch") { "jane" } else { "chirotouch" })], $x[1])
    $vArgs = @("tools\chiro-synth\verify_chiro_set.py", "--dir", $x[2], "--tag", ("SET1-" + $x[1]))
    if (Test-Path $other) { $vArgs += @("--compare", $other) }
    $vOut = @(& python @vArgs)
    if ($LASTEXITCODE) { $chiroFailed++; Say "FAIL" ("{0} {1}" -f $x[0], $x[1]); $vOut | Select-Object -Last 6 | ForEach-Object { Write-Host "        $_" } }
  }
  if ($chiroFailed) { Say "FAIL" ("{0} of {1} chiro set(s) failed verification" -f $chiroFailed, $chiroSets.Count); exit 1 }
  Say "OK" ("{0} chiro set(s) written and verified (ALL CHECKS PASS each); answer keys carry query_answers" -f $chiroSets.Count)
  exit 0
}

# ---------------------------------------------------------------- -AgentAsk: one tab 03 agent run from the terminal (step C)
if ($AgentAsk) {
  if ($Tenant -notmatch '^[A-Za-z0-9_-]{1,32}$') { Stop-Here "-Tenant must be a tenant id such as t01" }
  if ($Dataset -notmatch '^[A-Za-z0-9_.-]{1,64}$') { Stop-Here "-Dataset must be a dataset id of config\datasets.json, e.g. smb-fin-1" }
  if ($Template -notmatch '^[\x20-\x7E]{1,120}$') { Stop-Here "-Template must be a template number (1, 2, ...) or its label" }
  if ($AgentAnswerModel -ne "default" -and $AgentAnswerModel -ne "none" -and $AgentAnswerModel -notmatch '^[\w.-]+/[\w.:-]+$') { Stop-Here "-AgentAnswerModel must be default, none or provider/name" }
  if ((HttpStatus "http://127.0.0.1:8735/") -eq 0) { Stop-Here "the console API (127.0.0.1:8735) is not running: start the desk with the agent first (.\test-console\desk.ps1 -All), then run -AgentAsk" }
  $askArgs = @("scripts\agent-ask.ts", "--api", "http://127.0.0.1:8735", "--tenant", $Tenant, "--dataset", $Dataset, "--template", $Template, "--answer-model", $AgentAnswerModel)
  if ($AgentQuestion) { $askArgs += @("--question", $AgentQuestion) }
  if ($AgentSet) { $askArgs += @("--set", $AgentSet) }
  & node @askArgs
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------- -VerifyReceipt: offline receipt check, pinned key (step D)
if ($VerifyReceipt) {
  if (-not (Test-Path -LiteralPath $VerifyReceipt -PathType Leaf)) { Stop-Here "-VerifyReceipt: no file $VerifyReceipt (tab 03's Download receipt saves chainaim-receipt-<jobId>.json; -AgentAsk saves it in runtime\agent-ask)" }
  if (-not (Test-Path "config\receipt-public-key.pem")) { Stop-Here "config\receipt-public-key.pem is missing: run .\test-console\desk.ps1 -ReceiptKey once" }
  $verArgs = @("scripts\verify-receipt.ts", "--file", $VerifyReceipt, "--public-key", "config\receipt-public-key.pem", "--result", $VerifyResult)
  & node @verArgs
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------- -Smoke: every tab-03 template through the console API (reads only)
if ($Smoke) {
  if (@("default", "all") -notcontains $SmokeSets) { Stop-Here "-SmokeSets must be default or all" }
  if ($SmokeModel -notmatch '^[\w.-]+/[\w.:-]+$') { Stop-Here "-SmokeModel must look like provider/name, e.g. bedrock/nemotron-nano-3-30b" }
  if ($SmokeAnswerModel -ne "none" -and $SmokeAnswerModel -notmatch '^[\w.-]+/[\w.:-]+$') { Stop-Here "-SmokeAnswerModel must be none or provider/name" }
  # -SmokeDatasets chiro-ct,chiro-jane arrives as an array (PowerShell splits on the comma); ui-smoke wants one comma list
  [string]$smokeDs = @($SmokeDatasets) -join ","   # a plain string: the [string[]] parameter would turn it back into an array
  if ($smokeDs -notmatch '^[A-Za-z0-9_,-]+$') { Stop-Here "-SmokeDatasets must be all or dataset ids separated by commas" }
  if (@("on", "off") -notcontains $SmokeCheckAnswers) { Stop-Here "-SmokeCheckAnswers must be on or off" }
  if ((HttpStatus "http://127.0.0.1:8735/") -eq 0) { Stop-Here "the console API (127.0.0.1:8735) is not running: start the desk first (.\test-console\desk.ps1), then run -Smoke" }
  $smokeArgs = @("scripts\ui-smoke.ts", "--api", "http://127.0.0.1:8735", "--root", "samples", "--model", $SmokeModel, "--answer-model", $SmokeAnswerModel, "--datasets", $smokeDs, "--sets", $SmokeSets, "--check-answers", $SmokeCheckAnswers)
  if ($SmokeDryRun) { $smokeArgs += "--dry-run" }
  Say "RUN" "UI template smoke check: model $SmokeModel, sets $SmokeSets, datasets $smokeDs, answers checked $SmokeCheckAnswers (sample data; report in test-console\runs)"
  & node @smokeArgs
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------- -Test needs nothing else
# The terminal suites, shared by -Test and -Ship. Output goes to the screen; the exit codes are returned.
function Invoke-Suites {
  Say "TEST" "terminal suites (each starts its own servers; near-watch path from config\local\repos.json)"
  # packages/receipt and packages/agent-policy: privateAI-design-32 ARCH-613..616 and ARCH-620..624; packages/ap2: design-33 ARCH-626 (pure, no servers).
  & node --test "packages/crossask/test/*.test.ts" "packages/receipt/test/*.test.ts" "packages/agent-policy/test/*.test.ts" "packages/ap2/test/*.test.ts" "scripts/test/*.test.ts" "services/gateway/test/*.test.ts" "test-console/test/*.test.ts" | Out-Host
  $a = $LASTEXITCODE
  & npm --prefix services\analyst test | Out-Host
  $b = $LASTEXITCODE
  # The paywall's own suite (privateAI-design-32 step 2: the release notice carries the settlement for the receipt).
  & npm --prefix services\paywall test | Out-Host
  $c = $LASTEXITCODE
  return @($a, $b, $c)
}
if ($Test) {
  $r = Invoke-Suites
  if ($r[0] -eq 0 -and $r[1] -eq 0 -and $r[2] -eq 0) { Say "OK" "all terminal suites passed"; exit 0 }
  Say "FAIL" "a suite failed (root suites exit $($r[0]), analyst exit $($r[1]), paywall exit $($r[2])): see the not ok lines above"; exit 1
}

# ---------------------------------------------------------------- -All step 1: the terminal suites, before any start
if ($All) {
  if ($AllSkipTests) { Say "NOTE" "-All: terminal suites skipped (-AllSkipTests)" }
  else {
    Say "ALL" "step 1 of 5: terminal suites"
    & node scripts\check-deps.ts | Out-Host
    if ($LASTEXITCODE) { Stop-Here "-All step 1: check-deps failed (exit $LASTEXITCODE); nothing started" }
    $r = Invoke-Suites
    if ($r[0] -or $r[1] -or $r[2]) { Stop-Here "-All step 1: a suite failed (root suites exit $($r[0]), analyst exit $($r[1]), paywall exit $($r[2])); nothing started" }
    Say "OK" "all terminal suites passed"
  }
  # -AllSmbSample: this script's own -SmbSample as a child (gen_ar_ap.py --force, then verify_ar_ap.py), before any start.
  if ($AllSmbSample) {
    Say "ALL" "step 1b: smb-fin-1 sample receivables, payables and answer key (-SmbSample, seed $SmbSeed)"
    & $PSCommandPath -SmbSample -SmbSeed $SmbSeed -Settings $Settings
    if ($LASTEXITCODE) { Stop-Here "-All step 1b: -SmbSample failed (exit $LASTEXITCODE); nothing started" }
  }
  Say "ALL" "step 2 of 5: start both stacks"
}

# ---------------------------------------------------------------- -Ship: test, commit and push this checkout's changes
if ($Ship) {
  if (-not $ShipMessage.Trim()) { Stop-Here "-Ship needs -ShipMessage with the commit message" }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-Here "git is not on PATH" }
  $branch = "$(Quiet { & git rev-parse --abbrev-ref HEAD 2>$null })".Trim()
  if (-not $branch -or $branch -eq "HEAD") { Stop-Here "not on a branch (detached HEAD): check out a branch first" }
  if ($ShipBranch -and $branch -ne $ShipBranch) { Stop-Here "on branch $branch, but -ShipBranch is $ShipBranch" }
  Say "GIT" "fetch $ShipRemote $branch"
  Quiet { & git fetch $ShipRemote $branch }
  if ($LASTEXITCODE) { Stop-Here "git fetch $ShipRemote $branch failed (exit $LASTEXITCODE): nothing changed" }
  $behind = "$(Quiet { & git rev-list --count "HEAD..$ShipRemote/$branch" 2>$null })".Trim()
  if ($behind -ne "0") { Stop-Here "$branch is $behind commit(s) behind $ShipRemote/$branch (bring the branch up to date and re-test first); nothing changed" }
  if ($ShipTag) {
    # A tag is never moved or replaced: refuse before any test when it exists here or on the remote.
    Quiet { & git rev-parse -q --verify "refs/tags/$ShipTag" *> $null }
    if ($LASTEXITCODE -eq 0) { Stop-Here "tag $ShipTag already exists here: pick the next version; nothing changed" }
    $remoteTag = "$(Quiet { & git ls-remote --tags $ShipRemote "refs/tags/$ShipTag" 2>$null })".Trim()
    if ($LASTEXITCODE) { Stop-Here "git ls-remote $ShipRemote failed (exit $LASTEXITCODE): cannot check the tag; nothing changed" }
    if ($remoteTag) { Stop-Here "tag $ShipTag already exists on ${ShipRemote}: pick the next version; nothing changed" }
    Say "GIT" "tag $ShipTag is free here and on $ShipRemote"
  }
  $status = @(Quiet { & git status --porcelain --untracked-files=all 2>$null } | Where-Object { "$_".Length -gt 3 })
  $changed = @($status | ForEach-Object { $p = "$_".Substring(3); if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1] }; $p.Trim('"') })
  if (-not $changed.Count) { Stop-Here "nothing to commit: the working tree is clean" }
  if ($ShipFiles.Count) {
    $want = @($ShipFiles | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim().Replace('\', '/') } | Where-Object { $_ })
    $noChange = @($want | Where-Object { $changed -notcontains $_ })
    if ($noChange.Count) { Stop-Here ("-ShipFiles names files with no change: " + ($noChange -join ", ")) }
    $left = @($changed | Where-Object { $want -notcontains $_ })
    if ($left.Count) { Say "NOTE" ("left out of this commit (still changed): " + ($left -join ", ")) }
  } else { $want = $changed }
  Say "GIT" "branch $branch, $($want.Count) file(s) to commit:"
  foreach ($f in $want) { Write-Host "  $f" }
  if ($ShipSkipTests) { Say "NOTE" "tests skipped (-ShipSkipTests)" }
  else {
    Say "TEST" "scripts\check-deps.ts"
    & node scripts\check-deps.ts | Out-Host
    if ($LASTEXITCODE) { Stop-Here "check-deps failed (exit $LASTEXITCODE): nothing committed" }
    $r = Invoke-Suites
    if ($r[0] -or $r[1] -or $r[2]) { Stop-Here "a suite failed (root suites exit $($r[0]), analyst exit $($r[1]), paywall exit $($r[2])): nothing committed" }
    Say "OK" "all terminal suites passed"
  }
  if ($ShipDryRun) { Say "OK" "-ShipDryRun: nothing staged, committed or pushed"; exit 0 }
  $addArgs = @("add", "--") + $want
  Quiet { & git @addArgs }
  if ($LASTEXITCODE) { Stop-Here "git add failed (exit $LASTEXITCODE): nothing committed" }
  $commitArgs = @("commit", "-m", $ShipMessage)
  if ($ShipTrailer) { $commitArgs += @("-m", $ShipTrailer) }
  $commitArgs += @("--") + $want
  Quiet { & git @commitArgs }
  if ($LASTEXITCODE) { Stop-Here "git commit failed (exit $LASTEXITCODE): the files stay staged; nothing pushed" }
  Say "OK" "committed $("$(Quiet { & git log --oneline -1 2>$null })".Trim())"
  if ($ShipTag) {
    $tagMsg = if ($ShipTagMessage) { $ShipTagMessage } else { $ShipMessage }
    Quiet { & git tag -a $ShipTag -m $tagMsg }
    if ($LASTEXITCODE) { Stop-Here "git tag $ShipTag failed (exit $LASTEXITCODE): the commit is kept; nothing pushed" }
    Say "OK" "tagged $ShipTag (annotated) on $("$(Quiet { & git rev-parse --short HEAD 2>$null })".Trim())"
  }
  if ($ShipNoPush) { Say "OK" "-ShipNoPush: not pushed; push later with git push $ShipRemote $branch$(if ($ShipTag) { " and git push $ShipRemote $ShipTag" })"; exit 0 }
  Say "GIT" "push $ShipRemote $branch"
  Quiet { & git push $ShipRemote $branch }
  if ($LASTEXITCODE) { Stop-Here "git push failed (exit $LASTEXITCODE): the commit is kept locally; fix the cause above, then git push $ShipRemote $branch" }
  $ahead = "$(Quiet { & git rev-list --count "$ShipRemote/$branch..HEAD" 2>$null })".Trim()
  if ($ahead -ne "0") { Stop-Here "push reported success but $branch is still $ahead commit(s) ahead of $ShipRemote/$branch" }
  if ($ShipTag) {
    Say "GIT" "push $ShipRemote $ShipTag"
    Quiet { & git push $ShipRemote "refs/tags/$ShipTag" }
    if ($LASTEXITCODE) { Stop-Here "git push of tag $ShipTag failed (exit $LASTEXITCODE): the branch is pushed, the tag is kept here; git push $ShipRemote $ShipTag" }
    $pushedTag = "$(Quiet { & git ls-remote --tags $ShipRemote "refs/tags/$ShipTag" 2>$null })".Trim()
    if (-not $pushedTag) { Stop-Here "push reported success but $ShipRemote does not list tag $ShipTag" }
  }
  Say "OK" "committed and pushed to $ShipRemote/$branch$(if ($ShipTag) { ", tag $ShipTag" })"
  exit 0
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
# NEAR AI model attestation (ARCH-411): the same auto / on / off shape as agent mode; up.ps1 makes the auto decision.
$attestMode = if ($Attest) { "on" } elseif ($P.attest -and $P.attest.enabled -is [bool]) { $(if ($P.attest.enabled) { "on" } else { "off" }) } elseif ($P.attest -and $P.attest.enabled) { [string]$P.attest.enabled } else { "auto" }
if (@("auto", "on", "off") -notcontains $attestMode) { Stop-Here "$Settings attest.enabled must be auto, on or off" }
if ($attestMode -eq "on" -and -not $paid) { Stop-Here "model attestation needs paid jobs on (paidJobs.enabled in $Settings)" }
$attestGpu = if ($P.attest -and $P.attest.gpuCheck) { [string]$P.attest.gpuCheck } else { "on" }
if (@("on", "off") -notcontains $attestGpu) { Stop-Here "$Settings attest.gpuCheck must be on or off" }
# Whether up.ps1 actually started ca-attest: runtime\compose\commands.yml (written by up.ps1, commands only, no secrets).
function AttestStarted {
  $f = Join-Path $repo "runtime\compose\commands.yml"
  if (-not (Test-Path $f)) { return $false }
  try { return [bool]((Get-Content -Raw $f | ConvertFrom-Json).services.attest) } catch { return $false }
}
if ($P.paidJobs -and $P.paidJobs.feePerModelCallUsd) { Say "NOTE" "$Settings has paidJobs fees: they are no longer used (prices come from up.ps1's price files)" }
# Job Evidence Receipts (privateAI-design-32 ARCH-614/615): the same auto / on / off shape; up.ps1 makes the auto decision
# (on when chainaim.env holds the signing key). Nothing here reads the key.
$receiptsMode = if ($Receipts) { "on" } elseif ($P.receipts -and $P.receipts.enabled -is [bool]) { $(if ($P.receipts.enabled) { "on" } else { "off" }) } elseif ($P.receipts -and $P.receipts.enabled) { [string]$P.receipts.enabled } else { "auto" }
if (@("auto", "on", "off") -notcontains $receiptsMode) { Stop-Here "$Settings receipts.enabled must be auto, on or off" }
if ($receiptsMode -eq "on" -and -not $paid) { Stop-Here "receipts need paid jobs on (paidJobs.enabled in $Settings): a receipt is for a paid job" }

# ---------------------------------------------------------------- -ReceiptKey: the receipt signing key, then stop
# The Node script reads and writes chainaim.env; this script only passes the path, so it still never reads a secret value.
if ($ReceiptKey) {
  if (-not (Test-Path $secrets)) { Stop-Here "the secrets folder $secrets does not exist (secretsDir in $Settings)" }
  $keyArgs = @("scripts\receipt-key.ts", "--secrets-file", (Join-Path $secrets "chainaim.env"), "--var", $ReceiptKeyName)
  # Step B: the PUBLIC key also goes to config\receipt-public-key.pem (committed), the key the agent and verifiers pin.
  $keyArgs += @("--public-out", "config\receipt-public-key.pem")
  if ($ReceiptKeyRotate) { $keyArgs += "--rotate" }
  Say "RUN" "receipt signing key $ReceiptKeyName in $secrets\chainaim.env$(if ($ReceiptKeyRotate) { ' (rotate)' }); only the key id and PUBLIC key are printed"
  & node @keyArgs
  if ($LASTEXITCODE) { Stop-Here "scripts\receipt-key.ts stopped (exit $LASTEXITCODE): its message is above; nothing else changed" }
  Say "NEXT" "start (or restart) the desk so the console signs receipts: .\test-console\desk.ps1 -All"
  exit 0
}

# ---------------------------------------------------------------- -Ap2Key: the AP2 signing key (ES256), then stop
# privateAI-design-33 ARCH-627. The same Node script as -ReceiptKey with --alg ES256; this script only passes paths.
if ($Ap2Key) {
  if (-not (Test-Path $secrets)) { Stop-Here "the secrets folder $secrets does not exist (secretsDir in $Settings)" }
  $ap2Args = @("scripts\receipt-key.ts", "--secrets-file", (Join-Path $secrets "chainaim.env"), "--alg", "ES256", "--var", $Ap2KeyName)
  # The PUBLIC key as a JWK Set goes to config\ap2-public-key.jwk.json (committed), the key the agent pins.
  $ap2Args += @("--public-out", "config\ap2-public-key.jwk.json")
  if ($Ap2KeyRotate) { $ap2Args += "--rotate" }
  Say "RUN" "AP2 signing key $Ap2KeyName (ES256) in $secrets\chainaim.env$(if ($Ap2KeyRotate) { ' (rotate)' }); only the key id and PUBLIC key are printed"
  & node @ap2Args
  if ($LASTEXITCODE) { Stop-Here "scripts\receipt-key.ts stopped (exit $LASTEXITCODE): its message is above; nothing else changed" }
  Say "NEXT" "commit config\ap2-public-key.jwk.json with the next ship; the console uses the key once AP2 signing is on (design-33 ARCH-628)"
  exit 0
}

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
    @("agent (tab 03)", "http://127.0.0.1:8760/healthz", $agentOn),
    @("attest (ca-attest)", "http://127.0.0.1:8770/healthz", ($attestMode -ne "off" -and $paid)))
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
    if ($r[0] -eq "attest (ca-attest)" -and -not (AttestStarted)) {
      if ($attestMode -eq "auto") { Write-Host ("  {0,-20} {1,-5} {2}" -f $r[0], "off", "up.ps1 switched model attestation off (see its INFO line above)"); continue }
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
  # The model pick lists of tab 02 (Private chat) and tab 03 (Across Files) are the gateway's /v1/models, through the console
  # API. Each required family must be listed (owner 2026-11-07: local, Bedrock and NEAR AI). Listed is checked here, not
  # answering: a local model also needs Ollama with it pulled (-Memory shows that); Bedrock and NEAR AI need their keys.
  $gm = HttpJson "http://127.0.0.1:8735/gateway/models"
  $ids = @(if ($gm -and $gm.models) { @($gm.models) | ForEach-Object { [string]$_ } })
  if (-not $ids.Count) { Write-Host ("  {0,-20} {1,-5} {2}" -f "models (tabs 02/03)", "DOWN", "the console API listed no models (http://127.0.0.1:8735/gateway/models)"); $bad++ }
  else {
    foreach ($fam in $RequireModels) {
      $hit = @($ids | Where-Object { $_.StartsWith($fam + "/") })
      if ($hit.Count) { Write-Host ("  {0,-20} {1,-5} {2}" -f "models $fam", "OK", ($hit -join ", ")) }
      else {
        Write-Host ("  {0,-20} {1,-5} {2}" -f "models $fam", "MISS", "not in the gateway's list: $($ids -join ', ')"); $bad++
        if ($fam -eq "nearai") { $notes += "NEAR AI is not in the gateway's model mode: run .\test-console\switch-models.ps1 -To ollama-cpu-8gb-all-nearai once (NEARAI_API_KEY in $secrets\chainaim.env), then this again." }
        else { $notes += "No $fam model in the gateway's model mode: switch-models.ps1 -To ollama-cpu-8gb-all-nearai lists local, Bedrock and NEAR AI together." }
      }
    }
    if ($gm.defaultAnswerModel) { Write-Host ("  {0,-20} {1,-5} {2}" -f "Explained default", "OK", [string]$gm.defaultAnswerModel) }
  }
  # Signed receipts (ARCH-615): what the running console API says in /jobs/config, never the key.
  if ($paid -and $receiptsMode -ne "off") {
    $jc = HttpJson "http://127.0.0.1:8735/jobs/config"
    $rcpt = if ($jc -and $null -ne $jc.receipts) { [bool]$jc.receipts } else { $null }
    if ($rcpt -eq $true) { Write-Host ("  {0,-20} {1,-5} {2}" -f "receipts", "OK", "signed after each paid job (GET /jobs/<id>/receipt)") }
    elseif ($receiptsMode -eq "on") { Write-Host ("  {0,-20} {1,-5} {2}" -f "receipts", "DOWN", "required (-Receipts / receipts.enabled on) but the console API reports them off"); $bad++ }
    else { Write-Host ("  {0,-20} {1,-5} {2}" -f "receipts", "off", "no signing key yet: run .\test-console\desk.ps1 -ReceiptKey once, then start again") }
  } else { Write-Host ("  {0,-20} off in {1}" -f "receipts", $Settings) }
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
  # The 8800 admin UI is a Next.js build that nearadminup.ps1 starts but never builds: rebuild it when its source is newer
  # than the last build, so this one command always serves the current code (CLAUDE.md rule 8). The old 8800 process was
  # stopped in step 2, so the new build is what starts.
  $consoleDir = Join-Path $adminRoot "apps\admin-console"
  $buildId = Join-Path $consoleDir ".next\BUILD_ID"
  $srcDirs = @(@("app", "components", "lib", "hooks") | ForEach-Object { Join-Path $consoleDir $_ } | Where-Object { Test-Path $_ })
  $newest = @(Get-ChildItem -Path $srcDirs -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1)
  if (-not (Test-Path $buildId) -or ($newest.Count -and $newest[0].LastWriteTimeUtc -gt (Get-Item $buildId).LastWriteTimeUtc)) {
    Say "RUN" "admin UI build (npm --prefix apps\admin-console run build): its source changed since the last build"
    & npm --prefix $consoleDir run build
    if ($LASTEXITCODE) { Stop-Here "the admin UI build failed (exit $LASTEXITCODE): its error is above" }
  } else { Say "OK" "admin UI build is current" }
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
if ($attestMode -ne "auto") { $privArgs.Attest = $attestMode }
if ($receiptsMode -ne "auto") { $privArgs.Receipts = $receiptsMode }
$privArgs.ReceiptKeyName = $ReceiptKeyName
$privArgs.AttestGpuCheck = $attestGpu
# Tab 03 defaults (owner 2026-11-07): the AI agent pays, NEAR AI words Explained answers; desk.json console.* changes them.
$defAnswer = if ($P.console -and $null -ne $P.console.defaultAnswerModel) { [string]$P.console.defaultAnswerModel } else { "nearai/deepseek-v4.1-flash" }
$defPayer = if ($P.console -and $P.console.defaultPayer) { [string]$P.console.defaultPayer } else { "agent" }
if (@("me", "agent") -notcontains $defPayer) { Stop-Here "$Settings console.defaultPayer must be me or agent" }
if ($defAnswer) { $privArgs.DefaultAnswerModel = $defAnswer }
$privArgs.DefaultPayer = $defPayer
Say "RUN" "test-console\up.ps1 -ReplaceRunning -PaidJobs $($privArgs.PaidJobs)$(if ($Build) { ' -Build' })$(if ($WithStub) { ' -Test' })$(if ($agentMode -ne 'auto') { ' -Agent ' + $agentMode })$(if ($attestMode -ne 'auto') { ' -Attest ' + $attestMode }) -AttestGpuCheck $attestGpu$(if ($receiptsMode -ne 'auto') { ' -Receipts ' + $receiptsMode }) -DefaultPayer $defPayer$(if ($defAnswer) { ' -DefaultAnswerModel ' + $defAnswer })"
& $privUp @privArgs
if ($LASTEXITCODE) { Stop-Here "test-console\up.ps1 stopped (exit $LASTEXITCODE): its STOP line above names the fix" }

# 5. operator re-judge of FALSE reconcile mismatches (only with -RejudgeReceiver): inside ca-near-watch, so its admin key
#    comes from near-watch's own env file and never reaches this window. Every row is checked on its own by near-watch.
if ($RejudgeReceiver) {
  if (-not $admin) { Stop-Here "-RejudgeReceiver needs the NEAR admin side (adminUi.enabled in $Settings)" }
  Say "RUN" "re-judge every reconcile mismatch against receiver $RejudgeReceiver (near-watch src/rejudge.ts --all-mismatches)"
  $rj = @(Quiet { & docker exec ca-near-watch node --env-file=/run/secrets/near-watch.env src/rejudge.ts --all-mismatches --receiver $RejudgeReceiver --reason $RejudgeReason 2>&1 })
  $rjCode = $LASTEXITCODE
  foreach ($l in $rj) { Say "REJUDGE" ([string]$l) }
  if ($rjCode -ne 0) { Problem "some mismatch rows were not re-judged (exit $rjCode): each line above says why; they stay mismatch" }
  else { Say "OK" "re-judge done; the NEAR admin UI Reconcile tab shows the rows as matched with the reason" }
}

# 6. one table across both
$bad = Report
$bad += $script:problems
if ($bad) { Write-Host ""; Say "NOT READY" "$bad problem(s) above; each names its fix"; exit 1 }
Write-Host ""; Say "READY" "console http://127.0.0.1:8730$(if ($admin) { '   NEAR admin UI http://127.0.0.1:8800/#jobs' })   stop: .\test-console\desk.ps1 -Stop"

# 7. log windows (-Windows, or analyst by default with -All): one PowerShell window per container log; the service is not
#    touched, closing a window only stops watching it.
foreach ($n in $WindowNames) {
  $c = $LogContainers[$n]
  $inner = '$host.UI.RawUI.WindowTitle = ''desk log: ' + $n + ' (' + $c + ')''; docker logs -f --tail 50 ' + $c
  Say "WINDOW" "$n log ($c) in its own window"
  Start-Process powershell -ArgumentList @("-NoExit", "-NoProfile", "-Command", $inner)
}

# 8. the pages open as soon as the stack is READY, before the smoke check, so a smoke FAIL never hides the UIs
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:8730"; if ($admin) { Start-Process "http://127.0.0.1:8800/#jobs" } }

# 9. -All step 4: the UI template smoke check against the stack just started (this script's own -Smoke, same options).
#    A FAIL here is a result check (a wrong answer or a template error), not the stack: both UIs stay up and open.
if ($All -and -not $AllSkipSmoke) {
  Say "ALL" "step 5 of 5: UI template smoke check (both UIs are already up and open)"
  & $PSCommandPath -Smoke -SmokeModel $SmokeModel -SmokeSets $SmokeSets -SmokeDatasets $SmokeDatasets -SmokeAnswerModel $SmokeAnswerModel -SmokeCheckAnswers $SmokeCheckAnswers -Settings $Settings
  if ($LASTEXITCODE) {
    Say "FAIL" "-All step 5: the UI smoke check reported FAIL (exit $LASTEXITCODE): see its FAIL lines and the report in test-console\runs"
    Say "UP" "the stack is still running and both UIs are open: console http://127.0.0.1:8730$(if ($admin) { '   NEAR admin UI http://127.0.0.1:8800/#jobs' })"
    exit 1
  }
} elseif ($All) { Say "NOTE" "-All: UI smoke check skipped (-AllSkipSmoke)" }
if ($All) { Say "ALL OK" "terminal suites, both stacks, log windows, both UIs and the UI smoke check all passed" }
