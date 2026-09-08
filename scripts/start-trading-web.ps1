param(
  [int]$Port = 3081,
  [switch]$SkipIquant,
  [int]$IquantPort = 5810
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dsh = Join-Path $root '.local\node_modules\.bin\dsh.cmd'
$optionsPort = 8090

function Test-Listening([int]$ListenPort) {
  [bool](Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue)
}

function Get-IquantPaths {
  $sdk = if ($env:IQUANT_SDK_ROOT) { $env:IQUANT_SDK_ROOT } else { 'D:\workspace\myquant\iquant_market_clean_fresh' }
  $vendor = if ($env:IQUANT_VENDOR_ROOT) { $env:IQUANT_VENDOR_ROOT } else { 'D:\workspace\myquant\installed\国信iQuant策略交易平台' }
  $apiDll = if ($env:IQUANT_API_DLL) { $env:IQUANT_API_DLL } else { Join-Path $sdk 'build\native\Release\iquant_quote.dll' }
  $qmtquote = if ($env:IQUANT_QMTQUOTE_DLL) { $env:IQUANT_QMTQUOTE_DLL } else { Join-Path $vendor 'bin.x64\qmtquote.dll' }
  $config = if ($env:IQUANT_QUOTE_CONFIG) { $env:IQUANT_QUOTE_CONFIG } else { Join-Path $vendor 'config\xtquoterconfig.xml' }
  return [pscustomobject]@{
    Sdk = $sdk
    ApiDll = $apiDll
    Qmtquote = $qmtquote
    Config = $config
  }
}

function Write-PathCheck([string]$Name, [string]$Path) {
  $mark = if (Test-Path $Path) { 'OK     ' } else { 'MISSING' }
  Write-Host ('  {0,-10} {1}  {2}' -f $Name, $mark, $Path)
}

function Write-Preflight {
  $iquant = Get-IquantPaths
  $hostOk = Test-Path $dsh
  $webListen = Test-Listening $Port
  $quoteListen = Test-Listening $IquantPort
  $optionsListen = Test-Listening $optionsPort
  $quoteHealth = 'n/a'
  if ($quoteListen) {
    try {
      $res = Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/health' -f $IquantPort) -UseBasicParsing -TimeoutSec 2
      $quoteHealth = [string]$res.StatusCode
    } catch {
      $quoteHealth = 'no-health'
    }
  }

  $hostMark = 'MISSING'
  if ($hostOk) { $hostMark = 'OK' }
  $webMark = 'no'
  if ($webListen) { $webMark = 'yes (will stop)' }
  $quoteLine = 'iQuant   :{0}  will-open-window  /health=starting' -f $IquantPort
  if ($SkipIquant) {
    $quoteLine = 'iQuant   :{0}  skip  listen={1}  /health={2}' -f $IquantPort, $quoteListen, $quoteHealth
  } elseif ($quoteListen) {
    $quoteLine = 'iQuant   :{0}  already-up  /health={1}' -f $IquantPort, $quoteHealth
  }
  $optMark = 'no'
  if ($optionsListen) { $optMark = 'yes' }

  Write-Host '======== trading-web check ========'
  Write-Host ('repo     {0}' -f $root)
  Write-Host ('host     {0}  {1}' -f $hostMark, $dsh)
  Write-Host 'profile  trading-web'
  Write-Host ('web      127.0.0.1:{0}  listen={1}' -f $Port, $webMark)
  Write-Host ('page     need ?token=  bare http://127.0.0.1:{0}/ is blank' -f $Port)
  Write-Host $quoteLine
  Write-PathCheck 'SDK' $iquant.Sdk
  Write-PathCheck 'API.dll' $iquant.ApiDll
  Write-PathCheck 'qmtquote' $iquant.Qmtquote
  Write-PathCheck 'config' $iquant.Config
  Write-Host ('options  :{0}  listen={1}  (T-board/IV only, not started here)' -f $optionsPort, $optMark)
  Write-Host 'Keep both windows open. Quotes in the extra window, host in this one.'
  Write-Host '==================================='
  Write-Host ''
}

function Get-ProfileManifestPath {
  Join-Path $env:USERPROFILE '.dsh\profiles\trading-web\package.json'
}

function Get-MissingProfileBundles {
  $pj = Get-ProfileManifestPath
  if (-not (Test-Path -LiteralPath $pj)) { return @('profile-package.json') }
  $raw = [System.IO.File]::ReadAllText($pj).TrimStart([char]0xFEFF)
  $names = [regex]::Matches($raw, '"(@dshtrading/[^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
  $missing = @()
  foreach ($name in $names) {
    $short = $name.Substring('@dshtrading/'.Length)
    $pkgJson = Join-Path $env:USERPROFILE ('.dsh\profiles\trading-web\node_modules\@dshtrading\{0}\package.json' -f $short)
    if (-not (Test-Path -LiteralPath $pkgJson)) { $missing += $name }
  }
  return @($missing)
}

function Write-ProfileBundleCheck {
  $missing = @(Get-MissingProfileBundles)
  if ($missing.Count -eq 0) {
    Write-Host 'profile  bundles OK'
    return $false
  }
  Write-Host ('profile  MISSING {0}' -f ($missing -join ', '))
  return $true
}

function Test-StaleFallbackLinks {
  $packagesRoot = Join-Path $root 'packages'
  $fallbackRoot = Join-Path $env:USERPROFILE '.dsh\profiles\trading-web\.dsh-module-fallback\node_modules\@dshtrading'
  if (-not (Test-Path -LiteralPath $fallbackRoot)) { return $false }
  foreach ($item in @(Get-ChildItem -LiteralPath $fallbackRoot -Force -ErrorAction SilentlyContinue)) {
    if (-not $item.PSIsContainer) { continue }
    $expected = Join-Path $packagesRoot $item.Name
    if (-not (Test-Path -LiteralPath $expected)) { return $true }
    $target = @($item.Target)[0]
    if (-not $target) { return $true }
    $targetFull = $null
    try { $targetFull = (Resolve-Path -LiteralPath $target).Path } catch { return $true }
    $expectedFull = (Resolve-Path -LiteralPath $expected).Path
    if ($targetFull -ne $expectedFull) { return $true }
  }
  return $false
}

Write-Preflight
$needRepair = Write-ProfileBundleCheck
$staleFallback = Test-StaleFallbackLinks
if ($staleFallback) {
  Write-Host 'profile  fallback junctions stale (nested copies, not workspace packages)'
}
if ($needRepair -or $staleFallback) {
  Write-Host 'Repairing trading-web profile: drop deleted market bundles, relink this repo.'
  & (Join-Path $PSScriptRoot 'link-trading-web-workspace.ps1') -Port $Port
  $still = @(Get-MissingProfileBundles)
  if ($still.Count -gt 0) {
    Write-Host ('[error] Profile still missing: {0}' -f ($still -join ', '))
    Write-Host 'Run scripts\link-trading-web-workspace.ps1 then try again.'
    exit 1
  }
  Write-Host 'profile  bundles repaired'
  Write-Host ''
}

function Repair-StaleClientUiTrading {
  $bridgeJs = Join-Path $root 'packages\client-ui-trading\lib\bridge.js'
  if (-not (Test-Path -LiteralPath $bridgeJs)) { return }
  $text = [System.IO.File]::ReadAllText($bridgeJs)
  if ($text -notmatch 'kit-hk|kit-us|kit-crypto') { return }
  Write-Host 'client-ui-trading lib is stale (imports deleted kits). Rebuilding...'
  Push-Location $root
  try {
    & pnpm --filter @dshtrading/client-ui-trading build
    if ($LASTEXITCODE -ne 0) { throw 'pnpm build client-ui-trading failed' }
  } finally {
    Pop-Location
  }
  $text = [System.IO.File]::ReadAllText($bridgeJs)
  if ($text -match 'kit-hk|kit-us|kit-crypto') {
    throw 'client-ui-trading/lib/bridge.js still imports deleted kits after rebuild'
  }
  Write-Host 'client-ui-trading rebuild OK'
}

Repair-StaleClientUiTrading

if (-not (Test-Path $dsh)) {
  Write-Host ('[error] Local DSH host not found: {0}' -f $dsh)
  Write-Host 'Install @deepseek-ai/dsh into .local first, then run this script again.'
  exit 1
}

if (-not $SkipIquant -and -not (Test-Listening $IquantPort)) {
  $quoteBat = Join-Path $root 'start-iquant-quote.bat'
  if (Test-Path $quoteBat) {
    Start-Process -FilePath $quoteBat -ArgumentList ([string]$IquantPort) -WorkingDirectory $root
  } else {
    Write-Host ('[warn] {0} is missing. CN quotes will return TRADING_NETWORK.' -f $quoteBat)
  }
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($row in $listeners) {
  Write-Host ('Stopping PID {0} on port {1}' -f $row.OwningProcess, $Port)
  Stop-Process -Id $row.OwningProcess -Force -ErrorAction SilentlyContinue
}

function Get-HostCommand {
  $binJs = Join-Path $root '.local\node_modules\@deepseek-ai\dsh\lib\bin.js'
  $nodeCandidates = @(
    (Join-Path $root '.local\node_modules\.bin\node.exe'),
    (Join-Path $root '.local\node.exe')
  )
  $pathNode = Get-Command node -ErrorAction SilentlyContinue
  if ($pathNode) { $nodeCandidates += $pathNode.Source }
  foreach ($node in $nodeCandidates) {
    if ($node -and (Test-Path $node) -and (Test-Path $binJs)) {
      return @{ File = $node; Args = @($binJs, '--profile', 'trading-web', '--port', [string]$Port, '--no-open') }
    }
  }
  return @{ File = $dsh; Args = @('--profile', 'trading-web', '--port', [string]$Port, '--no-open') }
}

function Get-LineText($Item) {
  if ($null -eq $Item) { return '' }
  if ($Item -is [System.Management.Automation.ErrorRecord]) {
    if ($Item.Exception -and $Item.Exception.Message) { return [string]$Item.Exception.Message }
    return [string]$Item
  }
  return [string]$Item
}

function Get-TokenUrl([string]$Line) {
  $clean = $Line -replace '\x1b\[[0-9;]*m', ''
  if ($clean -match 'dsh web:\s+(https?://\S+)') {
    return $Matches[1].TrimEnd('.,);]')
  }
  if ($clean -match '(https?://\S+\?token=\S+)') {
    return $Matches[1].TrimEnd('.,);]')
  }
  return $null
}

function Show-TokenUrl([string]$Url) {
  $urlFile = Join-Path $root '.local\last-trading-web-url.txt'
  $dir = Split-Path $urlFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  Set-Content -Path $urlFile -Value $Url -Encoding ASCII
  try { Set-Clipboard -Value $Url } catch { }

  Write-Host ''
  Write-Host '======== token URL ========'
  Write-Host $Url
  Write-Host '==========================='
  Write-Host ('also saved: {0}' -f $urlFile)
  Write-Host 'Copy this URL. Bare http://127.0.0.1 without ?token= is blank.'
  Write-Host ''
  Start-Process $Url
}

Write-Host ('Starting trading-web on port {0}. Keep this window open.' -f $Port)
Write-Host 'A page without ?token= is blank on purpose (host auth fence).'
Write-Host ''

$hostCmd = Get-HostCommand
$tokenUrl = $null
$oldEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $hostCmd.File @($hostCmd.Args) 2>&1 | ForEach-Object {
    $line = Get-LineText $_
    if ($line.Length -gt 0) { [Console]::WriteLine($line) }
    if (-not $tokenUrl) {
      $found = Get-TokenUrl $line
      if ($found) {
        $tokenUrl = $found
        Show-TokenUrl $tokenUrl
      }
    }
  }
} finally {
  $ErrorActionPreference = $oldEap
}

if (-not $tokenUrl) {
  Write-Host ''
  Write-Host '[warn] Did not see a dsh web: ?token= URL in host output.'
  Write-Host 'If the host is up, look for a line starting with "dsh web:".'
}

exit $LASTEXITCODE
