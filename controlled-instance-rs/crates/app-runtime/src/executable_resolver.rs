use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    env, fs,
    path::{Component, Path, PathBuf},
};

const WINDOWS_COMMAND_INTERPRETER_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
    OtherUnix,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::OtherUnix
        }
    }

    pub const fn is_windows(self) -> bool {
        matches!(self, Self::Windows)
    }

    fn path_delimiter(self) -> char {
        if self.is_windows() {
            ';'
        } else {
            ':'
        }
    }
}

impl Default for Platform {
    fn default() -> Self {
        Self::current()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutableResolverId {
    Path,
    Nvm,
    Homebrew,
    NpmGlobal,
}

impl ExecutableResolverId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Path => "path",
            Self::Nvm => "nvm",
            Self::Homebrew => "homebrew",
            Self::NpmGlobal => "npm-global",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutableResolution {
    pub executable: PathBuf,
    pub resolver: ExecutableResolverId,
    /// Environment additions that must be applied when launching this command.
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct ExecutableResolverOptions {
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    pub platform: Platform,
    pub home_dir: PathBuf,
    pub nvm_dir: Option<PathBuf>,
    pub homebrew_bin_directories: Option<Vec<PathBuf>>,
    pub npm_global_bin_directories: Option<Vec<PathBuf>>,
    pub node_runtime_directories: Option<Vec<PathBuf>>,
    /// The executable running this process when it is `node.exe` on Windows.
    pub running_node_executable: Option<PathBuf>,
}

impl Default for ExecutableResolverOptions {
    fn default() -> Self {
        let env = env::vars().collect::<BTreeMap<_, _>>();
        let platform = Platform::current();
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let home_dir = default_home_dir(&env, platform, &cwd);
        Self {
            env,
            cwd,
            platform,
            home_dir,
            nvm_dir: None,
            homebrew_bin_directories: None,
            npm_global_bin_directories: None,
            node_runtime_directories: None,
            running_node_executable: None,
        }
    }
}

/// Resolves a command the same way the Node controlled instance does.
///
/// Resolution order is PATH, NVM, Homebrew, then the npm global directory. A
/// command containing a path separator is resolved relative to `options.cwd`
/// and never falls through to the installation-directory resolvers.
pub fn resolve_executable(
    command: &str,
    options: &ExecutableResolverOptions,
) -> Option<ExecutableResolution> {
    resolve_path_executable(command, options)
        .or_else(|| resolve_nvm_executable(command, options))
        .or_else(|| resolve_homebrew_executable(command, options))
        .or_else(|| resolve_npm_global_executable(command, options))
}

fn resolve_path_executable(
    command: &str,
    options: &ExecutableResolverOptions,
) -> Option<ExecutableResolution> {
    let explicit_path = is_explicit_path(command, options.platform);
    if is_absolute_path(command, options.platform) {
        return executable_candidate(Path::new(command), options.platform, &options.env).map(
            |executable| ExecutableResolution {
                executable,
                resolver: ExecutableResolverId::Path,
                env: BTreeMap::new(),
            },
        );
    }
    if explicit_path {
        let cwd = absolute_cwd(&options.cwd);
        let candidate = normalize_lexically(&cwd.join(command));
        return executable_candidate(&candidate, options.platform, &options.env).map(
            |executable| ExecutableResolution {
                executable,
                resolver: ExecutableResolverId::Path,
                env: BTreeMap::new(),
            },
        );
    }
    for directory in path_entries(&options.env, options.platform) {
        let candidate = directory.join(command);
        if let Some(executable) = executable_candidate(&candidate, options.platform, &options.env) {
            return Some(ExecutableResolution {
                executable,
                resolver: ExecutableResolverId::Path,
                env: BTreeMap::new(),
            });
        }
    }
    None
}

fn resolve_nvm_executable(
    command: &str,
    options: &ExecutableResolverOptions,
) -> Option<ExecutableResolution> {
    if options.platform.is_windows() || is_explicit_path(command, options.platform) {
        return None;
    }
    let nvm_dir = options
        .nvm_dir
        .clone()
        .or_else(|| env_value(&options.env, options.platform, "NVM_DIR").map(PathBuf::from))
        .unwrap_or_else(|| options.home_dir.join(".nvm"));
    let installed = installed_nvm_versions(&nvm_dir);
    let preferred = preferred_nvm_version(&nvm_dir, &installed);
    let mut directories = Vec::new();
    if let Some(directory) = env_value(&options.env, options.platform, "NVM_BIN") {
        if !directory.is_empty() {
            directories.push(PathBuf::from(directory));
        }
    }
    if let Some(preferred) = preferred {
        directories.push(nvm_version_bin(&nvm_dir, &preferred));
    }
    for version in installed {
        directories.push(nvm_version_bin(&nvm_dir, &version));
    }
    for directory in unique_paths(directories) {
        let mut extra_env = BTreeMap::from([
            ("NVM_BIN".to_string(), path_text(&directory)),
            ("NVM_DIR".to_string(), path_text(&nvm_dir)),
        ]);
        if let Some(resolution) = resolution_from_bin(
            ExecutableResolverId::Nvm,
            &directory,
            command,
            options,
            &mut extra_env,
        ) {
            return Some(resolution);
        }
    }
    None
}

fn resolve_homebrew_executable(
    command: &str,
    options: &ExecutableResolverOptions,
) -> Option<ExecutableResolution> {
    if options.platform.is_windows() || is_explicit_path(command, options.platform) {
        return None;
    }
    let directories = options
        .homebrew_bin_directories
        .clone()
        .unwrap_or_else(|| default_homebrew_bin_directories(options.platform, &options.env));
    for directory in unique_paths(directories) {
        if let Some(resolution) = resolution_from_bin(
            ExecutableResolverId::Homebrew,
            &directory,
            command,
            options,
            &mut BTreeMap::new(),
        ) {
            return Some(resolution);
        }
    }
    None
}

fn resolve_npm_global_executable(
    command: &str,
    options: &ExecutableResolverOptions,
) -> Option<ExecutableResolution> {
    if is_explicit_path(command, options.platform) {
        return None;
    }
    let directories = options
        .npm_global_bin_directories
        .clone()
        .unwrap_or_else(|| {
            default_npm_global_bin_directories(options.platform, &options.env, &options.home_dir)
        });
    for directory in unique_paths(directories) {
        if let Some(resolution) = resolution_from_bin(
            ExecutableResolverId::NpmGlobal,
            &directory,
            command,
            options,
            &mut BTreeMap::new(),
        ) {
            return Some(resolution);
        }
    }
    None
}

fn resolution_from_bin(
    resolver: ExecutableResolverId,
    bin_directory: &Path,
    command: &str,
    options: &ExecutableResolverOptions,
    extra_env: &mut BTreeMap<String, String>,
) -> Option<ExecutableResolution> {
    let executable =
        executable_candidate(&bin_directory.join(command), options.platform, &options.env)?;
    let mut resolution_env = BTreeMap::from([(
        "PATH".to_string(),
        prepend_path(bin_directory, &options.env, options.platform),
    )]);
    resolution_env.append(extra_env);
    Some(ExecutableResolution {
        executable,
        resolver,
        env: resolution_env,
    })
}

/// Supplies the environment additions a Windows `.cmd`/`.bat` shim needs.
///
/// npm shims invoke bare `node`, so a stale environment that can see the shim
/// but not the Node runtime is repaired here. Non-Windows environments are
/// returned unchanged.
pub fn command_interpreter_shim_environment(
    env: &BTreeMap<String, String>,
    options: &ExecutableResolverOptions,
) -> BTreeMap<String, String> {
    if !options.platform.is_windows() {
        return env.clone();
    }
    let mut prepared = env.clone();
    if env_value(env, options.platform, "PATHEXT").is_none_or(str::is_empty) {
        env_set(
            &mut prepared,
            options.platform,
            "PATHEXT",
            WINDOWS_COMMAND_INTERPRETER_PATHEXT,
        );
    }
    if node_runtime_on_path(&prepared, options.platform) {
        return prepared;
    }
    let directories = options.node_runtime_directories.clone().unwrap_or_else(|| {
        default_node_runtime_directories(options.platform, &prepared, &options.home_dir, options)
    });
    let Some(directory) = directories.into_iter().find(|directory| {
        executable_candidate(&directory.join("node"), options.platform, &prepared).is_some()
    }) else {
        return prepared;
    };
    let path = prepend_path(&directory, &prepared, options.platform);
    env_set(&mut prepared, options.platform, "PATH", path);
    prepared
}

fn default_homebrew_bin_directories(
    platform: Platform,
    env: &BTreeMap<String, String>,
) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(prefix) = nonempty_env_value(env, platform, "HOMEBREW_PREFIX") {
        directories.push(PathBuf::from(prefix).join("bin"));
    }
    match platform {
        Platform::MacOs => {
            directories.push(PathBuf::from("/opt/homebrew/bin"));
            directories.push(PathBuf::from("/usr/local/bin"));
        }
        Platform::Linux => directories.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin")),
        Platform::Windows | Platform::OtherUnix => {}
    }
    unique_paths(directories)
}

fn default_npm_global_bin_directories(
    platform: Platform,
    env: &BTreeMap<String, String>,
    home_dir: &Path,
) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(prefix) = nonempty_env_value(env, platform, "NPM_CONFIG_PREFIX")
        .or_else(|| nonempty_env_value(env, platform, "npm_config_prefix"))
    {
        let prefix = PathBuf::from(prefix);
        directories.push(if platform.is_windows() {
            prefix
        } else {
            prefix.join("bin")
        });
    }
    if platform.is_windows() {
        let roaming = nonempty_env_value(env, platform, "APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join("AppData").join("Roaming"));
        directories.push(roaming.join("npm"));
    }
    unique_paths(directories)
}

fn default_node_runtime_directories(
    platform: Platform,
    env: &BTreeMap<String, String>,
    home_dir: &Path,
    options: &ExecutableResolverOptions,
) -> Vec<PathBuf> {
    if !platform.is_windows() {
        return Vec::new();
    }
    let local_app_data = nonempty_env_value(env, platform, "LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join("AppData").join("Local"));
    let roaming = nonempty_env_value(env, platform, "APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join("AppData").join("Roaming"));
    let running_node = options
        .running_node_executable
        .as_ref()
        .and_then(|executable| {
            executable
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| name.eq_ignore_ascii_case("node.exe"))
                .and_then(|_| executable.parent().map(Path::to_path_buf))
        });
    let mut directories = Vec::new();
    for directory in [
        nonempty_env_value(env, platform, "NVM_SYMLINK").map(PathBuf::from),
        nonempty_env_value(env, platform, "NVM_HOME").map(PathBuf::from),
        nonempty_env_value(env, platform, "TASK_HANDOFF_NODE")
            .and_then(|node| Path::new(node).parent().map(Path::to_path_buf)),
        running_node,
        nonempty_env_value(env, platform, "ProgramFiles")
            .map(|root| PathBuf::from(root).join("nodejs")),
        nonempty_env_value(env, platform, "ProgramFiles(x86)")
            .map(|root| PathBuf::from(root).join("nodejs")),
        Some(local_app_data.join("Programs").join("nodejs")),
        Some(local_app_data.join("Volta").join("bin")),
        Some(
            local_app_data
                .join("Microsoft")
                .join("WinGet")
                .join("Links"),
        ),
        Some(home_dir.join("scoop").join("shims")),
        Some(roaming.join("nvm")),
    ]
    .into_iter()
    .flatten()
    {
        directories.push(directory);
    }
    unique_paths(directories)
}

fn executable_candidate(
    candidate: &Path,
    platform: Platform,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let extensions = executable_extensions(platform, env);
    for extension in extensions {
        let resolved =
            if platform.is_windows() && !path_has_extension(&path_text(candidate), platform) {
                let mut value = candidate.as_os_str().to_os_string();
                value.push(extension);
                PathBuf::from(value)
            } else {
                candidate.to_path_buf()
            };
        if executable_file(&resolved, platform) {
            return Some(resolved);
        }
    }
    None
}

fn executable_extensions(platform: Platform, env: &BTreeMap<String, String>) -> Vec<String> {
    if !platform.is_windows() {
        return vec![String::new()];
    }
    let path_ext =
        nonempty_env_value(env, platform, "PATHEXT").unwrap_or(WINDOWS_COMMAND_INTERPRETER_PATHEXT);
    let mut seen = BTreeSet::new();
    let mut extensions = Vec::new();
    for extension in path_ext
        .split(';')
        .filter(|extension| !extension.is_empty())
    {
        for candidate in [extension.to_string(), extension.to_lowercase()] {
            if seen.insert(candidate.clone()) {
                extensions.push(candidate);
            }
        }
    }
    extensions
}

fn executable_file(path: &Path, platform: Platform) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    if platform.is_windows() {
        return true;
    }
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn installed_nvm_versions(nvm_dir: &Path) -> Vec<String> {
    let versions_dir = nvm_dir.join("versions").join("node");
    let Ok(entries) = fs::read_dir(versions_dir) else {
        return Vec::new();
    };
    let mut versions = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_dir())
                .map(|_| entry.file_name().to_string_lossy().into_owned())
        })
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| compare_node_versions_descending(left, right));
    versions
}

