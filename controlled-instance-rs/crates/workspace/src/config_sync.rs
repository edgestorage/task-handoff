use controlled_instance_core::paths::StoragePaths;
use controlled_instance_protocol::{
    ConfigSyncBatchResult, ConfigSyncDirection, ConfigSyncItemResult, ConfigSyncItemStatus,
    ConfigSyncItemType, ConfigSyncPreset, ConfigSyncPresetItem, ConfigSyncPresetSummary,
    ConfigSyncProgram, ConfigSyncProgramResult, ConfigSyncRequest, FolderTreeEntry,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

const BROWSER_PROFILE_SKIPPED_ENTRIES: [&str; 9] = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "ShaderCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "DawnCache",
    "Crashpad",
    "BrowserMetrics",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSyncError {
    pub code: String,
    pub message: String,
    pub status_code: u16,
}

impl ConfigSyncError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, status_code: u16) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status_code,
        }
    }

    fn failed(error: impl std::fmt::Display) -> Self {
        Self::new("CONFIG_SYNC_FAILED", error.to_string(), 500)
    }
}

impl std::fmt::Display for ConfigSyncError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConfigSyncError {}

impl From<io::Error> for ConfigSyncError {
    fn from(error: io::Error) -> Self {
        Self::failed(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSyncBrowserProfile {
    pub id: String,
    pub name: String,
    pub directory: PathBuf,
    pub is_default: bool,
}

#[derive(Debug, Clone)]
pub struct ConfigSyncEnvironment {
    pub home: PathBuf,
    pub workspace: PathBuf,
    pub codex_home: PathBuf,
    pub claude_home: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub artifact_dir: PathBuf,
}

impl ConfigSyncEnvironment {
    pub fn from_storage_paths(paths: &StoragePaths) -> Self {
        let home = home_dir();
        Self {
            workspace: env_path(["TASK_HANDOFF_WORKSPACE", "WORKSPACE"])
                .unwrap_or_else(|| PathBuf::from("/workspace")),
            codex_home: env_path(["CODEX_HOME"]).unwrap_or_else(|| home.join(".codex")),
            claude_home: env_path(["CLAUDE_HOME"]).unwrap_or_else(|| home.join(".claude")),
            data_dir: paths.data_dir.clone(),
            log_dir: paths.log_dir.clone(),
            artifact_dir: paths.artifact_dir.clone(),
            home,
        }
    }
}

type ProfileGuard = Arc<dyn Fn(&str) -> Result<(), ConfigSyncError> + Send + Sync>;

#[derive(Clone)]
pub struct ConfigSyncService {
    environment: ConfigSyncEnvironment,
    browser_profiles: Vec<ConfigSyncBrowserProfile>,
    assert_profile_idle: Option<ProfileGuard>,
}

impl std::fmt::Debug for ConfigSyncService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConfigSyncService")
            .field("environment", &self.environment)
            .field("browser_profiles", &self.browser_profiles)
            .finish_non_exhaustive()
    }
}

impl ConfigSyncService {
    pub fn new(
        environment: ConfigSyncEnvironment,
        browser_profiles: Vec<ConfigSyncBrowserProfile>,
        assert_profile_idle: Option<ProfileGuard>,
    ) -> Self {
        Self {
            environment,
            browser_profiles,
            assert_profile_idle,
        }
    }

    pub fn presets(&self) -> Vec<ConfigSyncPreset> {
        presets(&self.environment, &self.browser_profiles)
    }

    pub fn programs() -> Vec<ConfigSyncProgram> {
        ["codex", "claude", "browser"]
            .into_iter()
            .map(|id| ConfigSyncProgram {
                id: id.to_string(),
                label: match id {
                    "codex" => "Codex",
                    "claude" => "Claude",
                    _ => "Browser",
                }
                .to_string(),
                directory_name: id.to_string(),
            })
            .collect()
    }

    pub fn list_folders(
        &self,
        relative_path: Option<&str>,
        depth: u32,
    ) -> Result<Vec<FolderTreeEntry>, ConfigSyncError> {
        list_folders(&self.environment, relative_path.unwrap_or("."), depth)
    }

