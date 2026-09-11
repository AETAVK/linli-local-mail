use std::env;
use std::ffi::c_void;
use std::io::{Read, Write};
use std::path::Path;

const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x0000_0001;
const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
const INVALID_HANDLE_VALUE: isize = -1;

type Handle = *mut c_void;

// OPENFILENAMEW Win32 layout (Windows SDK commdlg.h; _MAC fields excluded).
#[repr(C)]
struct OpenFileName {
    size:u32, owner:Handle, instance:Handle, filter:*const u16, custom_filter:*mut u16,
    max_custom_filter:u32, filter_index:u32, file:*mut u16, max_file:u32,
    file_title:*mut u16, max_file_title:u32, initial_dir:*const u16, title:*const u16,
    flags:u32, file_offset:u16, file_extension:u16, default_extension:*const u16,
    custom_data:isize, hook:*const c_void, template_name:*const u16, reserved:*mut c_void,
    reserved_word:u32, flags_ex:u32,
}
#[cfg(target_arch="x86_64")]
const _: [();152] = [();std::mem::size_of::<OpenFileName>()];
#[link(name="comdlg32")]
extern "system" {
    fn GetOpenFileNameW(info:*mut OpenFileName)->i32;
    fn CommDlgExtendedError()->u32;
}
fn command_choose_diagnostic_files(arguments:&[String])->Result<i32,String> {
    if !arguments.is_empty(){return Err("choose-diagnostic-files does not accept arguments".into());}
    let input=String::from_utf8(read_stdin()?).map_err(|_|"invalid initial folder")?;
    if input.len()>16384||input.contains('\0')||(!input.is_empty()&&!Path::new(&input).is_absolute()){return Err("invalid initial folder".into());}
    let initial:Vec<u16>=input.encode_utf16().chain(Some(0)).collect();
    let title:Vec<u16>="选择诊断资料（可多选，不修改文件）".encode_utf16().chain(Some(0)).collect();
    let filter:Vec<u16>="歌曲诊断资料\0*.log;*.bak;*.old;*.txt;*.gz;*.json;*.sqlite;*.sqlite3;*.db\0所有文件\0*.*\0\0".encode_utf16().collect();
    let mut buffer=vec![0u16;131072];
    let mut info:OpenFileName=unsafe{std::mem::zeroed()};
    info.size=std::mem::size_of::<OpenFileName>() as u32;info.filter=filter.as_ptr();info.filter_index=1;
    info.file=buffer.as_mut_ptr();info.max_file=buffer.len() as u32;info.initial_dir=initial.as_ptr();info.title=title.as_ptr();
    // Explorer, multiselect, path/file must exist, no CWD change, no Recent Documents shortcut.
    info.flags=0x00080000|0x00000200|0x00001000|0x00000800|0x00000008|0x02000000|0x00100000;
    if unsafe{GetOpenFileNameW(&mut info)}==0{
        if unsafe{CommDlgExtendedError()}!=0{return Err("diagnostic file dialog failed".into());}
        write_stdout(b"{\"cancelled\":true,\"paths\":[]}")?;return Ok(0);
    }
    let mut parts=Vec::new();let mut start=0;
    while start<buffer.len()&&buffer[start]!=0{
        let end=start+buffer[start..].iter().position(|u|*u==0).ok_or("invalid selection")?;
        parts.push(String::from_utf16(&buffer[start..end]).map_err(|_|"invalid selection encoding")?);start=end+1;
    }
    if parts.is_empty()||parts.len()>33{return Err("select at most 32 files".into());}
    let paths:Vec<String>=if parts.len()==1{parts}else{parts[1..].iter().map(|name|Path::new(&parts[0]).join(name).to_string_lossy().into_owned()).collect()};
    if paths.iter().any(|p|p.len()>16384||!Path::new(p).is_absolute()||!Path::new(p).is_file()){return Err("invalid file selection".into());}
    write_stdout(format!("{{\"cancelled\":false,\"paths\":[{}]}}",paths.iter().map(|p|json_escape(p)).collect::<Vec<_>>().join(",")).as_bytes())?;
    Ok(0)
}

