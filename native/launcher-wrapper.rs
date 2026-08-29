#![windows_subsystem = "windows"]

use std::env;
use std::ffi::c_void;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SERVICE_PORT: u16 = 27149;
const SERVICE_TIMEOUT: Duration = Duration::from_secs(30);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const WAIT_OBJECT_0: u32 = 0x0000_0000;
const WAIT_ABANDONED: u32 = 0x0000_0080;
const INFINITE: u32 = 0xffff_ffff;
const MB_OK: u32 = 0x0000_0000;
const MB_ICONERROR: u32 = 0x0000_0010;

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(
        lp_mutex_attributes: *mut c_void,
        b_initial_owner: i32,
        lp_name: *const u16,
    ) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn ReleaseMutex(handle: *mut c_void) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
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

struct StartupLock {
    handle: *mut c_void,
}

impl Drop for StartupLock {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.handle);
            let _ = CloseHandle(self.handle);
        }
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn log_line(game_root: &Path, message: &str) {
    let log_directory = game_root.join("linli-local-mail").join("logs");
    if fs::create_dir_all(&log_directory).is_err() {
        return;
    }
    let path = log_directory.join("launcher-wrapper.log");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{now}] {message}");
    }
}

fn show_error(message: &str) {
    let text = wide_null(message);
    let caption = wide_null("林离本地回信");
    unsafe {
        let _ = MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn response_body_has_ok_true(body: &[u8]) -> bool {
    let key = b"\"ok\"";
    let mut offset = 0;
    while offset + key.len() <= body.len() {
        let Some(relative) = body[offset..]
            .windows(key.len())
            .position(|window| window == key)
        else {
            break;
        };
        let key_start = offset + relative;
        let mut cursor = key_start + key.len();
        while cursor < body.len() && body[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor < body.len() && body[cursor] == b':' {
            cursor += 1;
            while cursor < body.len() && body[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if body[cursor..].starts_with(b"true") {
                return true;
            }
        }
        offset = key_start + key.len();
    }
    false
}

fn service_is_ready() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], SERVICE_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(600)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let request = b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }

    let mut response = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    while response.len() < 65_536 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => response.extend_from_slice(&chunk[..count]),
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                break;
            }
            Err(_) => return false,
        }
    }

    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let header = &response[..header_end];
    if !(header.starts_with(b"HTTP/1.1 200") || header.starts_with(b"HTTP/1.0 200")) {
        return false;
    }
    response_body_has_ok_true(&response[header_end + 4..])
}

fn acquire_startup_lock() -> Option<StartupLock> {
    let name = wide_null("Local\\LinliLocalMailLauncherStartup");
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    let result = unsafe { WaitForSingleObject(handle, INFINITE) };
    if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
        Some(StartupLock { handle })
    } else {
        unsafe {
            let _ = CloseHandle(handle);
        }
        None
    }
}

fn spawn_service(game_root: &Path, script: &Path) -> Result<Child, String> {
    let arguments = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
    ];
    let shells = ["powershell.exe", "pwsh.exe"];
    let mut last_error = String::from("未找到 PowerShell");
    for shell in shells {
        let attempt = Command::new(shell)
            .args(arguments)
            .arg(script)
            .arg("-NoGame")
            .current_dir(game_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        match attempt {
            Ok(child) => return Ok(child),
            Err(error) => last_error = format!("{shell}: {error}"),
        }
    }
    Err(last_error)
}

fn ensure_service(game_root: &Path) -> Result<(), String> {
    if service_is_ready() {
        log_line(game_root, "service already ready");
        return Ok(());
    }

    let _lock = acquire_startup_lock();
    if service_is_ready() {
        log_line(game_root, "service became ready while waiting for startup lock");
        return Ok(());
    }

    let script = game_root
        .join("linli-local-mail")
        .join("Start-LinliLocalMail.ps1");
    if !script.is_file() {
        return Err(format!("找不到本地服务启动脚本：{}", script.display()));
    }
    log_line(game_root, "service not ready; starting Start-LinliLocalMail.ps1 -NoGame");
    let mut process = spawn_service(game_root, &script)?;
    let deadline = Instant::now() + SERVICE_TIMEOUT;
    loop {
        if service_is_ready() {
            log_line(game_root, "service ready");
            return Ok(());
        }
        if let Ok(Some(status)) = process.try_wait() {
            log_line(game_root, &format!("service bootstrap exited with {status}"));
            break;
        }
        if Instant::now() >= deadline {
            let _ = process.kill();
            let _ = process.wait();
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }

    Err(format!(
        "本地服务未能在 {} 秒内就绪。请检查 linli-local-mail\\logs\\service-*.err.log。",
        SERVICE_TIMEOUT.as_secs()
    ))
}

fn executable_directory() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| format!("无法定位包装器：{error}"))?;
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位游戏根目录".to_string())
}

fn launch_original(game_root: &Path, arguments: &[std::ffi::OsString]) -> Result<i32, String> {
    let original = game_root.join("launcher.original.exe");
    if !original.is_file() {
        return Err(format!(
            "找不到官方启动器备份：{}。请运行 linli-local-mail\\tools\\restore-launcher.ps1 或重新安装包装器。",
            original.display()
        ));
    }
    log_line(
        game_root,
        &format!("launching official launcher backup: {}", original.display()),
    );
    let mut process = Command::new(&original)
        .args(arguments)
        .current_dir(game_root)
        .spawn()
        .map_err(|error| format!("无法启动官方启动器备份：{error}"))?;
    let status = process
        .wait()
        .map_err(|error| format!("等待官方启动器结束时出错：{error}"))?;
    Ok(status.code().unwrap_or(0))
}

fn run() -> i32 {
    let Ok(game_root) = executable_directory() else {
        show_error("无法定位游戏根目录，启动已取消。");
        return 1;
    };
    let arguments: Vec<std::ffi::OsString> = env::args_os().skip(1).collect();

    if arguments
        .first()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value == "--linli-wrapper-check")
    {
        return match ensure_service(&game_root) {
            Ok(()) => 0,
            Err(error) => {
                log_line(&game_root, &format!("wrapper check failed: {error}"));
                show_error(&error);
                1
            }
        };
    }

    if let Err(error) = ensure_service(&game_root) {
        log_line(&game_root, &format!("startup blocked: {error}"));
        show_error(&format!("本地服务启动失败，游戏未启动。\n\n{error}"));
        return 1;
    }

    match launch_original(&game_root, &arguments) {
        Ok(code) => code,
        Err(error) => {
            log_line(&game_root, &format!("official launcher failed: {error}"));
            show_error(&error);
            1
        }
    }
}

fn main() {
    std::process::exit(run());
}
