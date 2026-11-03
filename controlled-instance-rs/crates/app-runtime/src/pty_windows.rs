use std::{
    collections::{BTreeMap, HashMap},
    ffi::{c_void, OsStr},
    fs::File,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle, RawHandle},
        process::CommandExt as _,
    },
    path::Path,
    process::Stdio,
    ptr,
    sync::{Arc, Mutex, OnceLock},
};

use tokio::process::Command;
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, INVALID_HANDLE_VALUE,
        WAIT_TIMEOUT,
    },
    Security::SECURITY_ATTRIBUTES,
    System::{
        Console::{ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON},
        Environment::{FreeEnvironmentStringsW, GetEnvironmentStringsW},
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Pipes::CreatePipe,
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
            InitializeProcThreadAttributeList, OpenProcess, ResumeThread, TerminateProcess,
            UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
            LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            STARTUPINFOEXW, STARTUPINFOW,
        },
    },
};

use super::{PtySpawn, PROCESS_KILL_TIMEOUT, PROCESS_STOP_TIMEOUT};
use crate::AppRuntimeError;

static RESIZE_TARGETS: OnceLock<Mutex<HashMap<usize, HPCON>>> = OnceLock::new();

fn resize_targets() -> &'static Mutex<HashMap<usize, HPCON>> {
    RESIZE_TARGETS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_resize_target(writer: &File, pseudo_console: HPCON) {
    resize_targets()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(writer.as_raw_handle() as usize, pseudo_console);
}

fn unregister_resize_target(writer: &File) {
    resize_targets()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&(writer.as_raw_handle() as usize));
}

struct PseudoConsole {
    handle: HPCON,
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        if self.handle != 0 {
            unsafe { ClosePseudoConsole(self.handle) };
        }
    }
}

struct TargetProcess {
    process: OwnedHandle,
    job: Option<OwnedHandle>,
    pid: u32,
}

struct WindowsPty {
    _pseudo_console: PseudoConsole,
    writer: File,
    target: Arc<TargetProcess>,
}

impl Drop for WindowsPty {
    fn drop(&mut self) {
        unregister_resize_target(&self.writer);
    }
}

#[derive(Clone)]
pub struct PtyHandle {
    inner: Arc<WindowsPty>,
    pid: u32,
    closed: Arc<std::sync::atomic::AtomicBool>,
}

impl PtyHandle {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn write(&self, data: &[u8]) -> Result<(), AppRuntimeError> {
        use std::io::Write;
        (&self.inner.writer)
            .write_all(data)
            .map_err(|error| AppRuntimeError::spawn(error.to_string()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), AppRuntimeError> {
        resize_pty(&self.inner.writer, cols, rows)
    }

    pub fn stop(&self) {
        if self.closed.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        terminate_owned_process_tree(&self.inner.target);
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub fn spawn_pty(
    command: &str,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    cols: u16,
    rows: u16,
) -> Result<PtySpawn, AppRuntimeError> {
    let (input_read, input_write) = create_pipe()?;
    let (output_read, output_write) = create_pipe()?;

    let mut pseudo_console = 0;
    let result = unsafe {
        CreatePseudoConsole(
            console_size(cols, rows),
            input_read.as_raw_handle() as HANDLE,
            output_write.as_raw_handle() as HANDLE,
            0,
            &mut pseudo_console,
        )
    };
    if result < 0 {
        return Err(AppRuntimeError::spawn(format!(
            "CreatePseudoConsole failed: HRESULT 0x{result:08x}"
        )));
    }
    drop(input_read);
    drop(output_write);

    let pseudo_console = PseudoConsole {
        handle: pseudo_console,
    };
    let writer = unsafe { File::from_raw_handle(input_write.into_raw_handle()) };
    let reader = unsafe { File::from_raw_handle(output_read.into_raw_handle()) };

    let command_line = make_command_line(command, args)?;
    let mut command_line = command_line;
    let environment = environment_block(env);
    let current_directory = wide_null(cwd.as_os_str().encode_wide());
    let startup = start_info(pseudo_console.handle)?;
    let mut process_info = PROCESS_INFORMATION::default();

    let created = unsafe {
        CreateProcessW(
            ptr::null(),
            command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            environment.as_ptr().cast::<c_void>(),
            current_directory.as_ptr(),
            &startup.startup_info as *const STARTUPINFOEXW as *const STARTUPINFOW,
            &mut process_info,
        )
    };
    if created == 0 {
        let error = io::Error::last_os_error();
        return Err(if matches!(error.raw_os_error(), Some(2 | 3 | 1920)) {
            AppRuntimeError::missing_command(command.to_string())
        } else {
            AppRuntimeError::spawn(error.to_string())
        });
    }

    let process = unsafe { OwnedHandle::from_raw_handle(process_info.hProcess as RawHandle) };
    let thread = unsafe { OwnedHandle::from_raw_handle(process_info.hThread as RawHandle) };
    let pid = process_info.dwProcessId;

    let job = match create_job_object() {
        Some(job) => {
            let assigned = unsafe {
                AssignProcessToJobObject(
                    job.as_raw_handle() as HANDLE,
                    process.as_raw_handle() as HANDLE,
                )
            };
            if assigned == 0 {
                None
            } else {
                Some(job)
            }
        }
        None => None,
    };

    if unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) } == u32::MAX {
        let error = io::Error::last_os_error();
        if let Some(job) = job.as_ref() {
            unsafe {
                TerminateJobObject(job.as_raw_handle() as HANDLE, 1);
            }
        } else {
            unsafe {
                TerminateProcess(process.as_raw_handle() as HANDLE, 1);
            }
        }
        return Err(AppRuntimeError::spawn(format!(
            "Could not resume ConPTY child: {error}"
        )));
    }
    drop(thread);

    let target = Arc::new(TargetProcess { process, job, pid });
    let mut monitor = Command::new(monitor_program())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            terminate_owned_process_tree(&target);
            AppRuntimeError::spawn(format!("Could not start ConPTY monitor: {error}"))
        })?;

