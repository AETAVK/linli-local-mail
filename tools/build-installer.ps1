param(
  [string]$NodeVersion = "24.11.1",
  [string]$CertificateSubject = "CN=Linli Local Mail (Self-Signed)",
  [switch]$AllowDirty,
  [switch]$AllowUnpublishedSource,
  [switch]$KeepWork
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$serviceRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $serviceRoot "dist"
$version = (Get-Content -Raw -LiteralPath (Join-Path $serviceRoot "package.json") | ConvertFrom-Json).version
$installerName = "LinliLocalMail-$version-Setup.exe"
$installerPath = Join-Path $distRoot $installerName
$certificatePath = Join-Path $distRoot "LinliLocalMail-SelfSigned.cer"

function Get-Sha256([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($stream)
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
  return ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

function Find-OpenSsl {
  $fromPath = Get-Command openssl.exe -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }

  $candidates = @()
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($git) {
    $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
    $candidates += (Join-Path $gitRoot "mingw64\bin\openssl.exe")
    $candidates += (Join-Path $gitRoot "usr\bin\openssl.exe")
  }
  $candidates += @(
    "C:\Program Files\Git\mingw64\bin\openssl.exe",
    "C:\Program Files\Git\usr\bin\openssl.exe",
    "C:\Program Files (x86)\Git\mingw64\bin\openssl.exe",
    "C:\Program Files (x86)\Git\usr\bin\openssl.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  throw "未找到 openssl.exe。需要 Git for Windows，或把 OpenSSL 加入 PATH。"
}

function Find-OsslSignCode([string]$cachePath, [string]$extractRoot) {
  $fromPath = Get-Command osslsigncode.exe -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  if (-not (Test-Path -LiteralPath $cachePath -PathType Leaf)) {
    Invoke-Checked "node.exe" @(
      "tools/download-osslsigncode.mjs",
      "--cache-dir",
      (Split-Path -Parent $cachePath)
    )
  }
  New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
  Expand-Archive -LiteralPath $cachePath -DestinationPath $extractRoot -Force
  $candidate = Get-ChildItem -LiteralPath $extractRoot -Filter osslsigncode.exe -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $candidate) { throw "osslsigncode 压缩包中找不到 osslsigncode.exe" }
  return $candidate.FullName
}

function New-CodeSigningCertificate([string]$openssl, [string]$subject, [string]$temporaryRoot, [string]$pfxPath, [string]$certificatePath, [string]$password) {
  $keyPath = Join-Path $temporaryRoot "LinliLocalMail-signing.key.pem"
  $pemPath = Join-Path $temporaryRoot "LinliLocalMail-signing.cert.pem"
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $openssl req -x509 -newkey rsa:3072 -keyout $keyPath -out $pemPath -days 1095 -nodes -subj "/$subject" -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=codeSigning" 2> $null
    $requestExit = $LASTEXITCODE
    & $openssl x509 -in $pemPath -outform der -out $certificatePath 2> $null
    $certificateExit = $LASTEXITCODE
    & $openssl pkcs12 -export -out $pfxPath -inkey $keyPath -in $pemPath -passout "pass:$password" -name "Linli Local Mail" 2> $null
    $pfxExit = $LASTEXITCODE
    $fingerprint = (& $openssl x509 -in $pemPath -fingerprint -sha1 -noout 2> $null | Out-String).Trim()
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($requestExit -ne 0) { throw "OpenSSL 自签名证书生成失败（exit code $requestExit）" }
  if ($certificateExit -ne 0) { throw "OpenSSL 公钥证书导出失败（exit code $certificateExit）" }
  if ($pfxExit -ne 0) { throw "OpenSSL PFX 导出失败（exit code $pfxExit）" }
  $match = [regex]::Match($fingerprint, "([A-Fa-f0-9]{2}:){19}[A-Fa-f0-9]{2}")
  if (-not $match.Success) { throw "无法读取自签名证书指纹：$fingerprint" }
  return [pscustomobject]@{
    subject = $subject
    thumbprint = $match.Value.Replace(":", "").ToUpperInvariant()
    pemPath = $pemPath
    pfxPath = $pfxPath
    certificatePath = $certificatePath
  }
}

function Sign-File([string]$osslsigncode, [string]$path, [string]$pfxPath, [string]$password, [string]$temporaryRoot, [string]$certificatePemPath) {
  $signedPath = Join-Path $temporaryRoot ("signed-" + [Guid]::NewGuid().ToString("N") + ".exe")
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $osslsigncode sign -pkcs12 $pfxPath -pass $password -h sha256 -n "Linli Local Mail" -i "https://github.com/" -in $path -out $signedPath 2> $null
    $signExit = $LASTEXITCODE
    & $osslsigncode verify -CAfile $certificatePemPath -in $signedPath 2> $null
    $verifyExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($signExit -ne 0) { throw "签名失败：$path（osslsigncode exit code $signExit）" }
  if ($verifyExit -ne 0) { throw "签名验证失败：$path（osslsigncode exit code $verifyExit）" }
  Move-Item -LiteralPath $signedPath -Destination $path -Force
}

function Invoke-Checked([string]$file, [string[]]$arguments) {
  & $file @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$file 执行失败（exit code $LASTEXITCODE）"
  }
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("linli-installer-build-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
$buildSucceeded = $false

try {
  $releaseArguments = @("tools/release.mjs")
  if ($AllowDirty) { $releaseArguments += "--allow-dirty" }
  if ($AllowUnpublishedSource) { $releaseArguments += "--allow-unpublished-source" }
  Invoke-Checked "node.exe" $releaseArguments
  $releaseZip = Join-Path $distRoot "linli-local-mail-$version.zip"
  if (-not (Test-Path -LiteralPath $releaseZip)) {
    throw "运行时 ZIP 未生成：$releaseZip"
  }

  $nodeInfoText = & node.exe tools/download-node-runtime.mjs --version $NodeVersion --cache-dir (Join-Path $distRoot "node-cache") 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "Node.js 下载/校验失败：$nodeInfoText" }
  $nodeInfo = $nodeInfoText | ConvertFrom-Json

  $payloadRoot = Join-Path $temporaryRoot "payload"
  $servicePayloadRoot = Join-Path $payloadRoot "linli-local-mail"
  $nodeUnpackRoot = Join-Path $temporaryRoot "node-unpack"
  New-Item -ItemType Directory -Path $servicePayloadRoot,$nodeUnpackRoot -Force | Out-Null
  Expand-Archive -LiteralPath $releaseZip -DestinationPath $servicePayloadRoot -Force
  Expand-Archive -LiteralPath ([string]$nodeInfo.archivePath) -DestinationPath $nodeUnpackRoot -Force

  $nodeDirectory = Join-Path $nodeUnpackRoot "node-v$NodeVersion-win-x64"
  $nodeSource = Join-Path $nodeDirectory "node.exe"
  $nodeLicenseSource = Join-Path $nodeDirectory "LICENSE"
  if (-not (Test-Path -LiteralPath $nodeSource)) { throw "Node.js 压缩包中找不到 node.exe" }
  if (-not (Test-Path -LiteralPath $nodeLicenseSource)) { throw "Node.js 压缩包中找不到 LICENSE" }

  $runtimeRoot = Join-Path $servicePayloadRoot "runtime"
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $runtimeRoot "node.exe") -Force
  Copy-Item -LiteralPath $nodeLicenseSource -Destination (Join-Path $runtimeRoot "Node.js-LICENSE.txt") -Force
  $bundledNodeVersion = (& (Join-Path $runtimeRoot "node.exe") --version).Trim()
  if ($bundledNodeVersion -ne "v$NodeVersion") {
    throw "内置 Node.js 版本异常：$bundledNodeVersion"
  }

  $openssl = Find-OpenSsl
  $osslsigncodeCache = Join-Path $distRoot "tool-cache\osslsigncode-2.13-windows-x64-mingw.zip"
  $osslsigncode = Find-OsslSignCode $osslsigncodeCache (Join-Path $temporaryRoot "osslsigncode")
  $signingPfxPath = Join-Path $temporaryRoot "LinliLocalMail-signing.pfx"
  $signingPassword = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
  $certificate = New-CodeSigningCertificate $openssl $CertificateSubject $temporaryRoot $signingPfxPath $certificatePath $signingPassword
  $thumbprint = [string]$certificate.thumbprint
  $payloadWrapper = Join-Path $servicePayloadRoot "native\linli-launcher-wrapper.exe"
  Sign-File $osslsigncode $payloadWrapper $signingPfxPath $signingPassword $temporaryRoot $certificate.pemPath

  $payloadZip = Join-Path $temporaryRoot "payload.zip"
  Invoke-Checked "tar.exe" @("-a", "-cf", $payloadZip, "-C", $payloadRoot, ".")

  $rustc = Get-Command rustc.exe -ErrorAction SilentlyContinue
  if (-not $rustc) { throw "未找到 rustc.exe；只有维护者构建安装器时才需要 Rust。" }
  $installerSource = Join-Path $serviceRoot "native\installer.rs"
  if (-not (Test-Path -LiteralPath $installerSource)) { throw "安装器源码不存在：$installerSource" }

  $env:LINLI_INSTALLER_PAYLOAD = $payloadZip
  try {
    & $rustc.Source $installerSource `
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
      -o $installerPath
    if ($LASTEXITCODE -ne 0) { throw "安装器编译失败（rustc exit code $LASTEXITCODE）" }
  } finally {
    Remove-Item Env:LINLI_INSTALLER_PAYLOAD -ErrorAction SilentlyContinue
  }

  Sign-File $osslsigncode $installerPath $signingPfxPath $signingPassword $temporaryRoot $certificate.pemPath
  $installerSha256 = Get-Sha256 $installerPath
  Set-Content -LiteralPath "$installerPath.sha256" -Value "$installerSha256  $installerName" -Encoding ascii
  $manifest = [ordered]@{
    installer = $installerName
    installerSha256 = $installerSha256
    nodeVersion = $NodeVersion
    nodeArchiveSha256 = [string]$nodeInfo.sha256
    nodeArchiveSource = [string]$nodeInfo.sourceUrl
    signingSubject = [string]$certificate.subject
    signingThumbprint = [string]$thumbprint
    signedFiles = @($installerName, "linli-local-mail/native/linli-launcher-wrapper.exe")
    generatedAt = (Get-Date).ToString("o")
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$installerPath.json" -Encoding utf8
  $buildSucceeded = $true

  [pscustomobject]@{
    installer = $installerPath
    sha256 = $installerSha256
    size = (Get-Item -LiteralPath $installerPath).Length
    nodeVersion = $NodeVersion
    nodeArchiveSha256 = [string]$nodeInfo.sha256
    signingSubject = [string]$certificate.subject
    signingThumbprint = [string]$thumbprint
    certificate = $certificatePath
  } | ConvertTo-Json -Depth 4
} finally {
  if (-not $KeepWork -and (Test-Path -LiteralPath $temporaryRoot)) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
