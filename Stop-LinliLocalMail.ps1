$ErrorActionPreference = "Stop"
$serviceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidPath = Join-Path $serviceRoot "data\service.pid.json"

try {
  $session = Invoke-RestMethod -Uri "http://127.0.0.1:27149/api/session" -TimeoutSec 2
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:27149/api/shutdown" -Headers @{ "X-Local-Mail-Session" = $session.data.token } -ContentType "application/json" -Body "{}" -TimeoutSec 2 | Out-Null
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 100
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:27149/health" -TimeoutSec 1 | Out-Null
    } catch {
      break
    }
  }
  if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
  Write-Host "Local mail service stopped."
  exit 0
} catch {
  if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Host "No launcher-managed local mail process was found."
    exit 0
  }
}

$record = Get-Content -Raw -LiteralPath $pidPath | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Remove-Item -LiteralPath $pidPath -Force
  Write-Host "The recorded process had already ended."
  exit 0
}

$recordedStart = [DateTimeOffset]::Parse([string]$record.startedAt).LocalDateTime
$difference = [Math]::Abs(($process.StartTime - $recordedStart).TotalSeconds)
if ($process.ProcessName -ne "node" -or $difference -gt 15) {
  throw "The recorded PID now belongs to another process; it was not terminated."
}

Stop-Process -Id $record.pid
Remove-Item -LiteralPath $pidPath -Force
Write-Host "Local mail service was force-stopped after the graceful endpoint was unavailable."
