use std::{
    path::{Component, Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use controlled_instance_protocol::FinalComputerPlatform;
use serde::{Deserialize, Serialize};
use url::Url;

const MAX_NATIVE_MANIFEST_FILES: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedAppRecipeLibc {
    Gnu,
    Musl,
}

impl ManagedAppRecipeLibc {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gnu => "gnu",
            Self::Musl => "musl",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ManagedAppRecipeTarget {
    pub libc: Option<ManagedAppRecipeLibc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppManifest {
    pub schema_version: u32,
    pub app_id: String,
    pub version: String,
    pub package: String,
    pub package_version: String,
    pub integrity: String,
    pub install_root: PathBuf,
    pub launch_path: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativePackageIntegrity {
    Sha256(Vec<u8>),
    Sha512(Vec<u8>),
}

impl NativePackageIntegrity {
    pub fn parse(value: &str) -> Option<Self> {
        let (algorithm, encoded) = value.split_once('-')?;
        if encoded.is_empty()
            || encoded
                .bytes()
                .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'+' | b'/' | b'='))
        {
            return None;
        }
        let digest = BASE64.decode(encoded).ok()?;
        match algorithm {
            "sha256" if digest.len() == 32 => Some(Self::Sha256(digest)),
            "sha512" if digest.len() == 64 => Some(Self::Sha512(digest)),
            _ => None,
        }
    }

    pub fn matches(&self, sha256: &[u8], sha512: &[u8]) -> bool {
        match self {
            Self::Sha256(expected) => expected.as_slice() == sha256,
            Self::Sha512(expected) => expected.as_slice() == sha512,
        }
    }
}

pub fn valid_native_package_name(value: &str) -> bool {
    fn segment(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 100
            && value
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    }

    if let Some(scoped) = value.strip_prefix('@') {
        let Some((scope, name)) = scoped.split_once('/') else {
            return false;
        };
        !name.contains('/') && segment(scope) && segment(name)
    } else {
        !value.contains('/') && segment(value)
    }
}

pub fn valid_native_package_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 121
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'_' | b'-'))
}

pub fn valid_native_launch_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 1_024
        || value.contains('\\')
        || value.contains('\0')
        || Path::new(value).is_absolute()
    {
        return false;
    }
    let mut segments = 0;
    for component in Path::new(value).components() {
        if !matches!(component, Component::Normal(_)) {
            return false;
        }
        segments += 1;
    }
    segments > 0 && segments <= 100
}

pub fn managed_native_app_root(root: &Path, app_id: &str) -> PathBuf {
    root.join("native").join(app_id)
}

pub fn managed_native_app_launcher(root: &Path, app_id: &str, launch_path: &str) -> PathBuf {
    managed_native_app_root(root, app_id).join(launch_path)
}

pub fn managed_native_app_manifest_path(root: &Path, app_id: &str) -> PathBuf {
    managed_native_app_root(root, app_id).join("managed-app.json")
}

pub fn managed_native_app_staging(root: &Path, app_id: &str) -> PathBuf {
    root.join("native")
        .join(".staging")
        .join(format!("{app_id}-{}", uuid::Uuid::new_v4()))
}

pub fn read_native_app_manifest(root: &Path, app_id: &str) -> Option<NativeAppManifest> {
    let raw = std::fs::read_to_string(managed_native_app_manifest_path(root, app_id)).ok()?;
    let manifest = serde_json::from_str::<NativeAppManifest>(&raw).ok()?;
    let expected_install_root = managed_native_app_root(root, app_id);
    (manifest.schema_version == 1
        && manifest.app_id == app_id
        && !manifest.version.trim().is_empty()
        && valid_native_package_name(&manifest.package)
        && valid_native_package_version(&manifest.package_version)
        && NativePackageIntegrity::parse(&manifest.integrity).is_some()
        && valid_native_launch_path(&manifest.launch_path)
        && manifest.install_root.is_absolute()
        && manifest.install_root == expected_install_root
        && manifest.files.len() <= MAX_NATIVE_MANIFEST_FILES
        && manifest
            .files
            .iter()
            .all(|file| valid_native_launch_path(file)))
    .then_some(manifest)
}

