use std::io::{self, Write};
use std::path::Path;

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
    temporary.persist(path).map_err(|error| error.error)?;
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
}