    pub fn run(
        &self,
        direction: ConfigSyncDirection,
        preset_id: &str,
        preset_override: Option<&ConfigSyncPreset>,
    ) -> Result<ConfigSyncProgramResult, ConfigSyncError> {
        run(
            &self.environment,
            &self.browser_profiles,
            self.assert_profile_idle.as_deref(),
            direction,
            preset_id,
            preset_override,
        )
    }

    pub fn run_batch(
        &self,
        request: ConfigSyncRequest,
    ) -> Result<ConfigSyncBatchResult, ConfigSyncError> {
        let request = request
            .normalize()
            .map_err(|message| ConfigSyncError::new("CONFIG_SYNC_FAILED", message, 500))?;
        let selected = resolve_workspace_folder(&self.environment, &request.workspace_folder)?;
        let workspace_folder = relative_workspace_path(&selected.workspace, &selected.resolved);
        let available = self.presets();
        let mut programs = Vec::with_capacity(request.program_ids.len());
        for program_id in &request.program_ids {
            let preset = available
                .iter()
                .find(|preset| preset.id == *program_id)
                .ok_or_else(|| {
                    ConfigSyncError::new(
                        "CONFIG_SYNC_PROGRAM_NOT_FOUND",
                        format!("Config sync program {program_id} was not found."),
                        404,
                    )
                })?;
            let mut preset = preset.clone();
            preset.project_root = if workspace_folder == "." {
                preset.id.clone()
            } else {
                format!("{workspace_folder}/{}", preset.id)
            };
            programs.push(self.run(request.direction, program_id, Some(&preset))?);
        }
        Ok(ConfigSyncBatchResult {
            direction: request.direction,
            workspace_folder,
            programs,
        })
    }
}

pub fn config_sync_programs() -> Vec<ConfigSyncProgram> {
    ConfigSyncService::programs()
}

fn presets(
    environment: &ConfigSyncEnvironment,
    browser_profiles: &[ConfigSyncBrowserProfile],
) -> Vec<ConfigSyncPreset> {
    vec![
        ConfigSyncPreset {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            project_root: ".task-handoff/configs/codex".to_string(),
            items: vec![
                file_item(
                    "config",
                    "config.toml",
                    environment.home.join(".codex").join("config.toml"),
                ),
                file_item(
                    "auth",
                    "auth.json",
                    environment.home.join(".codex").join("auth.json"),
                ),
                file_item(
                    "agents",
                    "AGENTS.md",
                    environment.home.join(".codex").join("AGENTS.md"),
                ),
                directory_item(
                    "skills",
                    "skills",
                    environment.home.join(".codex").join("skills"),
                ),
            ],
        },
        ConfigSyncPreset {
            id: "claude".to_string(),
            label: "Claude".to_string(),
            project_root: ".task-handoff/configs/claude".to_string(),
            items: vec![
                file_item(
                    "claude-json",
                    ".claude.json",
                    environment.home.join(".claude.json"),
                ),
                file_item(
                    "settings",
                    "settings.json",
                    environment.home.join(".claude").join("settings.json"),
                ),
                file_item(
                    "claude-md",
                    "CLAUDE.md",
                    environment.home.join(".claude").join("CLAUDE.md"),
                ),
                directory_item(
                    "commands",
                    "commands",
                    environment.home.join(".claude").join("commands"),
                ),
                directory_item(
                    "agents",
                    "agents",
                    environment.home.join(".claude").join("agents"),
                ),
                directory_item(
                    "skills",
                    "skills",
                    environment.home.join(".claude").join("skills"),
                ),
            ],
        },
        browser_preset(environment, browser_profiles),
    ]
}

fn browser_preset(
    environment: &ConfigSyncEnvironment,
    profiles: &[ConfigSyncBrowserProfile],
) -> ConfigSyncPreset {
    let mut items = vec![directory_item(
        "chromium-profile",
        "chromium",
        environment.home.join(".config").join("chromium"),
    )];
    let mut used_paths = BTreeSet::from(["chromium".to_string()]);
    for profile in profiles {
        let base = if profile.is_default {
            "chromium-default".to_string()
        } else {
            format!("chromium-{}", browser_profile_slug(profile))
        };
        let mut project_path = base.clone();
        let mut suffix = 2;
        while used_paths.contains(&project_path) {
            project_path = format!("{base}-{suffix}");
            suffix += 1;
        }
        used_paths.insert(project_path.clone());
        items.push(ConfigSyncPresetItem {
            id: format!("chromium-profile-{}", profile.id),
            item_type: ConfigSyncItemType::Dir,
            project_path,
            container_path: profile.directory.display().to_string(),
            profile_id: Some(profile.id.clone()),
        });
    }
    ConfigSyncPreset {
        id: "browser".to_string(),
        label: "Browser".to_string(),
        project_root: ".task-handoff/configs/browser".to_string(),
        items,
    }
}

fn file_item(id: &str, project_path: &str, container_path: PathBuf) -> ConfigSyncPresetItem {
    ConfigSyncPresetItem {
        id: id.to_string(),
        item_type: ConfigSyncItemType::File,
        project_path: project_path.to_string(),
        container_path: container_path.display().to_string(),
        profile_id: None,
    }
}

fn directory_item(id: &str, project_path: &str, container_path: PathBuf) -> ConfigSyncPresetItem {
    ConfigSyncPresetItem {
        id: id.to_string(),
        item_type: ConfigSyncItemType::Dir,
        project_path: project_path.to_string(),
        container_path: container_path.display().to_string(),
        profile_id: None,
    }
}

fn browser_profile_slug(profile: &ConfigSyncBrowserProfile) -> String {
    let mut slug = String::new();
    for character in profile.name.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').chars().take(40).collect::<String>();
    if slug.is_empty() {
        "profile".to_string()
    } else {
        slug
    }
}

type ProfileIdleAssertion<'a> =
    Option<&'a (dyn Fn(&str) -> Result<(), ConfigSyncError> + Send + Sync)>;

fn run(
    environment: &ConfigSyncEnvironment,
    browser_profiles: &[ConfigSyncBrowserProfile],
    assert_profile_idle: ProfileIdleAssertion<'_>,
    direction: ConfigSyncDirection,
    preset_id: &str,
    preset_override: Option<&ConfigSyncPreset>,
) -> Result<ConfigSyncProgramResult, ConfigSyncError> {
    let owned_presets = presets(environment, browser_profiles);
    let preset = preset_override
        .or_else(|| owned_presets.iter().find(|preset| preset.id == preset_id))
        .ok_or_else(|| {
            ConfigSyncError::new(
                "CONFIG_SYNC_PRESET_NOT_FOUND",
                format!("Config sync preset {preset_id} was not found."),
                404,
            )
        })?;
    let preset_root = resolve_workspace_folder(environment, &preset.project_root)?;
    assert_no_symlink_segments(
        &preset_root.workspace,
        &preset_root.resolved,
        "CONFIG_SYNC_FOLDER_INVALID",
    )?;
    let profiles_by_directory = browser_profiles
        .iter()
        .map(|profile| (absolute_path(&profile.directory), profile))
        .collect::<BTreeMap<_, _>>();
    let item_profiles = preset
        .items
        .iter()
        .map(|item| {
            item.profile_id
                .as_ref()
                .and_then(|id| browser_profiles.iter().find(|profile| profile.id == *id))
                .or_else(|| {
                    profiles_by_directory
                        .get(&absolute_path(Path::new(&item.container_path)))
                        .copied()
                })
        })
        .collect::<Vec<_>>();
    for profile in item_profiles.iter().flatten() {
        if let Some(assert_profile_idle) = assert_profile_idle {
            assert_profile_idle(&profile.id)?;
        }
    }

    let mut results = Vec::with_capacity(preset.items.len());
    for (item, profile) in preset.items.iter().zip(item_profiles) {
        let project_path =
            resolve_project_path(environment, &preset.project_root, &item.project_path)?;
        let container_path = resolve_container_path(environment, &item.container_path)?;
        let (source, target) = match direction {
            ConfigSyncDirection::Import => (&project_path, &container_path),
            ConfigSyncDirection::Export => (&container_path, &project_path),
        };
        let status = copy_item(item.item_type, source, target, profile.is_some());
        let (status, error) = match status {
            Ok(status) => (status, None),
            Err(error) => (ConfigSyncItemStatus::Failed, Some(error.message)),
        };
        results.push(ConfigSyncItemResult {
            id: item.id.clone(),
            item_type: item.item_type,
            project_path: item.project_path.clone(),
            container_path: item.container_path.clone(),
            source: source.display().to_string(),
            target: target.display().to_string(),
            status,
            error,
        });
    }
    Ok(ConfigSyncProgramResult {
        preset: ConfigSyncPresetSummary {
            id: preset.id.clone(),
            label: preset.label.clone(),
            project_root: preset.project_root.clone(),
        },
        direction,
        items: results,
    })
}

fn list_folders(
    environment: &ConfigSyncEnvironment,
    relative_path: &str,
    depth: u32,
) -> Result<Vec<FolderTreeEntry>, ConfigSyncError> {
    let selected = resolve_workspace_folder(environment, relative_path)?;
    if !selected.resolved.exists() || !selected.resolved.is_dir() {
        return Err(ConfigSyncError::new(
            "CONFIG_SYNC_FOLDER_NOT_FOUND",
            format!("Config sync folder was not found: {relative_path}"),
            404,
        ));
    }
    let real_workspace = fs::canonicalize(&selected.workspace)?;
    let real_resolved = fs::canonicalize(&selected.resolved)?;
    if !path_inside(&real_resolved, &real_workspace) {
        return Err(ConfigSyncError::new(
            "CONFIG_SYNC_FOLDER_INVALID",
            "Config sync folder must stay inside the instance workspace.",
            400,
        ));
    }
    Ok(vec![folder_tree_entry(
        &real_workspace,
        &real_resolved,
        depth.min(2),
    )?])
}

fn folder_tree_entry(
    workspace: &Path,
    directory: &Path,
    depth: u32,
) -> Result<FolderTreeEntry, ConfigSyncError> {
    let mut children = Vec::new();
    if depth > 0 {
        let mut entries = fs::read_dir(directory)?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            let left = left.file_name().to_string_lossy().to_lowercase();
            let right = right.file_name().to_string_lossy().to_lowercase();
            left.cmp(&right)
        });
        for entry in entries {
            children.push(folder_tree_entry(workspace, &entry.path(), depth - 1)?);
        }
    }
    let name = if directory == workspace {
        workspace
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| workspace.display().to_string())
    } else {
        directory
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| directory.display().to_string())
    };
    Ok(FolderTreeEntry {
        name,
        path: relative_workspace_path(workspace, directory),
        children,
    })
}

