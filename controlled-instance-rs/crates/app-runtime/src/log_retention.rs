use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};
use tokio::{io::AsyncReadExt, process::Child};

pub(crate) const DEFAULT_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub(crate) const DEFAULT_LOG_BACKUP_COUNT: usize = 2;
pub(crate) const DEFAULT_APP_SESSION_LOG_BUDGET_BYTES: u64 = 192 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct RotatingLogWriter {
    path: Arc<PathBuf>,
    max_bytes: u64,
    backup_count: usize,
    state: Arc<Mutex<WriterState>>,
}

struct WriterState {
    file: Option<File>,
    size: u64,
}

impl RotatingLogWriter {
    pub(crate) fn open(path: impl Into<PathBuf>) -> io::Result<Self> {
        Self::open_with(path, DEFAULT_LOG_MAX_BYTES, DEFAULT_LOG_BACKUP_COUNT)
    }

    fn open_with(
        path: impl Into<PathBuf>,
        max_bytes: u64,
        backup_count: usize,
    ) -> io::Result<Self> {
        let path = path.into();
        ensure_private_directory(path.parent().unwrap_or_else(|| Path::new(".")))?;
        rotate_oversized_existing_file(&path, max_bytes, backup_count)?;
        normalize_backup_sizes(&path, max_bytes, backup_count)?;
        let file = open_active_log(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            path: Arc::new(path),
            max_bytes,
            backup_count,
            state: Arc::new(Mutex::new(WriterState {
                file: Some(file),
                size,
            })),
        })
    }

    pub(crate) fn write(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.size > 0 && state.size.saturating_add(bytes.len() as u64) > self.max_bytes {
            self.rotate_locked(&mut state)?;
        }
        let tail = if bytes.len() as u64 > self.max_bytes {
            let start = bytes.len().saturating_sub(self.max_bytes as usize);
            &bytes[start..]
        } else {
            bytes
        };
        let file = state
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("log file is not open"))?;
        file.write_all(tail)?;
        state.size = state.size.saturating_add(tail.len() as u64);
        Ok(())
    }

    fn rotate_locked(&self, state: &mut WriterState) -> io::Result<()> {
        state.file.take();
        rotate_files(&self.path, self.backup_count)?;
        state.file = Some(open_active_log(&self.path)?);
        state.size = 0;
        Ok(())
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        self.path.as_path()
    }
}

pub(crate) fn attach_child_logs(child: &mut Child, log_path: &Path) -> io::Result<()> {
    let writer = RotatingLogWriter::open(log_path.to_path_buf())?;
    if let Some(stdout) = child.stdout.take() {
        forward_output(stdout, writer.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        forward_output(stderr, writer);
    }
    Ok(())
}

fn forward_output<R>(mut reader: R, writer: RotatingLogWriter)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(size) => {
                    if writer.write(&buffer[..size]).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
}

pub(crate) fn enforce_instance_log_budget(
    log_root: &Path,
    active_log_directories: impl IntoIterator<Item = PathBuf>,
    max_bytes: u64,
) -> Vec<PathBuf> {
    let log_root = absolute_path(log_root);
    let active_roots = active_log_directories
        .into_iter()
        .map(|path| absolute_path(&path))
        .collect::<Vec<_>>();
    if !log_root.is_dir() || is_symlink(&log_root) {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_log_files(&log_root, &active_roots, &mut files);
    let mut total = files.iter().map(|file| file.size).sum::<u64>();
    if total <= max_bytes {
        return Vec::new();
    }
    files.sort_by(|left, right| {
        left.active
            .cmp(&right.active)
            .then_with(|| left.modified.cmp(&right.modified))
    });

    let mut deleted = Vec::new();
    for file in files {
        if total <= max_bytes {
            break;
        }
        if file.active && !file.rotated {
            continue;
        }
        if fs::remove_file(&file.path).is_ok() {
            total = total.saturating_sub(file.size);
            deleted.push(file.path);
        }
    }
    deleted
}

struct LogFile {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
    active: bool,
    rotated: bool,
}

fn collect_log_files(root: &Path, active_roots: &[PathBuf], files: &mut Vec<LogFile>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_log_files(&path, active_roots, files);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let resolved = absolute_path(&path);
        files.push(LogFile {
            path,
            size: metadata.len(),
            modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            active: active_roots.iter().any(|root| resolved.starts_with(root)),
            rotated: is_rotated_log_name(&entry.file_name().to_string_lossy()),
        });
    }
}

fn rotate_oversized_existing_file(
    path: &Path,
    max_bytes: u64,
    backup_count: usize,
) -> io::Result<()> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() < max_bytes {
        return Ok(());
    }
    let tail = read_file_tail(path, max_bytes)?;
    shift_backups(path, backup_count)?;
    if backup_count > 0 {
        write_private_file(&rotated_path(path, 1), &tail)?;
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn normalize_backup_sizes(path: &Path, max_bytes: u64, backup_count: usize) -> io::Result<()> {
    for generation in 1..=backup_count {
        let backup = rotated_path(path, generation);
        let Ok(metadata) = fs::metadata(&backup) else {
            continue;
        };
        if metadata.len() <= max_bytes {
            continue;
        }
        let tail = read_file_tail(&backup, max_bytes)?;
        write_private_file(&backup, &tail)?;
    }
    Ok(())
}

fn rotate_files(path: &Path, backup_count: usize) -> io::Result<()> {
    if backup_count == 0 {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        };
    }
    shift_backups(path, backup_count)?;
    match fs::rename(path, rotated_path(path, 1)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn shift_backups(path: &Path, backup_count: usize) -> io::Result<()> {
    if backup_count == 0 {
        return Ok(());
    }
    remove_if_exists(&rotated_path(path, backup_count))?;
    for generation in (1..backup_count).rev() {
        let source = rotated_path(path, generation);
        if source.exists() {
            fs::rename(source, rotated_path(path, generation + 1))?;
        }
    }
    Ok(())
}

fn open_active_log(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    restrict_private_file(path)?;
    Ok(file)
}

fn write_private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::write(path, bytes)?;
    restrict_private_file(path)
}

fn read_file_tail(path: &Path, max_bytes: u64) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(max_bytes)))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        let start = bytes.len().saturating_sub(max_bytes as usize);
        bytes.drain(..start);
    }
    Ok(bytes)
}