    let monitor_raw_handle = match monitor.raw_handle() {
        Some(handle) => handle,
        None => {
            terminate_owned_process_tree(&target);
            let _ = monitor.start_kill();
            return Err(AppRuntimeError::spawn(
                "ConPTY monitor has no process handle",
            ));
        }
    };
    let monitor_handle =
        match duplicate_process_handle(monitor_raw_handle, PROCESS_TERMINATE | PROCESS_SYNCHRONIZE)
        {
            Ok(handle) => handle,
            Err(error) => {
                terminate_owned_process_tree(&target);
                let _ = monitor.start_kill();
                return Err(error);
            }
        };
    let target_handle = match duplicate_process_handle(
        target.process.as_raw_handle() as RawHandle,
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
    ) {
        Ok(handle) => handle,
        Err(error) => {
            terminate_owned_process_tree(&target);
            let _ = monitor.start_kill();
            return Err(error);
        }
    };

    if let Err(error) = std::thread::Builder::new()
        .name(format!("conpty-monitor-{pid}"))
        .spawn(move || {
            let _ =
                unsafe { WaitForSingleObject(target_handle.as_raw_handle() as HANDLE, INFINITE) };
            let mut exit_code = 1;
            if unsafe {
                GetExitCodeProcess(
                    target_handle.as_raw_handle() as HANDLE,
                    &mut exit_code as *mut u32,
                )
            } == 0
            {
                exit_code = 1;
            }
            unsafe {
                TerminateProcess(monitor_handle.as_raw_handle() as HANDLE, exit_code);
            }
        })
    {
        terminate_owned_process_tree(&target);
        let _ = monitor.start_kill();
        return Err(AppRuntimeError::spawn(format!(
            "Could not start ConPTY exit monitor: {error}"
        )));
    }

    register_resize_target(&writer, pseudo_console.handle);
    let handle = PtyHandle {
        inner: Arc::new(WindowsPty {
            _pseudo_console: pseudo_console,
            writer,
            target,
        }),
        pid,
        closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    Ok(PtySpawn {
        child: monitor,
        reader,
        handle,
        pid,
    })
}

pub fn resize_pty(master: &File, cols: u16, rows: u16) -> Result<(), AppRuntimeError> {
    let pseudo_console = resize_targets()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&(master.as_raw_handle() as usize))
        .copied()
        .ok_or_else(|| AppRuntimeError::spawn("PTY resize target is not available"))?;
    let result = unsafe { ResizePseudoConsole(pseudo_console, console_size(cols, rows)) };
    if result < 0 {
        Err(AppRuntimeError::spawn(format!(
            "PTY resize failed: HRESULT 0x{result:08x}"
        )))
    } else {
        Ok(())
    }
}

