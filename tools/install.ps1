# 林离本地回信桥：一键安装脚本
# 面向接收者：验证/安装 Node.js、校验游戏目录、导入兼容基线、安装前端补丁，并可立即启动。
# 用法：双击仓库根目录的 Install.cmd，或 powershell -File tools\install.ps1 [-NoLaunch]

param(
  [switch]$NoLaunch,
  [switch]$NonInteractive,
  [switch]$RequireWrapper
)

$ErrorActionPreference = "Stop"
$serviceRoot = Split-Path -Parent $PSScriptRoot
$gameRoot = Split-Path -Parent $serviceRoot
$requiredNodeMajor = 24

function Write-Step($message) { Write-Host ""
  Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "    $message" -ForegroundColor Green }
function Write-Warn2($message) { Write-Host "    $message" -ForegroundColor Yellow }
function Die($message) {
  Write-Host ""
  Write-Host "安装中止：$message" -ForegroundColor Red
  if (-not $NonInteractive) { Read-Host "按回车键退出" }
  exit 1
}

function Test-PathLiteral([string]$path, [ValidateSet("Any", "Leaf", "Container")][string]$pathType = "Any") {
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  if ($pathType -eq "Any") { return Test-Path -LiteralPath $path }
  return Test-Path -LiteralPath $path -PathType $pathType
}

function Assert-NoLauncherProcess {
  $running = @(Get-Process -Name "launcher", "launcher.original" -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    $names = ($running | Select-Object -ExpandProperty ProcessName -Unique) -join ", "
    Die "检测到启动器进程仍在运行（$names）。请完全退出游戏和启动器后重新运行安装包。"
  }
}

function Move-ConflictingContainer([string]$path) {
  if (-not (Test-PathLiteral $path -pathType Container)) { return }
  $parent = Split-Path -Parent $path
  $leaf = Split-Path -Leaf $path
  $candidate = Join-Path -Path $parent -ChildPath ($leaf + ".linli-conflict-" + $PID)
  $suffix = 2
  while (Test-PathLiteral $candidate) {
    $candidate = Join-Path -Path $parent -ChildPath ($leaf + ".linli-conflict-" + $PID + "-" + $suffix)
    $suffix += 1
  }
  Move-Item -LiteralPath $path -Destination $candidate
  Write-Warn2 "检测到启动脚本目标是目录，已保留为：$candidate"
}

Write-Host "林离本地回信桥 - 一键安装" -ForegroundColor White
Write-Host "项目目录：$serviceRoot"
Write-Host "游戏目录：$gameRoot"

if (-not [Environment]::Is64BitOperatingSystem) {
  Die "当前系统是 32 位 Windows。本项目安装包和内置 Node.js 仅支持 64 位 Windows 10/11。"
}

# ---- 步骤 1：游戏目录检查 ----
Write-Step "检查游戏目录"
$officialPack = Join-Path -Path $gameRoot -ChildPath "0.0.9.627\resources\feapp.dat"
$officialWebplayerPack = Join-Path -Path $gameRoot -ChildPath "0.0.9.627\resources\webplayer.dat"
$launcher = Join-Path -Path $gameRoot -ChildPath "launcher.exe"
if (-not (Test-PathLiteral $officialPack -pathType Leaf)) {
  Die "未找到 $officialPack。请确认 linli-local-mail 文件夹放在 0.0.9.627 版本的游戏根目录内（与 0.0.9.627、launcher.exe 平级）。"
}
if (-not (Test-PathLiteral $officialWebplayerPack -pathType Leaf)) {
  Die "未找到 $officialWebplayerPack。请确认 0.0.9.627 的 webplayer.dat 完整存在；不要在缺少第二个前端包时继续安装。"
}
if (-not (Test-PathLiteral $launcher -pathType Leaf)) {
  Die "未找到 $launcher。请确认这是 BSide Olivia Lin 的游戏根目录。"
}
Write-Ok "游戏目录结构正确（0.0.9.627 feapp.dat + webplayer.dat + launcher.exe）"

# ---- 步骤 2：验证内置或系统 Node.js（>= 24）----
Write-Step "检查 Node.js（需要 >= $requiredNodeMajor）"

