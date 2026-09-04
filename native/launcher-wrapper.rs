#![windows_subsystem = "windows"]

use std::env;
use std::ffi::c_void;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SERVICE_PORT: u16 = 27149;
const SERVICE_TIMEOUT: Duration = Duration::from_secs(30);
const DESKTOP_RUNTIME_ARG: &str = "--linli-desktop-runtime";
const DESKTOP_RUNTIME_MUTEX_NAME: &str = "Local\\LinliLocalMailDesktopRuntime";
// The custom desktop widget remains in the source for future native Gizmo research,
// but the current runtime version must not create or show it.
const DESKTOP_WIDGET_FEATURE_ENABLED: bool = false;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const WAIT_OBJECT_0: u32 = 0x0000_0000;
const WAIT_ABANDONED: u32 = 0x0000_0080;
const INFINITE: u32 = 0xffff_ffff;
const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const INVALID_HANDLE_VALUE: isize = -1;
const STILL_ACTIVE: u32 = 259;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const MB_OK: u32 = 0x0000_0000;
const MB_ICONERROR: u32 = 0x0000_0010;

const DESKTOP_WINDOW_CLASS: &str = "LinliLocalMailDesktopRuntimeWindow";
const MAIL_ROUTE: &str = "/collection";
const MUSIC_ROUTE: &str = "/studio";
const MAIL_BUTTON_ID: u32 = 1001;
const MUSIC_BUTTON_ID: u32 = 1002;
const WM_NCCREATE: u32 = 0x0081;
const WM_NCDESTROY: u32 = 0x0082;
const WM_CREATE: u32 = 0x0001;
const WM_DESTROY: u32 = 0x0002;
const WM_PAINT: u32 = 0x000f;
const WM_ERASEBKGND: u32 = 0x0014;
const WM_MOUSEACTIVATE: u32 = 0x0021;
const WM_DPICHANGED: u32 = 0x02e0;
const WM_COMMAND: u32 = 0x0111;
const WM_QUIT: u32 = 0x0012;
const WM_CLOSE: u32 = 0x0010;
const WM_DRAWITEM: u32 = 0x002b;
const GWLP_USERDATA: i32 = -21;
const BN_CLICKED: u32 = 0;
const MA_NOACTIVATE: isize = 3;
const ODS_SELECTED: u32 = 0x0001;
const DT_SINGLELINE: u32 = 0x0020;
const DT_CENTER: u32 = 0x0001;
const DT_VCENTER: u32 = 0x0004;
const TRANSPARENT: i32 = 1;
const CS_HREDRAW: u32 = 0x0002;
const CS_VREDRAW: u32 = 0x0001;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_TOPMOST: u32 = 0x0000_0008;
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
const WS_POPUP: u32 = 0x8000_0000;
const WS_CHILD: u32 = 0x4000_0000;
const BS_OWNERDRAW: u32 = 0x0000_000b;
const SW_HIDE: i32 = 0;
const SW_SHOWNOACTIVATE: i32 = 4;
const SW_RESTORE: i32 = 9;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_SHOWWINDOW: u32 = 0x0040;
const SWP_HIDEWINDOW: u32 = 0x0080;
const SPI_GETWORKAREA: u32 = 0x0030;
const SM_CXSCREEN: i32 = 0;
const SM_CYSCREEN: i32 = 1;
const HWND_TOPMOST: isize = -1;
const IDC_ARROW: usize = 32512;
const QS_ALLINPUT: u32 = 0x04ff;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: isize = -4;
const GAME_PROCESS_NAME: &str = "Olivia.exe";
const GAME_POLL_INTERVAL: Duration = Duration::from_millis(250);
const GAME_START_GRACE: Duration = Duration::from_secs(30);
const GAME_EXIT_CONFIRM: Duration = Duration::from_secs(2);
const SERVICE_HEALTH_INTERVAL: Duration = Duration::from_secs(2);
const SERVICE_RESTART_MAX: Duration = Duration::from_secs(60);
const SETTINGS_POLL_INTERVAL: Duration = Duration::from_secs(1);

type Hwnd = *mut c_void;
type Hinstance = *mut c_void;
type Hmenu = *mut c_void;
type Hbrush = *mut c_void;
type Hicon = *mut c_void;
type Hcursor = *mut c_void;
type Hdc = *mut c_void;
type Hgdioobj = *mut c_void;
type Wparam = usize;
type Lparam = isize;
type Lresult = isize;
type Bool = i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct Msg {
    hwnd: Hwnd,
    message: u32,
    w_param: Wparam,
    l_param: Lparam,
    time: u32,
    point_x: i32,
    point_y: i32,
    private: u32,
}

#[repr(C)]
struct PaintStruct {
    hdc: Hdc,
    erase: Bool,
    paint_rect: Rect,
    restore: Bool,
    inc_update: Bool,
    reserved: [u8; 32],
}

#[repr(C)]
struct CreateStructW {
    create_params: *mut c_void,
    h_instance: Hinstance,
    h_menu: Hmenu,
    hwnd_parent: Hwnd,
    cy: i32,
    cx: i32,
    y: i32,
    x: i32,
    style: i32,
    name: *const u16,
    class_name: *const u16,
    ex_style: u32,
}

#[repr(C)]
struct DrawItemStruct {
    control_type: u32,
    control_id: u32,
    item_id: u32,
    item_action: u32,
    item_state: u32,
    hwnd_item: Hwnd,
    hdc: Hdc,
    item_rect: Rect,
    item_data: usize,
}

type WindowProc = unsafe extern "system" fn(Hwnd, u32, Wparam, Lparam) -> Lresult;
type EnumWindowsProc = unsafe extern "system" fn(Hwnd, Lparam) -> Bool;

