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
  $candidate = Join-Path $PSScriptRoot '..\.local\node_modules\@deepseek-ai'
  if (-not (Test-Path -LiteralPath $candidate)) {
    throw "Host package root not found: $candidate. Install @deepseek-ai/dsh@0.1.2-rc.1 into repo .local first."
  }
  $HostRoot = (Resolve-Path -LiteralPath $candidate).Path
}

$corePkgs = @(
  'dsh-web-app', 'dsh-tools', 'cosmokit', 'schemastery', 'dsh-agent-presets',
  'dsh-brand', 'dsh-util-values', 'dsh-settings', 'dsh-skill', 'dsh-tool-cordis',
  'dsh-llm', 'dsh-scope', 'dsh-timeout', 'dsh-typert-protocol', 'dsh-util-crypto',
  'cordis', 'cordis-plugin-group', 'cordis-plugin-include', 'cordis-plugin-loader',
  'cordis-plugin-timer'
)

function Remove-LinkOrDirectory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  $reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if ($reparse) {
    [System.IO.Directory]::Delete($item.FullName)
    return
  }
  Remove-Item -LiteralPath $Path -Recurse -Force
}

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
# profile 顶层 + 本仓库 packages/*/node_modules/@deepseek-ai（不扫 .pnpm）。
# Get-ChildItem -Recurse 不跟 junction，workspace 包必须另扫，否则 cordis 仍指向仓库 store。

function Link-HostPackage {
  param($Shadow, $HostRoot, $Names)
  if ($null -eq $Shadow) { return }
  $pkg = $Shadow.Name
  if ($Names -notcontains $pkg) { return }
  $hostPkg = Join-Path $HostRoot $pkg
  if (-not (Test-Path $hostPkg)) {
    Write-Host "  skip $pkg (missing on host)"
    return
  }
  if ($Shadow.LinkType -eq 'Junction' -or $Shadow.LinkType -eq 'SymbolicLink') {
    $current = @($Shadow.Target)[0]
    if ($current) {
      $curFull = (Resolve-Path -LiteralPath $current).Path
      $hostFull = (Resolve-Path -LiteralPath $hostPkg).Path
      if ($curFull -eq $hostFull) {
        Write-Host "  already linked: $($Shadow.FullName)"
        return
      }
    }
  }
  Write-Host "  link $($Shadow.FullName) -> $hostPkg"
  Remove-LinkOrDirectory $Shadow.FullName
  New-Item -ItemType Junction -Path $Shadow.FullName -Target $hostPkg | Out-Null
}

$profileAi = Join-Path $profileRoot 'node_modules\@deepseek-ai'
if (Test-Path -LiteralPath $profileAi) {
  foreach ($shadow in @(Get-ChildItem -LiteralPath $profileAi -Directory -ErrorAction SilentlyContinue)) {
    Link-HostPackage $shadow $HostRoot $corePkgs
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$repoAi = Join-Path $repoRoot 'node_modules\@deepseek-ai'
if (Test-Path -LiteralPath $repoAi) {
  foreach ($shadow in @(Get-ChildItem -LiteralPath $repoAi -Directory -ErrorAction SilentlyContinue)) {
    Link-HostPackage $shadow $HostRoot $corePkgs
  }
}

$packagesRoot = Join-Path $repoRoot 'packages'
if (Test-Path -LiteralPath $packagesRoot) {
  foreach ($pkgDir in @(Get-ChildItem -LiteralPath $packagesRoot -Directory -ErrorAction SilentlyContinue)) {
    foreach ($rel in @('node_modules\@deepseek-ai', 'lib\node_modules\@deepseek-ai')) {
      $ai = Join-Path $pkgDir.FullName $rel
      if (-not (Test-Path -LiteralPath $ai)) { continue }
      foreach ($shadow in @(Get-ChildItem -LiteralPath $ai -Force -ErrorAction SilentlyContinue)) {
        if (-not $shadow.PSIsContainer) { continue }
        Link-HostPackage $shadow $HostRoot $corePkgs
      }
    }
  }
}

Write-Host '== Done. Restart with start-trading-web.bat =='