pub fn terminate_process_group(pid: u32) -> Vec<u32> {
    if pid == 0 {
        return Vec::new();
    }
    terminate_process_groups(&[pid])
}

pub fn terminate_process_groups(pids: &[u32]) -> Vec<u32> {
    let pids = pids
        .iter()
        .copied()
        .filter(|pid| *pid > 0)
        .collect::<Vec<_>>();
    for pid in &pids {
        run_taskkill(*pid, false);
    }
    if pids.is_empty() {
        return Vec::new();
    }
    let mut remaining = wait_for_process_groups(&pids, PROCESS_STOP_TIMEOUT);
    if remaining.is_empty() {
        return remaining;
    }
    for pid in &remaining {
        run_taskkill(*pid, true);
    }
    remaining = wait_for_process_groups(&remaining, PROCESS_KILL_TIMEOUT);
    remaining
}

pub fn request_stop_process_group(pid: u32) {
    if pid == 0 {
        return;
    }
    run_taskkill(pid, false);
}

pub fn request_stop_process_groups(pids: &[u32]) {
    for pid in pids {
        request_stop_process_group(*pid);
    }
}

pub fn wait_process_groups(pids: &[u32], timeout: std::time::Duration) -> Vec<u32> {
    wait_for_process_groups(pids, timeout)
}

pub fn kill_process_groups(pids: &[u32]) {
    for pid in pids {
        if *pid == 0 {
            continue;
        }
        run_taskkill(*pid, true);
    }
}

pub fn process_group_exists(pid: u32) -> bool {
    process_exists(pid)
}

fn terminate_owned_process_tree(target: &TargetProcess) {
    run_taskkill(target.pid, false);
    let remaining = wait_for_process_groups(&[target.pid], PROCESS_STOP_TIMEOUT);
    if remaining.is_empty() {
        return;
    }
    if let Some(job) = target.job.as_ref() {
        unsafe {
            TerminateJobObject(job.as_raw_handle() as HANDLE, 1);
        }
    }
    if process_exists(target.pid) {
        if let Some(job) = target.job.as_ref() {
            unsafe {
                TerminateJobObject(job.as_raw_handle() as HANDLE, 1);
            }
        }
        run_taskkill(target.pid, true);
    }
    let _ = wait_for_process_groups(&remaining, PROCESS_KILL_TIMEOUT);
}

fn wait_for_process_groups(pids: &[u32], timeout: std::time::Duration) -> Vec<u32> {
    let deadline = std::time::Instant::now() + timeout;
    let mut remaining = pids
        .iter()
        .copied()
        .filter(|pid| process_group_exists(*pid))
        .collect::<Vec<_>>();
    while !remaining.is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
        remaining.retain(|pid| process_group_exists(*pid));
    }
    remaining
}

fn process_exists(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if process.is_null() {
        return false;
    }
    let running = unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT;
    unsafe {
        CloseHandle(process);
    }
    running
}

fn run_taskkill(pid: u32, force: bool) {
    if pid == 0 {
        return;
    }
    let mut command = std::process::Command::new("taskkill.exe");
    command.args(["/pid", &pid.to_string(), "/t"]);
    if force {
        command.arg("/f");
    }
    command
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let _ = command.status();
}

fn monitor_program() -> std::path::PathBuf {
    std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("more.com")
}

