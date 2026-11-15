use std::{fmt, time::Duration};

use controlled_instance_protocol::{
    FinalComputerArch, FinalComputerCapabilities, FinalComputerPlatform,
};
use serde_json::Value;

use crate::{
    native_package::{valid_native_package_name, NativePackageIntegrity},
    InstallRecipe,
};

const DEFAULT_REGISTRIES: [&str; 2] = [
    "https://registry.npmjs.org",
    "https://registry.npmmirror.com",
];
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_REGISTRY_REDIRECTS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryNativePackageError {
    message: String,
}

impl RegistryNativePackageError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for RegistryNativePackageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RegistryNativePackageError {}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedPackage {
    version: String,
    integrity: String,
    tarball_url: String,
}

fn platform_name(platform: FinalComputerPlatform) -> Option<&'static str> {
    match platform {
        FinalComputerPlatform::Linux => Some("linux"),
        FinalComputerPlatform::Darwin => Some("darwin"),
        _ => None,
    }
}

fn arch_name(arch: FinalComputerArch) -> Option<&'static str> {
    match arch {
        FinalComputerArch::X64 => Some("x64"),
        FinalComputerArch::Arm64 => Some("arm64"),
        _ => None,
    }
}

fn normalized_registry(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(value.to_string())
}

fn registry_candidates(primary: Option<&str>) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(value) = primary.and_then(normalized_registry) {
        values.push(value);
    }
    for name in ["npm_config_registry", "NPM_CONFIG_REGISTRY"] {
        if let Ok(value) = std::env::var(name) {
            if let Some(value) = normalized_registry(&value) {
                if !values.contains(&value) {
                    values.push(value);
                }
            }
        }
    }
    for value in DEFAULT_REGISTRIES {
        let value = value.to_string();
        if !values.contains(&value) {
            values.push(value);
        }
    }
    values
}

fn package_name(
    prefix: &str,
    platform: FinalComputerPlatform,
    arch: FinalComputerArch,
) -> Result<String, RegistryNativePackageError> {
    let platform = platform_name(platform).ok_or_else(|| {
        RegistryNativePackageError::new("Remote desktop package platform is unsupported.")
    })?;
    let arch = arch_name(arch).ok_or_else(|| {
        RegistryNativePackageError::new("Remote desktop package architecture is unsupported.")
    })?;
    let package = format!("{prefix}-{platform}-{arch}");
    if !valid_native_package_name(prefix) || !valid_native_package_name(&package) {
        return Err(RegistryNativePackageError::new(
            "The registry native package prefix is invalid.",
        ));
    }
    Ok(package)
}

fn encoded_package_name(package_name: &str) -> String {
    package_name.replace('@', "%40").replace('/', "%2F")
}

fn valid_exact_registry_version(value: &str) -> bool {
    let (without_build, build) = value
        .split_once('+')
        .map_or((value, None), |(version, build)| (version, Some(build)));
    let (core, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, None), |(core, prerelease)| {
            (core, Some(prerelease))
        });
    let parts = core.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return false;
    }
    let valid_identifier = |identifier: &str| {
        !identifier.is_empty()
            && identifier
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    };
    prerelease.is_none_or(|value| value.split('.').all(valid_identifier))
        && build.is_none_or(|value| value.split('.').all(valid_identifier))
}

fn canonical_https_url(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 2_048 {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.to_string())
}

fn registry_redirect_allowed(url: &reqwest::Url, previous: usize) -> bool {
    previous < MAX_REGISTRY_REDIRECTS && canonical_https_url(url.as_str()).is_some()
}

fn exact_version(value: &Value, package_name: &str) -> Result<String, RegistryNativePackageError> {
    let manifest = value
        .as_object()
        .ok_or_else(|| RegistryNativePackageError::new("npm returned invalid package metadata."))?;
    if manifest.get("name").and_then(Value::as_str) != Some(package_name) {
        return Err(RegistryNativePackageError::new(format!(
            "npm metadata identity does not match {package_name}."
        )));
    }
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RegistryNativePackageError::new(format!(
                "npm did not provide a version for {package_name}."
            ))
        })?;
    if !valid_exact_registry_version(version) {
        return Err(RegistryNativePackageError::new(format!(
            "npm did not provide an exact version for {package_name}."
        )));
    }
    Ok(version.to_string())
}