#[derive(Debug, Clone)]
struct ResolvedWorkspaceFolder {
    workspace: PathBuf,
    resolved: PathBuf,
}

fn resolve_project_path(
    environment: &ConfigSyncEnvironment,
    project_root: &str,
    relative_path: &str,
) -> Result<PathBuf, ConfigSyncError> {
    let workspace = absolute_path(&environment.workspace);
    let root = absolute_path(&workspace.join(project_root));
    if !path_inside(&root, &workspace) {
        return Err(ConfigSyncError::new(
            "CONFIG_SYNC_FOLDER_INVALID",
            format!("Config sync folder escapes the workspace: {project_root}"),
            400,
        ));
    }
    assert_no_symlink_segments(&workspace, &root, "CONFIG_SYNC_FOLDER_INVALID")?;
    let resolved = absolute_path(&root.join(relative_path));
    if !path_inside(&resolved, &root) {
        return Err(ConfigSyncError::new(
            "CONFIG_SYNC_PATH_INVALID",
            format!("Config sync path escapes project root: {relative_path}"),
            400,
        ));
    }
    assert_no_symlink_segments(&workspace, &resolved, "CONFIG_SYNC_PATH_INVALID")?;
    Ok(resolved)
}

fn resolve_workspace_folder(
    environment: &ConfigSyncEnvironment,
    relative_path: &str,
) -> Result<ResolvedWorkspaceFolder, ConfigSyncError> {
    let workspace = absolute_path(&environment.workspace);
    if Path::new(relative_path).is_absolute() {
        return Err(ConfigSyncError::new(
            "CONFIG_SYNC_FOLDER_INVALID",
            "Config sync folder must be relative to the instance workspace.",
            400,
        ));
    }
    let resolved = absolute_path(&workspace.join(relative_path));
    if !path_inside(&resolved, &workspace) {
        return Err(ConfigSyncError::new(
            "CONFIG_SYNC_FOLDER_INVALID",
            "Config sync folder must stay inside the instance workspace.",
            400,
        ));
    }
    assert_no_symlink_segments(&workspace, &resolved, "CONFIG_SYNC_FOLDER_INVALID")?;
    Ok(ResolvedWorkspaceFolder {
        workspace,
        resolved,
    })
}