#[repr(C)]
struct WndClassExW {
    size: u32,
    style: u32,
    window_proc: Option<WindowProc>,
    class_extra: i32,
    window_extra: i32,
    instance: Hinstance,
    icon: Hicon,
    cursor: Hcursor,
    background: Hbrush,
    menu_name: *const u16,
    class_name: *const u16,
    small_icon: Hicon,
}

#[repr(C)]
struct ProcessEntry32W {
    size: u32,
    usage: u32,
    process_id: u32,
    default_heap_id: usize,
    module_id: u32,
    threads: u32,
    parent_process_id: u32,
    priority_class_base: i32,
    flags: u32,
    exe_file: [u16; 260],
}

impl Default for ProcessEntry32W {
    fn default() -> Self {
        Self {
            size: 0,
            usage: 0,
            process_id: 0,
            default_heap_id: 0,
            module_id: 0,
            threads: 0,
            parent_process_id: 0,
            priority_class_base: 0,
            flags: 0,
            exe_file: [0; 260],
        }
    }
}

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
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
    fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
    fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
    fn GetExitCodeProcess(process: *mut c_void, exit_code: *mut u32) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(
        window: *mut c_void,
        text: *const u16,
        caption: *const u16,
        kind: u32,
    ) -> i32;
    fn RegisterClassExW(class: *const WndClassExW) -> u16;
    fn UnregisterClassW(class_name: *const u16, instance: Hinstance) -> i32;
    fn GetModuleHandleW(module_name: *const u16) -> Hinstance;
    fn LoadCursorW(instance: Hinstance, cursor_name: *const u16) -> Hcursor;
    fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: Hwnd,
        menu: Hmenu,
        instance: Hinstance,
        create_params: *mut c_void,
    ) -> Hwnd;
    fn DefWindowProcW(window: Hwnd, message: u32, w_param: Wparam, l_param: Lparam) -> Lresult;
    fn SetWindowLongPtrW(window: Hwnd, index: i32, value: Lresult) -> Lresult;
    fn GetWindowLongPtrW(window: Hwnd, index: i32) -> Lresult;
    fn ShowWindow(window: Hwnd, command: i32) -> i32;
    fn UpdateWindow(window: Hwnd) -> i32;
    fn DestroyWindow(window: Hwnd) -> i32;
    fn SetWindowPos(
        window: Hwnd,
        insert_after: Hwnd,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        flags: u32,
    ) -> i32;
    fn GetClientRect(window: Hwnd, rect: *mut Rect) -> i32;
    fn GetDpiForWindow(window: Hwnd) -> u32;
    fn SetProcessDpiAwarenessContext(context: Hwnd) -> i32;
    fn SystemParametersInfoW(action: u32, parameter: u32, data: *mut c_void, flags: u32) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn PeekMessageW(
        message: *mut Msg,
        window: Hwnd,
        minimum: u32,
        maximum: u32,
        remove: u32,
    ) -> i32;
    fn TranslateMessage(message: *const Msg) -> i32;
    fn DispatchMessageW(message: *const Msg) -> Lresult;
    fn PostQuitMessage(exit_code: i32);
    fn PostMessageW(window: Hwnd, message: u32, w_param: Wparam, l_param: Lparam) -> i32;
    fn MsgWaitForMultipleObjects(
        count: u32,
        handles: *const c_void,
        wait_all: i32,
        milliseconds: u32,
        wake_mask: u32,
    ) -> u32;
    fn EnumWindows(callback: Option<EnumWindowsProc>, l_param: Lparam) -> i32;
    fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
    fn IsWindowVisible(window: Hwnd) -> i32;
    fn IsIconic(window: Hwnd) -> i32;
    fn ShowWindowAsync(window: Hwnd, command: i32) -> i32;
    fn BringWindowToTop(window: Hwnd) -> i32;
    fn SetForegroundWindow(window: Hwnd) -> i32;
    fn InvalidateRect(window: Hwnd, rect: *const Rect, erase: i32) -> i32;
    fn BeginPaint(window: Hwnd, paint: *mut PaintStruct) -> Hdc;
    fn EndPaint(window: Hwnd, paint: *const PaintStruct) -> i32;
    fn FillRect(hdc: Hdc, rect: *const Rect, brush: Hbrush) -> i32;
    fn FrameRect(hdc: Hdc, rect: *const Rect, brush: Hbrush) -> i32;
    fn DrawTextW(hdc: Hdc, text: *const u16, length: i32, rect: *mut Rect, format: u32) -> i32;
    fn SetBkMode(hdc: Hdc, mode: i32) -> i32;
    fn SetTextColor(hdc: Hdc, color: u32) -> u32;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateSolidBrush(color: u32) -> Hbrush;
    fn DeleteObject(object: Hgdioobj) -> i32;
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

struct HttpResponse {
    status: u16,
    body: Vec<u8>,
}

fn decode_chunked_body(input: &[u8]) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    let mut cursor = 0;
    loop {
        if cursor > input.len() {
            return None;
        }
        let line_end = input[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")?
            + cursor;
        let size_text = std::str::from_utf8(&input[cursor..line_end]).ok()?;
        let size_text = size_text.split(';').next()?.trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        cursor = line_end + 2;
        if size == 0 {
            return Some(output);
        }
        let data_end = cursor.checked_add(size)?;
        let framed_end = data_end.checked_add(2)?;
        if framed_end > input.len() {
            return None;
        }
        output.extend_from_slice(&input[cursor..data_end]);
        cursor = data_end;
        if &input[cursor..framed_end] != b"\r\n" {
            return None;
        }
        cursor = framed_end;
    }
}