fn compare_node_versions_descending(left: &str, right: &str) -> std::cmp::Ordering {
    #[derive(Clone)]
    enum Part {
        Number(u128),
        Text(String),
    }

    impl Part {
        fn as_text(&self) -> String {
            match self {
                Self::Number(number) => number.to_string(),
                Self::Text(text) => text.clone(),
            }
        }
    }

    fn parse(value: &str) -> Vec<Part> {
        value
            .strip_prefix('v')
            .unwrap_or(value)
            .split(['.', '-'])
            .map(|part| {
                if !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()) {
                    Part::Number(part.parse().unwrap_or(u128::MAX))
                } else {
                    Part::Text(part.to_string())
                }
            })
            .collect()
    }

    let left = parse(left);
    let right = parse(right);
    for index in 0..left.len().max(right.len()) {
        let left_part = left.get(index).unwrap_or(&Part::Number(0));
        let right_part = right.get(index).unwrap_or(&Part::Number(0));
        match (left_part, right_part) {
            (Part::Number(left), Part::Number(right)) if left == right => {}
            (Part::Number(left), Part::Number(right)) => return right.cmp(left),
            (left, right) => {
                let ordering = right.as_text().cmp(&left.as_text());
                if ordering != std::cmp::Ordering::Equal {
                    return ordering;
                }
            }
        }
    }
    std::cmp::Ordering::Equal
}