fn resolve_container_path(
    environment: &ConfigSyncEnvironment,
    container_path: &str,
) -> Result<PathBuf, ConfigSyncError> {
    let resolved = absolute_path(&PathBuf::from(expand_container_path(
        environment,
        container_path,
    )));
    let allowed_roots = [
        absolute_path(&environment.home),
        absolute_path(&environment.workspace),
        absolute_path(&environment.data_dir),
        absolute_path(&environment.log_dir),
        absolute_path(&environment.artifact_dir),
    ];
    let Some(allowed_root) = allowed_roots
        .iter()
        .find(|root| path_inside(&resolved, root))
    else {
        return Err(ConfigSyncError::new(
            "CONFIG_SYNC_CONTAINER_PATH_INVALID",
            format!("Config sync target path is not allowed: {container_path}"),
            400,
        ));
    };
    assert_no_symlink_segments(
        allowed_root,
        &resolved,
        "CONFIG_SYNC_CONTAINER_PATH_INVALID",
    )?;
    Ok(resolved)
}

fn expand_container_path(environment: &ConfigSyncEnvironment, value: &str) -> String {
    [
        ("${HOME}", &environment.home),
        ("${WORKSPACE}", &environment.workspace),
        ("${CODEX_HOME}", &environment.codex_home),
        ("${CLAUDE_HOME}", &environment.claude_home),
    ]
    .into_iter()
    .fold(value.to_string(), |value, (token, replacement)| {
        value.replace(token, &replacement.display().to_string())
    })
}