fn http_request(
    method: &str,
    path: &str,
    session: Option<&str>,
    body: Option<&[u8]>,
) -> Result<HttpResponse, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], SERVICE_PORT));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(800))
        .map_err(|error| format!("连接本地服务失败：{error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(token) = session {
        if token.contains('\r') || token.contains('\n') {
            return Err("本地会话 token 包含非法换行".to_string());
        }
        request.push_str("X-Local-Mail-Session: ");
        request.push_str(token);
        request.push_str("\r\n");
    }
    if let Some(payload) = body {
        request.push_str("Content-Type: application/json; charset=utf-8\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("发送本地请求失败：{error}"))?;
    if let Some(payload) = body {
        stream
            .write_all(payload)
            .map_err(|error| format!("发送本地请求正文失败：{error}"))?;
    }

    let mut response = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    while response.len() < 262_144 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => response.extend_from_slice(&chunk[..count]),
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                break;
            }
            Err(error) => return Err(format!("读取本地响应失败：{error}")),
        }
    }

    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "本地响应缺少 HTTP header".to_string())?;
    let header = &response[..header_end];
    let status_line_end = header
        .windows(2)
        .position(|window| window == b"\r\n")
        .unwrap_or(header.len());
    let status_line = std::str::from_utf8(&header[..status_line_end])
        .map_err(|_| "本地响应状态行不是 UTF-8".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "本地响应状态码无效".to_string())?;
    let body = &response[header_end + 4..];
    let header_lower = String::from_utf8_lossy(header).to_ascii_lowercase();
    let body = if header_lower.contains("transfer-encoding: chunked") {
        decode_chunked_body(body).unwrap_or_else(|| body.to_vec())
    } else {
        body.to_vec()
    };
    Ok(HttpResponse { status, body })
}

