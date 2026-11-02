use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::atomic::write_json_atomic;
use crate::fs_permissions::{restrict_file, restrict_path};
use crate::process::{process_matches_start_identity, process_start_identity};

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
    let value = fs::read(lock_path.join("owner.json")).ok()?;
    serde_json::from_slice(&value).ok()
}

pub fn local_controlled_instance_lock_path() -> PathBuf {
    std::env::temp_dir().join(format!(
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
    for attempt in 0..5 {
        match create_lock(&lock_path, &details) {
            Ok(owner) => {
                return Ok(AcquiredProcessLock {
                    lock_path,
                    owner,
                    released: false,
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if let Some(owner) = read_owner(&lock_path) {
                    if process_matches_start_identity(owner.pid, owner.start_identity.as_deref()) {
                        return Err(ProcessSingletonError {
                            label,
                            detail: format!(" as pid {}", owner.pid),
                            code,
                            lock_path,
                            owner: Some(Box::new(owner)),
                        });
                    }
                }
                if attempt < 4 {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    continue;
                }
                let quarantine = lock_path.with_file_name(format!(
                    ".{}-stale-{}",
                    lock_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("instance-lock"),
                    std::process::id()
                ));
                let _ = fs::rename(&lock_path, &quarantine);
                let _ = fs::remove_dir_all(&quarantine);
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
    let owner = ProcessLockOwner {
        pid: std::process::id(),
        hostname: hostname(),
        command: std::env::args().collect::<Vec<_>>().join(" "),
        acquired_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        token: uuid_like(),
        component: details.component.clone(),
        start_identity: process_start_identity(std::process::id()),
        data_dir: details.data_dir.clone(),
        host: details.host.clone(),
        port: details.port,
        instance_id: details.instance_id.clone(),
    };
    write_json_atomic(&lock_path.join("initializing.json"), &owner, Some(0o600))?;
    write_owner(lock_path, &owner)?;
    let _ = fs::remove_file(lock_path.join("initializing.json"));
    Ok(owner)
}

fn write_owner(lock_path: &Path, owner: &ProcessLockOwner) -> io::Result<()> {
    let path = lock_path.join("owner.json");
    write_json_atomic(&path, owner, Some(0o600))?;
    restrict_file(&path)
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
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
