use crate::{display_path, error::RepositoryOperationError, hash_id};
use controlled_instance_protocol::{
    RepositoryDirectoryEntry, RepositoryDirectoryListing, RepositoryFileContent,
    RepositoryFileKind, RepositoryFileMode, RepositoryPathKind, RepositoryPathSearchEntry,
    RepositoryPathSearchResult,
};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

const DEFAULT_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct RepositoryFileService {
    root: PathBuf,
    boundary_root: PathBuf,
    max_file_bytes: u64,
}

impl RepositoryFileService {
    pub fn new(
        root: impl Into<PathBuf>,
        boundary_root: Option<PathBuf>,
        max_file_bytes: Option<u64>,
    ) -> Result<Self, RepositoryOperationError> {
        let root = fs::canonicalize(root.into()).map_err(|_| {
            RepositoryOperationError::new(
                "REPOSITORY_CWD_INACCESSIBLE",
                "Repository root is not accessible.",
            )
        })?;
        if !root.is_dir() {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_CWD_INACCESSIBLE",
                "Repository root is not a directory.",
            ));
        }
        let boundary_root = match boundary_root {
            Some(root) => fs::canonicalize(root).map_err(|_| {
                RepositoryOperationError::new(
                    "REPOSITORY_CWD_INACCESSIBLE",
                    "Workspace boundary is not accessible.",
                )
            })?,
            None => root.clone(),
        };
        if !boundary_root.is_dir() {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_CWD_INACCESSIBLE",
                "Workspace boundary is not a directory.",
            ));
        }
        if !within_root(&root, &boundary_root) {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_PATH_FORBIDDEN",
                "Repository root is outside the instance workspace boundary.",
            ));
        }
        Ok(Self {
            root,
            boundary_root,
            max_file_bytes: max_file_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES),
        })
    }

    pub fn list(
        &self,
        relative_path: &str,
    ) -> Result<RepositoryDirectoryListing, RepositoryOperationError> {
        let resolved = self.resolve(relative_path, true, true)?;
        let metadata = fs::symlink_metadata(&resolved).map_err(file_not_found)?;
        if !metadata.is_dir() {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_PATH_INVALID",
                "Directory path does not identify a directory.",
            ));
        }
        let mut entries = Vec::new();
        let read_dir = fs::read_dir(&resolved).map_err(file_io_error)?;
        for entry in read_dir {
            let entry = entry.map_err(file_io_error)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.eq_ignore_ascii_case(".git") {
                continue;
            }
            let entry_path = if relative_path.is_empty() {
                name.clone()
            } else {
                format!("{relative_path}/{name}")
            };
            let absolute_path = entry.path();
            let metadata = fs::symlink_metadata(&absolute_path).map_err(file_io_error)?;
            let kind = self.kind(&absolute_path, &metadata);
            let is_file = kind == RepositoryFileKind::File;
            entries.push(RepositoryDirectoryEntry {
                name,
                path: entry_path,
                kind,
                traversable: metadata.is_dir(),
                editable: is_file && metadata.len() <= self.max_file_bytes,
                size: is_file.then_some(metadata.len()),
                mode: is_file.then(|| file_mode(&metadata)),
            });
        }
        entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        let snapshot_id = directory_version(&entries)?;
        Ok(RepositoryDirectoryListing {
            path: relative_path.to_string(),
            entries,
            snapshot_id,
        })
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<RepositoryPathSearchResult, RepositoryOperationError> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(RepositoryPathSearchResult {
                entries: Vec::new(),
                truncated: false,
            });
        }
        let mut entries = Vec::new();
        let mut pending = VecDeque::from([(self.root.clone(), String::new())]);
        while let Some((directory, relative_directory)) = pending.pop_front() {
            let mut children = fs::read_dir(&directory)
                .map_err(file_io_error)?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            children.sort_by(|left, right| {
                left.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .cmp(&right.file_name().to_string_lossy().to_lowercase())
            });
            for child in children {
                let name = child.file_name().to_string_lossy().into_owned();
                if name.eq_ignore_ascii_case(".git") {
                    continue;
                }
                let relative_path = if relative_directory.is_empty() {
                    name.clone()
                } else {
                    format!("{relative_directory}/{name}")
                };
                let absolute_path = child.path();
                let Ok(metadata) = fs::symlink_metadata(&absolute_path) else {
                    continue;
                };
                let kind = self.kind(&absolute_path, &metadata);
                let searchable = match kind {
                    RepositoryFileKind::File => Some(RepositoryPathKind::File),
                    RepositoryFileKind::Directory => Some(RepositoryPathKind::Directory),
                    _ => None,
                };
                if let Some(kind) = searchable {
                    if relative_path.to_lowercase().contains(&query) {
                        if entries.len() >= limit {
                            return Ok(RepositoryPathSearchResult {
                                entries,
                                truncated: true,
                            });
                        }
                        entries.push(RepositoryPathSearchEntry {
                            name,
                            path: relative_path.clone(),
                            kind,
                        });
                    }
                }
                if kind == RepositoryFileKind::Directory {
                    pending.push_back((absolute_path, relative_path));
                }
            }
        }
        Ok(RepositoryPathSearchResult {
            entries,
            truncated: false,
        })
    }

    pub fn read(
        &self,
        relative_path: &str,
    ) -> Result<RepositoryFileContent, RepositoryOperationError> {
        let resolved = self.resolve(relative_path, false, true)?;
        let metadata = fs::symlink_metadata(&resolved).map_err(file_not_found)?;
        self.assert_regular_file(&resolved, &metadata)?;
        if metadata.len() > self.max_file_bytes {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_FILE_TOO_LARGE",
                format!("File exceeds {} bytes.", self.max_file_bytes),
            ));
        }
        let mut file = fs::File::open(&resolved).map_err(file_io_error)?;
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).map_err(file_io_error)?;
        if buffer.contains(&0) {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_FILE_BINARY",
                "Binary files cannot be opened in the text editor.",
            ));
        }
        let content = String::from_utf8(buffer.clone()).map_err(|_| {
            RepositoryOperationError::new("REPOSITORY_FILE_BINARY", "File is not valid UTF-8 text.")
        })?;
        Ok(RepositoryFileContent {
            path: relative_path.to_string(),
            content,
            byte_length: buffer.len() as u64,
            version: file_version(&buffer, &metadata),
            mode: file_mode(&metadata),
        })
    }

    pub fn create(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<RepositoryFileContent, RepositoryOperationError> {
        let resolved = self.resolve(relative_path, false, false)?;
        if resolved.exists() {
            return Err(file_exists());
        }
        let buffer = text_buffer(content, self.max_file_bytes)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o644);
        }
        let mut file = options.open(&resolved).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                file_exists()
            } else {
                file_io_error(error)
            }
        })?;
        file.write_all(&buffer).map_err(file_io_error)?;
        self.read(relative_path)
    }

    pub fn write(
        &self,
        relative_path: &str,
        content: &str,
        expected_version: &str,
    ) -> Result<RepositoryFileContent, RepositoryOperationError> {
        let current = self.read(relative_path)?;
        if current.version != expected_version {
            return Err(file_stale("File changed after it was opened."));
        }
        let resolved = self.resolve(relative_path, false, true)?;
        let buffer = text_buffer(content, self.max_file_bytes)?;
        let metadata = fs::metadata(&resolved).map_err(file_io_error)?;
        let temp_path = resolved.with_file_name(format!(
            ".{}.task-handoff-{}.tmp",
            resolved
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("file"),
            uuid::Uuid::new_v4()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            use std::os::unix::fs::PermissionsExt;
            options.mode(metadata.permissions().mode() & 0o777);
        }
        let result = (|| {
            let mut file = options.open(&temp_path).map_err(file_io_error)?;
            file.write_all(&buffer).map_err(file_io_error)?;
            file.sync_all().map_err(file_io_error)?;
            if self.read(relative_path)?.version != expected_version {
                return Err(file_stale("File changed while it was being saved."));
            }
            fs::rename(&temp_path, &resolved).map_err(file_io_error)?;
            fs::set_permissions(&resolved, metadata.permissions()).map_err(file_io_error)?;
            Ok(())
        })();
        let _ = fs::remove_file(&temp_path);
        result?;
        self.read(relative_path)
    }

    pub fn rename(
        &self,
        relative_path: &str,
        destination: &str,
        expected_version: &str,
    ) -> Result<RepositoryFileContent, RepositoryOperationError> {
        let current = self.read(relative_path)?;
        if current.version != expected_version {
            return Err(file_stale("File changed before it was renamed."));
        }
        let source = self.resolve(relative_path, false, true)?;
        let target = self.resolve(destination, false, false)?;
        if target.exists() {
            return Err(file_exists());
        }
        fs::hard_link(&source, &target).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                file_exists()
            } else {
                file_io_error(error)
            }
        })?;
        if let Err(error) = fs::remove_file(&source) {
            let _ = fs::remove_file(&target);
            return Err(file_io_error(error));
        }
        self.read(destination)
    }

    pub fn delete(
        &self,
        relative_path: &str,
        expected_version: &str,
    ) -> Result<(), RepositoryOperationError> {
        let current = self.read(relative_path)?;
        if current.version != expected_version {
            return Err(file_stale("File changed before it was deleted."));
        }
        fs::remove_file(self.resolve(relative_path, false, true)?).map_err(file_io_error)
    }

    fn resolve(
        &self,
        relative_path: &str,
        allow_root: bool,
        must_exist: bool,
    ) -> Result<PathBuf, RepositoryOperationError> {
        let segments = if relative_path.is_empty() && allow_root {
            Vec::new()
        } else {
            validate_repository_relative_path(relative_path)?
        };
        let mut current = self.root.clone();
        for (index, segment) in segments.iter().enumerate() {
            current.push(segment);
            let is_target = index == segments.len() - 1;
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        return Err(RepositoryOperationError::new(
                            "REPOSITORY_PATH_FORBIDDEN",
                            "Symbolic links are outside the repository file boundary.",
                        ));
                    }
                    if !is_target && !metadata.is_dir() {
                        return Err(RepositoryOperationError::new(
                            "REPOSITORY_PATH_INVALID",
                            "A parent path is not a directory.",
                        ));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if !is_target || must_exist {
                        return Err(RepositoryOperationError::new(
                            "REPOSITORY_FILE_NOT_FOUND",
                            "Repository path does not exist.",
                        ));
                    }
                }
                Err(error) => return Err(file_io_error(error)),
            }
        }
        if !within_root(&current, &self.root) || !within_root(&current, &self.boundary_root) {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_PATH_FORBIDDEN",
                "Path escapes the instance workspace boundary.",
            ));
        }
        Ok(current)
    }

    fn kind(&self, absolute_path: &Path, metadata: &fs::Metadata) -> RepositoryFileKind {
        if metadata.file_type().is_symlink() {
            return RepositoryFileKind::Symlink;
        }
        if metadata.is_file() {
            return RepositoryFileKind::File;
        }
        if metadata.is_dir() {
            let dot_git = absolute_path.join(".git");
            if let Ok(git_metadata) = fs::symlink_metadata(&dot_git) {
                return if git_metadata.is_file() {
                    RepositoryFileKind::Submodule
                } else {
                    RepositoryFileKind::NestedRepository
                };
            }
            return RepositoryFileKind::Directory;
        }
        RepositoryFileKind::Special
    }

    fn assert_regular_file(
        &self,
        absolute_path: &Path,
        metadata: &fs::Metadata,
    ) -> Result<(), RepositoryOperationError> {
        if !metadata.is_file() {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_FILE_UNSUPPORTED",
                format!(
                    "Only regular files can be edited: {}.",
                    display_path(absolute_path)
                ),
            ));
        }
        Ok(())
    }
}