fn json_field_value_start(body: &[u8], key: &str) -> Option<usize> {
    let mut needle = Vec::with_capacity(key.len() + 2);
    needle.push(b'"');
    needle.extend_from_slice(key.as_bytes());
    needle.push(b'"');
    let mut offset = 0;
    while offset + needle.len() <= body.len() {
        let relative = body[offset..]
            .windows(needle.len())
            .position(|window| window == needle.as_slice())?;
        let key_start = offset + relative;
        let mut cursor = key_start + needle.len();
        while cursor < body.len() && body[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor < body.len() && body[cursor] == b':' {
            cursor += 1;
            while cursor < body.len() && body[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            return Some(cursor);
        }
        offset = key_start + needle.len();
    }
    None
}

fn json_field_is_true(body: &[u8], key: &str) -> bool {
    json_field_value_start(body, key)
        .map(|start| body[start..].starts_with(b"true"))
        .unwrap_or(false)
}

fn json_field_is_zero(body: &[u8], key: &str) -> bool {
    let Some(start) = json_field_value_start(body, key) else {
        return false;
    };
    body[start..].starts_with(b"0")
        && !matches!(body.get(start + 1), Some(b'0'..=b'9'))
}

fn json_string_field(body: &[u8], key: &str) -> Option<String> {
    let mut cursor = json_field_value_start(body, key)?;
    if body.get(cursor) != Some(&b'"') {
        return None;
    }
    cursor += 1;
    let mut value = String::new();
    while cursor < body.len() {
        match body[cursor] {
            b'"' => return Some(value),
            b'\\' => {
                cursor += 1;
                let escaped = *body.get(cursor)?;
                match escaped {
                    b'"' => value.push('"'),
                    b'\\' => value.push('\\'),
                    b'/' => value.push('/'),
                    b'b' => value.push('\u{0008}'),
                    b'f' => value.push('\u{000c}'),
                    b'n' => value.push('\n'),
                    b'r' => value.push('\r'),
                    b't' => value.push('\t'),
                    b'u' => {
                        let end = cursor.checked_add(5)?;
                        let code = u16::from_str_radix(
                            std::str::from_utf8(body.get(cursor + 1..end)?).ok()?,
                            16,
                        )
                        .ok()?;
                        value.push(char::from_u32(code as u32)?);
                        cursor = end - 1;
                    }
                    _ => return None,
                }
            }
            byte if byte.is_ascii() => value.push(byte as char),
            _ => {
                let tail = std::str::from_utf8(&body[cursor..]).ok()?;
                let character = tail.chars().next()?;
                value.push(character);
                cursor += character.len_utf8() - 1;
            }
        }
        cursor += 1;
    }
    None
}

fn api_response_is_ok(response: &HttpResponse) -> bool {
    (200..300).contains(&response.status) && json_field_is_zero(&response.body, "code")
}

fn service_is_ready() -> bool {
    let Ok(response) = http_request("GET", "/health", None, None) else {
        return false;
    };
    response.status == 200 && response_body_has_ok_true(&response.body)
}

fn acquire_named_mutex(name: &str, wait_milliseconds: u32) -> Option<StartupLock> {
    let name = wide_null(name);
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    let result = unsafe { WaitForSingleObject(handle, wait_milliseconds) };
    if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
        Some(StartupLock { handle })
    } else {
        unsafe {
            let _ = CloseHandle(handle);
        }
        None
    }
}

fn acquire_startup_lock() -> Option<StartupLock> {
    acquire_named_mutex("Local\\LinliLocalMailLauncherStartup", INFINITE)
}

fn acquire_desktop_runtime_lock() -> Option<StartupLock> {
    match acquire_named_mutex(DESKTOP_RUNTIME_MUTEX_NAME, 0) {
        Some(lock) => Some(lock),
        None => None,
    }
}

fn spawn_service(game_root: &Path) -> Result<Child, String> {
    let service_root = game_root.join("linli-local-mail");
    let script = service_root.join("server.mjs");
    if !script.is_file() {
        return Err(format!("找不到本地服务入口：{}", script.display()));
    }

    let log_dir = service_root.join("logs");
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("无法创建本地服务日志目录：{error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let stdout_path = log_dir.join(format!("service-{timestamp}.out.log"));
    let stderr_path = log_dir.join(format!("service-{timestamp}.err.log"));
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_path)
        .map_err(|error| format!("无法打开本地服务 stdout 日志：{error}"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .map_err(|error| format!("无法打开本地服务 stderr 日志：{error}"))?;

    let bundled_node = service_root.join("runtime").join("node.exe");
    let executable = if bundled_node.is_file() {
        bundled_node
    } else {
        PathBuf::from("node.exe")
    };
    let attempt = Command::new(&executable)
        .arg("server.mjs")
        .current_dir(&service_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn();
    match attempt {
        Ok(child) => {
            log_line(
                game_root,
                &format!(
                    "starting local service with {} (stdout: {}, stderr: {})",
                    executable.display(),
                    stdout_path.display(),
                    stderr_path.display()
                ),
            );
            Ok(child)
        }
        Err(error) if executable == PathBuf::from("node.exe") => {
            Err(format!("无法启动 PATH 中的 node.exe：{error}"))
        }
        Err(error) => Err(format!(
            "无法启动内置 Node.js：{error}；请确认 runtime\\node.exe 或 PATH 中的 node.exe 可用"
        )),
    }
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

    log_line(game_root, "service not ready; starting local Node.js server");
    let mut process = spawn_service(game_root)?;
    let deadline = Instant::now() + SERVICE_TIMEOUT;
    let mut bootstrap_running = true;
    loop {
        if service_is_ready() {
            log_line(game_root, "service ready");
            return Ok(());
        }
        if bootstrap_running {
            match process.try_wait() {
                Ok(Some(status)) => {
                    log_line(
                        game_root,
                        &format!("service bootstrap exited with {status}"),
                    );
                    if status.success() {
                        bootstrap_running = false;
                        log_line(
                            game_root,
                            "service bootstrap completed; continuing readiness wait",
                        );
                    } else {
                        break;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    log_line(
                        game_root,
                        &format!("failed to query service bootstrap status: {error}"),
                    );
                    break;
                }
            }
        }
        if Instant::now() >= deadline {
            if bootstrap_running {
                let _ = process.kill();
                let _ = process.wait();
            }
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }

    Err(format!(
        "本地服务未能在 {} 秒内就绪。请检查 linli-local-mail\\logs\\service-*.err.log。",
        SERVICE_TIMEOUT.as_secs()
    ))
}

fn stop_service(game_root: &Path) -> Result<(), String> {
    let response = match http_request("GET", "/api/session", None, None) {
        Ok(response) => response,
        Err(_) => {
            log_line(game_root, "service stop requested while service was not running");
            return Ok(());
        }
    };
    if !api_response_is_ok(&response) {
        return Err(format!(
            "GET /api/session 返回 HTTP {} 或 code 非 0，无法停止本地服务",
            response.status
        ));
    }
    let token = json_string_field(&response.body, "token")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "GET /api/session 未返回 token，无法停止本地服务".to_string())?;
    let shutdown = http_request("POST", "/api/shutdown", Some(&token), Some(b"{}"))?;
    if !api_response_is_ok(&shutdown) {
        return Err(format!(
            "POST /api/shutdown 返回 HTTP {} 或 code 非 0",
            shutdown.status
        ));
    }

    let deadline = Instant::now() + SERVICE_TIMEOUT;
    while Instant::now() < deadline {
        if !service_is_ready() {
            log_line(game_root, "service stopped and health is no longer available");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "本地服务未能在 {} 秒内停止：health 仍然可用",
        SERVICE_TIMEOUT.as_secs()
    ))
}

fn has_argument(arguments: &[std::ffi::OsString], expected: &str) -> bool {
    arguments
        .iter()
        .any(|value| value.to_str() == Some(expected))
}

fn forwarded_arguments(arguments: &[std::ffi::OsString]) -> Vec<std::ffi::OsString> {
    arguments
        .iter()
        .filter(|value| {
            !matches!(
                value.to_str(),
                Some("--linli-service-only") | Some("--linli-service-stop")
            )
        })
        .cloned()
        .collect()
}

struct WidgetSettings {
    mail_widget: bool,
    music_widget: bool,
}

struct SessionClient {
    token: Option<String>,
}

impl SessionClient {
    fn new() -> Self {
        Self { token: None }
    }

    fn obtain_session(&mut self) -> Result<(), String> {
        let response = http_request("GET", "/api/session", None, None)?;
        if !api_response_is_ok(&response) {
            return Err(format!(
                "GET /api/session 返回 HTTP {} 或 code 非 0",
                response.status
            ));
        }
        let token = json_string_field(&response.body, "token")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "GET /api/session 未返回 token".to_string())?;
        self.token = Some(token);
        Ok(())
    }

    fn settings_request(&self) -> Result<HttpResponse, String> {
        let token = self
            .token
            .as_deref()
            .ok_or_else(|| "本地服务 session 尚未建立".to_string())?;
        http_request("GET", "/api/settings", Some(token), None)
    }

    fn load_widget_settings(&mut self) -> Result<WidgetSettings, String> {
        if self.token.is_none() {
            self.obtain_session()?;
        }
        let mut response = self.settings_request()?;
        if response.status == 401 {
            self.token = None;
            self.obtain_session()?;
            response = self.settings_request()?;
        }
        if !api_response_is_ok(&response) {
            return Err(format!(
                "GET /api/settings 返回 HTTP {} 或 code 非 0",
                response.status
            ));
        }
        Ok(WidgetSettings {
            mail_widget: json_field_is_true(&response.body, "mailWidget"),
            music_widget: json_field_is_true(&response.body, "musicWidget"),
        })
    }

    fn post_desktop_command(&mut self, route: &'static str) -> Result<(), String> {
        if route != MAIL_ROUTE && route != MUSIC_ROUTE {
            return Err(format!("拒绝未注册的桌面 route：{route}"));
        }
        if self.token.is_none() {
            self.obtain_session()?;
        }
        let payload = format!(r#"{{"route":"{route}"}}"#);
        let mut response = http_request(
            "POST",
            "/api/desktop-command",
            self.token.as_deref(),
            Some(payload.as_bytes()),
        )?;
        if response.status == 401 {
            self.token = None;
            self.obtain_session()?;
            response = http_request(
                "POST",
                "/api/desktop-command",
                self.token.as_deref(),
                Some(payload.as_bytes()),
            )?;
        }
        if !api_response_is_ok(&response) {
            return Err(format!(
                "POST /api/desktop-command 返回 HTTP {} 或 code 非 0",
                response.status
            ));
        }
        Ok(())
    }
}

fn process_name(entry: &ProcessEntry32W) -> String {
    let end = entry
        .exe_file
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(entry.exe_file.len());
    String::from_utf16_lossy(&entry.exe_file[..end])
}

fn process_ids_by_name(target: &str) -> Vec<u32> {
    let mut process_ids = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot as isize == INVALID_HANDLE_VALUE {
            return process_ids;
        }
        let mut entry = ProcessEntry32W::default();
        entry.size = std::mem::size_of::<ProcessEntry32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if process_name(&entry).eq_ignore_ascii_case(target) {
                    process_ids.push(entry.process_id);
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    process_ids
}

fn process_is_alive(process_id: u32) -> Option<bool> {
    if process_id == 0 {
        return Some(false);
    }
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return None;
        }
        let mut exit_code = 0;
        let result = GetExitCodeProcess(process, &mut exit_code);
        let _ = CloseHandle(process);
        if result == 0 {
            None
        } else {
            Some(exit_code == STILL_ACTIVE)
        }
    }
}

fn parse_runtime_parent_pid(arguments: &[std::ffi::OsString]) -> Option<u32> {
    arguments
        .windows(2)
        .find(|values| values[0].to_str() == Some("--linli-runtime-parent-pid"))
        .and_then(|values| values[1].to_str())
        .and_then(|value| value.parse::<u32>().ok())
}

struct ServiceWatchdog {
    next_health_check: Instant,
    next_repair: Instant,
    consecutive_failures: u32,
    had_failure: bool,
}

impl ServiceWatchdog {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            next_health_check: now,
            next_repair: now,
            consecutive_failures: 0,
            had_failure: false,
        }
    }

    fn retry_delay(failures: u32) -> Duration {
        let shift = failures.saturating_sub(1).min(5);
        let seconds = 2_u64.saturating_mul(1_u64 << shift);
        Duration::from_secs(seconds.min(SERVICE_RESTART_MAX.as_secs()))
    }

    fn tick(&mut self, game_root: &Path) {
        let now = Instant::now();
        if now < self.next_health_check {
            return;
        }
        self.next_health_check = now + SERVICE_HEALTH_INTERVAL;
        if service_is_ready() {
            if self.had_failure {
                log_line(game_root, "desktop runtime service watchdog recovered");
            }
            self.had_failure = false;
            self.consecutive_failures = 0;
            self.next_repair = now;
            return;
        }
        self.had_failure = true;
        if now < self.next_repair {
            return;
        }
        log_line(game_root, "desktop runtime service health check failed; attempting safe repair");
        match ensure_service(game_root) {
            Ok(()) => {
                log_line(game_root, "desktop runtime service repair succeeded");
                self.consecutive_failures = 0;
                self.next_repair = now;
            }
            Err(error) => {
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                let delay = Self::retry_delay(self.consecutive_failures);
                self.next_repair = Instant::now() + delay;
                log_line(
                    game_root,
                    &format!(
                        "desktop runtime service repair failed; retry in {} seconds: {error}",
                        delay.as_secs()
                    ),
                );
            }
        }
    }
}

struct DesktopWindowState {
    game_root: PathBuf,
    mail_button: Hwnd,
    music_button: Hwnd,
    mail_widget: bool,
    music_widget: bool,
}

fn rgb(red: u8, green: u8, blue: u8) -> u32 {
    red as u32 | ((green as u32) << 8) | ((blue as u32) << 16)
}

fn scale_for_dpi(value: i32, dpi: u32) -> i32 {
    ((value as i64 * i64::from(dpi.max(96)) + 48) / 96) as i32
}

unsafe fn draw_desktop_button(item: &DrawItemStruct) {
    let selected = item.item_state & ODS_SELECTED != 0;
    let background = if selected {
        rgb(73, 83, 103)
    } else {
        rgb(48, 53, 64)
    };
    let border = rgb(105, 116, 139);
    let text_color = rgb(238, 241, 247);
    let brush = CreateSolidBrush(background);
    if !brush.is_null() {
        let _ = FillRect(item.hdc, &item.item_rect, brush);
        let _ = DeleteObject(brush as Hgdioobj);
    }
    let border_brush = CreateSolidBrush(border);
    if !border_brush.is_null() {
        let _ = FrameRect(item.hdc, &item.item_rect, border_brush);
        let _ = DeleteObject(border_brush as Hgdioobj);
    }
    let label = wide_null(if item.control_id == MAIL_BUTTON_ID {
        "写信"
    } else {
        "音乐"
    });
    let mut text_rect = item.item_rect;
    let _ = SetBkMode(item.hdc, TRANSPARENT);
    let _ = SetTextColor(item.hdc, text_color);
    let _ = DrawTextW(
        item.hdc,
        label.as_ptr(),
        -1,
        &mut text_rect,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE,
    );
}

unsafe fn layout_desktop_window(window: Hwnd, state: &DesktopWindowState) {
    let dpi = GetDpiForWindow(window).max(96);
    let width = scale_for_dpi(196, dpi);
    let height = scale_for_dpi(58, dpi);
    let margin = scale_for_dpi(14, dpi);
    let gap = scale_for_dpi(8, dpi);
    let padding = scale_for_dpi(10, dpi);
    let mut work_area = Rect {
        left: 0,
        top: 0,
        right: GetSystemMetrics(SM_CXSCREEN),
        bottom: GetSystemMetrics(SM_CYSCREEN),
    };
    let _ = SystemParametersInfoW(
        SPI_GETWORKAREA,
        0,
        (&mut work_area as *mut Rect).cast::<c_void>(),
        0,
    );
    let x = (work_area.right - width - margin).max(work_area.left);
    let y = (work_area.bottom - height - margin).max(work_area.top);
    let visible = state.mail_widget || state.music_widget;
    let window_flags = SWP_NOACTIVATE
        | if visible {
            SWP_SHOWWINDOW
        } else {
            SWP_HIDEWINDOW
        };
    let _ = SetWindowPos(
        window,
        HWND_TOPMOST as Hwnd,
        x,
        y,
        width,
        height,
        window_flags,
    );

    let button_width = ((width - padding * 2 - gap) / 2).max(1);
    let button_y = padding;
    let button_height = (height - padding * 2).max(1);
    if !state.mail_button.is_null() {
        let _ = SetWindowPos(
            state.mail_button,
            std::ptr::null_mut(),
            padding,
            button_y,
            button_width,
            button_height,
            SWP_NOACTIVATE
                | if state.mail_widget {
                    SWP_SHOWWINDOW
                } else {
                    SWP_HIDEWINDOW
                },
        );
    }
    if !state.music_button.is_null() {
        let _ = SetWindowPos(
            state.music_button,
            std::ptr::null_mut(),
            padding + button_width + gap,
            button_y,
            button_width,
            button_height,
            SWP_NOACTIVATE
                | if state.music_widget {
                    SWP_SHOWWINDOW
                } else {
                    SWP_HIDEWINDOW
                },
        );
    }
    let _ = ShowWindow(
        window,
        if visible {
            SW_SHOWNOACTIVATE
        } else {
            SW_HIDE
        },
    );
    let _ = InvalidateRect(window, std::ptr::null(), 1);
}

fn dispatch_desktop_command(game_root: &Path, route: &'static str) {
    let mut client = SessionClient::new();
    let command_result = match client.post_desktop_command(route) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            log_line(
                game_root,
                &format!(
                    "desktop command first attempt failed for {route}; ensuring service before one retry: {first_error}"
                ),
            );
            if let Err(ensure_error) = ensure_service(game_root) {
                log_line(
                    game_root,
                    &format!("desktop command retry service ensure failed: {ensure_error}"),
                );
            }
            client
                .post_desktop_command(route)
                .map_err(|retry_error| {
                    format!(
                        "first command attempt failed: {first_error}; retry failed: {retry_error}"
                    )
                })
        }
    };
    let focused_windows = focus_olivia_windows();
    match command_result {
        Ok(()) => log_line(
            game_root,
            &format!(
                "desktop command sent for {route}; Olivia top-level windows focused: {focused_windows}"
            ),
        ),
        Err(error) => log_line(
            game_root,
            &format!(
                "desktop command failed for {route}; Olivia top-level windows found: {focused_windows}: {error}"
            ),
        ),
    }
}

