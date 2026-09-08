# Junction this repo's @dshtrading packages into trading-web.
# Does not run `dsh plugin install` (that rematerializes @deepseek-ai shadows).
# Stops the process on -Port first. Restart with start-trading-web.bat afterwards.
#
# Why every workspace package, not just api:
#   Junctioning @dshtrading/cn (0.1.5) while leaving profile connectors at the
#   npm 0.1.4 dirs loads two dataplane copies. Fallback then pointed some names
#   at packages/cn/node_modules/@dshtrading/* (a third path). Loader apply ×2
#   → service "tradingXxxMarketData" has been registered at <Include> (issue #81 family).
#
# PowerShell 5.1 Remove-Item -Recurse on a junction can delete the TARGET tree.
# Reparse points are dropped with Directory.Delete (link only).

param(
  [int]$Port = 3081
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$profileRoot = Join-Path $env:USERPROFILE '.dsh\profiles\trading-web'
$packagesRoot = Join-Path $root 'packages'

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

function Set-Junction {
  param([string]$Dest, [string]$Src)
  $srcFull = (Resolve-Path -LiteralPath $Src).Path
  if (Test-Path -LiteralPath $Dest) {
    $item = Get-Item -LiteralPath $Dest -Force
    if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
      $current = @($item.Target)[0]
      if ($current) {
        $currentFull = (Resolve-Path -LiteralPath $current).Path
        if ($currentFull -eq $srcFull) { return 'already' }
      }
    }
    Remove-LinkOrDirectory $Dest
  }
  New-Item -ItemType Junction -Path $Dest -Target $srcFull | Out-Null
  return 'linked'
}

if (-not (Test-Path $profileRoot)) { throw "Profile not found: $profileRoot" }

# `all` 是 reserved meta bundle，进 profile 会被当成第五份市场补丁。
# connector-template 只给脚手架用，不进 trading-web。
$skip = @('all', 'connector-template')
$pkgs = @(Get-ChildItem -LiteralPath $packagesRoot -Directory |
  Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName 'package.json')) -and
    ($skip -notcontains $_.Name)
  } |
  ForEach-Object { $_.Name })
if ($pkgs.Count -eq 0) { throw "No workspace packages under $packagesRoot" }

function Test-IsMarketBundle([string]$Dir) {
  $pj = Join-Path $Dir 'package.json'
  if (-not (Test-Path -LiteralPath $pj)) { return $false }
  $raw = [System.IO.File]::ReadAllText($pj).TrimStart([char]0xFEFF)
  return [bool]($raw -match '"bundle"\s*:\s*\{')
}

$marketPkgs = @($pkgs | Where-Object { Test-IsMarketBundle (Join-Path $packagesRoot $_) })
$orderedMarkets = @()
foreach ($name in @('base', 'cn')) {
  if ($marketPkgs -contains $name) { $orderedMarkets += $name }
}
$orderedMarkets += @($marketPkgs | Where-Object { $_ -notin @('base', 'cn') } | Sort-Object)
if ($orderedMarkets.Count -eq 0) { throw "No dsh.bundle packages under $packagesRoot" }

Write-Host "== Stop trading-web on port $Port =="
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host "  stop PID $($_.OwningProcess)"
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 1

$mainRoot = Join-Path $profileRoot 'node_modules\@dshtrading'
$fallbackRoot = Join-Path $profileRoot '.dsh-module-fallback\node_modules\@dshtrading'

Write-Host "== Link workspace packages into $mainRoot =="
New-Item -ItemType Directory -Force -Path $mainRoot | Out-Null
foreach ($pkg in $pkgs) {
  $src = Join-Path $packagesRoot $pkg
  $dest = Join-Path $mainRoot $pkg
  $status = Set-Junction -Dest $dest -Src $src
  Write-Host "  $pkg ($status)"
}

Write-Host "== Drop stale @dshtrading junctions =="
Get-ChildItem -LiteralPath $mainRoot -Force -ErrorAction SilentlyContinue | ForEach-Object {
  if ($pkgs -contains $_.Name) { return }
  Write-Host ("  remove {0}" -f $_.Name)
  Remove-LinkOrDirectory $_.FullName
}

if (Test-Path (Split-Path -Parent $fallbackRoot)) {
  New-Item -ItemType Directory -Force -Path $fallbackRoot | Out-Null
  Write-Host "== Retarget fallback @dshtrading to the same copies =="
  foreach ($pkg in $pkgs) {
    $src = Join-Path $mainRoot $pkg
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dest = Join-Path $fallbackRoot $pkg
    $status = Set-Junction -Dest $dest -Src $src
    Write-Host "  $pkg ($status)"
  }
  Get-ChildItem -LiteralPath $fallbackRoot -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if ($pkgs -contains $_.Name) { return }
    Write-Host ("  remove fallback {0}" -f $_.Name)
    Remove-LinkOrDirectory $_.FullName
  }
}

$utf8 = New-Object System.Text.UTF8Encoding $false
$pkgJsonPath = Join-Path $profileRoot 'package.json'
$depLines = @($orderedMarkets | ForEach-Object {
  $file = ((Join-Path $packagesRoot $_) -replace '\\', '/')
  '    "@dshtrading/{0}": "file:{1}"' -f $_, $file
})
$bundleNames = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') + @($orderedMarkets | ForEach-Object { "@dshtrading/$_" })
$bundleLines = @($bundleNames | ForEach-Object { '        "{0}"' -f $_ })
$manifest = @(
  '{',
  '  "name": "dsh-profile-trading-web",',
  '  "private": true,',
  '  "dependencies": {',
  ($depLines -join ",`n"),
  '  },',
  '  "dsh": {',
  '    "profile": {',
  '      "bundles": [',
  ($bundleLines -join ",`n"),
  '      ],',
  '      "patchReload": "live"',
  '    }',
  '  }',
  '}'
) -join "`n"
[System.IO.File]::WriteAllText($pkgJsonPath, $manifest.TrimEnd() + "`n", $utf8)
Write-Host '== Profile bundles =='
$bundleNames | ForEach-Object { Write-Host "  $_" }

$wsPath = Join-Path $profileRoot 'pnpm-workspace.yaml'
$ws = if (Test-Path $wsPath) {
  [System.IO.File]::ReadAllText($wsPath).TrimStart([char]0xFEFF)
} else {
  "packages:`n  - .`n"
}
if ($ws -notmatch '(?m)^overrides:') {
  $ws = $ws.TrimEnd() + "`n`noverrides:`n"
}
foreach ($pkg in $pkgs) {
  $name = "@dshtrading/$pkg"
  $file = ('file:{0}' -f ((Join-Path $packagesRoot $pkg) -replace '\\', '/'))
  $line = "  '$name': '$file'"
  if ($ws -notmatch [regex]::Escape("'$name':")) {
    $ws = $ws.TrimEnd() + "`n$line`n"
  }
}
[System.IO.File]::WriteAllText($wsPath, $ws.TrimEnd() + "`n", $utf8)

Write-Host '== Done. Next: scripts\refresh-trading-web-profile.ps1 then start-trading-web.bat =='