fn preferred_nvm_version(nvm_dir: &Path, installed: &[String]) -> Option<String> {
    let mut alias = Some("default".to_string());
    let mut visited = HashSet::new();
    for _ in 0..8 {
        let current = alias.take()?;
        if current.is_empty() || !visited.insert(current.clone()) {
            break;
        }
        let Some(target) = read_nvm_alias(nvm_dir, &current) else {
            break;
        };
        if let Some(version) = installed
            .iter()
            .find(|version| **version == target || **version == format!("v{target}"))
        {
            return Some(version.clone());
        }
        if target == "node" || target == "stable" {
            return installed.first().cloned();
        }
        if is_partial_node_version(&target) {
            let prefix = if target.starts_with('v') {
                target.clone()
            } else {
                format!("v{target}")
            };
            if let Some(version) = installed
                .iter()
                .find(|version| **version == prefix || version.starts_with(&format!("{prefix}.")))
            {
                return Some(version.clone());
            }
        }
        alias = Some(target);
    }
    None
}

fn read_nvm_alias(nvm_dir: &Path, alias: &str) -> Option<String> {
    if is_absolute_path(alias, Platform::OtherUnix)
        || alias
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    let mut alias_path = nvm_dir.join("alias");
    for segment in alias.split('/') {
        alias_path.push(segment);
    }
    let content = fs::read_to_string(alias_path).ok()?;
    content
        .split_whitespace()
        .next()
        .filter(|target| !target.is_empty())
        .map(ToString::to_string)
}