unsafe extern "system" fn desktop_window_proc(
    window: Hwnd,
    message: u32,
    w_param: Wparam,
    l_param: Lparam,
) -> Lresult {
    if message == WM_NCCREATE {
        let create = &*(l_param as *const CreateStructW);
        let state = create.create_params as *mut DesktopWindowState;
        let _ = SetWindowLongPtrW(window, GWLP_USERDATA, state as Lresult);
    }
    let state = GetWindowLongPtrW(window, GWLP_USERDATA) as *mut DesktopWindowState;
    match message {
        WM_CREATE => 0,
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            let mut paint = std::mem::zeroed::<PaintStruct>();
            let hdc = BeginPaint(window, &mut paint);
            if !hdc.is_null() {
                let mut rect = Rect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                let _ = GetClientRect(window, &mut rect);
                let brush = CreateSolidBrush(rgb(28, 31, 38));
                if !brush.is_null() {
                    let _ = FillRect(hdc, &rect, brush);
                    let _ = DeleteObject(brush as Hgdioobj);
                }
            }
            let _ = EndPaint(window, &paint);
            0
        }
        WM_DRAWITEM if l_param != 0 => {
            draw_desktop_button(&*(l_param as *const DrawItemStruct));
            1
        }
        WM_COMMAND if state.is_null() == false => {
            let command_id = (w_param & 0xffff) as u32;
            let notification = ((w_param >> 16) & 0xffff) as u32;
            let route = if notification == BN_CLICKED
                && command_id == MAIL_BUTTON_ID
                && (*state).mail_widget
            {
                Some(MAIL_ROUTE)
            } else if notification == BN_CLICKED
                && command_id == MUSIC_BUTTON_ID
                && (*state).music_widget
            {
                Some(MUSIC_ROUTE)
            } else {
                None
            };
            if let Some(route) = route {
                let game_root = (*state).game_root.clone();
                let _ = thread::Builder::new()
                    .name("linli-desktop-command".to_string())
                    .spawn(move || dispatch_desktop_command(&game_root, route));
            }
            0
        }
        WM_MOUSEACTIVATE => MA_NOACTIVATE,
        WM_DPICHANGED if state.is_null() == false => {
            layout_desktop_window(window, &*state);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        WM_NCDESTROY => {
            let result = DefWindowProcW(window, message, w_param, l_param);
            let _ = SetWindowLongPtrW(window, GWLP_USERDATA, 0);
            result
        }
        _ => DefWindowProcW(window, message, w_param, l_param),
    }
}

