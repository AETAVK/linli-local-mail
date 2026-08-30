#![windows_subsystem = "windows"]

use std::env;
use std::ffi::c_void;
use std::fs;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MB_OK: u32 = 0x0000_0000;
const MB_YESNO: u32 = 0x0000_0004;
const MB_ICONERROR: u32 = 0x0000_0010;
const MB_ICONQUESTION: u32 = 0x0000_0020;
const MB_ICONINFORMATION: u32 = 0x0000_0040;
const IDYES: i32 = 6;
const BIF_RETURNONLYFSDIRS: u32 = 0x0000_0001;
const BIF_NEWDIALOGSTYLE: u32 = 0x0000_0040;
const COINIT_APARTMENTTHREADED: u32 = 0x0000_0002;
const SYNCHRONIZE: u32 = 0x0010_0000;
const WAIT_OBJECT_0: u32 = 0x0000_0000;
const WAIT_TIMEOUT: u32 = 0x0000_0102;

static PAYLOAD: &[u8] = include_bytes!(env!("LINLI_INSTALLER_PAYLOAD"));

#[repr(C)]
struct BrowseInfoW {
    hwnd_owner: *mut c_void,
    pidl_root: *mut c_void,
    psz_display_name: *mut u16,
    lpsz_title: *const u16,
    ul_flags: u32,
    lpfn: Option<unsafe extern "system" fn(*mut c_void, u32, isize, isize) -> i32>,
    l_param: isize,
    i_image: i32,
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, co_init: u32) -> i32;
    fn CoUninitialize();
    fn CoTaskMemFree(pointer: *mut c_void);
}

#[link(name = "shell32")]
extern "system" {
    fn SHBrowseForFolderW(info: *const BrowseInfoW) -> *mut c_void;
    fn SHGetPathFromIDListW(item_id_list: *const c_void, path: *mut u16) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(
        window: *mut c_void,
        text: *const u16,
        caption: *const u16,
        kind: u32,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn show_message(message: &str, caption: &str, kind: u32) -> i32 {
    let text = wide_null(message);
    let title = wide_null(caption);
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), kind) }
}

fn select_folder() -> Option<PathBuf> {
    let co_initialized = unsafe { CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED) } >= 0;
    let mut display_name = [0_u16; 260];
    let title = wide_null("请选择 BSide Olivia Lin Test 游戏根目录（应包含 0.0.9.627 和 launcher.exe）");
    let info = BrowseInfoW {
        hwnd_owner: std::ptr::null_mut(),
        pidl_root: std::ptr::null_mut(),
        psz_display_name: display_name.as_mut_ptr(),
        lpsz_title: title.as_ptr(),
        ul_flags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
        lpfn: None,
        l_param: 0,
        i_image: 0,
    };

    let item_id_list = unsafe { SHBrowseForFolderW(&info) };
    let result = if item_id_list.is_null() {
        None
    } else {
        let mut path = [0_u16; 32768];
        let success = unsafe { SHGetPathFromIDListW(item_id_list, path.as_mut_ptr()) } != 0;
        unsafe { CoTaskMemFree(item_id_list) };
        if success {
            let length = path.iter().position(|value| *value == 0).unwrap_or(path.len());
            let value = String::from_utf16_lossy(&path[..length]);
            if value.is_empty() { None } else { Some(PathBuf::from(value)) }
        } else {
            None
        }
    };

    if co_initialized {
        unsafe { CoUninitialize() };
    }
    result
}

fn argument_value(name: &str) -> Option<String> {
    let arguments: Vec<String> = env::args().collect();
    let prefix = format!("{name}=");
    for (index, argument) in arguments.iter().enumerate() {
        if let Some(value) = argument.strip_prefix(&prefix) {
            return Some(value.to_string());
        }
        if argument == name {
            return arguments.get(index + 1).cloned();
        }
    }
    None
}

fn has_argument(name: &str) -> bool {
    env::args().any(|argument| argument == name)
}

fn wait_for_process_exit(process_id: u32) -> Result<(), String> {
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, process_id) };
    if handle.is_null() {
        return Ok(());
    }
    let result = unsafe { WaitForSingleObject(handle, 15_000) };
    unsafe { CloseHandle(handle) };
    if result == WAIT_OBJECT_0 {
        Ok(())
    } else if result == WAIT_TIMEOUT {
        Err("本地回信服务未能及时退出，请关闭游戏后重新运行安装包。".to_string())
    } else {
        Err("等待本地回信服务退出时发生系统错误。".to_string())
    }
}

fn is_game_root(path: &Path) -> bool {
    path.join("0.0.9.627")
        .join("resources")
        .join("feapp.dat")
        .is_file()
        && path.join("launcher.exe").is_file()
}

fn resolve_game_root() -> Result<Option<PathBuf>, String> {
    if let Some(value) = argument_value("--game-root") {
        let requested = PathBuf::from(value);
        if is_game_root(&requested) {
            return Ok(Some(requested));
        }
        if requested.file_name().and_then(|name| name.to_str()) == Some("linli-local-mail") {
            if let Some(parent) = requested.parent() {
                if is_game_root(parent) {
                    return Ok(Some(parent.to_path_buf()));
                }
            }
        }
        return Err(format!(
            "所选目录不是有效的游戏根目录：{}\n需要同时存在 0.0.9.627\\resources\\feapp.dat 和 launcher.exe。",
            requested.display()
        ));
    }

    // 推荐的接收者流程是把安装器放到游戏根目录后直接双击。
    // 若从下载目录运行，则继续使用目录选择框作为兜底。
    if let Ok(executable) = env::current_exe() {
        if let Some(parent) = executable.parent() {
            if is_game_root(parent) {
                return Ok(Some(parent.to_path_buf()));
            }
        }
    }

    let Some(selected) = select_folder() else {
        return Ok(None);
    };
    if is_game_root(&selected) {
        return Ok(Some(selected));
    }
    Err(format!(
        "所选目录不是有效的游戏根目录：{}\n需要同时存在 0.0.9.627\\resources\\feapp.dat 和 launcher.exe。",
        selected.display()
    ))
}