pub fn validate_repository_relative_path(
    relative_path: &str,
) -> Result<Vec<String>, RepositoryOperationError> {
    if relative_path.is_empty()
        || relative_path.contains('\0')
        || relative_path.starts_with('/')
        || relative_path.starts_with('\\')
        || is_windows_absolute(relative_path)
    {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_PATH_INVALID",
            "Path must be repository-relative.",
        ));
    }
    let path = Path::new(relative_path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_PATH_INVALID",
            "Path contains a forbidden segment.",
        ));
    }
    let segments = relative_path
        .split('/')
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if segments.iter().any(|segment| {
        segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.eq_ignore_ascii_case(".git")
    }) {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_PATH_INVALID",
            "Path contains a forbidden segment.",
        ));
    }
    Ok(segments)
}

fn is_windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

pub fn within_root(candidate: &Path, root: &Path) -> bool {
    let Ok(relative) = candidate.strip_prefix(root) else {
        return false;
    };
    relative
        .components()
        .all(|component| !matches!(component, Component::ParentDir))
}

fn text_buffer(content: &str, max_bytes: u64) -> Result<Vec<u8>, RepositoryOperationError> {
    if content.contains('\0') {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_FILE_BINARY",
            "Text content cannot contain NUL bytes.",
        ));
    }
    let buffer = content.as_bytes().to_vec();
    if buffer.len() as u64 > max_bytes {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_FILE_TOO_LARGE",
            format!("File exceeds {max_bytes} bytes."),
        ));
    }
    Ok(buffer)
}

