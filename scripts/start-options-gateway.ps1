param(
  [int]$Port = 8090
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'python\options'

if (-not (Test-Path (Join-Path $dir 'pyproject.toml'))) {
  Write-Host "[error] python/options is missing: $dir"
  exit 1
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($row in $listeners) {
  Write-Host "Stopping PID $($row.OwningProcess) on port $Port"
  Stop-Process -Id $row.OwningProcess -Force -ErrorAction SilentlyContinue
}

$env:DSH_OPTIONS_GATEWAY_PORT = [string]$Port
Set-Location $dir
Write-Host "Starting dsh-options gateway on 127.0.0.1:$Port. Keep this window open."

$uv = Get-Command uv -ErrorAction SilentlyContinue
if ($null -ne $uv) {
  & uv sync
  & uv run python -m dsh_options.gateway
  exit $LASTEXITCODE
}

$py = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $py) {
  Write-Host '[error] Need uv or python on PATH.'
  exit 1
}

Write-Host 'uv not found; using python -m pip (akshare/numpy/pandas/pyarrow).'
& python -m pip install -e . -q
$env:PYTHONPATH = (Join-Path $dir 'src')
& python -m dsh_options.gateway
