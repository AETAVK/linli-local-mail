param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
$osslsigncode = $env:LINLI_OSSLSIGNCODE_PATH
$pfxPath = $env:LINLI_SIGNING_PFX_PATH
$password = $env:LINLI_SIGNING_PFX_PASSWORD
$certificatePem = $env:LINLI_SIGNING_CERT_PEM
if ([string]::IsNullOrWhiteSpace($osslsigncode) -or -not (Test-Path -LiteralPath $osslsigncode -PathType Leaf)) {
  throw "LINLI_OSSLSIGNCODE_PATH is missing or invalid"
}
if ([string]::IsNullOrWhiteSpace($pfxPath) -or -not (Test-Path -LiteralPath $pfxPath -PathType Leaf)) {
  throw "LINLI_SIGNING_PFX_PATH is missing or invalid"
}
if ([string]::IsNullOrWhiteSpace($certificatePem) -or -not (Test-Path -LiteralPath $certificatePem -PathType Leaf)) {
  throw "LINLI_SIGNING_CERT_PEM is missing or invalid"
}
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "File to sign was not found: $Path" }

$signedPath = "$Path.linli-signed-$PID"
$previousErrorAction = $ErrorActionPreference
try {
  $ErrorActionPreference = "Continue"
  & $osslsigncode sign -pkcs12 $pfxPath -pass $password -h sha256 -n "Linli Local Mail" -i "https://github.com/AETAVK/linli-local-mail" -in $Path -out $signedPath
  $signExit = $LASTEXITCODE
  & $osslsigncode verify -CAfile $certificatePem -in $signedPath
  $verifyExit = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  if ($signExit -ne 0) { throw "osslsigncode sign failed with exit code $signExit" }
  if ($verifyExit -ne 0) { throw "osslsigncode verification failed with exit code $verifyExit" }
  Move-Item -LiteralPath $signedPath -Destination $Path -Force
} finally {
  $ErrorActionPreference = $previousErrorAction
  if (Test-Path -LiteralPath $signedPath -PathType Leaf) { Remove-Item -LiteralPath $signedPath -Force }
}
