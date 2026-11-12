//! Provider-owned npm package metadata and private install layout. The package
//! version follows the controlled-instance release; npm is only the artifact
//! source and no package lifecycle script is executed.
use crate::{
    managed_native_app_launcher, managed_native_app_manifest_path, managed_native_app_root,
    native_package::{
        valid_native_launch_path, valid_native_package_name, valid_native_package_version,
        ManagedAppRecipeLibc, NativePackageIntegrity,
    },
    read_native_app_manifest, InstallRecipe, ManagedAppDefinition, ManagedAppDetectionRule,
};
use controlled_instance_protocol::{
    AppCatalogItem, AppInstallPrivilege, AppKind, FinalComputerArch, FinalComputerPlatform,
};
use serde::Deserialize;
use std::collections::BTreeMap;
pub const APP_ID: &str = "remote-desktop";
pub const EXECUTABLE: &str = "bin/task-handoff-desktop-streaming";
#[derive(Deserialize)]
struct PackageArtifact {
    version: String,
    platform: FinalComputerPlatform,
    arch: FinalComputerArch,
    package: String,
    integrity: String,
}
#[derive(Deserialize)]
struct Release {
    packages: Vec<PackageArtifact>,
}
pub fn definition() -> ManagedAppDefinition {
    definition_for_version(
        &controlled_instance_core::package_version::resolve_controlled_instance_package_version(),
    )
}
pub fn definition_for_version(version: &str) -> ManagedAppDefinition {
    let release = serde_json::from_str::<Release>(include_str!(
        "../../../../shared/remote-desktop-packages.json"
    ));
    let mut recipes: Vec<InstallRecipe> = release
        .ok()
        .map(|r| {
            r.packages
                .into_iter()
                .filter(|package| {
                    package.version == version
                        && matches!(
                            package.platform,
                            FinalComputerPlatform::Linux | FinalComputerPlatform::Darwin
                        )
                        && matches!(
                            package.arch,
                            FinalComputerArch::X64 | FinalComputerArch::Arm64
                        )
                        && valid_native_package_name(&package.package)
                        && valid_native_package_version(&package.version)
                        && valid_native_launch_path(EXECUTABLE)
                        && NativePackageIntegrity::parse(&package.integrity).is_some()
                })
                .map(|package| InstallRecipe::NativePackage {
                    platforms: vec![package.platform],
                    arches: Some(vec![package.arch]),
                    privilege: Some(AppInstallPrivilege::User),
                    libc: matches!(package.platform, FinalComputerPlatform::Linux)
                        .then_some(ManagedAppRecipeLibc::Gnu),
                    package: package.package,
                    package_version: package.version.clone(),
                    version: package.version,
                    integrity: package.integrity,
                    launch_path: EXECUTABLE.into(),
                    tarball_url: None,
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

fn executable(binary: &std::path::Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(binary) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn native_installed_package(base: &std::path::Path) -> Option<InstalledPackage> {
    let manifest = read_native_app_manifest(base, APP_ID)?;
    if manifest.app_id != APP_ID
        || manifest.launch_path != EXECUTABLE
        || !manifest.files.iter().any(|file| file == EXECUTABLE)
    {
        return None;
    }
    let root = managed_native_app_root(base, APP_ID);
    let binary = managed_native_app_launcher(base, APP_ID, EXECUTABLE);
    let canonical_root = root.canonicalize().ok()?;
    let canonical_binary = binary.canonicalize().ok()?;
    if !canonical_binary.starts_with(&canonical_root) || !executable(&binary) {
        return None;
    }
    Some(InstalledPackage {
        binary,
        version: manifest.version,
    })
}

fn legacy_installed_package(
    base: &std::path::Path,
    state: &std::path::Path,
) -> Option<InstalledPackage> {
    let root = base.join(APP_ID);
    let manifest = state.join("manifests").join(format!("{APP_ID}.json"));
    if !manifest.exists()
        && !root.join(EXECUTABLE).exists()
        && !root.join("desktop-component.json").exists()
        && !crate::archive_transaction::pending(state, APP_ID)
    {
        return None;
    }
    if crate::archive_transaction::pending(state, APP_ID) {
        return None;
    }
    let record: serde_json::Value = serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
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
        if !files.iter().any(|value| value.as_str() == Some(file)) {
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
        serde_json::from_slice(&std::fs::read(root.join("desktop-component.json")).ok()?).ok()?;
    let version = record.get("version")?.as_str()?.to_string();
    if version.is_empty() {
        return None;
    }
    let binary = root.join(EXECUTABLE);
    executable(&binary).then_some(InstalledPackage { binary, version })
}

pub fn installed_package(
    base: &std::path::Path,
    state: &std::path::Path,
) -> Result<Option<InstalledPackage>, crate::AppRuntimeError> {
    let native_root = managed_native_app_root(base, APP_ID);
    let native_manifest = managed_native_app_manifest_path(base, APP_ID);
    if native_manifest.exists() || native_root.exists() {
        return native_installed_package(base).map(Some).ok_or_else(|| {
            crate::AppRuntimeError::catalog_invalid("REMOTE_DESKTOP_PACKAGE_INVALID")
        });
    }
    let legacy_root = base.join(APP_ID);
    let legacy_manifest = state.join("manifests").join(format!("{APP_ID}.json"));
    if !legacy_manifest.exists()
        && !legacy_root.join(EXECUTABLE).exists()
        && !legacy_root.join("desktop-component.json").exists()
        && !crate::archive_transaction::pending(state, APP_ID)
    {
        return Ok(None);
    }
    legacy_installed_package(base, state)
        .map(Some)
        .ok_or_else(|| crate::AppRuntimeError::catalog_invalid("REMOTE_DESKTOP_PACKAGE_INVALID"))
}

/// Remove only the files owned by the previous archive layout after a complete
/// native package has landed. Unknown files under the legacy root are preserved.
pub fn remove_legacy_managed_package(base: &std::path::Path, state: &std::path::Path) -> bool {
    if native_installed_package(base).is_none() {
        return false;
    }
    let root = base.join(APP_ID);
    let manifest = state.join("manifests").join(format!("{APP_ID}.json"));
    let transaction = state
        .join("manifests")
        .join(format!("{APP_ID}.json.transaction"));
    if !manifest.exists() || transaction.exists() {
        return false;
    }
    let Ok(raw) = std::fs::read(&manifest) else {
        return false;
    };
    let Ok(record) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return false;
    };
    if record.get("appId").and_then(serde_json::Value::as_str) != Some(APP_ID)
        || record
            .get("installRoot")
            .and_then(serde_json::Value::as_str)
            != root.to_str()
    {
        return false;
    }
    let Some(files) = record
        .get("files")
        .and_then(serde_json::Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
    else {
        return false;
    };
    if files.is_empty() || files.iter().any(|file| !valid_native_launch_path(file)) {
        return false;
    }
    let targets = files
        .iter()
        .map(|file| {
            let target = root.join(file);
            (file, target)
        })
        .collect::<Vec<_>>();
    if targets.iter().any(|(_, target)| !target.starts_with(&root)) {
        return false;
    }
    for (_, target) in &targets {
        match std::fs::remove_file(target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
    }
    let mut directories = targets
        .iter()
        .filter_map(|(_, target)| target.parent().map(ToOwned::to_owned))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        let _ = std::fs::remove_dir(directory);
    }
    std::fs::remove_file(manifest).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::json;
    use std::fs;

    fn executable(path: &std::path::Path) {
        fs::write(path, "test-only").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

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
        executable(&root.join(EXECUTABLE));
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

    #[test]
    fn native_package_manifest_wins_over_legacy_archive() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("apps");
        let state = dir.path().join("state");
        let legacy_root = base.join(APP_ID);
        fs::create_dir_all(legacy_root.join("bin")).unwrap();
        fs::create_dir_all(state.join("manifests")).unwrap();
        executable(&legacy_root.join(EXECUTABLE));
        fs::write(
            legacy_root.join("desktop-component.json"),
            r#"{"version":"old"}"#,
        )
        .unwrap();
        fs::write(state.join("manifests/remote-desktop.json"),serde_json::to_vec(&json!({"appId":APP_ID,"installRoot":legacy_root,"files":[EXECUTABLE,"desktop-component.json"]})).unwrap()).unwrap();

        let native_root = managed_native_app_root(&base, APP_ID);
        fs::create_dir_all(native_root.join("bin")).unwrap();
        executable(&native_root.join(EXECUTABLE));
        fs::write(native_root.join("managed-app.json"),serde_json::to_vec(&json!({"schemaVersion":1,"appId":APP_ID,"version":"new","package":"@task-handoff/remote-desktop-test","packageVersion":"new","integrity":format!("sha512-{}",base64::engine::general_purpose::STANDARD.encode([1u8;64])),"installRoot":native_root,"launchPath":EXECUTABLE,"files":["bin/task-handoff-desktop-streaming","managed-app.json"]})).unwrap()).unwrap();
        let package = installed_package(&base, &state).unwrap().unwrap();
        assert_eq!(package.version, "new");
        assert_eq!(package.binary, native_root.join(EXECUTABLE));
    }

    #[test]
    fn legacy_cleanup_removes_owned_files_and_preserves_unknown_files() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("apps");
        let state = dir.path().join("state");
        let legacy_root = base.join(APP_ID);
        let legacy_manifest = state.join("manifests").join(format!("{APP_ID}.json"));
        fs::create_dir_all(legacy_root.join("bin")).unwrap();
        fs::create_dir_all(legacy_manifest.parent().unwrap()).unwrap();
        executable(&legacy_root.join(EXECUTABLE));
        fs::write(
            legacy_root.join("desktop-component.json"),
            r#"{"version":"old"}"#,
        )
        .unwrap();
        fs::write(legacy_root.join("user.txt"), "preserved").unwrap();
        fs::write(
            &legacy_manifest,
            serde_json::to_vec(&json!({
                "appId": APP_ID,
                "installRoot": legacy_root,
                "files": [EXECUTABLE, "desktop-component.json"],
            }))
            .unwrap(),
        )
        .unwrap();

        let native_root = managed_native_app_root(&base, APP_ID);
        fs::create_dir_all(native_root.join("bin")).unwrap();
        executable(&native_root.join(EXECUTABLE));
        fs::write(
            native_root.join("managed-app.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "appId": APP_ID,
                "version": "new",
                "package": "@task-handoff/remote-desktop-test",
                "packageVersion": "new",
                "integrity": format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode([1u8; 64])),
                "installRoot": native_root,
                "launchPath": EXECUTABLE,
                "files": [EXECUTABLE, "managed-app.json"],
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(remove_legacy_managed_package(&base, &state));
        assert!(!legacy_root.join(EXECUTABLE).exists());
        assert!(!legacy_root.join("desktop-component.json").exists());
        assert!(!legacy_manifest.exists());
        assert_eq!(
            fs::read_to_string(legacy_root.join("user.txt")).unwrap(),
            "preserved"
        );
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