fn is_partial_node_version(value: &str) -> bool {
    let value = value.strip_prefix('v').unwrap_or(value);
    let parts = value.split('.').collect::<Vec<_>>();
    (1..=3).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn nvm_version_bin(nvm_dir: &Path, version: &str) -> PathBuf {
    nvm_dir
        .join("versions")
        .join("node")
        .join(version)
        .join("bin")
}

fn node_runtime_on_path(env: &BTreeMap<String, String>, platform: Platform) -> bool {
    path_entries(env, platform)
        .into_iter()
        .any(|directory| executable_candidate(&directory.join("node"), platform, env).is_some())
}

fn path_entries(env: &BTreeMap<String, String>, platform: Platform) -> Vec<PathBuf> {
    env_value(env, platform, "PATH")
        .unwrap_or_default()
        .split(platform.path_delimiter())
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn prepend_path(directory: &Path, env: &BTreeMap<String, String>, platform: Platform) -> String {
    let directory = path_text(directory);
    let current = env_value(env, platform, "PATH").unwrap_or_default();
    if current.is_empty() {
        directory
    } else {
        format!("{directory}{}{current}", platform.path_delimiter())
    }
}

fn unique_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path_text(path)))
        .collect()
}

fn env_value<'a>(
    env: &'a BTreeMap<String, String>,
    platform: Platform,
    key: &str,
) -> Option<&'a str> {
    env.get(key).map(String::as_str).or_else(|| {
        if platform.is_windows() {
            env.iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
                .map(|(_, value)| value.as_str())
        } else {
            None
        }
    })
}