#[repr(C)]
struct BrowseInfo {
    owner: Handle, root: *const c_void, display: *mut u16, title: *const u16, flags: u32,
    callback: Option<unsafe extern "system" fn(Handle, u32, isize, isize) -> i32>, parameter: isize, image: i32,
}
#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
    fn CoUninitialize();
    fn CoTaskMemFree(memory: *mut c_void);
}
#[link(name = "shell32")]
extern "system" {
    fn SHBrowseForFolderW(info: *const BrowseInfo) -> *mut c_void;
    fn SHGetPathFromIDListEx(id: *const c_void, path: *mut u16, length: u32, flags: u32) -> i32;
}
#[link(name = "user32")]
extern "system" {
    fn SendMessageW(window: Handle, message: u32, wparam: usize, lparam: isize) -> isize;
    fn SetForegroundWindow(window: Handle) -> i32;
}
unsafe extern "system" fn folder_callback(window: Handle, message: u32, _value: isize, initial: isize) -> i32 {
    if message == 1 {
        if initial != 0 { SendMessageW(window, 0x467, 1, initial); } // BFFM_SETSELECTIONW
        SetForegroundWindow(window);
    }
    0
}
fn command_choose_song_folder(arguments: &[String]) -> Result<i32, String> {
    if !arguments.is_empty() { return Err("choose-song-folder does not accept arguments".into()); }
    let input = String::from_utf8(read_stdin()?).map_err(|_| "folder must be UTF-8")?;
    if input.len() > 16384 || input.contains('\0') || (!input.is_empty() && !Path::new(&input).is_absolute()) { return Err("invalid initial folder".into()); }
    let initial: Vec<u16> = input.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "选择歌曲下载文件夹（包含 midi_… 子文件夹）".encode_utf16().chain(Some(0)).collect();
    let mut display = [0u16; 260]; let mut selected = vec![0u16; 4097];
    unsafe {
        if CoInitializeEx(std::ptr::null_mut(), 2) < 0 { return Err("folder dialog initialization failed".into()); }
        let info = BrowseInfo { owner: std::ptr::null_mut(), root: std::ptr::null(), display: display.as_mut_ptr(), title: title.as_ptr(),
            flags: 0x0001 | 0x0040 | 0x0010 | 0x0200, callback: Some(folder_callback), parameter: initial.as_ptr() as isize, image: 0 };
        let id = SHBrowseForFolderW(&info);
        if id.is_null() { CoUninitialize(); write_stdout(b"{\"cancelled\":true,\"path\":null}")?; return Ok(0); }
        let valid = SHGetPathFromIDListEx(id, selected.as_mut_ptr(), selected.len() as u32, 0);
        CoTaskMemFree(id); CoUninitialize();
        if valid == 0 { return Err("selected item is not a filesystem folder".into()); }
    }
    let end = selected.iter().position(|unit| *unit == 0).ok_or("folder is too long")?;
    let value = String::from_utf16(&selected[..end]).map_err(|_| "invalid folder encoding")?;
    if !Path::new(&value).is_dir() { return Err("selected folder is not accessible".into()); }
    write_stdout(format!("{{\"cancelled\":false,\"path\":{}}}", json_escape(&value)).as_bytes())?;
    Ok(0)
}

#[repr(C)]
struct DataBlob {
    size: u32,
    data: *mut u8,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct FileTime {
    low: u32,
    high: u32,
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
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
            size: std::mem::size_of::<Self>() as u32,
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

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        input: *const DataBlob,
        description: *const u16,
        optional_entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        output: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const DataBlob,
        description: *mut *mut u16,
        optional_entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        output: *mut DataBlob,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: Handle) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
    fn GetProcessTimes(
        process: Handle,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        buffer: *mut u16,
        size: *mut u32,
    ) -> i32;
}

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(
        process: Handle,
        information_class: u32,
        information: *mut c_void,
        information_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

struct OwnedHandle(Handle);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 as isize != INVALID_HANDLE_VALUE {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[derive(Clone)]
struct ProcessIdentity {
    pid: u32,
    name: String,
    executable_path: String,
    command_line: String,
    creation_date: String,
}

fn windows_error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}

fn read_stdin() -> Result<Vec<u8>, String> {
    let mut input = Vec::new();
    std::io::stdin()
        .read_to_end(&mut input)
        .map_err(|error| format!("failed to read stdin: {error}"))?;
    Ok(input)
}

fn write_stdout(bytes: &[u8]) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(bytes)
        .and_then(|_| stdout.flush())
        .map_err(|error| format!("failed to write stdout: {error}"))
}

