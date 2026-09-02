param(
  [string]$NodeVersion = "24.11.1",
  [string]$InnoVersion = "7.1.0",
  [string]$IsccPath = "",
  [string]$CertificateSubject = "CN=Linli Local Mail (Self-Signed)",
  [string]$SigningPfxPath = $env:LINLI_SIGNING_PFX_PATH,
  [string]$SigningPassword = $env:LINLI_SIGNING_PFX_PASSWORD,
  [switch]$AllowDirty,
  [switch]$AllowUnpublishedSource,
  [switch]$KeepWork
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$serviceRoot = Split-Path -Parent $PSScriptRoot
& node.exe (Join-Path $PSScriptRoot "repo-guard.mjs") "--allow-role" "private-canonical" "--allow-role" "public-projection"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$distRoot = Join-Path $serviceRoot "dist"
$version = (Get-Content -Raw -LiteralPath (Join-Path $serviceRoot "package.json") | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "package.json 版本必须符合 major.minor.patch：$version" }
$installerName = "LinliLocalMail-$version-Setup.exe"
$installerPath = Join-Path $distRoot $installerName
$certificatePath = Join-Path $distRoot "LinliLocalMail-SelfSigned.cer"
$innoCacheRoot = Join-Path $distRoot "tool-cache\inno-$InnoVersion"

function Get-Sha256([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $hash = $algorithm.ComputeHash($stream) }
  finally { $algorithm.Dispose(); $stream.Dispose() }
  return ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

function Invoke-Checked([string]$file, [string[]]$arguments) {
  & $file @arguments
  if ($LASTEXITCODE -ne 0) { throw "$file 执行失败（exit code $LASTEXITCODE）" }
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
    # Keep downloader stdout out of this function's return stream. Otherwise a
    # cold-cache build assigns both the JSON progress output and the executable
    # path to $osslsigncode, producing an invalid child-process environment value.
    Invoke-Checked "node.exe" @("tools/download-osslsigncode.mjs", "--cache-dir", (Split-Path -Parent $cachePath)) | Out-Null
  }
  New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
  Expand-Archive -LiteralPath $cachePath -DestinationPath $extractRoot -Force
  $candidate = Get-ChildItem -LiteralPath $extractRoot -Filter osslsigncode.exe -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $candidate) { throw "osslsigncode 压缩包中找不到 osslsigncode.exe" }
  return $candidate.FullName
}