fn create_pipe() -> Result<(OwnedHandle, OwnedHandle), AppRuntimeError> {
    let mut read = ptr::null_mut();
    let mut write = ptr::null_mut();
    let created =
        unsafe { CreatePipe(&mut read, &mut write, ptr::null::<SECURITY_ATTRIBUTES>(), 0) };
    if created == 0 {
        return Err(AppRuntimeError::spawn(format!(
            "CreatePipe failed: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(unsafe {
        (
            OwnedHandle::from_raw_handle(read as RawHandle),
            OwnedHandle::from_raw_handle(write as RawHandle),
        )
    })
}

fn create_job_object() -> Option<OwnedHandle> {
    let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if job.is_null() || job == INVALID_HANDLE_VALUE {
        return None;
    }
    let job = unsafe { OwnedHandle::from_raw_handle(job as RawHandle) };
    let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.as_raw_handle() as HANDLE,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    (configured != 0).then_some(job)
}

fn duplicate_process_handle(
    handle: RawHandle,
    access: u32,
) -> Result<OwnedHandle, AppRuntimeError> {
    let mut duplicate = ptr::null_mut();
    let duplicated = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle as HANDLE,
            GetCurrentProcess(),
            &mut duplicate,
            access,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if duplicated == 0 {
        return Err(AppRuntimeError::spawn(format!(
            "DuplicateHandle failed: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(duplicate as RawHandle) })
}

struct AttributeList {
    storage: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl AttributeList {
    fn for_pseudo_console(pseudo_console: HPCON) -> Result<Self, AppRuntimeError> {
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
        }
        if size == 0 {
            return Err(AppRuntimeError::spawn(format!(
                "InitializeProcThreadAttributeList sizing failed: {}",
                io::Error::last_os_error()
            )));
        }
        let word_size = std::mem::size_of::<usize>();
        let mut storage = vec![0usize; size.div_ceil(word_size)];
        let pointer = storage.as_mut_ptr().cast::<c_void>();
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut size) } == 0 {
            return Err(AppRuntimeError::spawn(format!(
                "InitializeProcThreadAttributeList failed: {}",
                io::Error::last_os_error()
            )));
        }
        let list = Self { storage, pointer };
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list.pointer,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                &pseudo_console as *const HPCON as *const c_void,
                std::mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        if updated == 0 {
            return Err(AppRuntimeError::spawn(format!(
                "UpdateProcThreadAttribute failed: {}",
                io::Error::last_os_error()
            )));
        }
        Ok(list)
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
        let _ = &self.storage;
    }
}

struct StartupInfo {
    startup_info: STARTUPINFOEXW,
    _attributes: AttributeList,
}

fn start_info(pseudo_console: HPCON) -> Result<StartupInfo, AppRuntimeError> {
    let attributes = AttributeList::for_pseudo_console(pseudo_console)?;
    let startup_info = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
            ..Default::default()
        },
        lpAttributeList: attributes.pointer,
    };
    Ok(StartupInfo {
        startup_info,
        _attributes: attributes,
    })
}

fn console_size(cols: u16, rows: u16) -> COORD {
    COORD {
        X: cols.max(1) as i16,
        Y: rows.max(1) as i16,
    }
}

fn environment_block(overrides: &BTreeMap<String, String>) -> Vec<u16> {
    let mut entries = current_environment_entries();
    for (key, value) in overrides {
        let normalized = key.to_ascii_uppercase();
        entries.retain(|entry| entry.normalized_key != normalized);
        let wide = format!("{key}={value}").encode_utf16().collect();
        entries.push(EnvironmentEntry {
            normalized_key: normalized,
            wide,
        });
    }
    entries.sort_by(|left, right| left.normalized_key.cmp(&right.normalized_key));
    let mut block = Vec::new();
    for entry in entries {
        block.extend(entry.wide);
        block.push(0);
    }
    block.push(0);
    block
}

struct EnvironmentEntry {
    normalized_key: String,
    wide: Vec<u16>,
}

fn current_environment_entries() -> Vec<EnvironmentEntry> {
    let block = unsafe { GetEnvironmentStringsW() };
    if block.is_null() {
        return std::env::vars_os()
            .map(|(key, value)| environment_entry(&key.to_string_lossy(), &value.to_string_lossy()))
            .collect();
    }
    let mut entries = Vec::new();
    let mut offset = 0;
    loop {
        let mut end = offset;
        while unsafe { *block.add(end) } != 0 {
            end += 1;
        }
        if end == offset {
            break;
        }
        let raw = unsafe { std::slice::from_raw_parts(block.add(offset), end - offset) };
        let separator = raw
            .iter()
            .enumerate()
            .skip(usize::from(raw.first() == Some(&('=' as u16))))
            .find_map(|(index, value)| (*value == '=' as u16).then_some(index));
        let key = separator
            .map(|separator| String::from_utf16_lossy(&raw[..separator]))
            .unwrap_or_default();
        entries.push(EnvironmentEntry {
            normalized_key: key.to_ascii_uppercase(),
            wide: raw.to_vec(),
        });
        offset = end + 1;
    }
    unsafe {
        FreeEnvironmentStringsW(block);
    }
    entries
}

fn environment_entry(key: &str, value: &str) -> EnvironmentEntry {
    EnvironmentEntry {
        normalized_key: key.to_ascii_uppercase(),
        wide: format!("{key}={value}").encode_utf16().collect(),
    }
}

fn make_command_line(command: &str, args: &[String]) -> Result<Vec<u16>, AppRuntimeError> {
    let mut line = Vec::new();
    if is_batch_file(command) {
        const PREFIX: &str = "cmd.exe /e:ON /v:OFF /d /c \"";
        line.extend(PREFIX.encode_utf16());
        if command.ends_with('\\') || command.contains('"') {
            return Err(AppRuntimeError::spawn(
                "Windows batch launcher path is invalid",
            ));
        }
        line.push('"' as u16);
        line.extend(command.encode_utf16());
        line.push('"' as u16);
        for arg in args {
            line.push(' ' as u16);
            append_batch_argument(&mut line, arg);
        }
        line.push('"' as u16);
    } else {
        append_quoted_argument(&mut line, command);
        for arg in args {
            line.push(' ' as u16);
            append_quoted_argument(&mut line, arg);
        }
    }
    line.push(0);
    Ok(line)
}

fn is_batch_file(command: &str) -> bool {
    Path::new(command)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("bat") || extension.eq_ignore_ascii_case("cmd")
        })
}

