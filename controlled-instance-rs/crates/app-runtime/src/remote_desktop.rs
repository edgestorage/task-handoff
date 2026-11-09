//! Provider-owned release metadata and private install layout. The release build
//! fills the shared artifact list after G6 validation; absent entries cannot be
//! guessed or replaced by a host/global executable.
use crate::{InstallRecipe, ManagedAppDefinition, ManagedAppDetectionRule};
use controlled_instance_protocol::{
    AppCatalogItem, AppInstallPrivilege, AppKind, FinalComputerArch, FinalComputerPlatform,
};
use serde::Deserialize;
use std::collections::BTreeMap;
pub const APP_ID: &str = "remote-desktop";
pub const EXECUTABLE: &str = "bin/task-handoff-desktop-streaming";
#[derive(Deserialize)]
struct Artifact {
    version: String,
    platform: FinalComputerPlatform,
    arch: FinalComputerArch,
    url: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Release {
    artifacts: Vec<Artifact>,
}
pub fn definition() -> ManagedAppDefinition {
    definition_for_version(
        &controlled_instance_core::package_version::resolve_controlled_instance_package_version(),
    )
}
pub fn definition_for_version(version: &str) -> ManagedAppDefinition {
    let release = serde_json::from_str::<Release>(include_str!(
        "../../../../shared/remote-desktop-artifacts.json"
    ));
    let mut recipes: Vec<InstallRecipe> = release
        .ok()
        .map(|r| {
            r.artifacts
                .into_iter()
                .filter(|a| {
                    a.version == version
                        && matches!(
                            a.platform,
                            FinalComputerPlatform::Linux | FinalComputerPlatform::Darwin
                        )
                        && matches!(a.arch, FinalComputerArch::X64 | FinalComputerArch::Arm64)
                        && a.sha256.len() == 64
                        && a.sha256
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        && url::Url::parse(&a.url).ok().is_some_and(|url| {
                            url.scheme() == "https"
                                && url.has_host()
                                && url.username().is_empty()
                                && url.password().is_none()
                                && url.query().is_none()
                                && url.fragment().is_none()
                        })
                })
                .map(|a| InstallRecipe::Archive {
                    platforms: vec![a.platform],
                    arches: Some(vec![a.arch]),
                    privilege: Some(AppInstallPrivilege::User),
                    url: a.url,
                    sha256: a.sha256,
                    format: "tar.gz".into(),
                    install_root: APP_ID.into(),
                })
                .collect()
        })
        .unwrap_or_default();
    recipes.push(InstallRecipe::ArchiveOwnership {
        platforms: vec![FinalComputerPlatform::Linux, FinalComputerPlatform::Darwin],
        arches: Some(vec![FinalComputerArch::X64, FinalComputerArch::Arm64]),
        privilege: Some(AppInstallPrivilege::User),
        install_root: APP_ID.into(),
    });
    ManagedAppDefinition {
        launcher: AppCatalogItem {
            id: APP_ID.into(),
            name: "Remote Desktop".into(),
            kind: AppKind::Tty,
            description: Some("Optional instance desktop streaming component.".into()),
            command: Some(EXECUTABLE.into()),
            args: None,
            cwd: None,
            env: Some(BTreeMap::new()),
            display: None,
            default_display_target: None,
            automation: None,
            web: None,
        },
        launchable: false,
        detection: vec![ManagedAppDetectionRule::LauncherExecutable {
            version_args: vec!["--version".into()],
        }],
        recipes,
    }
}

pub struct InstalledPackage {
    pub binary: std::path::PathBuf,
    pub version: String,
}
pub fn installed_package(
    base: &std::path::Path,
    state: &std::path::Path,
) -> Result<Option<InstalledPackage>, crate::AppRuntimeError> {
    let root = base.join(APP_ID);
    let manifest = state.join("manifests").join(format!("{APP_ID}.json"));
    if !manifest.exists()
        && !root.join(EXECUTABLE).exists()
        && !root.join("desktop-component.json").exists()
        && !crate::archive_transaction::pending(state, APP_ID)
    {
        return Ok(None);
    }
    let invalid = || crate::AppRuntimeError::catalog_invalid("REMOTE_DESKTOP_PACKAGE_INVALID");
    let result = (|| -> Option<InstalledPackage> {
        if crate::archive_transaction::pending(state, APP_ID) {
            return None;
        }
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
        if record.get("appId")?.as_str()? != APP_ID
            || record.get("installRoot")?.as_str()? != root.to_str()?
        {
            return None;
        }
        let files = record.get("files")?.as_array()?;
        let metadata = std::fs::symlink_metadata(&root).ok()?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return None;
        }
        let canonical = root.canonicalize().ok()?;
        if !canonical.starts_with(base.canonicalize().ok()?) {
            return None;
        }
        for file in [EXECUTABLE, "desktop-component.json"] {
            if !files.iter().any(|v| v.as_str() == Some(file)) {
                return None;
            }
            let target = root.join(file);
            let metadata = std::fs::symlink_metadata(&target).ok()?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || !target.canonicalize().ok()?.starts_with(&canonical)
            {
                return None;
            }
        }
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("desktop-component.json")).ok()?)
                .ok()?;
        let version = record.get("version")?.as_str()?.to_string();
        if version.is_empty() {
            return None;
        }
        let binary = root.join(EXECUTABLE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&binary).ok()?.permissions().mode() & 0o111 == 0 {
                return None;
            }
        }
        Some(InstalledPackage { binary, version })
    })();
    result.map(Some).ok_or_else(invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    #[test]
    fn package_requires_owned_complete_tree_and_no_pending_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("apps");
        let state = dir.path().join("state");
        let root = base.join(APP_ID);
        let manifest = state.join("manifests/remote-desktop.json");
        assert!(installed_package(&base, &state).unwrap().is_none());
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(root.join(EXECUTABLE), "test-only").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join(EXECUTABLE), fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(
            root.join("desktop-component.json"),
            r#"{"version":"1","future":true}"#,
        )
        .unwrap();
        assert!(installed_package(&base, &state).is_err());
        let record = json!({"appId":APP_ID,"installRoot":root,"files":[EXECUTABLE,"desktop-component.json"]});
        fs::write(&manifest, serde_json::to_vec(&record).unwrap()).unwrap();
        let package = installed_package(&base, &state).unwrap().unwrap();
        assert_eq!(package.version, "1");
        assert_eq!(package.binary, root.join(EXECUTABLE));
        fs::write(root.join("desktop-component.json"), r#"{"version":""}"#).unwrap();
        assert!(installed_package(&base, &state).is_err());
        fs::remove_dir_all(&root).unwrap();
        fs::remove_file(&manifest).unwrap();
        fs::write(
            state.join("manifests/remote-desktop.json.transaction"),
            "{}",
        )
        .unwrap();
        assert!(installed_package(&base, &state).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn package_rejects_symlinked_executable() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("apps");
        let root = base.join(APP_ID);
        let state = dir.path().join("state");
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(state.join("manifests")).unwrap();
        fs::write(dir.path().join("external"), "test-only").unwrap();
        symlink(dir.path().join("external"), root.join(EXECUTABLE)).unwrap();
        fs::write(root.join("desktop-component.json"), r#"{"version":"1"}"#).unwrap();
        fs::write(state.join("manifests/remote-desktop.json"),serde_json::to_vec(&json!({"appId":APP_ID,"installRoot":root,"files":[EXECUTABLE,"desktop-component.json"]})).unwrap()).unwrap();
        assert!(installed_package(&base, &state).is_err());
    }
}