pub fn npm_tarball_url(
    registry: Option<&str>,
    package: &str,
    package_version: &str,
) -> Option<String> {
    if !valid_native_package_name(package) || !valid_native_package_version(package_version) {
        return None;
    }
    let registry = registry
        .unwrap_or("https://registry.npmjs.org")
        .trim_end_matches('/');
    let leaf = package.rsplit('/').next()?;
    let candidate = format!("{registry}/{package}/-/{leaf}-{package_version}.tgz");
    normalized_https_url(&candidate)
}

pub fn normalized_https_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    valid_https_url(&url).then(|| url.to_string())
}

pub fn valid_https_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

pub fn detect_managed_app_recipe_target(platform: FinalComputerPlatform) -> ManagedAppRecipeTarget {
    if platform != FinalComputerPlatform::Linux {
        return ManagedAppRecipeTarget::default();
    }
    static LINUX_LIBC: OnceLock<ManagedAppRecipeLibc> = OnceLock::new();
    ManagedAppRecipeTarget {
        libc: Some(*LINUX_LIBC.get_or_init(|| {
            let musl = cfg!(target_env = "musl")
                || Path::new("/etc/alpine-release").exists()
                || Command::new("ldd")
                    .arg("--version")
                    .output()
                    .ok()
                    .is_some_and(|output| {
                        format!(
                            "{}{}",
                            String::from_utf8_lossy(&output.stdout),
                            String::from_utf8_lossy(&output.stderr)
                        )
                        .to_ascii_lowercase()
                        .contains("musl")
                    });
            if musl {
                ManagedAppRecipeLibc::Musl
            } else {
                ManagedAppRecipeLibc::Gnu
            }
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_manifest(root: &Path, app_id: &str, install_root: &Path, files: Vec<String>) {
        let manifest = NativeAppManifest {
            schema_version: 1,
            app_id: app_id.to_string(),
            version: "1.2.3".to_string(),
            package: "native-tool".to_string(),
            package_version: "1.2.3-linux-x64".to_string(),
            integrity: "sha512-FotDc7bVHwaommtsdDP8PPrH0a5IwC/t8H/LhdEcH4EBqgeYFRCtptiHcuwgvNRCLbTbOyFE/Ur6GzYCljgaSQ==".to_string(),
            install_root: install_root.to_path_buf(),
            launch_path: "vendor/bin/tool".to_string(),
            files,
        };
        let path = managed_native_app_manifest_path(root, app_id);
        std::fs::create_dir_all(path.parent().expect("manifest parent"))
            .expect("manifest directory");
        std::fs::write(path, serde_json::to_vec(&manifest).expect("manifest json"))
            .expect("manifest");
    }

    #[test]
    fn native_manifest_requires_the_managed_root_and_safe_owned_files() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let expected_root = managed_native_app_root(temporary.path(), "tool");
        write_manifest(
            temporary.path(),
            "tool",
            &expected_root,
            vec![
                "vendor/bin/tool".to_string(),
                "managed-app.json".to_string(),
            ],
        );
        assert!(read_native_app_manifest(temporary.path(), "tool").is_some());

        write_manifest(
            temporary.path(),
            "tool",
            Path::new("native/tool"),
            vec!["vendor/bin/tool".to_string()],
        );
        assert!(read_native_app_manifest(temporary.path(), "tool").is_none());

        write_manifest(
            temporary.path(),
            "tool",
            &expected_root,
            vec!["vendor/bin/tool".to_string(), "../escape".to_string()],
        );
        assert!(read_native_app_manifest(temporary.path(), "tool").is_none());
    }

    #[test]
    fn artifact_urls_reject_credentials_queries_and_fragments() {
        assert_eq!(
            normalized_https_url("https://registry.example.test/native-tool.tgz").as_deref(),
            Some("https://registry.example.test/native-tool.tgz")
        );
        assert!(normalized_https_url("http://registry.example.test/native-tool.tgz").is_none());
        assert!(
            normalized_https_url("https://user:pass@registry.example.test/native-tool.tgz")
                .is_none()
        );
        assert!(
            normalized_https_url("https://registry.example.test/native-tool.tgz?token=secret")
                .is_none()
        );
        assert!(
            normalized_https_url("https://registry.example.test/native-tool.tgz#fragment")
                .is_none()
        );
    }
}
