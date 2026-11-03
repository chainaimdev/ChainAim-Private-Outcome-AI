<#
Sets the per-PC chain details without putting them on the command line (DESIGN/xrplh-28 section 3.3).

  .\test-console\chain-config.ps1 -List                              chains and environments from config\chains\networks.json
  .\test-console\chain-config.ps1 -Set -Chain xrpl -Env testnet      asks for the pay-to address (hidden), checks it, saves it
  .\test-console\chain-config.ps1 -Set -Chain near -Env testnet      asks for the NEAR account (hidden), checks it, saves it
  .\test-console\chain-config.ps1 -Select -Chain near -Env testnet   the chain/env the console twisty starts on
  .\test-console\chain-config.ps1 -SetSecret BEDROCK_API_KEY         hidden prompt -> the secrets file outside the repo
  .\test-console\chain-config.ps1 -Show                              everything, masked

  -Field        which profile field -Set writes (default: payTo for XRPL, account for others)
  -Visible      -Set reads the value with a normal (visible) prompt instead of a hidden one
  -ProfileFile  default config\local\chain-profile.json (git-ignored)
  -SecretsFile  default C:\PRIV-AI-SECRETS\chainaim.env (must be outside the repository)
  -Registry     default config\chains\networks.json
Values never appear on the command line or in the output (masked). ASCII only (Windows PowerShell 5.1).
#>
param(
  [switch]$List,
  [switch]$Set,
  [switch]$Select,
  [string]$SetSecret,
  [switch]$Show,
  [string]$Chain,
  [Alias("Env")][string]$Network,
  [string]$Field,
  [switch]$Visible,
  [string]$ProfileFile,
  [string]$SecretsFile,
  [string]$Registry
)
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "lib\settings.psm1") -Force
$d = Get-SettingsDefaults
if (-not $ProfileFile) { $ProfileFile = $d.Profile }
if (-not $SecretsFile) { $SecretsFile = $d.Secrets }
if (-not $Registry) { $Registry = $d.Registry }
$reg = Get-ChainRegistry $Registry
$chains = @($reg.PSObject.Properties | Where-Object { $_.Name -notin @("version", "notes") })

function Need-ChainEnv {
  if (-not $Chain -or -not $Network) { throw "Give -Chain and -Env (see -List)." }
  $c = $reg.PSObject.Properties[$Chain]; if (-not $c) { throw "Unknown chain $Chain (known: $(($chains | ForEach-Object Name) -join ', '))" }
  $e = $c.Value.environments.PSObject.Properties[$Network]; if (-not $e) { throw "Unknown environment $Network for $Chain (known: $(($c.Value.environments.PSObject.Properties | ForEach-Object Name) -join ', '))" }
  return $c.Value
}

if (-not ($List -or $Set -or $Select -or $SetSecret -or $Show)) { $Show = $true }

if ($List) {
  foreach ($c in $chains) {
    foreach ($e in $c.Value.environments.PSObject.Properties) {
      Write-Host ("{0,-6} {1,-15} {2,-28} capabilities: {3}" -f $c.Name, $e.Name, $e.Value.label, (@($e.Value.capabilities) -join ", "))
    }
  }
}

if ($Set) {
  $c = Need-ChainEnv
  if (-not $Field) { $Field = if ($c.adapter -eq "xrpl") { "payTo" } else { "account" } }
  if ($Visible) { $v = (Read-Host "Value for $Chain $Network $Field").Trim() } else { $v = Read-HiddenValue "Value for $Chain $Network $Field (hidden; paste with a right-click)" 2 }
  if (-not (Test-ChainAddress $c.addressRule $v)) { throw "That is not a valid $($c.addressRule) value; nothing saved." }
  Set-ProfileAccount $Chain $Network $Field $v $ProfileFile
  Write-Host "Saved $Chain $Network $Field = $(Get-MaskedValue $v) in $ProfileFile"
}

if ($Select) {
  [void](Need-ChainEnv)
  Set-ProfileSelected $Chain $Network $ProfileFile
  Write-Host "Selected $Chain $Network (the console twisty starts there)."
}

if ($SetSecret) {
  $v = Read-HiddenValue "Paste $SetSecret and press Enter (it stays hidden; right-click to paste)" 16
  Set-SecretInFile $SetSecret $v $SecretsFile
  Remove-Variable v
  Write-Host "Saved $SetSecret in $SecretsFile (value not shown)."
}

if ($Show) {
  $p = Get-ChainProfile $ProfileFile
  Write-Host "Profile:  $ProfileFile $(if (Test-Path $ProfileFile) { '' } else { '(not created yet)' })"
  Write-Host "Selected: $(if ($p.selected) { "$($p.selected.chain) $($p.selected.env)" } else { '(none)' })"
  foreach ($a in $p.accounts.PSObject.Properties) {
    foreach ($f in $a.Value.PSObject.Properties) { Write-Host ("  {0,-22} {1,-8} {2}" -f $a.Name, $f.Name, (Get-MaskedValue ([string]$f.Value))) }
  }
  $s = Read-SecretsFile $SecretsFile
  Write-Host "Secrets:  $SecretsFile $(if (Test-Path $SecretsFile) { '' } else { '(not created yet)' })"
  foreach ($n in @("BEDROCK_API_KEY", "OPENROUTER_API_KEY") + @($s.Keys | Where-Object { $_ -notin @("BEDROCK_API_KEY", "OPENROUTER_API_KEY") } | Sort-Object)) {
    Write-Host ("  {0,-30} {1}" -f $n, $(if ($s.ContainsKey($n) -and $s[$n]) { "set" } else { "not set" }))
  }
}