fn assert_no_symlink_segments(
    root: &Path,
    candidate: &Path,
    code: &str,
) -> Result<(), ConfigSyncError> {
    let relative = candidate.strip_prefix(root).map_err(|_| {
        ConfigSyncError::new(code, "Config sync path escapes its allowed root.", 400)
    })?;
    let mut current = root.to_path_buf();
    for segment in relative.components() {
        match segment {
            Component::Normal(value) => current.push(value),
            Component::CurDir => continue,
            _ => {
                return Err(ConfigSyncError::new(
                    code,
                    "Config sync path escapes its allowed root.",
                    400,
                ));
            }
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ConfigSyncError::new(
                    code,
                    format!(
                        "Config sync path contains a symbolic link: {}",
                        current.display()
                    ),
                    400,
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(ConfigSyncError::failed(error)),
        }
    }
    Ok(())
}

fn copy_item(
    item_type: ConfigSyncItemType,
    source: &Path,
    target: &Path,
    browser_profile: bool,
) -> Result<ConfigSyncItemStatus, ConfigSyncError> {
    if !source.exists() {
        return Ok(ConfigSyncItemStatus::SkippedMissingSource);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    match item_type {
        ConfigSyncItemType::Dir => copy_directory(source, target, browser_profile)?,
        ConfigSyncItemType::File => {
            let metadata = fs::symlink_metadata(source)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(ConfigSyncError::new(
                    "CONFIG_SYNC_SYMLINK_NOT_ALLOWED",
                    format!(
                        "Config sync file source is not a regular file: {}",
                        source.display()
                    ),
                    400,
                ));
            }
            copy_file(source, target)?;
        }
    }
    Ok(ConfigSyncItemStatus::Copied)
}

fn copy_file(source: &Path, target: &Path) -> Result<(), ConfigSyncError> {
    let mut source_file = open_no_follow(source)?;
    let metadata = source_file.metadata()?;
    if !metadata.is_file() {
        return Err(ConfigSyncError::new(
            "CONFIG_SYNC_SYMLINK_NOT_ALLOWED",
            format!(
                "Config sync file source is not a regular file: {}",
                source.display()
            ),
            400,
        ));
    }
    let temporary = target
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(
            ".task-handoff-config-sync-{}.tmp",
            uuid::Uuid::new_v4()
        ));
    let result = (|| -> Result<(), ConfigSyncError> {
        let mut target_file = open_no_follow_new(&temporary)?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = source_file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            target_file.write_all(&buffer[..read])?;
        }
        target_file.set_permissions(metadata.permissions())?;
        target_file.sync_all()?;
        drop(target_file);
        fs::rename(&temporary, target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn open_no_follow(path: &Path) -> Result<fs::File, ConfigSyncError> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(ConfigSyncError::failed)
}

fn open_no_follow_new(path: &Path) -> Result<fs::File, ConfigSyncError> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CREAT | libc::O_EXCL);
    }
    options.open(path).map_err(ConfigSyncError::failed)
}

