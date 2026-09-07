# Remount trading-web profile @deepseek-ai core packages onto the local DSH host tree.
# Same purpose as refresh-trading-web-profile.sh: one module instance so
# TOOL_RUNTIME_SCHEDULER (a module-level Symbol) matches across agent-loop and tools.
#
# Usage:
#   powershell -File scripts/refresh-trading-web-profile.ps1
# Stops any process listening on -Port (default 3081) before rewriting node_modules.

param(
  [int]$Port = 3081,
  [string]$HostRoot = ''
)

$ErrorActionPreference = 'Stop'
$profileRoot = Join-Path $env:USERPROFILE '.dsh\profiles\trading-web'
if (-not $HostRoot) {
  $HostRoot = Join-Path $PSScriptRoot '..\.local\node_modules\@deepseek-ai' | Resolve-Path
}

$corePkgs = @(
  'dsh-web-app', 'dsh-tools', 'cosmokit', 'schemastery', 'dsh-agent-presets',
  'dsh-brand', 'dsh-util-values', 'dsh-settings', 'dsh-skill', 'dsh-tool-cordis',
  'dsh-llm', 'dsh-scope', 'dsh-timeout', 'dsh-typert-protocol', 'dsh-util-crypto'
)

if (-not (Test-Path $profileRoot)) { throw "Profile not found: $profileRoot" }
if (-not (Test-Path $HostRoot)) { throw "Host package root not found: $HostRoot" }

Write-Host '== Stop trading-web if it holds the port =='
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host "  stop PID $($_.OwningProcess)"
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 1

Write-Host '== Remount host core packages as junctions =='
$shadows = Get-ChildItem (Join-Path $profileRoot 'node_modules') -Recurse -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Parent.Name -eq '@deepseek-ai' -and $corePkgs -contains $_.Name }

foreach ($shadow in $shadows) {
  $pkg = $shadow.Name
  $hostPkg = Join-Path $HostRoot $pkg
  if (-not (Test-Path $hostPkg)) {
    Write-Host "  skip $pkg (missing on host)"
    continue
  }
  if ($shadow.LinkType -eq 'Junction' -or $shadow.LinkType -eq 'SymbolicLink') {
    $current = @($shadow.Target)[0]
    if ($current -and ((Resolve-Path $current).Path -eq (Resolve-Path $hostPkg).Path)) {
      Write-Host "  already linked: $($shadow.FullName)"
      continue
    }
  }
  Write-Host "  link $($shadow.FullName) -> $hostPkg"
  Remove-Item -LiteralPath $shadow.FullName -Recurse -Force
  New-Item -ItemType Junction -Path $shadow.FullName -Target $hostPkg | Out-Null
}

Write-Host '== Done. Restart with start-trading-web.bat =='