fn run_desktop_window(
    game_root: PathBuf,
    ready: Sender<usize>,
    stop: Arc<AtomicBool>,
) {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 as Hwnd,
        );
        let instance = GetModuleHandleW(std::ptr::null());
        if instance.is_null() {
            log_line(&game_root, "desktop runtime could not get module handle");
            let _ = ready.send(0);
            return;
        }
        let class_name = wide_null(DESKTOP_WINDOW_CLASS);
        let class = WndClassExW {
            size: std::mem::size_of::<WndClassExW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            window_proc: Some(desktop_window_proc),
            class_extra: 0,
            window_extra: 0,
            instance,
            icon: std::ptr::null_mut(),
            cursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW as *const u16),
            background: std::ptr::null_mut(),
            menu_name: std::ptr::null(),
            class_name: class_name.as_ptr(),
            small_icon: std::ptr::null_mut(),
        };
        if RegisterClassExW(&class) == 0 {
            log_line(&game_root, "desktop runtime could not register Win32 window class");
            let _ = ready.send(0);
            return;
        }

        let mut state = Box::new(DesktopWindowState {
            game_root: game_root.clone(),
            mail_button: std::ptr::null_mut(),
            music_button: std::ptr::null_mut(),
            mail_widget: false,
            music_widget: false,
        });
        let title = wide_null("林离本地回信");
        let window = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            (&mut *state as *mut DesktopWindowState).cast::<c_void>(),
        );
        if window.is_null() {
            log_line(&game_root, "desktop runtime could not create Win32 window");
            let _ = UnregisterClassW(class_name.as_ptr(), instance);
            let _ = ready.send(0);
            return;
        }

        let button_class = wide_null("BUTTON");
        let mail_text = wide_null("写信");
        let music_text = wide_null("音乐");
        state.mail_button = CreateWindowExW(
            0,
            button_class.as_ptr(),
            mail_text.as_ptr(),
            WS_CHILD | BS_OWNERDRAW,
            0,
            0,
            0,
            0,
            window,
            MAIL_BUTTON_ID as usize as Hmenu,
            instance,
            std::ptr::null_mut(),
        );
        state.music_button = CreateWindowExW(
            0,
            button_class.as_ptr(),
            music_text.as_ptr(),
            WS_CHILD | BS_OWNERDRAW,
            0,
            0,
            0,
            0,
            window,
            MUSIC_BUTTON_ID as usize as Hmenu,
            instance,
            std::ptr::null_mut(),
        );
        if state.mail_button.is_null() {
            log_line(&game_root, "desktop runtime failed to create the 写信 button");
        }
        if state.music_button.is_null() {
            log_line(&game_root, "desktop runtime failed to create the 音乐 button");
        }
        layout_desktop_window(window, &state);
        let _ = UpdateWindow(window);
        let _ = ready.send(window as usize);
        log_line(&game_root, "desktop runtime Win32 window created");

        let mut session = SessionClient::new();
        let mut next_settings_poll = Instant::now();
        let mut last_settings_error: Option<String> = None;
        let mut message = std::mem::zeroed::<Msg>();
        let mut quit = false;
        while !stop.load(Ordering::Acquire) && !quit {
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 1) != 0 {
                if message.message == WM_QUIT {
                    quit = true;
                    break;
                }
                let _ = TranslateMessage(&message);
                let _ = DispatchMessageW(&message);
            }
            if quit || stop.load(Ordering::Acquire) {
                break;
            }
            if Instant::now() >= next_settings_poll {
                match session.load_widget_settings() {
                    Ok(settings) => {
                        last_settings_error = None;
                        if state.mail_widget != settings.mail_widget
                            || state.music_widget != settings.music_widget
                        {
                            state.mail_widget = settings.mail_widget;
                            state.music_widget = settings.music_widget;
                            layout_desktop_window(window, &state);
                            log_line(
                                &game_root,
                                &format!(
                                    "desktop widget settings changed: mailWidget={}, musicWidget={}",
                                    state.mail_widget, state.music_widget
                                ),
                            );
                        }
                    }
                    Err(error) => {
                        if last_settings_error.as_deref() != Some(error.as_str()) {
                            log_line(&game_root, &format!("desktop settings poll failed: {error}"));
                            last_settings_error = Some(error);
                        }
                    }
                }
                next_settings_poll = Instant::now() + SETTINGS_POLL_INTERVAL;
            }
            let _ = MsgWaitForMultipleObjects(0, std::ptr::null(), 0, 250, QS_ALLINPUT);
        }
        stop.store(true, Ordering::Release);
        let _ = DestroyWindow(window);
        let _ = UnregisterClassW(class_name.as_ptr(), instance);
    }
}

