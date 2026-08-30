param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateNotNullOrEmpty()]
  [string]$Zip,
  [Parameter(Mandatory = $true, Position = 1)]
  [ValidateNotNullOrEmpty()]
  [string]$Destination
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8
try { [Console]::OutputEncoding = $utf8 } catch { }

function Get-SafeRelativePath([string]$entryName) {
  $normalized = ([string]$entryName).Replace([char]92, [char]47)
  if ($normalized.StartsWith("/") -or $normalized -match "^[A-Za-z]:") {
    throw "ZIP contains an absolute path: $entryName"
  }

  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($part in $normalized.Split('/')) {
    if ([string]::IsNullOrEmpty($part) -or $part -eq ".") { continue }
    if ($part -eq "..") { throw "ZIP contains a path traversal entry: $entryName" }
    if ($part.EndsWith(".") -or $part.EndsWith(" ")) {
      throw "ZIP contains a Windows-normalized file name: $entryName"
    }
    if ($part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
      throw "ZIP contains an invalid file name: $entryName"
    }
    [void]$parts.Add($part)
  }
  if ($parts.Count -eq 0) { return $null }
  return ($parts -join [IO.Path]::DirectorySeparatorChar)
}

function Get-ExistingKind([string]$path) {
  if ([IO.File]::Exists($path)) { return "file" }
  if ([IO.Directory]::Exists($path)) { return "directory" }
  return $null
}

function Move-ConflictingPath([string]$path) {
  $parent = [IO.Path]::GetDirectoryName($path)
  if (-not [IO.Directory]::Exists($parent)) {
    [IO.Directory]::CreateDirectory($parent) | Out-Null
  }
  $candidate = "$path.linli-conflict-$PID"
  $suffix = 2
  while ([IO.File]::Exists($candidate) -or [IO.Directory]::Exists($candidate)) {
    $candidate = "$path.linli-conflict-$PID-$suffix"
    $suffix += 1
  }

  $kind = Get-ExistingKind $path
  if ($kind -eq "directory") {
    [IO.Directory]::Move($path, $candidate)
  } elseif ($kind -eq "file") {
    [IO.File]::Move($path, $candidate)
  }
  Write-Output "Moved conflicting path to $candidate"
}

$zipPath = [IO.Path]::GetFullPath($Zip)
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (-not [IO.File]::Exists($zipPath)) {
  throw "ZIP payload was not found: $zipPath"
}
if ([IO.File]::Exists($destinationPath)) {
  throw "Extraction destination is a file: $destinationPath"
}
if (-not [IO.Directory]::Exists($destinationPath)) {
  [IO.Directory]::CreateDirectory($destinationPath) | Out-Null
}

$destinationPrefix = $destinationPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entries = @()
  $seen = @{}
  foreach ($entry in $archive.Entries) {
    $relative = Get-SafeRelativePath $entry.FullName
    if ($null -eq $relative) { continue }
    $isDirectory = $entry.FullName.EndsWith("/") -or [string]::IsNullOrEmpty($entry.Name)
    if ($seen.ContainsKey($relative) -and $seen[$relative] -ne $isDirectory) {
      throw "ZIP contains both a file and a directory with the same path: $relative"
    }
    $seen[$relative] = $isDirectory
    $entries += [pscustomobject]@{
      RelativePath = $relative
      IsDirectory = $isDirectory
    }
  }
} finally {
  $archive.Dispose()
}

function Resolve-ArchiveTarget([string]$relativePath) {
  $target = [IO.Path]::GetFullPath([IO.Path]::Combine($destinationPath, $relativePath))
  if ($target -ne $destinationPath -and -not $target.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "ZIP entry escapes the extraction destination: $relativePath"
  }
  return $target
}

# Ensure every archive parent is a directory before extraction. This covers both
# file-to-directory and directory-to-file collisions, regardless of tar availability.
$directories = @()
$files = @()
foreach ($entry in $entries) {
  $parts = $entry.RelativePath -split [regex]::Escape([IO.Path]::DirectorySeparatorChar)
  for ($index = 1; $index -lt $parts.Count; $index += 1) {
    $directories += ($parts[0..($index - 1)] -join [IO.Path]::DirectorySeparatorChar)
  }
  if ($entry.IsDirectory) { $directories += $entry.RelativePath }
  else { $files += $entry.RelativePath }
}

$directories = @($directories | Sort-Object Length | Select-Object -Unique)
$files = @($files | Sort-Object Length | Select-Object -Unique)
foreach ($directory in $directories) {
  if (@($files) -contains $directory) {
    throw "ZIP contains an incompatible file/directory collision: $directory"
  }
  $target = Resolve-ArchiveTarget $directory
  if ((Get-ExistingKind $target) -eq "file") { Move-ConflictingPath $target }
}
foreach ($file in $files) {
  $target = Resolve-ArchiveTarget $file
  if ((Get-ExistingKind $target) -eq "directory") { Move-ConflictingPath $target }
}

# Do the actual extraction through the .NET ZIP API instead of Expand-Archive.
# Windows PowerShell 5.1 ships different Microsoft.PowerShell.Archive versions
# across Windows editions; using the already loaded API keeps the installer path
# independent of that module while retaining the validation above.
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  foreach ($entry in $archive.Entries) {
    $relative = Get-SafeRelativePath $entry.FullName
    if ($null -eq $relative) { continue }

    $target = Resolve-ArchiveTarget $relative
    $isDirectory = $entry.FullName.EndsWith("/") -or [string]::IsNullOrEmpty($entry.Name)
    if ($isDirectory) {
      if (-not [IO.Directory]::Exists($target)) {
        [IO.Directory]::CreateDirectory($target) | Out-Null
      }
      continue
    }

    $parent = [IO.Path]::GetDirectoryName($target)
    if (-not [IO.Directory]::Exists($parent)) {
      [IO.Directory]::CreateDirectory($parent) | Out-Null
    }

    $inputStream = $entry.Open()
    $outputStream = [IO.File]::Open($target, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $inputStream.CopyTo($outputStream)
    } finally {
      $outputStream.Dispose()
      $inputStream.Dispose()
    }
  }
} finally {
  $archive.Dispose()
}