fn latest_version(
    value: &Value,
    package_name: &str,
    dist_tag: &str,
) -> Result<String, RegistryNativePackageError> {
    let metadata = value
        .as_object()
        .ok_or_else(|| RegistryNativePackageError::new("npm returned invalid package metadata."))?;
    if metadata.get("name").and_then(Value::as_str) != Some(package_name) {
        return Err(RegistryNativePackageError::new(format!(
            "npm metadata identity does not match {package_name}."
        )));
    }
    let latest = metadata
        .get("dist-tags")
        .and_then(Value::as_object)
        .and_then(|tags| tags.get(dist_tag))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RegistryNativePackageError::new(format!(
                "npm did not provide the {dist_tag} version for {package_name}."
            ))
        })?;
    if !valid_exact_registry_version(latest) {
        return Err(RegistryNativePackageError::new(format!(
            "npm did not provide an exact {dist_tag} version for {package_name}."
        )));
    }
    if metadata
        .get("versions")
        .and_then(Value::as_object)
        .and_then(|versions| versions.get(latest))
        .is_none()
    {
        return Err(RegistryNativePackageError::new(format!(
            "npm metadata has no manifest for {package_name}@{latest}."
        )));
    }
    Ok(latest.to_string())
}

fn parse_resolved_manifest(
    value: &Value,
    package_name: &str,
    expected_version: &str,
) -> Result<ResolvedPackage, RegistryNativePackageError> {
    if exact_version(value, package_name)? != expected_version {
        return Err(RegistryNativePackageError::new(format!(
            "npm manifest identity does not match {package_name}@{expected_version}."
        )));
    }
    let dist = value
        .get("dist")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            RegistryNativePackageError::new(format!(
                "npm manifest for {package_name}@{expected_version} has no distribution metadata."
            ))
        })?;
    let integrity = dist
        .get("integrity")
        .and_then(Value::as_str)
        .filter(|value| NativePackageIntegrity::parse(value).is_some())
        .ok_or_else(|| {
            RegistryNativePackageError::new(format!(
                "npm manifest for {package_name}@{expected_version} has no valid integrity."
            ))
        })?;
    let tarball_url = dist
        .get("tarball")
        .and_then(Value::as_str)
        .and_then(canonical_https_url)
        .ok_or_else(|| {
            RegistryNativePackageError::new(format!(
                "npm manifest for {package_name}@{expected_version} has no canonical HTTPS tarball."
            ))
        })?;
    Ok(ResolvedPackage {
        version: expected_version.to_string(),
        integrity: integrity.to_string(),
        tarball_url,
    })
}

async fn registry_package(
    client: &reqwest::Client,
    registry: &str,
    package_name: &str,
    dist_tag: &str,
) -> Result<ResolvedPackage, RegistryNativePackageError> {
    let encoded = encoded_package_name(package_name);
    let package_url = format!("{registry}/{encoded}");
    let response = client
        .get(&package_url)
        .header(
            reqwest::header::ACCEPT,
            "application/vnd.npm.install-v1+json",
        )
        .header(
            reqwest::header::USER_AGENT,
            "task-handoff-controlled-instance",
        )
        .send()
        .await
        .map_err(|error| RegistryNativePackageError::new(format!("{package_url}: {error}")))?;
    if !response.status().is_success() {
        return Err(RegistryNativePackageError::new(format!(
            "{package_url}: HTTP {}",
            response.status()
        )));
    }
    let metadata = response
        .json::<Value>()
        .await
        .map_err(|error| RegistryNativePackageError::new(format!("{package_url}: {error}")))?;
    let version = latest_version(&metadata, package_name, dist_tag)?;
    let exact_url = format!("{registry}/{encoded}/{version}");
    let exact_response = client
        .get(&exact_url)
        .header(
            reqwest::header::ACCEPT,
            "application/vnd.npm.install-v1+json",
        )
        .header(
            reqwest::header::USER_AGENT,
            "task-handoff-controlled-instance",
        )
        .send()
        .await
        .map_err(|error| RegistryNativePackageError::new(format!("{exact_url}: {error}")))?;
    if !exact_response.status().is_success() {
        return Err(RegistryNativePackageError::new(format!(
            "{exact_url}: HTTP {}",
            exact_response.status()
        )));
    }
    let exact = exact_response
        .json::<Value>()
        .await
        .map_err(|error| RegistryNativePackageError::new(format!("{exact_url}: {error}")))?;
    let resolved = parse_resolved_manifest(&exact, package_name, &version)?;
    if let Some(listed) = metadata
        .get("versions")
        .and_then(Value::as_object)
        .and_then(|versions| versions.get(&version))
        .and_then(Value::as_object)
        .and_then(|manifest| manifest.get("dist"))
        .and_then(Value::as_object)
    {
        if let Some(listed_integrity) = listed.get("integrity").and_then(Value::as_str) {
            if listed_integrity != resolved.integrity {
                return Err(RegistryNativePackageError::new(format!(
                    "npm changed {package_name}@{version} while resolving it."
                )));
            }
        }
        if let Some(listed_tarball) = listed
            .get("tarball")
            .and_then(Value::as_str)
            .and_then(canonical_https_url)
        {
            if listed_tarball != resolved.tarball_url {
                return Err(RegistryNativePackageError::new(format!(
                    "npm changed the {package_name}@{version} tarball while resolving it."
                )));
            }
        }
    }
    Ok(resolved)
}

