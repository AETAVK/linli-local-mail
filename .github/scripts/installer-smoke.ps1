param(
  [string]$ExtractorPath = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($ExtractorPath)) {
  $ExtractorPath = Join-Path -Path $repoRoot -ChildPath "native\extract-payload.ps1"
}
if (-not [IO.File]::Exists($ExtractorPath)) {
  throw "解压脚本不存在：$ExtractorPath"
}

function Assert-Condition([bool]$condition, [string]$message) {
  if (-not $condition) { throw "冒烟测试失败：$message" }
}

function New-TestZip([string]$path, [hashtable]$entries) {
  $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($name in $entries.Keys) {
      $entry = $archive.CreateEntry([string]$name)
      $content = $entries[$name]
      if ($null -ne $content) {
        $entryStream = $entry.Open()
        try {
          $bytes = [Text.Encoding]::UTF8.GetBytes([string]$content)
          $entryStream.Write($bytes, 0, $bytes.Length)
        } finally {
          $entryStream.Dispose()
        }
      }
    }
  } finally {
    $archive.Dispose()
    $stream.Dispose()
  }
}

function Invoke-Extractor([string]$zipPath, [string]$destinationPath, [switch]$ExpectFailure) {
  try {
    $output = @(& $ExtractorPath -Zip $zipPath -Destination $destinationPath 2>&1)
    if ($ExpectFailure) {
      throw "恶意 ZIP 被错误接受：$($output -join [Environment]::NewLine)"
    }
    return $output
  } catch {
    if (-not $ExpectFailure) { throw }
    Write-Host "    已拒绝预期的恶意 ZIP：$($_.Exception.Message)" -ForegroundColor DarkGray
    return @()
  }
}

$testRoot = Join-Path -Path ([IO.Path]::GetTempPath()) -ChildPath ("linli-installer-smoke-" + [Guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null

$entries = [ordered]@{
  "linli-local-mail/server.mjs" = "console.log('smoke');"
  "linli-local-mail/tools/backup.mjs" = "backup"
  "linli-local-mail/tools/install.ps1" = "Write-Output 'install'"
  "linli-local-mail/资料/测试.txt" = "中文路径"
}

try {
  Write-Host "Installer extractor smoke test ($($PSVersionTable.PSVersion))" -ForegroundColor Cyan

  $normalZip = Join-Path -Path $testRoot -ChildPath "payload-normal.zip"
  $normalDestination = Join-Path -Path $testRoot -ChildPath "游戏目录 空格\目标"
  New-TestZip $normalZip $entries
  Invoke-Extractor $normalZip $normalDestination | Out-Null
  Assert-Condition ([IO.File]::Exists((Join-Path -Path $normalDestination -ChildPath "linli-local-mail\server.mjs"))) "普通路径未解压 server.mjs"
  Assert-Condition (([IO.File]::ReadAllText((Join-Path -Path $normalDestination -ChildPath "linli-local-mail\资料\测试.txt"))) -eq "中文路径") "中文文件内容不一致"
  Write-Host "  PASS: 普通、空格和中文路径"

  $directoryCollisionDestination = Join-Path -Path $testRoot -ChildPath "collision-directory"
  $collisionTools = Join-Path -Path $directoryCollisionDestination -ChildPath "linli-local-mail\tools"
  [IO.Directory]::CreateDirectory($collisionTools) | Out-Null
  [IO.Directory]::CreateDirectory((Join-Path -Path $collisionTools -ChildPath "backup.mjs")) | Out-Null
  Invoke-Extractor $normalZip $directoryCollisionDestination | Out-Null
  $backupPath = Join-Path -Path $collisionTools -ChildPath "backup.mjs"
  $directoryConflicts = @([IO.Directory]::GetDirectories($collisionTools, "backup.mjs.linli-conflict-*"))
  Assert-Condition ([IO.File]::Exists($backupPath)) "文件覆盖目录冲突未恢复为文件"
  Assert-Condition ($directoryConflicts.Count -eq 1) "原冲突目录没有保留为可恢复备份"
  Write-Host "  PASS: 文件覆盖同名目录冲突"

  $fileCollisionDestination = Join-Path -Path $testRoot -ChildPath "collision-file"
  $fileCollisionRoot = Join-Path -Path $fileCollisionDestination -ChildPath "linli-local-mail"
  [IO.Directory]::CreateDirectory($fileCollisionRoot) | Out-Null
  $fileCollisionTools = Join-Path -Path $fileCollisionRoot -ChildPath "tools"
  [IO.File]::WriteAllText($fileCollisionTools, "old tools")
  Invoke-Extractor $normalZip $fileCollisionDestination | Out-Null
  $restoredTools = Join-Path -Path $fileCollisionRoot -ChildPath "tools"
  $fileConflicts = @([IO.Directory]::GetFiles($fileCollisionRoot, "tools.linli-conflict-*"))
  Assert-Condition ([IO.Directory]::Exists($restoredTools)) "同名父文件未恢复为目录"
  Assert-Condition ([IO.File]::Exists((Join-Path -Path $restoredTools -ChildPath "backup.mjs"))) "父文件冲突后载荷文件缺失"
  Assert-Condition ($fileConflicts.Count -eq 1) "原父文件没有保留为可恢复备份"
  Write-Host "  PASS: 目录覆盖同名文件冲突"

  $maliciousZip = Join-Path -Path $testRoot -ChildPath "payload-traversal.zip"
  $maliciousDestination = Join-Path -Path $testRoot -ChildPath "malicious-destination"
  New-TestZip $maliciousZip ([ordered]@{
    "../linli-installer-smoke-escape.txt" = "must not be written"
    "linli-local-mail/server.mjs" = "safe"
  })
  Invoke-Extractor $maliciousZip $maliciousDestination -ExpectFailure | Out-Null
  Assert-Condition (-not [IO.File]::Exists((Join-Path -Path $testRoot -ChildPath "linli-installer-smoke-escape.txt"))) "路径穿越文件被写出解压目录"
  Write-Host "  PASS: ZIP 路径穿越拒绝"

  Write-Host "Installer extractor smoke test passed." -ForegroundColor Green
} finally {
  if ([IO.Directory]::Exists($testRoot)) {
    [IO.Directory]::Delete($testRoot, $true)
  }
}
