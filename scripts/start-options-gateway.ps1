param(
  [int]$Port = 8090
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'python\options'
$src = Join-Path $dir 'src'

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
$env:PYTHONPATH = $src
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

# Prefer PYTHONPATH + already-installed runtime deps. Blind `pip install -e .` on
# Python 3.14 tries to satisfy pyproject pins (e.g. older pyarrow) via source/cmake
# and can fail even when the gateway would run fine.
function Test-OptionsImports {
  # volsurface 必须在列：缺了它 SVI 只能降级（vol_analytics 的 svi 行 insufficient），
  # 其余命令正常，网关会“看起来健康”——2026-09-09 session 已踩过这个假阳性。
  & python -c "import dsh_options, numpy, pandas, pyarrow, volsurface" 2>$null
  return ($LASTEXITCODE -eq 0)
}

if (-not (Test-OptionsImports)) {
  Write-Host 'uv not found; installing missing runtime deps (no forced pyarrow downgrade).'
  & python -m pip install -e . --no-deps -q
  & python -m pip install "numpy>=2,<3" "pandas>=2.2,<3" "pyarrow>=18" "akshare>=1.16" "volsurface>=0.2.0" "matplotlib>=3.10.9" -q
  if (-not (Test-OptionsImports)) {
    Write-Host '[error] dsh_options imports still fail after pip. Install uv, or fix Python deps, then retry.'
    exit 1
  }
} else {
  Write-Host 'Runtime imports OK; skipping pip (avoids pyarrow/cmake rebuild on Python 3.14).'
}

& python -m dsh_options.gateway
