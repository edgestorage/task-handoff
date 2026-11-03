use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::atomic::write_json_atomic;
use crate::fs_permissions::{restrict_file, restrict_path};
use crate::process::{pid_is_alive, process_matches_start_identity, process_start_identity};

const INCOMPLETE_LOCK_STALE_MS: u64 = 2_000;
const INCOMPLETE_LOCK_RETRY_COUNT: usize = 5;
const INCOMPLETE_LOCK_RETRY_MS: u64 = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLockOwner {
    pub pid: u32,
    pub hostname: String,
    pub command: String,
    pub acquired_at: String,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLockDetails {
    pub component: Option<String>,
    pub data_dir: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub instance_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{label} is already running{detail}. Lock: {lock_path}")]
pub struct ProcessSingletonError {
    pub label: String,
    pub detail: String,
    pub code: String,
    pub lock_path: PathBuf,
    pub owner: Option<Box<ProcessLockOwner>>,
}

impl ProcessSingletonError {
    pub fn code(&self) -> &str {
        &self.code
    }
}

#[derive(Debug)]
pub struct AcquiredProcessLock {
    lock_path: PathBuf,
    owner: ProcessLockOwner,
    released: bool,
}

impl AcquiredProcessLock {
    pub fn path(&self) -> &Path {
        &self.lock_path
    }

    pub fn owner(&self) -> &ProcessLockOwner {
        &self.owner
    }

    pub fn update_details(&mut self, details: ProcessLockDetails) -> io::Result<bool> {
        let current = read_owner(&self.lock_path);
        if current.as_ref().map(|owner| owner.token.as_str()) != Some(self.owner.token.as_str()) {
            return Ok(false);
        }
        if details.component.is_some() {
            self.owner.component = details.component;
        }
        if details.data_dir.is_some() {
            self.owner.data_dir = details.data_dir;
        }
        if details.host.is_some() {
            self.owner.host = details.host;
        }
        if details.port.is_some() {
            self.owner.port = details.port;
        }
        if details.instance_id.is_some() {
            self.owner.instance_id = details.instance_id;
        }
        write_owner(&self.lock_path, &self.owner)?;
        Ok(true)
    }

    pub fn release(mut self) -> io::Result<()> {
        self.release_inner()?;
        self.released = true;
        Ok(())
    }

    fn release_inner(&self) -> io::Result<()> {
        if read_owner(&self.lock_path)
            .as_ref()
            .map(|owner| owner.token.as_str())
            != Some(self.owner.token.as_str())
        {
            return Ok(());
        }
        fs::remove_dir_all(&self.lock_path)
    }
}

impl Drop for AcquiredProcessLock {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let _ = self.release_inner();
    }
}

pub fn read_owner(lock_path: &Path) -> Option<ProcessLockOwner> {
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(lock_path.join("owner.json")).ok()?).ok()?;
    read_owner_value(value)
}

fn read_owner_value(value: serde_json::Value) -> Option<ProcessLockOwner> {
    let object = value.as_object()?;
    let pid = object.get("pid").and_then(serde_json::Value::as_u64)?;
    let pid = u32::try_from(pid).ok().filter(|pid| *pid > 0)?;
    if let Some(start_time) = object.get("startTime").and_then(serde_json::Value::as_str) {
        return Some(ProcessLockOwner {
            pid,
            hostname: object
                .get("hostname")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(hostname),
            component: object
                .get("component")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .or_else(|| Some("server-update".to_string())),
            command: object
                .get("command")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            acquired_at: object
                .get("createdAt")
                .and_then(serde_json::Value::as_str)
                .filter(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
                .unwrap_or("1970-01-01T00:00:00.000Z")
                .to_string(),
            token: object
                .get("token")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("legacy:{pid}:{start_time}")),
            start_identity: Some(if start_time.starts_with("linux:") {
                start_time.to_string()
            } else {
                format!("linux:{start_time}")
            }),
            data_dir: None,
            host: None,
            port: None,
            instance_id: None,
        });
    }
    let owner = serde_json::from_value::<ProcessLockOwner>(value).ok()?;
    if owner.pid == 0
        || owner.hostname.is_empty()
        || owner.token.is_empty()
        || chrono::DateTime::parse_from_rfc3339(&owner.acquired_at).is_err()
    {
        return None;
    }
    Some(owner)
}