function Get-NodeVersion([string]$nodePath) {
  if ($nodePath -and (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    try { return ((& $nodePath --version 2>$null) -replace '^v', '').Trim() } catch { return $null }
  }
  return $null
}

function Add-KnownNodePaths {
  $candidates = @()
  $locations = @(
    @{ Base = $env:ProgramFiles; Relative = "nodejs" }
    @{ Base = ${env:ProgramFiles(x86)}; Relative = "nodejs" }
    @{ Base = $env:LOCALAPPDATA; Relative = "Programs\nodejs" }
  )
  foreach ($location in $locations) {
    if ([string]::IsNullOrWhiteSpace([string]$location.Base)) { continue }
    $directory = Join-Path -Path ([string]$location.Base) -ChildPath $location.Relative
    if (Test-PathLiteral (Join-Path -Path $directory -ChildPath "node.exe") -pathType Leaf) {
      $candidates += $directory
    }
  }
  foreach ($directory in $candidates) {
    if ((@($env:Path -split ';') -notcontains $directory)) {
      if ([string]::IsNullOrWhiteSpace($env:Path)) { $env:Path = $directory }
      else { $env:Path = "$env:Path;$directory" }
    }
  }
}

$bundledNodePath = Join-Path -Path $serviceRoot -ChildPath "runtime\node.exe"
$nodePath = $null
$nodeVersion = $null
$usingBundledNode = Test-Path -LiteralPath $bundledNodePath -PathType Leaf
if ($usingBundledNode) {
  $nodePath = (Resolve-Path -LiteralPath $bundledNodePath).Path
  $nodeVersion = Get-NodeVersion $nodePath
  if (-not $nodeVersion) {
    Die "内置 Node.js 无法运行：$nodePath"
  }
  if ([int]($nodeVersion.Split('.')[0]) -lt $requiredNodeMajor) {
    Die "内置 Node.js $nodeVersion 版本过旧（本项目需要 >= $requiredNodeMajor）。"
  }
  Write-Ok "使用内置 Node.js $nodeVersion"
}

if (-not $usingBundledNode) {
  Add-KnownNodePaths
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode) { $nodePath = $systemNode.Source }
  $nodeVersion = Get-NodeVersion $nodePath
}
$needsInstall = $false
if (-not $usingBundledNode -and -not $nodeVersion) {
  Write-Warn2 "未检测到 Node.js。"
  $needsInstall = $true
} elseif (-not $usingBundledNode -and [int]($nodeVersion.Split('.')[0]) -lt $requiredNodeMajor) {
  Write-Warn2 "Node.js $nodeVersion 版本过旧（本项目需要 >= $requiredNodeMajor，因为使用了内置 SQLite）。"
  $needsInstall = $true
} elseif (-not $usingBundledNode) {
  Write-Ok "Node.js $nodeVersion 满足要求"
}

if ($needsInstall) {
  $answer = Read-Host "是否现在通过 winget 自动安装 Node.js LTS？[Y/n]"
  if ($answer -match '^(n|N)') {
    Die "请手动安装 Node.js LTS（https://nodejs.org/，版本 >= $requiredNodeMajor）后重新运行本脚本。"
  }
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    Start-Process "https://nodejs.org/en/download"
    Die "未检测到 winget。已打开 Node.js 下载页，请安装 LTS 版本（>= $requiredNodeMajor）后重新运行本脚本。"
  }
  Write-Host "    正在通过 winget 安装 OpenJS.NodeJS.LTS（可能需要几分钟）……"
  & winget.exe install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Start-Process "https://nodejs.org/en/download"
    Die "winget 安装失败。已打开 Node.js 下载页，请手动安装 LTS 版本后重新运行本脚本。"
  }
  Add-KnownNodePaths
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode) { $nodePath = $systemNode.Source }
  $nodeVersion = Get-NodeVersion $nodePath
  if (-not $nodeVersion -or [int]($nodeVersion.Split('.')[0]) -lt $requiredNodeMajor) {
    Die "Node.js 已安装但当前会话无法找到新版本；请关闭本窗口，重新打开后再次运行 Install.cmd。"
  }
  Write-Ok "Node.js $nodeVersion 安装完成"
}

