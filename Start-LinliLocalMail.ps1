param(
  [switch]$NoGame,
  [switch]$OpenSettings
)

$ErrorActionPreference = "Stop"
$serviceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$gameRoot = Split-Path -Parent $serviceRoot
$healthUrl = "http://127.0.0.1:27149/health"
$pidPath = Join-Path $serviceRoot "data\service.pid.json"
$logRoot = Join-Path $serviceRoot "logs"

function Test-LocalMailService {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

function Get-NodeExecutable {
  $bundledNode = Join-Path $serviceRoot "runtime\node.exe"
  if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    return (Resolve-Path -LiteralPath $bundledNode).Path
  }
  return (Get-Command node.exe -ErrorAction Stop).Source
}

if (-not (Test-LocalMailService)) {
  $nodePath = Get-NodeExecutable
  $processEnvironment = [Environment]::GetEnvironmentVariables("Process")
  $pathKeys = @($processEnvironment.Keys | Where-Object { [string]$_ -ieq "Path" })
  if ($pathKeys.Count -gt 1) {
    $pathValue = [string]$env:PATH
    foreach ($pathKey in $pathKeys) {
      [Environment]::SetEnvironmentVariable([string]$pathKey, $null, "Process")
    }
    [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $pidPath) -Force | Out-Null
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdoutPath = Join-Path $logRoot "service-$stamp.out.log"
  $stderrPath = Join-Path $logRoot "service-$stamp.err.log"
  $process = Start-Process -FilePath $nodePath -ArgumentList @("server.mjs") -WorkingDirectory $serviceRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  [pscustomobject]@{
    pid = $process.Id
    startedAt = (Get-Date).ToString("o")
    serverPath = (Join-Path $serviceRoot "server.mjs")
  } | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding utf8

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Milliseconds 200
    if (Test-LocalMailService) { $ready = $true; break }
    if ($process.HasExited) { break }
  }
  if (-not $ready) {
    throw "Local mail service failed to start. See $stderrPath"
  }
  Write-Host "Local mail service started."
} else {
  Write-Host "Local mail service is already running."
}

if ($OpenSettings) {
  Start-Process -FilePath "http://127.0.0.1:27149/settings"
}

if (-not $NoGame) {
  $launcherPath = Join-Path $gameRoot "launcher.exe"
  Start-Process -FilePath $launcherPath -WorkingDirectory $gameRoot
}