pub fn local_controlled_instance_lock_path() -> PathBuf {
    // Node pins POSIX local locks to /tmp regardless of TMPDIR so that the
    // controlled instance and the Node launcher agree on the single-instance
    // boundary. Windows keeps os.tmpdir() semantics.
    #[cfg(unix)]
    let root = PathBuf::from("/tmp");
    #[cfg(not(unix))]
    let root = std::env::temp_dir();
    root.join(format!(
        "task-handoff-local-controlled-instance-{}.lock",
        local_user_key()
    ))
}

pub fn acquire_local_controlled_instance_lock(
    details: ProcessLockDetails,
    lock_path: Option<PathBuf>,
) -> Result<AcquiredProcessLock, ProcessSingletonError> {
    acquire(
        lock_path.unwrap_or_else(local_controlled_instance_lock_path),
        details,
        "Local controlled instance",
        "LOCAL_CONTROLLED_INSTANCE_ALREADY_RUNNING",
    )
}

fn local_user_key() -> String {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() }.to_string()
    }
    #[cfg(not(unix))]
    {
        std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "unknown".to_string())
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || "._-".contains(character) {
                    character
                } else {
                    '_'
                }
            })
            .collect()
    }
}

pub fn acquire(
    lock_path: impl Into<PathBuf>,
    details: ProcessLockDetails,
    label: impl Into<String>,
    code: impl Into<String>,
) -> Result<AcquiredProcessLock, ProcessSingletonError> {
    let lock_path = lock_path.into();
    let label = label.into();
    let code = code.into();
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| lock_io_error(&lock_path, &label, &code, error))?;
    }
    for attempt in 0..INCOMPLETE_LOCK_RETRY_COUNT {
        match create_lock(&lock_path, &details) {
            Ok(owner) => {
                return Ok(AcquiredProcessLock {
                    lock_path,
                    owner,
                    released: false,
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let current = read_owner(&lock_path);
                if let Some(owner) = current.as_ref() {
                    if process_matches_start_identity(owner.pid, owner.start_identity.as_deref()) {
                        return Err(ProcessSingletonError {
                            label,
                            detail: format!(" as pid {}", owner.pid),
                            code,
                            lock_path,
                            owner: Some(Box::new(owner.clone())),
                        });
                    }
                }
                if current.is_none()
                    && (initialization_matches_live_process(&lock_path)
                        || incomplete_lock_age_ms(&lock_path) < INCOMPLETE_LOCK_STALE_MS)
                {
                    if attempt + 1 < INCOMPLETE_LOCK_RETRY_COUNT {
                        std::thread::sleep(std::time::Duration::from_millis(
                            INCOMPLETE_LOCK_RETRY_MS,
                        ));
                        continue;
                    }
                    return Err(ProcessSingletonError {
                        label,
                        detail: String::new(),
                        code,
                        lock_path,
                        owner: None,
                    });
                }
                let recovery_token = uuid_like();
                if !claim_stale_lock(&lock_path, &recovery_token) {
                    if attempt + 1 < INCOMPLETE_LOCK_RETRY_COUNT {
                        std::thread::sleep(std::time::Duration::from_millis(
                            INCOMPLETE_LOCK_RETRY_MS,
                        ));
                        continue;
                    }
                    return Err(ProcessSingletonError {
                        label,
                        detail: String::new(),
                        code,
                        lock_path: lock_path.clone(),
                        owner: read_owner(&lock_path).map(Box::new),
                    });
                }
                let claimed_owner = read_owner(&lock_path);
                if let Some(owner) = claimed_owner.as_ref() {
                    if process_matches_start_identity(owner.pid, owner.start_identity.as_deref()) {
                        let _ = fs::remove_file(recovery_path(&lock_path));
                        return Err(ProcessSingletonError {
                            label,
                            detail: format!(" as pid {}", owner.pid),
                            code,
                            lock_path,
                            owner: Some(Box::new(owner.clone())),
                        });
                    }
                }
                if let (Some(current), Some(claimed)) = (current.as_ref(), claimed_owner.as_ref()) {
                    if current.token != claimed.token {
                        let _ = fs::remove_file(recovery_path(&lock_path));
                        continue;
                    }
                }
                if !recovery_claim_matches(&lock_path, &recovery_token) {
                    continue;
                }
                let _ = fs::remove_dir_all(&lock_path);
            }
            Err(error) => return Err(lock_io_error(&lock_path, &label, &code, error)),
        }
    }
    Err(ProcessSingletonError {
        label,
        detail: String::new(),
        code,
        lock_path: lock_path.clone(),
        owner: read_owner(&lock_path).map(Box::new),
    })
}

fn create_lock(lock_path: &Path, details: &ProcessLockDetails) -> io::Result<ProcessLockOwner> {
    fs::create_dir(lock_path)?;
    restrict_path(lock_path, 0o700)?;
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let owner = ProcessLockOwner {
        pid: std::process::id(),
        hostname: hostname(),
        command: std::env::args().collect::<Vec<_>>().join(" "),
        acquired_at: started_at.clone(),
        token: uuid_like(),
        component: details.component.clone(),
        start_identity: process_start_identity(std::process::id()),
        data_dir: details.data_dir.clone(),
        host: details.host.clone(),
        port: details.port,
        instance_id: details.instance_id.clone(),
    };
    write_json_atomic(
        &initialization_path(lock_path),
        &json!({
            "token": owner.token,
            "pid": owner.pid,
            "startIdentity": owner.start_identity,
            "startedAt": started_at,
        }),
        Some(0o600),
    )?;
    if read_initialization(lock_path)
        .map(|initialization| initialization.token != owner.token)
        .unwrap_or(true)
    {
        let _ = fs::remove_dir_all(lock_path);
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "process lock initialization was superseded",
        ));
    }
    write_owner(lock_path, &owner)?;
    let _ = fs::remove_file(initialization_path(lock_path));
    Ok(owner)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializationRecord {
    token: String,
    pid: u32,
    #[serde(default)]
    start_identity: Option<String>,
    #[serde(default)]
    started_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryClaim {
    token: String,
    #[serde(default)]
    pid: u32,
    #[serde(default)]
    started_at: String,
}

fn owner_path(lock_path: &Path) -> PathBuf {
    lock_path.join("owner.json")
}

fn initialization_path(lock_path: &Path) -> PathBuf {
    lock_path.join("initializing.json")
}

fn recovery_path(lock_path: &Path) -> PathBuf {
    lock_path.join("recovering.json")
}

fn read_initialization(lock_path: &Path) -> Option<InitializationRecord> {
    let bytes = fs::read(initialization_path(lock_path)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn initialization_matches_live_process(lock_path: &Path) -> bool {
    read_initialization(lock_path).is_some_and(|initialization| {
        initialization.pid > 0
            && process_matches_start_identity(
                initialization.pid,
                initialization.start_identity.as_deref(),
            )
    })
}

fn incomplete_lock_age_ms(lock_path: &Path) -> u64 {
    if let Some(started_at) = read_initialization(lock_path).and_then(|initialization| {
        chrono::DateTime::parse_from_rfc3339(&initialization.started_at).ok()
    }) {
        let elapsed = Utc::now().signed_duration_since(started_at.with_timezone(&Utc));
        return elapsed.num_milliseconds().max(0) as u64;
    }
    fs::metadata(lock_path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn claim_stale_lock(lock_path: &Path, token: &str) -> bool {
    let bytes = format!(
        "{}\n",
        json!({
            "token": token,
            "pid": std::process::id(),
            "startedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    );
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(recovery_path(lock_path))
    {
        Ok(mut file) => {
            use std::io::Write;
            if file.write_all(bytes.as_bytes()).is_err() {
                let _ = fs::remove_file(recovery_path(lock_path));
                return false;
            }
            let _ = restrict_file(&recovery_path(lock_path));
            true
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if recover_abandoned_claim(lock_path) {
                claim_stale_lock(lock_path, token)
            } else {
                false
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(_) => false,
    }
}

fn read_recovery_claim(path: &Path) -> Option<RecoveryClaim> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn recover_abandoned_claim(lock_path: &Path) -> bool {
    let marker_path = recovery_path(lock_path);
    let Some(observed) = read_recovery_claim(&marker_path) else {
        return false;
    };
    let started_at = chrono::DateTime::parse_from_rfc3339(&observed.started_at)
        .ok()
        .map(|value| value.with_timezone(&Utc));
    let recent = started_at.is_some_and(|started_at| {
        (Utc::now()
            .signed_duration_since(started_at)
            .num_milliseconds()
            .max(0) as u64)
            < INCOMPLETE_LOCK_STALE_MS
    });
    if (observed.pid > 0 && pid_is_alive(observed.pid)) || recent {
        return false;
    }
    let quarantine = lock_path.join(format!(".recovering-{}.stale", uuid_like()));
    if fs::rename(&marker_path, &quarantine).is_err() {
        return false;
    }
    let moved = read_recovery_claim(&quarantine);
    if moved.as_ref().map(|claim| claim.token.as_str()) == Some(observed.token.as_str()) {
        let _ = fs::remove_file(&quarantine);
        return true;
    }
    let _ = fs::hard_link(&quarantine, &marker_path);
    let _ = fs::remove_file(&quarantine);
    false
}

fn recovery_claim_matches(lock_path: &Path, token: &str) -> bool {
    read_recovery_claim(&recovery_path(lock_path)).is_some_and(|claim| claim.token == token)
}

fn write_owner(lock_path: &Path, owner: &ProcessLockOwner) -> io::Result<()> {
    let path = owner_path(lock_path);
    write_json_atomic(&path, owner, Some(0o600))?;
    restrict_file(&path)
}

fn hostname() -> String {
    crate::process::hostname()
}

fn uuid_like() -> String {
    use rand::RngCore;
    let mut bytes = [0_u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    format!(
		"{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-4{:01x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
		bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6] & 0x0f, bytes[7],
		(bytes[8] & 0x3f) | 0x80, bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
	)
}

fn lock_io_error(
    lock_path: &Path,
    label: &str,
    code: &str,
    error: io::Error,
) -> ProcessSingletonError {
    ProcessSingletonError {
        label: label.to_string(),
        detail: format!(" ({error})"),
        code: code.to_string(),
        lock_path: lock_path.to_path_buf(),
        owner: read_owner(lock_path).map(Box::new),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::pid_is_alive;

    #[test]
    fn stale_owner_is_quarantined_and_reacquired() {
        let root = tempfile::tempdir().expect("tempdir");
        let lock_path = root.path().join("instance.lock");
        fs::create_dir(&lock_path).expect("lock dir");
        fs::write(
            lock_path.join("owner.json"),
            serde_json::to_vec(&json!({
                "pid": 999_999u32,
                "hostname": "stale-host",
                "command": "stale",
                "acquiredAt": "2026-01-01T00:00:00.000Z",
                "token": "stale-token",
            }))
            .expect("owner"),
        )
        .expect("owner file");
        let acquired = acquire(
            lock_path.clone(),
            ProcessLockDetails::default(),
            "Instance",
            "ALREADY_RUNNING",
        )
        .expect("stale lock recovered");
        assert_eq!(acquired.owner().pid, std::process::id());
        acquired.release().expect("release");
    }

    #[test]
    fn live_initializing_lock_is_not_removed() {
        let root = tempfile::tempdir().expect("tempdir");
        let lock_path = root.path().join("instance.lock");
        fs::create_dir(&lock_path).expect("lock dir");
        fs::write(
            initialization_path(&lock_path),
            serde_json::to_vec(&json!({
                "token": "live-token",
                "pid": std::process::id(),
                "startIdentity": process_start_identity(std::process::id()),
                "startedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            }))
            .expect("initialization"),
        )
        .expect("initialization file");
        let result = acquire(
            lock_path.clone(),
            ProcessLockDetails::default(),
            "Instance",
            "ALREADY_RUNNING",
        );
        assert!(result.is_err());
        assert!(lock_path.exists());
    }

    #[test]
    fn legacy_owner_start_time_is_read_as_a_linux_start_identity() {
        let root = tempfile::tempdir().expect("tempdir");
        let lock_path = root.path().join("instance.lock");
        fs::create_dir(&lock_path).expect("lock dir");
        fs::write(
            lock_path.join("owner.json"),
            serde_json::to_vec(&json!({
                "pid": 12345u32,
                "startTime": "12345",
            }))
            .expect("legacy owner"),
        )
        .expect("legacy owner file");
        let owner = read_owner(&lock_path).expect("legacy owner");
        assert_eq!(owner.pid, 12345);
        assert_eq!(owner.start_identity.as_deref(), Some("linux:12345"));
        assert_eq!(owner.token, "legacy:12345:12345");
    }

    #[test]
    fn second_owner_is_rejected_and_release_allows_reacquire() {
        let root = tempfile::tempdir().expect("tempdir");
        let lock_path = root.path().join("instance.lock");
        let first = acquire(
            lock_path.clone(),
            ProcessLockDetails::default(),
            "Instance",
            "ALREADY_RUNNING",
        )
        .expect("first lock");
        let second = acquire(
            lock_path.clone(),
            ProcessLockDetails::default(),
            "Instance",
            "ALREADY_RUNNING",
        );
        assert!(second.is_err());
        assert!(pid_is_alive(std::process::id()));
        first.release().expect("release");
        let third = acquire(
            lock_path,
            ProcessLockDetails::default(),
            "Instance",
            "ALREADY_RUNNING",
        )
        .expect("third lock");
        third.release().expect("release third");
    }
}
