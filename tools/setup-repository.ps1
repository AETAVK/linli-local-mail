param(
  [ValidateSet("private-canonical", "public-projection")]
  [string]$ExpectedRole = "private-canonical"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
& node.exe (Join-Path $PSScriptRoot "repo-guard.mjs") "--allow-role" $ExpectedRole
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& git.exe -C $repositoryRoot config --local core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw "Unable to configure core.hooksPath." }
& node.exe (Join-Path $PSScriptRoot "governance-check.mjs") "--expected-role" $ExpectedRole "--require-hooks"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