struct FocusContext {
    process_ids: Vec<u32>,
    focused_windows: usize,
}

unsafe extern "system" fn focus_window_enum_proc(window: Hwnd, l_param: Lparam) -> Bool {
    let context = &mut *(l_param as *mut FocusContext);
    let mut process_id = 0;
    if GetWindowThreadProcessId(window, &mut process_id) == 0
        || !context.process_ids.iter().any(|value| *value == process_id)
        || (IsWindowVisible(window) == 0 && IsIconic(window) == 0)
    {
        return 1;
    }
    if IsIconic(window) != 0 {
        let _ = ShowWindowAsync(window, SW_RESTORE);
    }
    let _ = BringWindowToTop(window);
    let _ = SetForegroundWindow(window);
    context.focused_windows += 1;
    1
}

fn focus_olivia_windows() -> usize {
    let process_ids = process_ids_by_name(GAME_PROCESS_NAME);
    if process_ids.is_empty() {
        return 0;
    }
    let mut context = FocusContext {
        process_ids,
        focused_windows: 0,
    };
    unsafe {
        let _ = EnumWindows(
            Some(focus_window_enum_proc),
            (&mut context as *mut FocusContext) as Lparam,
        );
    }
    context.focused_windows
}

fn executable_directory() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| format!("无法定位包装器：{error}"))?;
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位游戏根目录".to_string())
}

