param(
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
$serviceRoot = Split-Path -Parent $PSScriptRoot
$targets = @(
  @{
    Name = "Launcher wrapper"
    Source = Join-Path $serviceRoot "native\launcher-wrapper.rs"
    Output = Join-Path $serviceRoot "native\linli-launcher-wrapper.exe"
  },
  @{
    Name = "Windows helper"
    Source = Join-Path $serviceRoot "native\windows-helper.rs"
    Output = Join-Path $serviceRoot "native\linli-windows-helper.exe"
  }
)

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
foreach ($target in $targets) {
  $sourcePath = [string]$target.Source
  $outputPath = [string]$target.Output
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "$($target.Name) source was not found: $sourcePath"
  }
  if ($Clean -and (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
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
    throw "$($target.Name) build failed; rustc exit code: $LASTEXITCODE"
  }

  $pdbPath = [System.IO.Path]::ChangeExtension($outputPath, ".pdb")
  if (Test-Path -LiteralPath $pdbPath) {
    Remove-Item -LiteralPath $pdbPath -Force
  }

  $hash = Get-Sha256 $outputPath
  $size = (Get-Item -LiteralPath $outputPath).Length
  Write-Host "$($target.Name) built: $outputPath"
  Write-Host "SHA-256: $hash"
  Write-Host "Size: $size bytes"
}