function Invoke-NodeCommand([string[]]$arguments) {
  $previousErrorAction = $ErrorActionPreference
  try {
    # Windows PowerShell 可能把原生程序的 stderr（包括 Node 的错误堆栈）
    # 转换成 NativeCommandError；这里必须先允许输出，才能根据退出码走回退路径。
    $ErrorActionPreference = "Continue"
    $output = & $nodePath @arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  [pscustomobject]@{
    Output = @($output)
    ExitCode = $exitCode
  }
}

Assert-NoLauncherProcess

# ---- 步骤 3：确认游戏本体是未打补丁的官方包或已完成安装 ----
Write-Step "检查前端补丁状态"
Push-Location -LiteralPath $serviceRoot
try {
  $verifyResult = Invoke-NodeCommand @("tools\feapp.mjs", "verify")
  if ($verifyResult.ExitCode -eq 0) {
    Write-Ok "前端补丁已安装且与本机源码一致，无需重装"
  } else {
    Write-Warn2 "补丁尚未安装或与当前版本不一致，开始安装……"

    # 基线缺失时先从官方包导入（幂等；官方包已被打补丁且基线仍在时会跳过导入直接安装）
    $baselinePath = Join-Path -Path $serviceRoot -ChildPath "backups\required\official-compatible-0.0.9.627\feapp.dat"
    $webplayerBaselinePath = Join-Path -Path $serviceRoot -ChildPath "backups\required\official-compatible-0.0.9.627\webplayer.dat"
    $baselineOverride = $null
    $webplayerBaselineOverride = $null
    $baselineReady = (Test-PathLiteral $baselinePath -pathType Leaf) -and (Test-PathLiteral $webplayerBaselinePath -pathType Leaf)
    if (-not $baselineReady) {
      Write-Host "    从官方包导入兼容基线（按 SHA-256 校验）……"
      $importResult = Invoke-NodeCommand @("tools\feapp.mjs", "import-baseline")
      $importResult.Output | Out-Host
      $baselineReady = (Test-PathLiteral $baselinePath -pathType Leaf) -and (Test-PathLiteral $webplayerBaselinePath -pathType Leaf)
      if ($importResult.ExitCode -ne 0 -and -not $baselineReady) {
        Die "导入兼容基线失败。安装目录里的 feapp.dat 与 webplayer.dat 必须都是未修改的官方包，或都能证明出自本项目的补丁；请用 Steam 验证文件完整性恢复原始 0.0.9.627 文件后重试。"
      }
      $importJson = $null
      try { $importJson = (($importResult.Output -join [Environment]::NewLine) | ConvertFrom-Json) } catch { $importJson = $null }
      if ($importJson -and $importJson.source -eq "rebuilt-by-unpatching" -and $importJson.baselinePath) {
        $candidate = Join-Path -Path $gameRoot -ChildPath ([string]$importJson.baselinePath -replace '/', '\')
        if (Test-PathLiteral $candidate -pathType Leaf) { $baselineOverride = $candidate }
      }
      if ($importJson -and $importJson.webplayer -and $importJson.webplayer.source -eq "rebuilt-by-unpatching" -and $importJson.webplayer.baselinePath) {
        $candidate = Join-Path -Path $gameRoot -ChildPath ([string]$importJson.webplayer.baselinePath -replace '/', '\')
        if (Test-PathLiteral $candidate -pathType Leaf) { $webplayerBaselineOverride = $candidate }
      }
    }

    $installArguments = @("tools\feapp.mjs", "install")
    if ($baselineOverride) {
      Write-Warn2 "使用逆向重建的临时基线安装（原始基线已不可考，补丁功能不受影响）"
      $installArguments += @("--baseline", $baselineOverride)
    }
    if ($webplayerBaselineOverride) {
      $installArguments += @("--webplayer-baseline", $webplayerBaselineOverride)
    }
    $installResult = Invoke-NodeCommand $installArguments
    $installResult.Output | Out-Host
    if ($installResult.ExitCode -ne 0) { Die "前端补丁安装失败，请把上方错误信息反馈给维护者。" }
    $installJson = $null
    try { $installJson = (($installResult.Output -join [Environment]::NewLine) | ConvertFrom-Json) } catch { $installJson = $null }
    if (-not $installJson -or -not $installJson.webplayer) {
      Die "前端补丁输出未包含 webplayer.dat 校验结果，拒绝把单包安装视为完成。"
    }
    Write-Ok "前端补丁安装完成（feapp.dat + webplayer.dat；安装前的包已自动备份）"
  }
} finally {
  Pop-Location
}

# ---- 步骤 4：把启动入口写入游戏根目录 ----
# 模板内容与 tools/release.mjs 的 ROOT_CMD_FILES 同源；脚本内置生成，
# 因此源码归档（Git/Gitee 的 main zip，不含 game-root-shortcuts 目录）也能获得完整入口。
Write-Step "配置游戏根目录启动入口"
$shortcuts = Join-Path -Path $serviceRoot -ChildPath "game-root-shortcuts"
$installed = 0
if (Test-PathLiteral $shortcuts -pathType Container) {
  foreach ($file in Get-ChildItem -LiteralPath $shortcuts -Filter "*.cmd" -File) {
    $destination = Join-Path -Path $gameRoot -ChildPath $file.Name
    Move-ConflictingContainer $destination
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    $installed += 1
  }
} else {
  # 源码归档没有这个目录；按同一份模板直接生成，保证行为一致。
  $shortcutTemplates = [ordered]@{
    "Start-LinliLocalMail.cmd"             = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0linli-local-mail\Start-LinliLocalMail.ps1`"`r`n"
    "Start-LinliLocalMail-ServiceOnly.cmd" = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0linli-local-mail\Start-LinliLocalMail.ps1`" -NoGame`r`n"
    "Stop-LinliLocalMail.cmd"              = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0linli-local-mail\Stop-LinliLocalMail.ps1`"`r`n"
  }
  foreach ($entry in $shortcutTemplates.GetEnumerator()) {
    $destination = Join-Path -Path $gameRoot -ChildPath $entry.Key
    Move-ConflictingContainer $destination
    [System.IO.File]::WriteAllText($destination, $entry.Value, [System.Text.Encoding]::ASCII)
    $installed += 1
  }
}
if ($installed -gt 0) {
  Write-Ok "已写入 $installed 个启动脚本到游戏根目录（Start / Stop / ServiceOnly）"
} else {
  Write-Warn2 "未找到 game-root-shortcuts 模板；如需启动脚本，请按 README 中的模板手动创建。"
}

# ---- 步骤 5：安装直接运行 launcher.exe 的本地服务包装器 ----
Write-Step "安装直接运行 launcher.exe 的本地服务包装器"
$wrapperBinary = Join-Path -Path $serviceRoot -ChildPath "native\linli-launcher-wrapper.exe"
if (-not (Test-PathLiteral $wrapperBinary -pathType Leaf)) {
  if ($RequireWrapper) {
    Die "安装载荷缺少本地服务包装器：$wrapperBinary。请重新下载 Release 页的 LinliLocalMail-Setup.exe，不要使用 Source code 压缩包。"
  }
  # 源码归档（Git/Gitee main zip）不含编译产物；补丁已完成，wrapper 缺失只影响
  # “双击 launcher.exe 自动拉起服务”，不该让整个安装失败。
  Write-Warn2 "未找到 native\linli-launcher-wrapper.exe —— 你下载的应该是源码归档（Source code zip），"
  Write-Warn2 "它只包含源码，没有编译好的启动器包装器。两种解决办法："
  Write-Host "    1.（推荐）到 Release 页下载 LinliLocalMail-Setup.exe 放进游戏根目录运行；"
  Write-Host "       它内置包装器、启动脚本和 Node.js 运行时。"
  Write-Host "    2. 跳过包装器：写信功能不受影响，只是不能通过双击 launcher.exe 自动启动本地服务，"
  Write-Host "       需要先运行 Start-LinliLocalMail.cmd（已在本步写入游戏根目录）再打开游戏。"
  if (-not $NonInteractive) {
    $answer = Read-Host "是否跳过包装器继续完成安装？[Y/n]"
    if ($answer -match '^(n|N)') { Die "本地服务包装器缺失。请下载 Release 页的 LinliLocalMail-Setup.exe 重新安装。" }
  }
  Write-Warn2 "已跳过包装器安装（写信链路不受影响）。"
} else {
  $launcherWrapperInstaller = Join-Path -Path $PSScriptRoot -ChildPath "install-launcher-wrapper.ps1"
  & $launcherWrapperInstaller
  if ($LASTEXITCODE -ne 0) { Die "本地服务包装器安装失败，请把上方错误信息反馈给维护者。" }
  Write-Ok "包装器已安装；官方 launcher.exe 已保留为 launcher.original.exe"
}

# ---- 步骤 6：完成并选择启动 ----
Write-Step "安装完成"
Write-Host "后续步骤："
Write-Host "  1. 打开游戏，进入设置页『本地回信』→『模型管理』，接入你的模型服务并填写 API Key。"
Write-Host "  2. 写一封信测试；等待回信变为未读即表示链路正常。"
Write-Host "  3. 可选：在信箱页『导入』弹窗导入你自己的历史信件（分享链接或 JSON）。"
Write-Host "  4. 之后可直接双击游戏根目录 launcher.exe；它会先确认本地服务，再启动官方启动器。"
Write-Host "  5. 可选：在项目目录运行 npm run doctor 做全面体检（模型未配置时提示未就绪属正常）。"

if ($NoLaunch) {
  Write-Host ""
  Write-Host "已按 -NoLaunch 跳过启动。之后可双击游戏根目录的 launcher.exe 或 Start-LinliLocalMail.cmd 开始使用。"
  exit 0
}

$answer = Read-Host "是否立即启动本地服务并打开游戏？[Y/n]"
if ($answer -match '^(n|N)') {
  Write-Host "完成。之后可双击游戏根目录的 launcher.exe 或 Start-LinliLocalMail.cmd 开始使用。"
  exit 0
}

& (Join-Path $serviceRoot "Start-LinliLocalMail.ps1")
Write-Host ""
Write-Host "本地服务已启动，游戏启动器已打开。祝你和林离通信愉快。" -ForegroundColor Green