#[cfg(unix)]
fn file_mode(metadata: &fs::Metadata) -> RepositoryFileMode {
    use std::os::unix::fs::PermissionsExt;
    let executable = metadata.permissions().mode() & 0o111 != 0;
    RepositoryFileMode {
        executable,
        git_mode: Some(if executable { "100755" } else { "100644" }.to_string()),
    }
}

#[cfg(not(unix))]
fn file_mode(_metadata: &fs::Metadata) -> RepositoryFileMode {
    RepositoryFileMode {
        executable: false,
        git_mode: Some("100644".to_string()),
    }
}

fn file_version(buffer: &[u8], metadata: &fs::Metadata) -> String {
    let mut hasher = Sha256::new();
    hasher.update(buffer);
    hasher.update(format!("{}", mode_bits(metadata) & 0o777));
    format!("version:{}", hex::encode(hasher.finalize()))
}

fn directory_version(
    entries: &[RepositoryDirectoryEntry],
) -> Result<String, RepositoryOperationError> {
    let serialized = serde_json::to_string(entries).map_err(|error| {
        RepositoryOperationError::new("REPOSITORY_OPERATION_FAILED", error.to_string())
    })?;
    Ok(hash_id("snapshot", &[serialized]))
}

#[cfg(unix)]
fn mode_bits(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode()
}