fn rotated_path(path: &Path, generation: usize) -> PathBuf {
    let extension = path.extension().and_then(|value| value.to_str());
    let stem = path
        .file_stem()
        .unwrap_or_else(|| path.file_name().unwrap_or_default());
    let name = match extension {
        Some(extension) if !extension.is_empty() => {
            format!("{}.{generation}.{extension}", stem.to_string_lossy())
        }
        _ => format!("{}.{generation}", stem.to_string_lossy()),
    };
    path.with_file_name(name)
}

fn is_rotated_log_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".log") else {
        return false;
    };
    let Some((_, generation)) = stem.rsplit_once('.') else {
        return false;
    };
    !generation.is_empty() && generation.bytes().all(|byte| byte.is_ascii_digit())
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    restrict_private_directory(path)
}

#[cfg(unix)]
fn restrict_private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_private_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_private_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_private_file(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_lexically(path)
    } else {
        std::env::current_dir()
            .map(|current| normalize_lexically(&current.join(path)))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some() {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn production_log_limits_match_the_node_contract() {
        assert_eq!(DEFAULT_LOG_MAX_BYTES, 10 * 1024 * 1024);
        assert_eq!(DEFAULT_LOG_BACKUP_COUNT, 2);
        assert_eq!(DEFAULT_APP_SESSION_LOG_BUDGET_BYTES, 192 * 1024 * 1024);
    }

    #[test]
    fn rotating_writer_keeps_two_backups_and_outputs_after_rotation() {
        let root = tempfile::tempdir().expect("tempdir");
        let path = root.path().join("tty.log");
        let writer = RotatingLogWriter::open_with(&path, 8, 2).expect("writer");

        writer.write(b"123456").expect("first");
        writer.write(b"abcdef").expect("second");
        writer.write(b"XYZW").expect("third");

        assert_eq!(fs::read_to_string(&path).expect("active"), "XYZW");
        assert_eq!(
            fs::read_to_string(root.path().join("tty.1.log")).expect("backup 1"),
            "abcdef"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("tty.2.log")).expect("backup 2"),
            "123456"
        );
        assert_eq!(writer.path(), path);
    }

    #[test]
    fn rotating_writer_normalizes_oversized_existing_file() {
        let root = tempfile::tempdir().expect("tempdir");
        let path = root.path().join("tty.log");
        fs::write(&path, b"0123456789abcdef").expect("existing log");

        let writer = RotatingLogWriter::open_with(&path, 8, 2).expect("writer");

        assert_eq!(writer.path(), path);
        assert_eq!(fs::read(&path).expect("active"), b"");
        assert_eq!(
            fs::read(root.path().join("tty.1.log")).expect("backup"),
            b"89abcdef"
        );
    }

    #[test]
    fn rotating_writer_keeps_the_tail_of_an_oversized_chunk() {
        let root = tempfile::tempdir().expect("tempdir");
        let path = root.path().join("tty.log");
        let writer = RotatingLogWriter::open_with(&path, 8, 2).expect("writer");

        writer.write(b"0123456789abcdef").expect("write");

        assert_eq!(fs::read(&path).expect("active"), b"89abcdef");
        assert!(!root.path().join("tty.1.log").exists());
    }

    #[test]
    fn instance_log_budget_deletes_inactive_then_rotated_logs() {
        let root = tempfile::tempdir().expect("tempdir");
        let log_root = root.path().join("logs/app-sessions");
        let active = log_root.join("active");
        let inactive_old = log_root.join("old/inactive.log");
        let inactive_new = log_root.join("new/inactive.log");
        fs::create_dir_all(&active).expect("active dir");
        fs::create_dir_all(inactive_old.parent().expect("old parent")).expect("old dir");
        fs::create_dir_all(inactive_new.parent().expect("new parent")).expect("new dir");
        fs::write(active.join("active.log"), b"aaaa").expect("active log");
        fs::write(active.join("active.1.log"), b"bbbb").expect("active rotated");
        fs::write(&inactive_old, b"cccc").expect("old log");
        fs::write(&inactive_new, b"dddd").expect("new log");
        let now = SystemTime::now();
        fs::File::options()
            .write(true)
            .open(&inactive_old)
            .expect("old file")
            .set_modified(now - Duration::from_secs(60))
            .expect("old mtime");
        fs::File::options()
            .write(true)
            .open(&inactive_new)
            .expect("new file")
            .set_modified(now)
            .expect("new mtime");

        let deleted = enforce_instance_log_budget(&log_root, [active.clone()], 4);

        assert_eq!(deleted.len(), 3);
        assert!(!inactive_old.exists());
        assert!(!inactive_new.exists());
        assert!(!active.join("active.1.log").exists());
        assert!(active.join("active.log").exists());
    }
}
