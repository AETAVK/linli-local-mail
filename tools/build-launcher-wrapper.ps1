param(
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
$serviceRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $serviceRoot "native\launcher-wrapper.rs"
$outputPath = Join-Path $serviceRoot "native\linli-launcher-wrapper.exe"

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

$rustc = Get-Command rustc.exe -ErrorAction SilentlyContinue
if (-not $rustc) {
  throw "rustc.exe was not found. Only the maintainer machine needs Rust; end users do not."
}
if (-not (Test-Path $sourcePath)) {
  throw "Launcher wrapper source was not found: $sourcePath"
}
if ($Clean -and (Test-Path $outputPath)) {
  Remove-Item -LiteralPath $outputPath -Force
}

& $rustc.Source $sourcePath `
  --edition 2021 `
  --target x86_64-pc-windows-msvc `
  -C opt-level=z `
  -C lto=fat `
  -C codegen-units=1 `
  -C panic=abort `
  -C debuginfo=0 `
  -C strip=symbols `
  -C target-feature=+crt-static `
  -C link-arg=/Brepro `
  -o $outputPath
if ($LASTEXITCODE -ne 0) {
  throw "Launcher wrapper build failed; rustc exit code: $LASTEXITCODE"
}

$pdbPath = [System.IO.Path]::ChangeExtension($outputPath, ".pdb")
if (Test-Path -LiteralPath $pdbPath) {
  Remove-Item -LiteralPath $pdbPath -Force
}

$hash = Get-Sha256 $outputPath
$size = (Get-Item -LiteralPath $outputPath).Length
Write-Host "Launcher wrapper built: $outputPath"
Write-Host "SHA-256: $hash"
Write-Host "Size: $size bytes"