#[cfg(not(unix))]
fn mode_bits(_metadata: &fs::Metadata) -> u32 {
    0
}

fn file_exists() -> RepositoryOperationError {
    RepositoryOperationError::new("REPOSITORY_FILE_EXISTS", "Destination already exists.")
}

fn file_stale(message: &str) -> RepositoryOperationError {
    RepositoryOperationError::new("REPOSITORY_FILE_STALE", message)
}

fn file_not_found(_error: std::io::Error) -> RepositoryOperationError {
    RepositoryOperationError::new(
        "REPOSITORY_FILE_NOT_FOUND",
        "Repository path does not exist.",
    )
}

fn file_io_error(error: std::io::Error) -> RepositoryOperationError {
    RepositoryOperationError::new("REPOSITORY_OPERATION_FAILED", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_reject_traversal_and_git_metadata() {
        assert!(validate_repository_relative_path("../outside").is_err());
        assert!(validate_repository_relative_path("/absolute").is_err());
        assert!(validate_repository_relative_path(".git/config").is_err());
        assert_eq!(
            validate_repository_relative_path("src/main.rs").expect("path"),
            vec!["src".to_string(), "main.rs".to_string()]
        );
    }

    #[test]
    fn file_service_round_trips_versions_and_rejects_stale_writes() {
        let root = tempfile::tempdir().expect("tempdir");
        let service = RepositoryFileService::new(root.path(), None, None).expect("service");
        let created = service.create("README.md", "first\n").expect("create");
        assert_eq!(created.content, "first\n");
        assert!(service.create("README.md", "again\n").is_err());
        let updated = service
            .write("README.md", "second\n", &created.version)
            .expect("write");
        assert_eq!(updated.content, "second\n");
        let stale = service.write("README.md", "third\n", &created.version);
        assert_eq!(stale.expect_err("stale").code, "REPOSITORY_FILE_STALE");
        let listing = service.list("").expect("list");
        assert!(listing
            .entries
            .iter()
            .any(|entry| entry.path == "README.md"));
        let search = service.search("read", 100).expect("search");
        assert_eq!(search.entries[0].path, "README.md");
    }
}