pub async fn resolve_registry_native_package(
    recipe: &InstallRecipe,
    capabilities: &FinalComputerCapabilities,
    primary_registry: Option<&str>,
) -> Result<InstallRecipe, RegistryNativePackageError> {
    let InstallRecipe::RegistryNativePackage {
        platforms,
        arches,
        privilege,
        libc,
        package_prefix,
        dist_tag,
        launch_path,
    } = recipe
    else {
        return Err(RegistryNativePackageError::new(
            "The selected recipe is not a registry native package.",
        ));
    };
    if !platforms.contains(&capabilities.platform)
        || arches
            .as_ref()
            .is_some_and(|arches| !arches.contains(&capabilities.arch))
    {
        return Err(RegistryNativePackageError::new(format!(
            "Registry native package does not support {}/{}.",
            platform_name(capabilities.platform).unwrap_or("unknown"),
            arch_name(capabilities.arch).unwrap_or("unknown")
        )));
    }
    let package = package_name(package_prefix, capabilities.platform, capabilities.arch)?;
    let client = reqwest::Client::builder()
        .timeout(DEFAULT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if registry_redirect_allowed(attempt.url(), attempt.previous().len()) {
                attempt.follow()
            } else {
                attempt.error(std::io::Error::other(
                    "npm registry redirects must use HTTPS without credentials, query strings, or fragments and stay within the limit",
                ))
            }
        }))
        .build()
        .map_err(|error| {
            RegistryNativePackageError::new(format!(
                "Registry client initialization failed: {error}"
            ))
        })?;
    let mut failures = Vec::new();
    for registry in registry_candidates(primary_registry) {
        match registry_package(&client, &registry, &package, dist_tag).await {
            Ok(resolved) => {
                return Ok(InstallRecipe::NativePackage {
                    platforms: vec![capabilities.platform],
                    arches: Some(vec![capabilities.arch]),
                    privilege: *privilege,
                    libc: *libc,
                    package,
                    package_version: resolved.version.clone(),
                    version: resolved.version,
                    integrity: resolved.integrity,
                    launch_path: launch_path.clone(),
                    tarball_url: Some(resolved.tarball_url),
                });
            }
            Err(error) => failures.push(format!("{registry}: {error}")),
        }
    }
    Err(RegistryNativePackageError::new(format!(
        "Remote desktop package source is unavailable: {}",
        failures.join("; ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn registry_versions_must_be_exact_semver() {
        for value in ["1.2.3", "1.2.3-beta.1", "1.2.3+sha.abcdef"] {
            assert!(valid_exact_registry_version(value));
        }
        for value in ["latest", "1.2", "01.2.3", "1.2.3-"] {
            assert!(!valid_exact_registry_version(value));
        }
    }

    fn package_manifest(package: &str) -> Value {
        let integrity = format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode([8_u8; 64])
        );
        serde_json::json!({
            "name": package,
            "version": "1.2.3",
            "dist": {
                "integrity": integrity,
                "tarball": format!("https://registry.npmjs.org/{package}/-/package-1.2.3.tgz")
            }
        })
    }

    #[test]
    fn validates_exact_registry_metadata_integrity_and_tarball() {
        let package = "task-handoff-remote-desktop-linux-arm64";
        let resolved =
            parse_resolved_manifest(&package_manifest(package), package, "1.2.3").unwrap();
        assert_eq!(resolved.version, "1.2.3");
        assert!(resolved
            .tarball_url
            .starts_with("https://registry.npmjs.org/"));
        assert!(NativePackageIntegrity::parse(&resolved.integrity).is_some());
    }

    #[test]
    fn rejects_missing_integrity_and_non_https_tarballs() {
        let package = "task-handoff-remote-desktop-linux-arm64";
        let mut value = package_manifest(package);
        value["dist"]["integrity"] = Value::Null;
        assert!(parse_resolved_manifest(&value, package, "1.2.3").is_err());

        let mut value = package_manifest(package);
        value["dist"]["tarball"] = Value::String("http://registry.example/package.tgz".into());
        assert!(parse_resolved_manifest(&value, package, "1.2.3").is_err());
    }

    #[test]
    fn registry_redirects_must_remain_https_and_bounded() {
        assert!(registry_redirect_allowed(
            &reqwest::Url::parse("https://registry.example/package").unwrap(),
            0
        ));
        assert!(!registry_redirect_allowed(
            &reqwest::Url::parse("http://registry.example/package").unwrap(),
            0
        ));
        assert!(!registry_redirect_allowed(
            &reqwest::Url::parse("https://registry.example/package?token=secret").unwrap(),
            0
        ));
        assert!(!registry_redirect_allowed(
            &reqwest::Url::parse("https://registry.example/package").unwrap(),
            MAX_REGISTRY_REDIRECTS
        ));
    }
}
