use std::io::{self, Write};
use std::path::Path;
#[cfg(any(windows, test))]
use std::time::Duration;

#[cfg(any(windows, test))]
const WINDOWS_REPLACE_RETRY_DELAYS: [Duration; 7] = [
    Duration::from_millis(10),
    Duration::from_millis(20),
    Duration::from_millis(40),
    Duration::from_millis(80),
    Duration::from_millis(160),
    Duration::from_millis(320),
    Duration::from_millis(640),
];

#[cfg(any(windows, test))]
fn is_transient_windows_replace_error(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::PermissionDenied)
        || matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(any(windows, test))]
fn retry_windows_replace<T>(
    mut operation: impl FnMut() -> io::Result<T>,
    mut wait: impl FnMut(Duration),
) -> io::Result<T> {
    for attempt in 0.. {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if is_transient_windows_replace_error(&error) => {
                let Some(delay) = WINDOWS_REPLACE_RETRY_DELAYS.get(attempt) else {
                    return Err(error);
                };
                wait(*delay);
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the retry loop only exits by returning")
}

pub fn write_atomic(path: &Path, bytes: &[u8], _mode: Option<u32>) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let parent_created = !parent.exists();
    std::fs::create_dir_all(parent)?;
    #[cfg(unix)]
    if parent_created {
        crate::fs_permissions::restrict_path(parent, 0o700)?;
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file_mut().sync_all()?;
    #[cfg(unix)]
    if let Some(mode) = _mode {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    let mut temporary = Some(temporary);
    let mut persist = || {
        let file = temporary
            .take()
            .expect("the temporary file is retained for each persist attempt");
        match file.persist(path) {
            Ok(_) => Ok(()),
            Err(error) => {
                temporary = Some(error.file);
                Err(error.error)
            }
        }
    };
    #[cfg(windows)]
    retry_windows_replace(persist, std::thread::sleep)?;
    #[cfg(not(windows))]
    persist()?;
    #[cfg(unix)]
    {
        let directory = std::fs::File::open(parent)?;
        directory.sync_all()?;
    }
    Ok(())
}

pub fn write_json_atomic<T: serde::Serialize>(
    path: &Path,
    value: &T,
    mode: Option<u32>,
) -> io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    write_atomic(path, &bytes, mode)
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> io::Result<T> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_a_complete_file() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("state.json");
        write_json_atomic(&path, &serde_json::json!({ "revision": 1 }), Some(0o600))
            .expect("write");
        write_json_atomic(&path, &serde_json::json!({ "revision": 2 }), Some(0o600))
            .expect("replace");
        let value: serde_json::Value = read_json(&path).expect("read");
        assert_eq!(value["revision"], 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn windows_replace_retries_transient_sharing_errors() {
        let mut attempts = 0;
        let mut waits = Vec::new();
        retry_windows_replace(
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(io::Error::from_raw_os_error(32))
                } else {
                    Ok(())
                }
            },
            |delay| waits.push(delay),
        )
        .expect("transient sharing violations should be retried");
        assert_eq!(attempts, 3);
        assert_eq!(waits, WINDOWS_REPLACE_RETRY_DELAYS[..2]);
    }

    #[test]
    fn windows_replace_stops_after_the_retry_budget() {
        let mut attempts = 0;
        let error = retry_windows_replace(
            || {
                attempts += 1;
                Err::<(), _>(io::Error::from_raw_os_error(5))
            },
            |_| {},
        )
        .expect_err("exhausted retries must remain visible");
        assert_eq!(error.raw_os_error(), Some(5));
        assert_eq!(attempts, WINDOWS_REPLACE_RETRY_DELAYS.len() + 1);
    }

    #[test]
    fn windows_replace_does_not_retry_unrelated_errors() {
        let mut attempts = 0;
        let error = retry_windows_replace(
            || {
                attempts += 1;
                Err::<(), _>(io::Error::from(io::ErrorKind::NotFound))
            },
            |_| {},
        )
        .expect_err("unrelated errors must fail immediately");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert_eq!(attempts, 1);
    }
}
