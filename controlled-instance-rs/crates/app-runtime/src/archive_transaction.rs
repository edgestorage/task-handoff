//! Private same-version installer journal, shared on disk with the Node adapter.
//! A journal means the new tree is uncommitted; recover the old complete tree and
//! manifest before detecting readiness. Never replay an interrupted install job.
use crate::AppRecipeExecutionError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    root: PathBuf,
    staging: PathBuf,
    had_root: bool,
    old_manifest: Option<String>,
}
fn error() -> AppRecipeExecutionError {
    AppRecipeExecutionError::new(
        "app_recovery_failed",
        "The archive transaction could not be recovered.",
        true,
    )
}
fn write(path: &Path, value: &impl Serialize) -> Result<(), AppRecipeExecutionError> {
    controlled_instance_core::atomic::write_json_atomic(path, value, Some(0o600))
        .map_err(|_| error())
}
fn checked(file: &Path, base: &Path) -> Result<Journal, AppRecipeExecutionError> {
    let j: Journal =
        serde_json::from_slice(&fs::read(file).map_err(|_| error())?).map_err(|_| error())?;
    if !j.root.is_absolute()
        || !j.root.starts_with(base)
        || j.root == base
        || j.root
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || j.root.parent() != j.staging.parent()
        || !j
            .staging
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with(".install-"))
    {
        return Err(error());
    }
    let metadata = fs::symlink_metadata(&j.staging).map_err(|_| error())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(error());
    }
    let parent = j
        .root
        .parent()
        .ok_or_else(error)?
        .canonicalize()
        .map_err(|_| error())?;
    if !parent.starts_with(base.canonicalize().map_err(|_| error())?) {
        return Err(error());
    }
    Ok(j)
}
pub fn recover(file: &Path, base: &Path) -> Result<(), AppRecipeExecutionError> {
    let j = checked(file, base)?;
    let previous = j.staging.join("previous");
    if j.had_root && previous.exists() {
        if j.root.exists() {
            fs::remove_dir_all(&j.root).map_err(|_| error())?;
        }
        fs::rename(previous, &j.root).map_err(|_| error())?;
    } else if !j.had_root {
        if j.root.exists() {
            fs::remove_dir_all(&j.root).map_err(|_| error())?;
        }
    } else if !j.root.exists() {
        return Err(error());
    }
    let manifest = file.with_extension("");
    if let Some(old) = j.old_manifest {
        let value: Value = serde_json::from_str(&old).map_err(|_| error())?;
        write(&manifest, &value)?;
    } else if manifest.exists() {
        fs::remove_file(&manifest).map_err(|_| error())?;
    }
    fs::remove_file(file).map_err(|_| error())?;
    fs::remove_dir_all(j.staging).map_err(|_| error())?;
    Ok(())
}
pub fn recover_all(state_dir: &Path, base: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    if let Ok(entries) = fs::read_dir(state_dir.join("manifests")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(app) = name.strip_suffix(".json.transaction") {
                if recover(&entry.path(), base).is_err() {
                    failures.push(app.into());
                }
            }
        }
    }
    failures
}
pub fn journal_path(manifest: &Path) -> PathBuf {
    let mut name = manifest.as_os_str().to_os_string();
    name.push(".transaction");
    PathBuf::from(name)
}
pub fn pending(state_dir: &Path, app_id: &str) -> bool {
    state_dir
        .join("manifests")
        .join(format!("{app_id}.json.transaction"))
        .exists()
}
pub fn commit(
    root: &Path,
    staging: &Path,
    candidate: &Path,
    manifest: &Path,
    payload: &Value,
    base: &Path,
) -> Result<(), AppRecipeExecutionError> {
    let file = journal_path(manifest);
    if file.exists() {
        recover(&file, base)?;
    }
    let journal = Journal {
        root: root.into(),
        staging: staging.into(),
        had_root: root.exists(),
        old_manifest: if manifest.exists() {
            Some(fs::read_to_string(manifest).map_err(|_| error())?)
        } else {
            None
        },
    };
    write(&file, &journal)?;
    let result = (|| {
        if journal.had_root {
            fs::rename(root, staging.join("previous")).map_err(|_| error())?;
        }
        fs::rename(candidate, root).map_err(|_| error())?;
        if payload.is_null() {
            if manifest.exists() {
                fs::remove_file(manifest).map_err(|_| error())?;
            }
        } else {
            write(manifest, payload)?;
        }
        fs::remove_file(&file).map_err(|_| error())?;
        Ok(())
    })();
    if result.is_err() {
        recover(&file, base)?;
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn uninstall_commit_and_interruption_preserve_unowned_files_and_restore_ownership() {
        for interrupted in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path().join("apps");
            let root = base.join("tool");
            let state = dir.path().join("state");
            let manifest = state.join("manifests/tool.json");
            let staging = base.join(".install-tool-uninstall");
            let candidate = staging.join("candidate");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir_all(&candidate).unwrap();
            fs::write(root.join("binary"), "owned").unwrap();
            fs::write(root.join("user"), "preserve").unwrap();
            fs::write(candidate.join("user"), "preserve").unwrap();
            let old = json!({"installRoot":root,"files":["binary"]});
            write(&manifest, &old).unwrap();
            if interrupted {
                write(
                    &journal_path(&manifest),
                    &Journal {
                        root: root.clone(),
                        staging: staging.clone(),
                        had_root: true,
                        old_manifest: Some(old.to_string()),
                    },
                )
                .unwrap();
                fs::rename(&root, staging.join("previous")).unwrap();
                fs::rename(&candidate, &root).unwrap();
                fs::remove_file(&manifest).unwrap();
                assert!(recover_all(&state, &base).is_empty());
                assert_eq!(fs::read_to_string(root.join("binary")).unwrap(), "owned");
                assert!(manifest.exists());
            } else {
                commit(&root, &staging, &candidate, &manifest, &Value::Null, &base).unwrap();
                assert!(!root.join("binary").exists());
                assert!(!manifest.exists());
                assert!(!pending(&state, "tool"));
            }
            assert_eq!(fs::read_to_string(root.join("user")).unwrap(), "preserve");
        }
    }
    #[test]
    fn restart_restores_previous_tree_and_manifest_at_every_commit_boundary() {
        for boundary in 0..4 {
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path().join("apps");
            let root = base.join("tool");
            let state = dir.path().join("state");
            let manifest = state.join("manifests/tool.json");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir_all(manifest.parent().unwrap()).unwrap();
            fs::write(root.join("binary"), "old").unwrap();
            fs::write(root.join("unowned"), "user").unwrap();
            let old = json!({"installRoot":root,"files":["binary"]});
            write(&manifest, &old).unwrap();
            let staging = base.join(".install-tool-test");
            let candidate = staging.join("candidate");
            fs::create_dir_all(&candidate).unwrap();
            fs::write(candidate.join("binary"), "new").unwrap();
            write(
                &journal_path(&manifest),
                &Journal {
                    root: root.clone(),
                    staging: staging.clone(),
                    had_root: true,
                    old_manifest: Some(old.to_string()),
                },
            )
            .unwrap();
            if boundary > 0 {
                fs::rename(&root, staging.join("previous")).unwrap();
            }
            if boundary > 1 {
                fs::rename(candidate, &root).unwrap();
            }
            if boundary > 2 {
                write(&manifest, &json!({"files":["new"]})).unwrap();
            }
            assert!(recover_all(&state, &base).is_empty());
            assert_eq!(fs::read_to_string(root.join("binary")).unwrap(), "old");
            assert_eq!(fs::read_to_string(root.join("unowned")).unwrap(), "user");
            assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(&manifest).unwrap()).unwrap(),
                old
            );
            assert!(recover_all(&state, &base).is_empty());
        }
    }
    #[test]
    fn invalid_journal_cannot_remove_external_paths() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("apps");
        fs::create_dir(&base).unwrap();
        let state = dir.path().join("state");
        let manifest = state.join("manifests/tool.json");
        let staging = base.join(".install-tool-test");
        fs::create_dir(&staging).unwrap();
        write(
            &journal_path(&manifest),
            &Journal {
                root: dir.path().into(),
                staging,
                had_root: false,
                old_manifest: None,
            },
        )
        .unwrap();
        assert_eq!(recover_all(&state, &base), vec!["tool"]);
        assert!(pending(&state, "tool"));
        assert!(base.exists());
    }
}
