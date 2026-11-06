<#
Stops what up.ps1 started: the 8730 UI window (server.ts --mode ui) and the compose stack (docker compose down),
including ca-agent when up.ps1 -Agent on started it.
Volumes are kept (the gateway ledger chainaim-test-ledger, the analyst's work folder, the console's run log), and so
are the network and the images. Back to the old way: DOCKERIZE-PLAN.md section 8 (stack.ps1, switch-models.ps1,
start-ui.ps1).

  .\test-console\down.ps1              UI and compose stack
  .\test-console\down.ps1 -KeepUi      compose stack only
ASCII only (Windows PowerShell 5.1).
#>
param([switch]$KeepUi, [int]$UiPort = 8730)
$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location $repo
if (-not $KeepUi) {
  # Only a console started in ui mode is stopped; anything else on the port is left alone.
  foreach ($c in @(Get-NetTCPConnection -LocalPort $UiPort -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)" -ErrorAction SilentlyContinue
    if ($p -and $p.CommandLine -match 'server\.ts' -and $p.CommandLine -match '--mode ui') { Stop-Process -Id $p.ProcessId -Force -Confirm:$false; Write-Host "STOP   UI on $UiPort" }
    else { Write-Host "KEEP   port $UiPort is held by another program (not the ui-mode console); left running" }
  }
}
$files = @("-f", "docker-compose.yml")
$cmdFile = Join-Path $repo "runtime\compose\commands.yml"
if (Test-Path $cmdFile) { $files += @("-f", $cmdFile) }
# --profile agent: ca-agent too, when up.ps1 -Agent on started it (ARCH-312); nothing else changes when it did not.
& docker compose @files --profile test --profile agent down
if ($LASTEXITCODE -ne 0) { Write-Host "STOP   docker compose down failed; see the message above."; exit 1 }
Write-Host "DONE   compose stack stopped (volumes, network and images kept)"