fn spawn_desktop_runtime(game_root: &Path) -> Result<(), String> {
    let executable = env::current_exe().map_err(|error| format!("无法定位桌面 runtime：{error}"))?;
    log_line(
        game_root,
        &format!("starting detached desktop runtime: {}", executable.display()),
    );
    let child = Command::new(&executable)
        .arg(DESKTOP_RUNTIME_ARG)
        .arg("--linli-runtime-parent-pid")
        .arg(std::process::id().to_string())
        .current_dir(game_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|error| format!("无法分离启动桌面 runtime：{error}"))?;
    drop(child);
    Ok(())
}

fn run_desktop_runtime(game_root: &Path, arguments: &[std::ffi::OsString]) -> i32 {
    let Some(_runtime_lock) = acquire_desktop_runtime_lock() else {
        log_line(game_root, "desktop runtime already running; exiting duplicate");
        return 0;
    };
    log_line(game_root, "desktop runtime entered");

    let stop_window = Arc::new(AtomicBool::new(false));
    let (gui_thread, window_handle) = if DESKTOP_WIDGET_FEATURE_ENABLED {
        let (window_sender, window_receiver) = std::sync::mpsc::channel();
        let gui_stop = Arc::clone(&stop_window);
        let gui_root = game_root.to_path_buf();
        let gui_thread = match thread::Builder::new()
            .name("linli-desktop-window".to_string())
            .spawn(move || run_desktop_window(gui_root, window_sender, gui_stop))
        {
            Ok(thread) => Some(thread),
            Err(error) => {
                log_line(
                    game_root,
                    &format!("desktop runtime window thread failed to start: {error}"),
                );
                None
            }
        };
        let window_handle = gui_thread.as_ref().and_then(|_| {
            match window_receiver.recv_timeout(Duration::from_secs(3)) {
                Ok(handle) if handle != 0 => Some(handle),
                Ok(_) => None,
                Err(_) => {
                    log_line(game_root, "desktop runtime window did not become ready");
                    None
                }
            }
        });
        (gui_thread, window_handle)
    } else {
        log_line(
            game_root,
            "desktop runtime Win32 widget disabled for current version",
        );
        (None, None)
    };

    let parent_process_id = parse_runtime_parent_pid(arguments);
    let started_at = Instant::now();
    let mut watchdog = ServiceWatchdog::new();
    let mut saw_game = false;
    let mut last_game_seen = started_at;
    loop {
        watchdog.tick(game_root);
        let game_running = !process_ids_by_name(GAME_PROCESS_NAME).is_empty();
        let now = Instant::now();
        if game_running {
            if !saw_game {
                log_line(game_root, "desktop runtime observed Olivia.exe");
            }
            saw_game = true;
            last_game_seen = now;
        } else if saw_game && now.duration_since(last_game_seen) >= GAME_EXIT_CONFIRM {
            log_line(game_root, "desktop runtime confirmed Olivia.exe exited");
            break;
        } else if !saw_game
            && now.duration_since(started_at) >= GAME_START_GRACE
            && parent_process_id
                .and_then(process_is_alive)
                .is_some_and(|alive| !alive)
        {
            log_line(
                game_root,
                "desktop runtime launch parent exited before Olivia.exe appeared",
            );
            break;
        }
        thread::sleep(GAME_POLL_INTERVAL);
    }

    stop_window.store(true, Ordering::Release);
    if let Some(handle) = window_handle {
        unsafe {
            let _ = PostMessageW(handle as Hwnd, WM_CLOSE, 0, 0);
        }
    }
    if let Some(thread) = gui_thread {
        let _ = thread.join();
    }
    log_line(game_root, "desktop runtime exited");
    0
}

fn launch_original(game_root: &Path, arguments: &[std::ffi::OsString]) -> Result<i32, String> {
    let original = game_root.join("launcher.original.exe");
    if !original.is_file() {
        return Err(format!(
            "找不到官方启动器备份：{}。请重新安装包装器或恢复官方启动器备份。",
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
        .is_some_and(|value| value == DESKTOP_RUNTIME_ARG)
    {
        return run_desktop_runtime(&game_root, &arguments);
    }

    if has_argument(&arguments, "--linli-service-stop") {
        return match stop_service(&game_root) {
            Ok(()) => 0,
            Err(error) => {
                log_line(&game_root, &format!("service stop failed: {error}"));
                show_error(&error);
                1
            }
        };
    }

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

    if has_argument(&arguments, "--linli-service-only") {
        log_line(&game_root, "service-only mode completed");
        return 0;
    }

    if let Err(error) = spawn_desktop_runtime(&game_root) {
        log_line(&game_root, &format!("desktop runtime launch failed: {error}"));
    }

    let launch_arguments = forwarded_arguments(&arguments);
    match launch_original(&game_root, &launch_arguments) {
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
