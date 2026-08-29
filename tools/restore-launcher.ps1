param()

$ErrorActionPreference = "Stop"
$serviceRoot = Split-Path -Parent $PSScriptRoot
$gameRoot = Split-Path -Parent $serviceRoot
$launcherPath = Join-Path $gameRoot "launcher.exe"
$originalPath = Join-Path $gameRoot "launcher.original.exe"
$manifestPath = Join-Path $gameRoot "launcher-wrapper.json"

function Get-Sha256([string]$path) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($path)
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream)) -replace "-", "").ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $originalPath -PathType Leaf)) {
  throw "Official launcher backup was not found: $originalPath"
}
$manifest = $null
if (Test-Path -LiteralPath $manifestPath) {
  try { $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json } catch { $manifest = $null }
}
$originalHash = Get-Sha256 $originalPath
if ($manifest -and $manifest.originalSha256 -and $originalHash -ne [string]$manifest.originalSha256) {
  throw "The official launcher backup hash does not match its manifest; refusing to restore."
}

$running = Get-Process -Name "launcher","launcher.original" -ErrorAction SilentlyContinue
if ($running) {
  $names = ($running | Select-Object -ExpandProperty ProcessName -Unique) -join ", "
  throw "A launcher process is still running ($names). Exit the game and launcher before restoring the official launcher."
}

$temporaryPath = Join-Path $gameRoot ("launcher.exe.restore-" + $PID + ".tmp")
try {
  Copy-Item -LiteralPath $originalPath -Destination $temporaryPath
  if ((Get-Sha256 $temporaryPath) -ne $originalHash) { throw "The temporary official launcher copy failed verification." }
  Move-Item -LiteralPath $temporaryPath -Destination $launcherPath -Force
} finally {
  if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
}

if (-not $manifest) {
  $manifest = [pscustomobject]@{
    schema = 1
    product = "linli-local-mail"
    originalFile = "launcher.original.exe"
    originalSha256 = $originalHash
    wrapperFile = "launcher.exe"
    active = "official"
  }
} else {
  $manifest | Add-Member -NotePropertyName active -NotePropertyValue "official" -Force
  $manifest | Add-Member -NotePropertyName restoredAt -NotePropertyValue (Get-Date).ToString("o") -Force
}
$manifestJson = ($manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
Write-Host "Official launcher restored: $launcherPath"
Write-Host "The wrapper binary remains at: $serviceRoot\native\linli-launcher-wrapper.exe"