function New-CodeSigningCertificate(
  [string]$openssl,
  [string]$subject,
  [string]$temporaryRoot,
  [string]$pfxPath,
  [string]$certificateDerPath,
  [string]$password
) {
  $keyPath = Join-Path $temporaryRoot "LinliLocalMail-signing.key.pem"
  $pemPath = Join-Path $temporaryRoot "LinliLocalMail-signing.cert.pem"
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $openssl req -x509 -newkey rsa:3072 -keyout $keyPath -out $pemPath -days 1095 -nodes -subj "/$subject" `
      -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=codeSigning" 2>$null
    $requestExit = $LASTEXITCODE
    & $openssl x509 -in $pemPath -outform der -out $certificateDerPath 2>$null
    $certificateExit = $LASTEXITCODE
    & $openssl pkcs12 -export -out $pfxPath -inkey $keyPath -in $pemPath -passout "pass:$password" -name "Linli Local Mail" 2>$null
    $pfxExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($requestExit -ne 0) { throw "OpenSSL 自签名证书生成失败" }
  if ($certificateExit -ne 0) { throw "OpenSSL 公钥证书导出失败" }
  if ($pfxExit -ne 0) { throw "OpenSSL PFX 导出失败" }
  return [pscustomobject]@{ subject = $subject; pfxPath = $pfxPath; pemPath = $pemPath; certificatePath = $certificateDerPath }
}

function Import-CodeSigningCertificate(
  [string]$openssl,
  [string]$sourcePfx,
  [string]$password,
  [string]$temporaryRoot,
  [string]$certificateDerPath
) {
  if (-not (Test-Path -LiteralPath $sourcePfx -PathType Leaf)) { throw "签名 PFX 不存在：$sourcePfx" }
  $pemPath = Join-Path $temporaryRoot "LinliLocalMail-signing.cert.pem"
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $openssl pkcs12 -in $sourcePfx -clcerts -nokeys -passin "pass:$password" -out $pemPath 2>$null
    $extractExit = $LASTEXITCODE
    & $openssl x509 -in $pemPath -outform der -out $certificateDerPath 2>$null
    $certificateExit = $LASTEXITCODE
    $subject = (& $openssl x509 -in $pemPath -noout -subject 2>$null | Out-String).Trim()
    $subjectExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($extractExit -ne 0) { throw "无法从签名 PFX 导出公钥证书" }
  if ($certificateExit -ne 0 -or $subjectExit -ne 0) { throw "无法导出签名公钥证书" }
  return [pscustomobject]@{ subject = $subject; pfxPath = (Resolve-Path -LiteralPath $sourcePfx).Path; pemPath = $pemPath; certificatePath = $certificateDerPath }
}

function Get-CertificateThumbprint([string]$openssl, [string]$pemPath) {
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $fingerprint = (& $openssl x509 -in $pemPath -fingerprint -sha1 -noout 2>$null | Out-String).Trim()
    $fingerprintExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($fingerprintExit -ne 0) { throw "无法读取签名证书指纹" }
  $match = [regex]::Match($fingerprint, "([A-Fa-f0-9]{2}:){19}[A-Fa-f0-9]{2}")
  if (-not $match.Success) { throw "无法读取签名证书指纹：$fingerprint" }
  return $match.Value.Replace(":", "").ToUpperInvariant()
}

function Find-OrInstall-InnoCompiler([string]$requestedPath, [string]$cacheRoot) {
  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($requestedPath)) { $candidates += $requestedPath }
  $candidates += @(
    (Join-Path $cacheRoot "ISCC.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 7\ISCC.exe"),
    "C:\Program Files\Inno Setup 7\ISCC.exe"
  )
  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  $downloadText = & node.exe tools/download-inno-setup.mjs --cache-dir (Join-Path $distRoot "tool-cache") 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup 下载/校验失败：$downloadText" }
  $download = $downloadText | ConvertFrom-Json
  New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
  # Windows PowerShell 5.1 joins ArgumentList into one command line. Preserve
  # the destination as one quoted argument when the repository path has spaces.
  # Portable mode is also required on restricted builders: it prevents the
  # compiler bootstrapper from registering itself in HKCU.
  $installLog = Join-Path $cacheRoot "portable-install.log"
  $arguments = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/CURRENTUSER",
    "/NOICONS",
    "/PORTABLE=1",
    ('/DIR="' + $cacheRoot + '"'),
    ('/LOG="' + $installLog + '"')
  )
  $process = Start-Process -FilePath ([string]$download.path) -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    $logTail = if (Test-Path -LiteralPath $installLog -PathType Leaf) {
      (Get-Content -LiteralPath $installLog -Tail 30 | Out-String).Trim()
    } else {
      "安装日志未生成：$installLog"
    }
    throw "Inno Setup 编译器安装失败（exit code $($process.ExitCode)）`n$logTail"
  }
  $installed = Join-Path $cacheRoot "ISCC.exe"
  if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { throw "Inno Setup 安装后找不到 ISCC.exe：$installed" }
  return $installed
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("linli-inno-build-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
$previousSigningEnvironment = @{
  LINLI_OSSLSIGNCODE_PATH = $env:LINLI_OSSLSIGNCODE_PATH
  LINLI_SIGNING_PFX_PATH = $env:LINLI_SIGNING_PFX_PATH
  LINLI_SIGNING_PFX_PASSWORD = $env:LINLI_SIGNING_PFX_PASSWORD
  LINLI_SIGNING_CERT_PEM = $env:LINLI_SIGNING_CERT_PEM
}

try {
  foreach ($artifact in @($installerPath, "$installerPath.sha256", "$installerPath.json", $certificatePath)) {
    if (Test-Path -LiteralPath $artifact -PathType Leaf) { Remove-Item -LiteralPath $artifact -Force }
  }

  $releaseArguments = @("tools/release.mjs")
  if ($AllowDirty) { $releaseArguments += "--allow-dirty" }
  if ($AllowUnpublishedSource) { $releaseArguments += "--allow-unpublished-source" }
  Invoke-Checked "node.exe" $releaseArguments
  $releaseZip = Join-Path $distRoot "linli-local-mail-$version.zip"
  if (-not (Test-Path -LiteralPath $releaseZip -PathType Leaf)) { throw "运行时 ZIP 未生成：$releaseZip" }

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
  if (-not (Test-Path -LiteralPath $nodeSource -PathType Leaf)) { throw "Node.js 压缩包中找不到 node.exe" }
  if (-not (Test-Path -LiteralPath $nodeLicenseSource -PathType Leaf)) { throw "Node.js 压缩包中找不到 LICENSE" }
  $runtimeRoot = Join-Path $servicePayloadRoot "runtime"
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $runtimeRoot "node.exe") -Force
  Copy-Item -LiteralPath $nodeLicenseSource -Destination (Join-Path $runtimeRoot "Node.js-LICENSE.txt") -Force
  $bundledNodeVersion = (& (Join-Path $runtimeRoot "node.exe") --version).Trim()
  if ($bundledNodeVersion -ne "v$NodeVersion") { throw "内置 Node.js 版本异常：$bundledNodeVersion" }

  $characterSource = Join-Path $servicePayloadRoot "config\characters\linli.v1.json"
  $characterDefaultRoot = Join-Path $servicePayloadRoot "config\defaults"
  if (-not (Test-Path -LiteralPath $characterSource -PathType Leaf)) { throw "运行时包缺少林离人设文件" }
  New-Item -ItemType Directory -Path $characterDefaultRoot -Force | Out-Null
  Copy-Item -LiteralPath $characterSource -Destination (Join-Path $characterDefaultRoot "linli.v1.json") -Force
  Remove-Item -LiteralPath $characterSource -Force

  $openssl = Find-OpenSsl
  $osslsigncodeCache = Join-Path $distRoot "tool-cache\osslsigncode-2.13-windows-x64-mingw.zip"
  $osslsigncode = Find-OsslSignCode $osslsigncodeCache (Join-Path $temporaryRoot "osslsigncode")
  $effectivePassword = $SigningPassword
  if ([string]::IsNullOrWhiteSpace($SigningPfxPath)) {
    $effectivePassword = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
    $temporaryPfx = Join-Path $temporaryRoot "LinliLocalMail-signing.pfx"
    $certificate = New-CodeSigningCertificate $openssl $CertificateSubject $temporaryRoot $temporaryPfx $certificatePath $effectivePassword
    Write-Warning "未提供稳定签名证书；本次使用临时自签名证书。正式发布应通过 LINLI_SIGNING_PFX_PATH/Password 提供固定证书。"
  } else {
    if ([string]::IsNullOrWhiteSpace($effectivePassword)) { throw "提供 SigningPfxPath 时必须同时提供 SigningPassword" }
    $certificate = Import-CodeSigningCertificate $openssl $SigningPfxPath $effectivePassword $temporaryRoot $certificatePath
  }
  $thumbprint = Get-CertificateThumbprint $openssl $certificate.pemPath

  $env:LINLI_OSSLSIGNCODE_PATH = $osslsigncode
  $env:LINLI_SIGNING_PFX_PATH = $certificate.pfxPath
  $env:LINLI_SIGNING_PFX_PASSWORD = $effectivePassword
  $env:LINLI_SIGNING_CERT_PEM = $certificate.pemPath

  $signHelper = Join-Path $serviceRoot "tools\sign-inno-file.ps1"
  $payloadWrapper = Join-Path $servicePayloadRoot "native\linli-launcher-wrapper.exe"
  Invoke-Checked "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $signHelper, "-Path", $payloadWrapper)

  $runtimeManifestPath = Join-Path $servicePayloadRoot "runtime-manifest.json"
  Invoke-Checked "node.exe" @("tools/generate-runtime-manifest.mjs", "--root", $servicePayloadRoot, "--version", $version, "--output", $runtimeManifestPath)
  $runtimeManifestSha256 = Get-Sha256 $runtimeManifestPath

  $compiler = Find-OrInstall-InnoCompiler $IsccPath $innoCacheRoot
  $compilerVersion = (& $compiler --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $compilerVersion -notmatch [regex]::Escape($InnoVersion)) { throw "Inno Setup 编译器版本异常：$compilerVersion" }
  $signCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File $q' + $signHelper + '$q -Path $f'
  $issPath = Join-Path $serviceRoot "installer\LinliLocalMail.iss"
  $isccArguments = @(
    "--quiet-progress",
    "--no-ide-signtools",
    "--define=MyAppVersion=$version",
    "--define=PayloadRoot=$payloadRoot",
    "--define=OutputDir=$distRoot",
    "--signtool=linli=$signCommand",
    $issPath
  )
  Invoke-Checked $compiler $isccArguments
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw "Inno Setup 未生成安装器：$installerPath" }
  Invoke-Checked $osslsigncode @("verify", "-CAfile", $certificate.pemPath, "-in", $installerPath)

  $installerSha256 = Get-Sha256 $installerPath
  Set-Content -LiteralPath "$installerPath.sha256" -Value "$installerSha256  $installerName" -Encoding ascii
  $manifest = [ordered]@{
    installer = $installerName
    installerSha256 = $installerSha256
    installerEngine = "Inno Setup $InnoVersion x64"
    runtimeManifestSha256 = $runtimeManifestSha256
    nodeVersion = $NodeVersion
    nodeArchiveSha256 = [string]$nodeInfo.sha256
    nodeArchiveSource = [string]$nodeInfo.sourceUrl
    signingSubject = [string]$certificate.subject
    signingThumbprint = [string]$thumbprint
    signedFiles = @($installerName, "linli-local-mail/native/linli-launcher-wrapper.exe", "uninstaller")
    generatedAt = (Get-Date).ToString("o")
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$installerPath.json" -Encoding utf8
  [pscustomobject]@{
    installer = $installerPath
    sha256 = $installerSha256
    size = (Get-Item -LiteralPath $installerPath).Length
    installerEngine = "Inno Setup $InnoVersion x64"
    runtimeManifestSha256 = $runtimeManifestSha256
    nodeVersion = $NodeVersion
    signingSubject = [string]$certificate.subject
    signingThumbprint = [string]$thumbprint
    certificate = $certificatePath
  } | ConvertTo-Json -Depth 4
} finally {
  foreach ($entry in $previousSigningEnvironment.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
  }
  if (-not $KeepWork -and (Test-Path -LiteralPath $temporaryRoot)) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