fn copy_directory(
    source: &Path,
    target: &Path,
    browser_profile: bool,
) -> Result<(), ConfigSyncError> {
    let source_metadata = fs::symlink_metadata(source)?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(ConfigSyncError::new(
            "CONFIG_SYNC_SYMLINK_NOT_ALLOWED",
            format!(
                "Config sync directory source is not a regular directory: {}",
                source.display()
            ),
            400,
        ));
    }
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(ConfigSyncError::new(
                "CONFIG_SYNC_SYMLINK_NOT_ALLOWED",
                format!(
                    "Config sync directory target is not a regular directory: {}",
                    target.display()
                ),
                400,
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create_directory_with_mode(target, &source_metadata)?;
        }
        Err(error) => return Err(ConfigSyncError::failed(error)),
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if browser_profile && is_skipped_browser_profile_entry(&name) {
            continue;
        }
        let source_entry = entry.path();
        let target_entry = target.join(&name);
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(ConfigSyncError::new(
                "CONFIG_SYNC_SYMLINK_NOT_ALLOWED",
                format!(
                    "Config sync directory contains a symbolic link: {}",
                    source_entry.display()
                ),
                400,
            ));
        }
        if file_type.is_dir() {
            copy_directory(&source_entry, &target_entry, browser_profile)?;
        } else if file_type.is_file() {
            copy_file(&source_entry, &target_entry)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_directory_with_mode(target: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let mut builder = fs::DirBuilder::new();
    builder.mode(metadata.permissions().mode() & 0o777);
    builder.create(target)
}

#[cfg(not(unix))]
fn create_directory_with_mode(target: &Path, _metadata: &fs::Metadata) -> io::Result<()> {
    fs::create_dir(target)
}

fn is_skipped_browser_profile_entry(name: &str) -> bool {
    name.starts_with("Singleton")
        || name.ends_with(".lock")
        || BROWSER_PROFILE_SKIPPED_ENTRIES.contains(&name)
}

fn absolute_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            value => normalized.push(value.as_os_str()),
        }
    }
    normalized
}

fn path_inside(candidate: &Path, root: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn relative_workspace_path(workspace: &Path, target: &Path) -> String {
    let path = target.strip_prefix(workspace).unwrap_or(target);
    let path = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if path.is_empty() {
        ".".to_string()
    } else {
        path
    }
}

fn env_path<const N: usize>(names: [&str; N]) -> Option<PathBuf> {
    names.into_iter().find_map(|name| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    })
}

