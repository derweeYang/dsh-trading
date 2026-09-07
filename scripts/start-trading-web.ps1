param(
  [int]$Port = 3081
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dsh = Join-Path $root '.local\node_modules\.bin\dsh.cmd'

if (-not (Test-Path $dsh)) {
  Write-Host "[error] Local DSH host not found: $dsh"
  Write-Host 'Install @deepseek-ai/dsh into .local first, then run this script again.'
  exit 1
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($row in $listeners) {
  Write-Host "Stopping PID $($row.OwningProcess) on port $Port"
  Stop-Process -Id $row.OwningProcess -Force -ErrorAction SilentlyContinue
}

Write-Host "Starting trading-web on port $Port. Keep this window open."
Write-Host "A page without ?token= is blank on purpose (host auth fence)."
Write-Host ''

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $dsh
$psi.Arguments = "--profile trading-web --port $Port --no-open"
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $false

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$state = [hashtable]::Synchronized(@{ opened = $false })

$onLine = {
  param($sender, $e)
  if ([string]::IsNullOrWhiteSpace($e.Data)) { return }
  [Console]::WriteLine($e.Data)
  if (-not $state.opened -and $e.Data -match 'https?://\S+') {
    $state.opened = $true
    Write-Host ''
    Write-Host ("Opening " + $Matches[0])
    Start-Process $Matches[0]
  }
}.GetNewClosure()

$proc.add_OutputDataReceived($onLine)
$proc.add_ErrorDataReceived($onLine)
[void]$proc.Start()
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()
$proc.WaitForExit()
exit $proc.ExitCode
