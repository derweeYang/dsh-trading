param(
  [int]$Port = 5810
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'python\iquant-quote'

if (-not (Test-Path (Join-Path $dir 'pyproject.toml'))) {
  Write-Host ('[error] python/iquant-quote is missing: {0}' -f $dir)
  exit 1
}

if (-not $env:IQUANT_SDK_ROOT) {
  $env:IQUANT_SDK_ROOT = 'D:\workspace\myquant\iquant_market_clean_fresh'
}
if (-not $env:IQUANT_VENDOR_ROOT) {
  $env:IQUANT_VENDOR_ROOT = 'D:\workspace\myquant\installed\国信iQuant策略交易平台'
}

$apiDll = if ($env:IQUANT_API_DLL) { $env:IQUANT_API_DLL } else {
  Join-Path $env:IQUANT_SDK_ROOT 'build\native\Release\iquant_quote.dll'
}
$qmtquote = if ($env:IQUANT_QMTQUOTE_DLL) { $env:IQUANT_QMTQUOTE_DLL } else {
  Join-Path $env:IQUANT_VENDOR_ROOT 'bin.x64\qmtquote.dll'
}
$config = if ($env:IQUANT_QUOTE_CONFIG) { $env:IQUANT_QUOTE_CONFIG } else {
  Join-Path $env:IQUANT_VENDOR_ROOT 'config\xtquoterconfig.xml'
}

foreach ($path in @($apiDll, $qmtquote, $config)) {
  if (-not (Test-Path $path)) {
    Write-Host ('[error] iQuant path missing: {0}' -f $path)
    Write-Host 'Set IQUANT_SDK_ROOT / IQUANT_VENDOR_ROOT or the explicit DLL env vars.'
    exit 1
  }
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($row in $listeners) {
  Write-Host ('Stopping PID {0} on port {1}' -f $row.OwningProcess, $Port)
  Stop-Process -Id $row.OwningProcess -Force -ErrorAction SilentlyContinue
}

$env:IQUANT_QUOTE_GATEWAY_PORT = [string]$Port
$env:IQUANT_API_DLL = $apiDll
$env:IQUANT_QMTQUOTE_DLL = $qmtquote
$env:IQUANT_QUOTE_CONFIG = $config

Set-Location $dir
Write-Host '======== iQuant quote check ========'
Write-Host ('gateway  127.0.0.1:{0}' -f $Port)
Write-Host ('SDK      {0}' -f $env:IQUANT_SDK_ROOT)
Write-Host ('API.dll  {0}' -f $apiDll)
Write-Host ('qmtquote {0}' -f $qmtquote)
Write-Host ('config   {0}' -f $config)
Write-Host 'spot SH/SZ ; option contracts SHO/SZO (do not subscribe options on SH)'
Write-Host 'login cwd=bin.x64 . Keep this window open.'
Write-Host '===================================='
Write-Host ''

$uv = Get-Command uv -ErrorAction SilentlyContinue
if ($null -ne $uv) {
  & uv sync
  & uv run python -m dsh_iquant_quote.gateway
  exit $LASTEXITCODE
}

$py = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $py) {
  Write-Host '[error] Need uv or python on PATH.'
  exit 1
}

$env:PYTHONPATH = (Join-Path $dir 'src')
& python -m dsh_iquant_quote.gateway