fn home_dir() -> PathBuf {
    env_path(["HOME", "USERPROFILE"])
        .or_else(|| {
            std::env::var_os("HOMEDRIVE")
                .zip(std::env::var_os("HOMEPATH"))
                .map(|(drive, path)| PathBuf::from(drive).join(path))
        })
        .unwrap_or_else(|| PathBuf::from("/home/agent"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(root: &Path) -> ConfigSyncEnvironment {
        ConfigSyncEnvironment {
            home: root.join("home"),
            workspace: root.join("workspace"),
            codex_home: root.join("home/.codex"),
            claude_home: root.join("home/.claude"),
            data_dir: root.join("data"),
            log_dir: root.join("logs"),
            artifact_dir: root.join("artifacts"),
        }
    }

    #[test]
    fn presets_and_browser_profile_slugs_match_the_node_contract() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let service = ConfigSyncService::new(
            environment(temporary.path()),
            vec![ConfigSyncBrowserProfile {
                id: "brp_1".to_string(),
                name: " Work / Primary ".to_string(),
                directory: temporary.path().join("profile"),
                is_default: true,
            }],
            None,
        );
        let browser = service
            .presets()
            .into_iter()
            .find(|preset| preset.id == "browser")
            .expect("browser preset");
        assert_eq!(browser.items[1].project_path, "chromium-default");
        assert_eq!(browser.items[1].profile_id.as_deref(), Some("brp_1"));
    }

    #[test]
    fn folder_listing_rejects_absolute_and_symlink_escapes() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let environment = environment(temporary.path());
        fs::create_dir_all(environment.workspace.join("one/two")).expect("workspace");
        let tree = list_folders(&environment, ".", 2).expect("tree");
        assert_eq!(tree[0].children[0].name, "one");
        assert!(list_folders(&environment, "/tmp", 0).is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                temporary.path().join("outside"),
                environment.workspace.join("link"),
            )
            .expect("symlink");
            let error = list_folders(&environment, "link", 0).expect_err("symlink rejection");
            assert_eq!(error.code, "CONFIG_SYNC_FOLDER_INVALID");
        }
    }

    #[test]
    fn import_copies_files_atomically_and_skips_browser_runtime_entries() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let environment = environment(temporary.path());
        let project_root = environment
            .workspace
            .join(".task-handoff/configs/browser/chromium-default");
        fs::create_dir_all(project_root.join("Nested")).expect("project profile");
        fs::write(project_root.join("Preferences"), "fresh").expect("preferences");
        fs::write(project_root.join("SingletonLock"), "ignored").expect("singleton");
        fs::create_dir_all(project_root.join("Cache")).expect("cache");
        fs::write(project_root.join("Cache/data"), "ignored").expect("cache data");
        let profile_dir = environment.home.join(".config/chromium-profile");
        fs::create_dir_all(&profile_dir).expect("profile");
        fs::write(profile_dir.join("Preferences"), "old").expect("old preferences");
        let profile = ConfigSyncBrowserProfile {
            id: "brp_1".to_string(),
            name: "Default".to_string(),
            directory: profile_dir.clone(),
            is_default: true,
        };
        let service = ConfigSyncService::new(environment, vec![profile], None);
        let preset = service
            .presets()
            .into_iter()
            .find(|preset| preset.id == "browser")
            .expect("browser preset");
        let result = service
            .run(ConfigSyncDirection::Import, "browser", Some(&preset))
            .expect("import");
        assert_eq!(result.items[1].status, ConfigSyncItemStatus::Copied);
        assert_eq!(
            fs::read_to_string(profile_dir.join("Preferences")).expect("preferences"),
            "fresh"
        );
        assert!(!profile_dir.join("SingletonLock").exists());
        assert!(!profile_dir.join("Cache").exists());
    }

    #[test]
    fn batch_workspace_folders_are_relative_and_normalized() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let environment = environment(temporary.path());
        fs::create_dir_all(environment.workspace.join("project")).expect("workspace");
        let service = ConfigSyncService::new(environment, Vec::new(), None);
        let result = service
            .run_batch(ConfigSyncRequest {
                direction: ConfigSyncDirection::Export,
                program_ids: vec!["codex".to_string()],
                workspace_folder: "./project".to_string(),
            })
            .expect("batch");
        assert_eq!(result.workspace_folder, "project");
        assert_eq!(result.programs[0].preset.project_root, "project/codex");
    }
}