fn append_quoted_argument(line: &mut Vec<u16>, argument: &str) {
    if argument.is_empty() {
        line.extend("\"\"".encode_utf16());
        return;
    }
    let quote = argument
        .chars()
        .any(|character| character.is_whitespace() || character == '"');
    if !quote {
        line.extend(argument.encode_utf16());
        return;
    }
    line.push('"' as u16);
    let mut backslashes = 0usize;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                line.extend(std::iter::repeat_n('\\' as u16, backslashes * 2 + 1));
                line.push('"' as u16);
                backslashes = 0;
            }
            _ => {
                line.extend(std::iter::repeat_n('\\' as u16, backslashes));
                line.extend(character.encode_utf16(&mut [0; 2]).iter().copied());
                backslashes = 0;
            }
        }
    }
    line.extend(std::iter::repeat_n('\\' as u16, backslashes * 2));
    line.push('"' as u16);
}

fn append_batch_argument(line: &mut Vec<u16>, argument: &str) {
    let mut quote = argument.is_empty() || argument.ends_with('\\');
    if !quote {
        const UNQUOTED: &str = r"#$*+-./:?@\_";
        quote = argument.chars().any(|character| {
            (character.is_ascii()
                && !(character.is_ascii_alphanumeric() || UNQUOTED.contains(character)))
                || character.is_control()
        });
    }
    if quote {
        line.push('"' as u16);
    }
    let mut backslashes = 0usize;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else {
            if character == '"' {
                line.extend(std::iter::repeat_n('\\' as u16, backslashes));
                line.push('"' as u16);
            } else if character == '%' || character == '\r' {
                line.extend("%%cd:~,".encode_utf16());
            }
            backslashes = 0;
        }
        line.extend(character.encode_utf16(&mut [0; 2]).iter().copied());
    }
    if quote {
        line.extend(std::iter::repeat_n('\\' as u16, backslashes));
        line.push('"' as u16);
    }
}

fn wide_null(wide: impl Iterator<Item = u16>) -> Vec<u16> {
    let mut result = wide.collect::<Vec<_>>();
    result.push(0);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_arguments_without_changing_unquoted_values() {
        let mut line = Vec::new();
        append_quoted_argument(&mut line, r#"C:\Program Files\app.exe"#);
        line.push(' ' as u16);
        append_quoted_argument(&mut line, "plain");
        assert_eq!(
            String::from_utf16(&line).expect("utf16 command line"),
            r#""C:\Program Files\app.exe" plain"#
        );
    }

    #[test]
    fn escapes_quotes_and_trailing_backslashes() {
        let mut line = Vec::new();
        append_quoted_argument(&mut line, r#"a"b\"#);
        assert_eq!(
            String::from_utf16(&line).expect("utf16 command line"),
            r#""a\"b\\""#
        );
    }

    #[test]
    fn environment_overrides_are_case_insensitive_and_null_terminated() {
        let mut overrides = BTreeMap::new();
        overrides.insert("Path".to_string(), "C:\\test".to_string());
        let block = environment_block(&overrides);
        assert_eq!(block.last(), Some(&0));
        let text = String::from_utf16_lossy(&block);
        assert!(text.contains("Path=C:\\test"));
    }

    #[test]
    fn recognizes_batch_launchers() {
        assert!(is_batch_file(r"C:\tools\npm.cmd"));
        assert!(is_batch_file(r"C:\tools\build.BAT"));
        assert!(!is_batch_file(r"C:\tools\app.exe"));
    }
}