fn dpapi_protect(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut owned_input = input.to_vec();
    let input_blob = DataBlob {
        size: owned_input.len().try_into().map_err(|_| "DPAPI input is too large")?,
        data: owned_input.as_mut_ptr(),
    };
    let mut output_blob = DataBlob {
        size: 0,
        data: std::ptr::null_mut(),
    };
    let result = unsafe {
        CryptProtectData(
            &input_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output_blob,
        )
    };
    if result == 0 {
        return Err(windows_error("CryptProtectData failed"));
    }
    let output = if output_blob.size == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output_blob.data, output_blob.size as usize) }.to_vec()
    };
    unsafe {
        if !output_blob.data.is_null() {
            let _ = LocalFree(output_blob.data.cast());
        }
    }
    Ok(output)
}

fn dpapi_unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut owned_input = input.to_vec();
    let input_blob = DataBlob {
        size: owned_input.len().try_into().map_err(|_| "DPAPI input is too large")?,
        data: owned_input.as_mut_ptr(),
    };
    let mut output_blob = DataBlob {
        size: 0,
        data: std::ptr::null_mut(),
    };
    let result = unsafe {
        CryptUnprotectData(
            &input_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output_blob,
        )
    };
    if result == 0 {
        return Err(windows_error("CryptUnprotectData failed"));
    }
    let output = if output_blob.size == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output_blob.data, output_blob.size as usize) }.to_vec()
    };
    unsafe {
        if !output_blob.data.is_null() {
            let _ = LocalFree(output_blob.data.cast());
        }
    }
    Ok(output)
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(input: &[u8]) -> String {
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(BASE64[(first >> 2) as usize] as char);
        output.push(BASE64[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(BASE64[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(BASE64[(third & 0x3f) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn base64_value(value: u8) -> Option<u8> {
    match value {
        b'A'..=b'Z' => Some(value - b'A'),
        b'a'..=b'z' => Some(value - b'a' + 26),
        b'0'..=b'9' => Some(value - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn base64_decode(input: &[u8]) -> Result<Vec<u8>, String> {
    let compact: Vec<u8> = input
        .iter()
        .copied()
        .filter(|value| !value.is_ascii_whitespace())
        .collect();
    if compact.is_empty() {
        return Ok(Vec::new());
    }
    if compact.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }
    let mut output = Vec::with_capacity(compact.len() / 4 * 3);
    for (index, chunk) in compact.chunks_exact(4).enumerate() {
        let last = index + 1 == compact.len() / 4;
        let a = base64_value(chunk[0]).ok_or_else(|| "invalid base64 character".to_string())?;
        let b = base64_value(chunk[1]).ok_or_else(|| "invalid base64 character".to_string())?;
        let c_padding = chunk[2] == b'=';
        let d_padding = chunk[3] == b'=';
        if (!last && (c_padding || d_padding)) || (c_padding && !d_padding) {
            return Err("invalid base64 padding".to_string());
        }
        let c = if c_padding { 0 } else { base64_value(chunk[2]).ok_or_else(|| "invalid base64 character".to_string())? };
        let d = if d_padding { 0 } else { base64_value(chunk[3]).ok_or_else(|| "invalid base64 character".to_string())? };
        output.push((a << 2) | (b >> 4));
        if !c_padding {
            output.push((b << 4) | (c >> 2));
        }
        if !d_padding {
            output.push((c << 6) | d);
        }
    }
    Ok(output)
}

fn process_name(entry: &ProcessEntry32W) -> String {
    let end = entry
        .exe_file
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(entry.exe_file.len());
    String::from_utf16_lossy(&entry.exe_file[..end])
}

fn enumerate_processes() -> Result<Vec<(u32, String)>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() || snapshot as isize == INVALID_HANDLE_VALUE {
        return Err(windows_error("CreateToolhelp32Snapshot failed"));
    }
    let snapshot = OwnedHandle(snapshot);
    let mut entry = ProcessEntry32W::default();
    let mut entries = Vec::new();
    let mut result = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while result != 0 {
        entries.push((entry.process_id, process_name(&entry)));
        entry = ProcessEntry32W::default();
        result = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    Ok(entries)
}

fn query_executable_path(process: Handle) -> Result<String, String> {
    let mut buffer = vec![0_u16; 32768];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return Err(windows_error("QueryFullProcessImageNameW failed"));
    }
    buffer.truncate(length as usize);
    Ok(String::from_utf16_lossy(&buffer))
}

fn query_creation_date(process: Handle) -> Result<String, String> {
    let mut creation = FileTime { low: 0, high: 0 };
    let mut exit = FileTime { low: 0, high: 0 };
    let mut kernel = FileTime { low: 0, high: 0 };
    let mut user = FileTime { low: 0, high: 0 };
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(windows_error("GetProcessTimes failed"));
    }
    let ticks = ((creation.high as u64) << 32) | creation.low as u64;
    Ok(ticks.to_string())
}

fn query_command_line(process: Handle) -> Result<String, String> {
    let mut required = 0_u32;
    unsafe {
        let _ = NtQueryInformationProcess(
            process,
            PROCESS_COMMAND_LINE_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut required,
        );
    }
    if required < std::mem::size_of::<UnicodeString>() as u32 || required > 16 * 1024 * 1024 {
        return Err("NtQueryInformationProcess returned an invalid command-line size".to_string());
    }
    let mut buffer = vec![0_u8; required as usize];
    let status = unsafe {
        NtQueryInformationProcess(
            process,
            PROCESS_COMMAND_LINE_INFORMATION,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    if status < 0 {
        return Err(format!("NtQueryInformationProcess failed: NTSTATUS 0x{:08x}", status as u32));
    }
    let value = unsafe { &*(buffer.as_ptr().cast::<UnicodeString>()) };
    if value.length == 0 {
        return Ok(String::new());
    }
    if value.length % 2 != 0 || value.buffer.is_null() {
        return Err("NtQueryInformationProcess returned an invalid UNICODE_STRING".to_string());
    }
    let start = value.buffer as usize;
    let end = start.saturating_add(value.length as usize);
    let allocation_start = buffer.as_ptr() as usize;
    let allocation_end = allocation_start.saturating_add(buffer.len());
    if start < allocation_start || end > allocation_end {
        return Err("NtQueryInformationProcess returned an out-of-range command line".to_string());
    }
    let characters = unsafe { std::slice::from_raw_parts(value.buffer, value.length as usize / 2) };
    Ok(String::from_utf16_lossy(characters))
}

fn inspect_process(pid: u32, name: String) -> Result<ProcessIdentity, String> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(windows_error(&format!("OpenProcess({pid}) failed")));
    }
    let process = OwnedHandle(process);
    Ok(ProcessIdentity {
        pid,
        name,
        executable_path: query_executable_path(process.0)?,
        command_line: query_command_line(process.0)?,
        creation_date: query_creation_date(process.0)?,
    })
}

fn inaccessible_identity(pid: u32, name: String) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        name,
        executable_path: String::new(),
        command_line: String::new(),
        creation_date: String::new(),
    }
}

fn json_escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            value if value <= '\u{1f}' => output.push_str(&format!("\\u{:04x}", value as u32)),
            value => output.push(value),
        }
    }
    output.push('"');
    output
}

fn identity_json(identity: &ProcessIdentity) -> String {
    format!(
        "{{\"pid\":{},\"name\":{},\"executablePath\":{},\"commandLine\":{},\"creationDate\":{}}}",
        identity.pid,
        json_escape(&identity.name),
        json_escape(&identity.executable_path),
        json_escape(&identity.command_line),
        json_escape(&identity.creation_date),
    )
}

fn parse_pid(arguments: &[String]) -> Result<u32, String> {
    if arguments.len() != 2 || arguments[0] != "--pid" {
        return Err("usage: linli-windows-helper.exe process-info --pid <pid>".to_string());
    }
    arguments[1]
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "pid must be a positive 32-bit integer".to_string())
}

fn parse_names(arguments: &[String]) -> Result<Vec<String>, String> {
    if arguments.is_empty() || arguments.len() % 2 != 0 {
        return Err("usage: linli-windows-helper.exe process-list --name <name> [--name <name> ...]".to_string());
    }
    let mut names = Vec::new();
    for pair in arguments.chunks_exact(2) {
        if pair[0] != "--name" || pair[1].trim().is_empty() || Path::new(&pair[1]).file_name().and_then(|value| value.to_str()) != Some(pair[1].as_str()) {
            return Err("process names must be non-empty file names".to_string());
        }
        if !names.iter().any(|name: &String| name.eq_ignore_ascii_case(&pair[1])) {
            names.push(pair[1].clone());
        }
    }
    Ok(names)
}

fn command_process_info(arguments: &[String]) -> Result<i32, String> {
    let pid = parse_pid(arguments)?;
    let entries = enumerate_processes()?;
    let Some((_, name)) = entries.into_iter().find(|(entry_pid, _)| *entry_pid == pid) else {
        return Ok(3);
    };
    let identity = inspect_process(pid, name)?;
    write_stdout(identity_json(&identity).as_bytes())?;
    Ok(0)
}

fn command_process_list(arguments: &[String]) -> Result<i32, String> {
    let names = parse_names(arguments)?;
    let mut identities = Vec::new();
    for (pid, name) in enumerate_processes()? {
        if !names.iter().any(|candidate| candidate.eq_ignore_ascii_case(&name)) {
            continue;
        }
        identities.push(inspect_process(pid, name.clone()).unwrap_or_else(|_| inaccessible_identity(pid, name)));
    }
    identities.sort_by_key(|identity| identity.pid);
    let json = format!(
        "[{}]",
        identities.iter().map(identity_json).collect::<Vec<_>>().join(",")
    );
    write_stdout(json.as_bytes())?;
    Ok(0)
}

fn command_self_test() -> Result<i32, String> {
    let plaintext = "Linli native helper self-test 林离\n".as_bytes();
    let encrypted = dpapi_protect(plaintext)?;
    let decrypted = dpapi_unprotect(&encrypted)?;
    if decrypted != plaintext {
        return Err("DPAPI self-test round trip did not preserve bytes".to_string());
    }
    let current_pid = std::process::id();
    let entries = enumerate_processes()?;
    let (_, name) = entries
        .into_iter()
        .find(|(pid, _)| *pid == current_pid)
        .ok_or_else(|| "self-test process was not found".to_string())?;
    let identity = inspect_process(current_pid, name)?;
    if identity.executable_path.is_empty() || identity.command_line.is_empty() || identity.creation_date.is_empty() {
        return Err("process identity self-test returned incomplete data".to_string());
    }
    write_stdout(b"{\"ok\":true}")?;
    Ok(0)
}

fn run() -> Result<i32, String> {
    let mut arguments = env::args().skip(1);
    let command = arguments.next().ok_or_else(|| {
        "usage: linli-windows-helper.exe <dpapi-protect|dpapi-unprotect|process-info|process-list|self-test>".to_string()
    })?;
    let rest: Vec<String> = arguments.collect();
    match command.as_str() {
        "dpapi-protect" => {
            if !rest.is_empty() {
                return Err("dpapi-protect does not accept arguments".to_string());
            }
            let ciphertext = dpapi_protect(&read_stdin()?)?;
            write_stdout(base64_encode(&ciphertext).as_bytes())?;
            Ok(0)
        }
        "dpapi-unprotect" => {
            if !rest.is_empty() {
                return Err("dpapi-unprotect does not accept arguments".to_string());
            }
            let ciphertext = base64_decode(&read_stdin()?)?;
            write_stdout(&dpapi_unprotect(&ciphertext)?)?;
            Ok(0)
        }
        "process-info" => command_process_info(&rest),
        "choose-song-folder" => command_choose_song_folder(&rest),
        "choose-diagnostic-files" => command_choose_diagnostic_files(&rest),
        "process-list" => command_process_list(&rest),
        "self-test" => {
            if !rest.is_empty() {
                return Err("self-test does not accept arguments".to_string());
            }
            command_self_test()
        }
        _ => Err(format!("unknown command: {command}")),
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            let _ = writeln!(std::io::stderr().lock(), "{error}");
            std::process::exit(1);
        }
    }
}