fn nonempty_env_value<'a>(
    env: &'a BTreeMap<String, String>,
    platform: Platform,
    key: &str,
) -> Option<&'a str> {
    env_value(env, platform, key).filter(|value| !value.is_empty())
}

fn env_set(
    env: &mut BTreeMap<String, String>,
    platform: Platform,
    key: &str,
    value: impl Into<String>,
) {
    let existing = if platform.is_windows() {
        env.keys()
            .find(|candidate| candidate.eq_ignore_ascii_case(key))
            .cloned()
    } else {
        env.contains_key(key).then(|| key.to_string())
    };
    env.insert(existing.unwrap_or_else(|| key.to_string()), value.into());
}

fn default_home_dir(
    env: &BTreeMap<String, String>,
    platform: Platform,
    fallback: &Path,
) -> PathBuf {
    let key = if platform.is_windows() {
        "USERPROFILE"
    } else {
        "HOME"
    };
    nonempty_env_value(env, platform, key)
        .or_else(|| nonempty_env_value(env, Platform::Windows, "USERPROFILE"))
        .or_else(|| nonempty_env_value(env, Platform::OtherUnix, "HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.to_path_buf())
}

pub(crate) fn path_has_extension(path: &str, platform: Platform) -> bool {
    let name = if platform.is_windows() {
        path.rsplit(['/', '\\']).next().unwrap_or(path)
    } else {
        path.rsplit('/').next().unwrap_or(path)
    };
    if name.is_empty() {
        return false;
    }
    let Some(index) = name.rfind('.') else {
        return false;
    };
    index > 0 && name != ".."
}

fn is_absolute_path(path: &str, platform: Platform) -> bool {
    if platform.is_windows() {
        let bytes = path.as_bytes();
        if path.starts_with('/') || path.starts_with('\\') {
            return true;
        }
        bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\')
    } else {
        path.starts_with('/')
    }
}

fn is_explicit_path(command: &str, platform: Platform) -> bool {
    is_absolute_path(command, platform) || command.contains('/') || command.contains('\\')
}

fn absolute_cwd(cwd: &Path) -> PathBuf {
    if cwd.is_absolute() {
        normalize_lexically(cwd)
    } else {
        env::current_dir()
            .map(|current| normalize_lexically(&current.join(cwd)))
            .unwrap_or_else(|_| cwd.to_path_buf())
    }
}

fn normalize_lexically(path: &Path) -> PathBuf {
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

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn options(platform: Platform) -> ExecutableResolverOptions {
        ExecutableResolverOptions {
            env: BTreeMap::new(),
            cwd: PathBuf::from("/workspace"),
            platform,
            home_dir: PathBuf::from("/home/tester"),
            nvm_dir: None,
            homebrew_bin_directories: None,
            npm_global_bin_directories: None,
            node_runtime_directories: None,
            running_node_executable: None,
        }
    }

    fn write_executable(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = fs::File::create(path).unwrap();
        writeln!(file, "#!/bin/sh").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn resolves_path_commands_in_path_order() {
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        write_executable(&first.path().join("fixture-tool"));
        write_executable(&second.path().join("fixture-tool"));
        let mut options = options(Platform::Linux);
        options.env.insert(
            "PATH".to_string(),
            format!("{}:{}", first.path().display(), second.path().display()),
        );

        let resolution = resolve_executable("fixture-tool", &options).unwrap();

        assert_eq!(resolution.executable, first.path().join("fixture-tool"));
        assert_eq!(resolution.resolver, ExecutableResolverId::Path);
        assert!(resolution.env.is_empty());
    }

    #[test]
    fn resolves_explicit_relative_paths_against_launch_cwd() {
        let root = TempDir::new().unwrap();
        let cwd = root.path().join("app");
        let command = cwd.join("tools").join("fixture-tool");
        write_executable(&command);
        let mut options = options(Platform::Linux);
        options.cwd = cwd.clone();

        let resolution = resolve_executable("tools/../tools/fixture-tool", &options).unwrap();

        assert_eq!(resolution.executable, command);
        assert_eq!(resolution.resolver, ExecutableResolverId::Path);
    }

    #[test]
    fn resolves_absolute_commands_without_searching() {
        let root = TempDir::new().unwrap();
        let command = root.path().join("fixture-tool");
        write_executable(&command);
        let mut options = options(Platform::Linux);
        options.env.insert(
            "PATH".to_string(),
            root.path().join("missing").display().to_string(),
        );

        let resolution = resolve_executable(command.to_str().unwrap(), &options).unwrap();

        assert_eq!(resolution.executable, command);
        assert_eq!(resolution.resolver, ExecutableResolverId::Path);
    }

    #[test]
    fn resolves_nvm_default_alias_and_augments_environment() {
        let root = TempDir::new().unwrap();
        let nvm_dir = root.path().join(".nvm");
        let command = nvm_dir
            .join("versions/node/v20.11.1/bin")
            .join("fixture-tool");
        write_executable(&command);
        fs::create_dir_all(nvm_dir.join("alias")).unwrap();
        fs::write(nvm_dir.join("alias/default"), "v20\n").unwrap();
        let mut options = options(Platform::Linux);
        options.nvm_dir = Some(nvm_dir.clone());
        options
            .env
            .insert("PATH".to_string(), "/usr/bin".to_string());

        let resolution = resolve_executable("fixture-tool", &options).unwrap();

        let bin = nvm_dir.join("versions/node/v20.11.1/bin");
        assert_eq!(resolution.executable, command);
        assert_eq!(resolution.resolver, ExecutableResolverId::Nvm);
        assert_eq!(resolution.env["NVM_BIN"], bin.display().to_string());
        assert_eq!(resolution.env["NVM_DIR"], nvm_dir.display().to_string());
        assert_eq!(
            resolution.env["PATH"],
            format!("{}:/usr/bin", bin.display())
        );
    }

    #[test]
    fn nvm_falls_back_to_highest_installed_version() {
        let root = TempDir::new().unwrap();
        let nvm_dir = root.path().join(".nvm");
        write_executable(
            &nvm_dir
                .join("versions/node/v18.20.0/bin")
                .join("fixture-tool"),
        );
        write_executable(
            &nvm_dir
                .join("versions/node/v22.1.0/bin")
                .join("fixture-tool"),
        );
        let mut options = options(Platform::Linux);
        options.nvm_dir = Some(nvm_dir.clone());

        let resolution = resolve_executable("fixture-tool", &options).unwrap();

        assert_eq!(
            resolution.executable,
            nvm_dir.join("versions/node/v22.1.0/bin/fixture-tool")
        );
    }

    #[test]
    fn resolves_homebrew_bin_directories_and_prepends_path() {
        let root = TempDir::new().unwrap();
        let brew_bin = root.path().join("opt/homebrew/bin");
        write_executable(&brew_bin.join("fixture-tool"));
        let mut options = options(Platform::MacOs);
        options.homebrew_bin_directories = Some(vec![brew_bin.clone()]);
        options
            .env
            .insert("PATH".to_string(), "/usr/bin".to_string());

        let resolution = resolve_executable("fixture-tool", &options).unwrap();

        assert_eq!(resolution.executable, brew_bin.join("fixture-tool"));
        assert_eq!(resolution.resolver, ExecutableResolverId::Homebrew);
        assert_eq!(
            resolution.env["PATH"],
            format!("{}:/usr/bin", brew_bin.display())
        );
    }

    #[test]
    fn resolves_npm_global_prefix_bin_directory() {
        let root = TempDir::new().unwrap();
        let prefix = root.path().join("npm-prefix");
        write_executable(&prefix.join("bin").join("fixture-tool"));
        let mut options = options(Platform::Linux);
        options.env.insert(
            "NPM_CONFIG_PREFIX".to_string(),
            prefix.display().to_string(),
        );

        let resolution = resolve_executable("fixture-tool", &options).unwrap();

        assert_eq!(
            resolution.executable,
            prefix.join("bin").join("fixture-tool")
        );
        assert_eq!(resolution.resolver, ExecutableResolverId::NpmGlobal);
    }

    #[test]
    fn windows_probes_pathext_case_variants() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("fixture-tool.cmd"), "").unwrap();
        let mut options = options(Platform::Windows);
        options
            .env
            .insert("PATH".to_string(), root.path().display().to_string());
        options
            .env
            .insert("PATHEXT".to_string(), ".EXE;.CMD".to_string());

        let resolution = resolve_executable("fixture-tool", &options).unwrap();

        assert!(resolution
            .executable
            .file_name()
            .unwrap()
            .to_string_lossy()
            .eq_ignore_ascii_case("fixture-tool.cmd"));
        assert_eq!(resolution.resolver, ExecutableResolverId::Path);
    }

    #[test]
    fn explicit_paths_do_not_fall_through_to_install_resolvers() {
        let root = TempDir::new().unwrap();
        let npm_bin = root.path().join("npm-bin");
        write_executable(&npm_bin.join("fixture-tool"));
        let mut options = options(Platform::Linux);
        options.cwd = root.path().to_path_buf();
        options.npm_global_bin_directories = Some(vec![npm_bin]);

        assert!(resolve_executable("missing/fixture-tool", &options).is_none());
    }

    #[test]
    fn windows_shim_environment_adds_default_pathext_and_node_runtime() {
        let root = TempDir::new().unwrap();
        let runtime = root.path().join("node-runtime");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(runtime.join("node.EXE"), "").unwrap();
        let mut options = options(Platform::Windows);
        options.node_runtime_directories = Some(vec![runtime.clone()]);
        let mut env = BTreeMap::from([("PATH".to_string(), "/stale/bin".to_string())]);

        let prepared = command_interpreter_shim_environment(&env, &options);

        assert_eq!(prepared["PATHEXT"], WINDOWS_COMMAND_INTERPRETER_PATHEXT);
        assert_eq!(
            prepared["PATH"],
            format!("{};/stale/bin", runtime.display())
        );

        env.insert("PATHEXT".to_string(), ".CMD".to_string());
        assert_eq!(
            command_interpreter_shim_environment(&env, &options)["PATHEXT"],
            ".CMD"
        );
    }

    #[test]
    fn windows_shim_environment_keeps_path_when_node_is_already_resolvable() {
        let root = TempDir::new().unwrap();
        let fallback = root.path().join("fallback");
        fs::create_dir_all(&fallback).unwrap();
        fs::write(fallback.join("node.EXE"), "").unwrap();
        let path_dir = root.path().join("path");
        fs::create_dir_all(&path_dir).unwrap();
        fs::write(path_dir.join("node.exe"), "").unwrap();
        let mut options = options(Platform::Windows);
        options.node_runtime_directories = Some(vec![fallback]);
        let env = BTreeMap::from([("PATH".to_string(), path_dir.display().to_string())]);

        let prepared = command_interpreter_shim_environment(&env, &options);

        assert_eq!(prepared["PATH"], path_dir.display().to_string());
    }

    #[test]
    fn windows_absolute_path_matches_node_semantics() {
        assert!(is_absolute_path("C:\\tools\\fixture", Platform::Windows));
        assert!(is_absolute_path("C:/tools/fixture", Platform::Windows));
        assert!(is_absolute_path("\\\\server\\share", Platform::Windows));
        assert!(is_absolute_path("\\fixture", Platform::Windows));
        assert!(!is_absolute_path("C:fixture", Platform::Windows));
        assert!(is_explicit_path("tools\\fixture", Platform::Windows));
        assert!(!is_absolute_path("C:\\tools\\fixture", Platform::Linux));
    }
}
