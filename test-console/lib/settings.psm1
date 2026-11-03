<#
Shared per-PC settings for the test-console scripts (DESIGN/xrplh-28 section 3.3). One lookup order everywhere:
flag -> environment variable -> profile / secrets file -> hidden prompt. Nothing here prints a secret; addresses are
shown masked (rn5h...gBej).

  Profile (git-ignored): config\local\chain-profile.json
    { "selected": { "chain": "xrpl", "env": "testnet" },
      "accounts": { "xrpl:testnet": { "payTo": "r..." }, "near:testnet": { "account": "name.testnet" } } }
  Secrets (outside every repository): C:\PRIV-AI-SECRETS\chainaim.env, NAME=value lines.
ASCII only (Windows PowerShell 5.1).
#>
$script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:DefaultProfile = Join-Path $script:RepoRoot "config\local\chain-profile.json"
$script:DefaultSecrets = "C:\PRIV-AI-SECRETS\chainaim.env"
$script:DefaultRegistry = Join-Path $script:RepoRoot "config\chains\networks.json"

function Get-SettingsDefaults { [pscustomobject]@{ Repo = $script:RepoRoot; Profile = $script:DefaultProfile; Secrets = $script:DefaultSecrets; Registry = $script:DefaultRegistry } }

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  $t = Get-Content -Raw -Encoding UTF8 $Path
  if ($t.Length -gt 0 -and [int][char]$t[0] -eq 0xFEFF) { $t = $t.Substring(1) }
  try { return ($t | ConvertFrom-Json) } catch { throw "$Path is not valid JSON: $($_.Exception.Message)" }
}

function Get-MaskedValue([string]$Value, [int]$Keep = 4) {
  if (-not $Value) { return "(not set)" }
  if ($Value.Length -le ($Keep * 2 + 1)) { return ("*" * $Value.Length) }
  return $Value.Substring(0, $Keep) + "..." + $Value.Substring($Value.Length - $Keep)
}

# Same rules as packages/chain-contracts (validAddress).
function Test-ChainAddress([string]$Rule, [string]$Value) {
  switch ($Rule) {
    "xrpl-classic" { return [bool]($Value -cmatch '^r[1-9A-HJ-NP-Za-km-z]{24,34}$') }
    "near-account" { return [bool]($Value -cmatch '^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$') }
    default { throw "Unknown address rule $Rule" }
  }
}

function Get-ChainRegistry([string]$Registry = $script:DefaultRegistry) {
  $r = Read-JsonFile $Registry
  if (-not $r) { throw "Chain registry not found: $Registry" }
  return $r
}

function Get-ChainProfile([string]$ProfileFile = $script:DefaultProfile) {
  $p = Read-JsonFile $ProfileFile
  if (-not $p) { $p = [pscustomobject]@{ selected = $null; accounts = [pscustomobject]@{} } }
  if (-not $p.PSObject.Properties["accounts"] -or -not $p.accounts) { $p | Add-Member -NotePropertyName accounts -NotePropertyValue ([pscustomobject]@{}) -Force }
  return $p
}

function Save-ChainProfile($Data, [string]$ProfileFile = $script:DefaultProfile) {
  $dir = Split-Path -Parent $ProfileFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $json = $Data | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($ProfileFile, $json + "`n", (New-Object Text.UTF8Encoding($false)))
}

# The value of accounts["<chain>:<env>"].<field> in the profile, or $null.
function Get-ProfileAccount([string]$Chain, [string]$Network, [string]$Field, [string]$ProfileFile = $script:DefaultProfile) {
  $p = Get-ChainProfile $ProfileFile
  $a = $p.accounts.PSObject.Properties["$($Chain):$($Network)"]
  if (-not $a -or -not $a.Value) { return $null }
  $f = $a.Value.PSObject.Properties[$Field]
  if ($f) { return [string]$f.Value } else { return $null }
}

function Set-ProfileAccount([string]$Chain, [string]$Network, [string]$Field, [string]$Value, [string]$ProfileFile = $script:DefaultProfile) {
  $p = Get-ChainProfile $ProfileFile
  $key = "$($Chain):$($Network)"
  if (-not $p.accounts.PSObject.Properties[$key]) { $p.accounts | Add-Member -NotePropertyName $key -NotePropertyValue ([pscustomobject]@{}) }
  $p.accounts.$key | Add-Member -NotePropertyName $Field -NotePropertyValue $Value -Force
  Save-ChainProfile $p $ProfileFile
}

function Set-ProfileSelected([string]$Chain, [string]$Network, [string]$ProfileFile = $script:DefaultProfile) {
  $p = Get-ChainProfile $ProfileFile
  $p | Add-Member -NotePropertyName selected -NotePropertyValue ([pscustomobject]@{ chain = $Chain; env = $Network }) -Force
  Save-ChainProfile $p $ProfileFile
}

# NAME=value lines -> hashtable. Missing file -> empty table. Values are never printed.
function Read-SecretsFile([string]$SecretsFile = $script:DefaultSecrets) {
  $h = @{}
  if (-not (Test-Path $SecretsFile)) { return $h }
  foreach ($line in (Get-Content -Encoding UTF8 $SecretsFile)) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $h[$Matches[1]] = $Matches[2].Trim().Trim('"') }
  }
  return $h
}

function Set-SecretInFile([string]$Name, [string]$Value, [string]$SecretsFile = $script:DefaultSecrets) {
  if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Secret name must be letters, digits and _ ($Name)" }
  $dir = Split-Path -Parent $SecretsFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $full = [IO.Path]::GetFullPath($SecretsFile)
  if ($full.StartsWith([IO.Path]::GetFullPath($script:RepoRoot), [StringComparison]::OrdinalIgnoreCase)) { throw "The secrets file must be outside the repository ($full)." }
  $lines = @(); if (Test-Path $SecretsFile) { $lines = @(Get-Content -Encoding UTF8 $SecretsFile | Where-Object { $_ -notmatch "^\s*(?:export\s+)?$Name\s*=" }) }
  $lines += "$Name=$Value"
  [IO.File]::WriteAllLines($SecretsFile, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
}

# Hidden prompt -> plain string in memory only. Refuses control characters (a Ctrl+V at a hidden prompt in PS 5.1).
function Read-HiddenValue([string]$Prompt, [int]$MinLength = 1) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if ($v.Length -lt $MinLength -or $v -match '[\x00-\x1F\x7F]') { throw "That does not look right ($($v.Length) characters, or a control character). Paste with a RIGHT-CLICK; Ctrl+V does not paste at a hidden prompt in Windows PowerShell." }
  return $v
}

# flag -> environment variable -> secrets file -> hidden prompt (unless -NoPrompt). Returns $null when nothing is found.
function Resolve-Secret([string]$Name, [string]$Value = "", [string]$SecretsFile = $script:DefaultSecrets, [switch]$NoPrompt) {
  if ($Value) { return $Value }
  $e = [Environment]::GetEnvironmentVariable($Name); if ($e) { return $e }
  $s = Read-SecretsFile $SecretsFile; if ($s.ContainsKey($Name) -and $s[$Name]) { return $s[$Name] }
  if ($NoPrompt) { return $null }
  return Read-HiddenValue "Paste $Name and press Enter (it stays hidden)" 16
}

Export-ModuleMember -Function Get-SettingsDefaults, Read-JsonFile, Get-MaskedValue, Test-ChainAddress, Get-ChainRegistry, Get-ChainProfile, Save-ChainProfile, Get-ProfileAccount, Set-ProfileAccount, Set-ProfileSelected, Read-SecretsFile, Set-SecretInFile, Read-HiddenValue, Resolve-Secret