fn output_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("{stdout}{stderr}").trim().to_string()
}

fn write_log(path: &Path, content: &str) {
    if let Ok(mut file) = fs::File::create(path) {
        let _ = file.write_all(content.as_bytes());
    }
}

fn run_powershell_script(script: &Path, arguments: &[&Path], current_dir: &Path) -> Result<Output, String> {
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script);
    for argument in arguments {
        command.arg(argument);
    }
    command
        .current_dir(current_dir)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("无法启动 PowerShell：{error}"))
}

fn run_install_script(script: &Path, service_root: &Path) -> Result<Output, String> {
    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(["-NoLaunch", "-NonInteractive"])
        .current_dir(service_root)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("无法启动安装脚本：{error}"))
}

fn install(game_root: &Path, silent: bool, confirmed_update: bool) -> Result<(), String> {
    let service_root = game_root.join("linli-local-mail");
    if service_root.exists() && !silent && !confirmed_update {
        let answer = show_message(
            "检测到已有林离本地回信目录。请先关闭正在运行的游戏窗口；安装器只会覆盖程序文件，不会删除 data、logs 或 backups。是否继续？",
            "林离本地回信 - 更新安装",
            MB_YESNO | MB_ICONQUESTION,
        );
        if answer != IDYES {
            return Ok(());
        }
    }

    let temporary_root = env::temp_dir().join(format!("linli-local-mail-installer-{}", std::process::id()));
    fs::create_dir_all(&temporary_root).map_err(|error| format!("无法创建临时目录：{error}"))?;
    let payload_zip = temporary_root.join("payload.zip");
    let extract_script = temporary_root.join("extract-payload.ps1");
    let extract_log = temporary_root.join("extract-payload.log");
    let install_log = temporary_root.join("install.log");
    let extract_script_content = r#"
param(
  [Parameter(Mandatory=$true)][string]$Zip,
  [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = "Stop"
# 预清理：zip 中是文件、目标中却存在同名【目录】的冲突。
# 常见于此前用其他工具（资源管理器/部分解压器）解压过旧 zip 的机器——目录条目
# 处理出错会把 backup.mjs 等文件名建成目录，Expand-Archive 写入被拒后在回滚时
# 又报 PathNotFound，掩盖真实原因。
$tar = Join-Path $env:SystemRoot "system32\tar.exe"
if (Test-Path $tar) {
  $entries = & $tar -tf $Zip
  foreach ($entry in $entries) {
    if ($entry.EndsWith("/")) { continue }
    $name = $entry.TrimStart("./")
    if (-not $name) { continue }
    $target = Join-Path $Destination ($name -replace "/", "\")
    if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).PSIsContainer) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }
  # bsdtar 对 tar 风格流式 zip 支持完整，优先使用
  & $tar -xf $Zip -C $Destination
  if ($LASTEXITCODE -eq 0) { exit 0 }
  # bsdtar 失败则回退到 Expand-Archive（预清理已消除最常见冲突）
  Expand-Archive -LiteralPath $Zip -DestinationPath $Destination -Force
} else {
  Expand-Archive -LiteralPath $Zip -DestinationPath $Destination -Force
}
"#;

    if let Err(error) = fs::write(&payload_zip, PAYLOAD) {
        let _ = fs::remove_dir_all(&temporary_root);
        return Err(format!("无法写入安装载荷：{error}"));
    }
    if let Err(error) = fs::write(&extract_script, extract_script_content) {
        let _ = fs::remove_dir_all(&temporary_root);
        return Err(format!("无法准备解压步骤：{error}"));
    }

    let extraction = run_powershell_script(&extract_script, &[&payload_zip, game_root], game_root)?;
    write_log(&extract_log, &output_text(&extraction));
    if !extraction.status.success() {
        return Err(format!(
            "解压安装文件失败。详细日志：{}\n{}",
            extract_log.display(),
            output_text(&extraction)
        ));
    }

    let install_script = service_root.join("tools").join("install.ps1");
    if !install_script.is_file() {
        return Err(format!("解压后找不到安装脚本：{}", install_script.display()));
    }
    let installation = run_install_script(&install_script, &service_root)?;
    write_log(&install_log, &output_text(&installation));
    if !installation.status.success() {
        return Err(format!(
            "游戏文件安装失败。详细日志：{}\n{}",
            install_log.display(),
            output_text(&installation)
        ));
    }

    let _ = fs::remove_dir_all(&temporary_root);
    if !silent {
        show_message(
            &format!(
                "安装完成。\n\n已保留原 launcher，并安装本地服务包装器。之后可直接双击：\n{}",
                game_root.join("launcher.exe").display()
            ),
            "林离本地回信 - 安装完成",
            MB_OK | MB_ICONINFORMATION,
        );
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let silent = has_argument("--silent");
    let confirmed_update = has_argument("--confirmed-update");
    if let Some(value) = argument_value("--wait-pid") {
        let process_id = value
            .parse::<u32>()
            .map_err(|_| "更新等待进程 ID 无效。".to_string())?;
        wait_for_process_exit(process_id)?;
    }
    let Some(game_root) = resolve_game_root()? else {
        return Ok(());
    };
    install(&game_root, silent, confirmed_update)
}

fn main() {
    if let Err(error) = run() {
        show_message(&error, "林离本地回信 - 安装失败", MB_OK | MB_ICONERROR);
        std::process::exit(1);
    }
}
