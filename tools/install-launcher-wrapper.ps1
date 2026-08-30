param()

$ErrorActionPreference = "Stop"
$serviceRoot = Split-Path -Parent $PSScriptRoot
$gameRoot = Split-Path -Parent $serviceRoot
$launcherPath = Join-Path $gameRoot "launcher.exe"
$originalPath = Join-Path $gameRoot "launcher.original.exe"
$wrapperPath = Join-Path $serviceRoot "native\linli-launcher-wrapper.exe"
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

function Stop-IfRunning {
  $running = Get-Process -Name "launcher","launcher.original" -ErrorAction SilentlyContinue
  if ($running) {
    $names = ($running | Select-Object -ExpandProperty ProcessName -Unique) -join ", "
    throw "A launcher process is still running ($names). Exit the game and launcher before installing the wrapper."
  }
}

function Assert-FilePath([string]$path, [string]$description) {
  if ((Test-Path -LiteralPath $path) -and -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "$description is not a regular file: $path"
  }
}

function Get-OriginalSignatureStatus([string]$path) {
  $signatureCommand = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue
  if (-not $signatureCommand) { return "Unavailable" }
  try {
    return [string](Get-AuthenticodeSignature -LiteralPath $path).Status
  } catch {
    return "Unavailable"
  }
}

Assert-FilePath $launcherPath "Game launcher"
Assert-FilePath $originalPath "Official launcher backup"
Assert-FilePath $manifestPath "Launcher wrapper manifest"

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
  throw "Game launcher was not found: $launcherPath"
}
if (-not (Test-Path -LiteralPath $wrapperPath -PathType Leaf)) {
  # install.ps1 会在调用本脚本前先检查同一个文件并给出完整指引，正常不会走到这里；
  # 保留兜底报错，但把矛头指向真正的原因：源码归档不含编译产物。
  throw "Built launcher wrapper was not found: $wrapperPath. You are probably running from a source-code archive; download LinliLocalMail-Setup.exe from the Release page instead (it bundles the built wrapper)."
}

$wrapperHash = Get-Sha256 $wrapperPath
$currentHash = Get-Sha256 $launcherPath
$manifest = $null
if (Test-Path -LiteralPath $manifestPath) {
  try { $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json } catch { $manifest = $null }
}

$isAlreadyInstalled = $currentHash -eq $wrapperHash
$isRegisteredWrapper = $manifest -and $manifest.active -eq "wrapper" -and $manifest.wrapperSha256 -and $currentHash -eq [string]$manifest.wrapperSha256
if (-not (Test-Path -LiteralPath $originalPath -PathType Leaf)) {
  if ($isAlreadyInstalled) {
    throw "launcher.exe is already the wrapper, but launcher.original.exe is missing. Refusing to continue to protect the official launcher."
  }
  Stop-IfRunning
  Copy-Item -LiteralPath $launcherPath -Destination $originalPath
  if ((Get-Sha256 $originalPath) -ne $currentHash) {
    throw "The official launcher backup failed verification; the wrapper was not installed."
  }
  $manifest = [pscustomobject]@{
    schema = 1
    product = "linli-local-mail"
    originalFile = "launcher.original.exe"
    originalSha256 = $currentHash
    originalSignatureStatus = Get-OriginalSignatureStatus $originalPath
    wrapperFile = "launcher.exe"
    wrapperSha256 = $wrapperHash
    installedAt = (Get-Date).ToString("o")
    active = "official"
  }
  $manifestJson = ($manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine
  [System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Official launcher preserved at: $originalPath"
} else {
  $originalHash = Get-Sha256 $originalPath
  if ($manifest -and $manifest.originalSha256 -and $originalHash -ne [string]$manifest.originalSha256) {
    throw "launcher.original.exe does not match the hash recorded in launcher-wrapper.json; refusing to overwrite."
  }
  if (-not $manifest) {
    $manifest = [pscustomobject]@{
      schema = 1
      product = "linli-local-mail"
      originalFile = "launcher.original.exe"
      originalSha256 = $originalHash
      originalSignatureStatus = Get-OriginalSignatureStatus $originalPath
      wrapperFile = "launcher.exe"
      wrapperSha256 = $wrapperHash
      installedAt = (Get-Date).ToString("o")
      active = $(if ($isAlreadyInstalled) { "wrapper" } else { "official" })
    }
  }
}

if ($isAlreadyInstalled) {
  Write-Host "Launcher wrapper is already installed; no overwrite needed."
  exit 0
}

if ($currentHash -ne (Get-Sha256 $originalPath) -and -not $isRegisteredWrapper) {
  throw "Current launcher.exe is neither the registered official launcher nor this wrapper; refusing to overwrite. Confirm the version or use the restore script first."
}

Stop-IfRunning
$temporaryPath = Join-Path $gameRoot ("launcher.exe.linli-temp-" + $PID + ".tmp")
try {
  Copy-Item -LiteralPath $wrapperPath -Destination $temporaryPath
  if ((Get-Sha256 $temporaryPath) -ne $wrapperHash) {
    throw "The temporary wrapper copy failed verification."
  }
  Move-Item -LiteralPath $temporaryPath -Destination $launcherPath -Force
} finally {
  if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
}

$manifest.active = "wrapper"
$manifest.wrapperSha256 = $wrapperHash
$manifest.installedAt = (Get-Date).ToString("o")
$manifestJson = ($manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
Write-Host "Launcher wrapper installed: $launcherPath"
Write-Host "Running launcher.exe directly will now check and start the local service first."
