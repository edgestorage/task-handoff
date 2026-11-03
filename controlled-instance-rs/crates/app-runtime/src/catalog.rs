use controlled_instance_core::atomic::{read_json, write_json_atomic};
use controlled_instance_protocol::{AppCatalogItem, AppKind, CustomAppCatalog};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::managed_app_providers::{managed_app_provider, managed_app_runtime_provider};
use crate::AppRuntimeError;
use crate::InstallRecipe;
use crate::{
    command_invocation::{resolve_command_executable, CommandInvocationOptions},
    executable_resolver::{
        resolve_executable as resolve_executable_resolution, ExecutableResolverOptions,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppSource {
    Builtin,
    Custom,
}

impl AppSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CatalogEntry {
    pub app: AppCatalogItem,
    pub source: AppSource,
    pub executable: Option<PathBuf>,
}

#[derive(Clone)]
pub struct AppCatalogRepository {
    custom_path: Arc<PathBuf>,
    managed_app_root: Option<Arc<PathBuf>>,
    managed_app_ids: Arc<BTreeSet<String>>,
    mutation: Arc<Mutex<()>>,
}

impl std::fmt::Debug for AppCatalogRepository {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppCatalogRepository")
            .field("custom_path", &self.custom_path)
            .finish()
    }
}

impl AppCatalogRepository {
    pub fn new(app_catalog_dir: impl AsRef<Path>) -> Self {
        Self::new_with_managed_root(app_catalog_dir, None)
    }

    pub fn new_with_managed_root(
        app_catalog_dir: impl AsRef<Path>,
        managed_app_root: Option<PathBuf>,
    ) -> Self {
        let managed_app_ids = crate::builtin_managed_app_definitions()
            .into_iter()
            .filter(|definition| {
                definition
                    .recipes
                    .iter()
                    .any(InstallRecipe::is_managed_node_package)
            })
            .map(|definition| definition.launcher.id)
            .collect();
        Self {
            custom_path: Arc::new(app_catalog_dir.as_ref().join("custom.json")),
            managed_app_root: managed_app_root.map(Arc::new),
            managed_app_ids: Arc::new(managed_app_ids),
            mutation: Arc::new(Mutex::new(())),
        }
    }

    pub fn managed_node_apps(&self) -> Option<crate::ManagedNodeApps> {
        self.managed_app_root
            .as_ref()
            .map(|root| crate::ManagedNodeApps::new(root.as_ref().clone()))
    }

    pub fn custom_path(&self) -> &Path {
        self.custom_path.as_path()
    }

    pub fn invalidate(&self) {}

    pub fn load_custom(&self) -> Result<CustomAppCatalog, AppRuntimeError> {
        let raw = match read_json::<Value>(&self.custom_path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(CustomAppCatalog::default())
            }
            Err(error) => return Err(AppRuntimeError::catalog_invalid(error.to_string())),
        };
        let catalog = sanitize_custom_catalog(raw).map_err(AppRuntimeError::catalog_invalid)?;
        validate_custom_catalog(&catalog)?;
        Ok(catalog)
    }

    pub fn safe_custom(&self) -> (CustomAppCatalog, Option<Value>) {
        match self.load_custom() {
            Ok(catalog) => (catalog, None),
            Err(_) => {
                let catalog = recover_custom_catalog(&self.custom_path).unwrap_or_default();
                (
                    catalog,
                    Some(json!({
                        "code": "APP_CATALOG_INVALID",
                        "message": "Custom app catalog is invalid."
                    })),
                )
            }
        }
    }

    pub fn save_custom(&self, value: Value) -> Result<CustomAppCatalog, AppRuntimeError> {
        validate_custom_catalog_wire(&value).map_err(AppRuntimeError::catalog_invalid)?;
        let catalog = sanitize_custom_catalog(value).map_err(AppRuntimeError::catalog_invalid)?;
        validate_custom_catalog(&catalog)?;
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        write_json_atomic(&self.custom_path, &catalog, Some(0o600))
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        self.invalidate();
        Ok(catalog)
    }

    pub fn entries(&self) -> Vec<CatalogEntry> {
        let (custom, _) = self.safe_custom();
        self.merged_entries(custom)
    }

    fn merged_entries(&self, custom: CustomAppCatalog) -> Vec<CatalogEntry> {
        let mut merged = Vec::<(AppCatalogItem, AppSource)>::new();
        let mut seen = BTreeSet::new();
        for app in builtin_app_catalog() {
            seen.insert(app.id.clone());
            merged.push((app, AppSource::Builtin));
        }
        for app in custom.items {
            if seen.insert(app.id.clone()) {
                merged.push((app, AppSource::Custom));
            }
        }
        merged
            .into_iter()
            .map(|(app, source)| {
                resolve_entry(
                    app,
                    source,
                    self.managed_app_root.as_deref().map(PathBuf::as_path),
                    &self.managed_app_ids,
                )
            })
            .collect()
    }

    pub fn catalog(&self) -> Vec<AppCatalogItem> {
        self.entries()
            .into_iter()
            .filter(|entry| entry.executable.is_some())
            .map(|entry| entry.app)
            .collect()
    }

    pub fn find(&self, app_id: &str) -> Option<CatalogEntry> {
        self.entries()
            .into_iter()
            .find(|entry| entry.app.id == app_id)
    }

    pub fn inventory(&self) -> controlled_instance_protocol::AppInventorySnapshot {
        let (custom, error) = self.safe_custom();
        let entries = self.merged_entries(custom);
        let items = entries
            .into_iter()
            .map(|entry| {
                let app = &entry.app;
                let provider = if entry.source == AppSource::Builtin {
                    managed_app_provider(&app.id)
                } else {
                    managed_app_runtime_provider(app)
                };
                let mut capabilities = serde_json::Map::from_iter([
                    (
                        "supportsCwdSelection".to_string(),
                        Value::Bool(
                            entry.source == AppSource::Builtin
                                && provider.is_some_and(|provider| {
                                    provider.capabilities.supports_cwd_selection
                                }),
                        ),
                    ),
                    (
                        "supportsProfiles".to_string(),
                        Value::Bool(
                            provider
                                .is_some_and(|provider| provider.capabilities.supports_profiles),
                        ),
                    ),
                ]);
                if let Some(automation) = app.automation.as_ref() {
                    capabilities.insert(
                        "automation".to_string(),
                        Value::String(automation.kind.clone()),
                    );
                }
                let mut item = serde_json::Map::from_iter([
                    ("id".to_string(), Value::String(app.id.clone())),
                    ("name".to_string(), Value::String(app.name.clone())),
                    (
                        "kind".to_string(),
                        Value::String(
                            match app.kind {
                                AppKind::Tty => "tty",
                                AppKind::Gui => "gui",
                                AppKind::Web => "web",
                            }
                            .to_string(),
                        ),
                    ),
                    (
                        "source".to_string(),
                        Value::String(entry.source.as_str().to_string()),
                    ),
                    (
                        "availability".to_string(),
                        Value::String(
                            if entry.executable.is_some() {
                                "available"
                            } else {
                                "missing-dependency"
                            }
                            .to_string(),
                        ),
                    ),
                    ("capabilities".to_string(), Value::Object(capabilities)),
                ]);
                if entry.executable.is_none() {
                    item.insert(
                        "diagnosticCode".to_string(),
                        Value::String("APP_EXECUTABLE_NOT_FOUND".to_string()),
                    );
                }
                Value::Object(item)
            })
            .collect::<Vec<_>>();
        controlled_instance_protocol::AppInventorySnapshot {
            items,
            observed_at: now_iso(),
            issues: error.into_iter().collect(),
        }
    }
}

pub fn builtin_app_catalog() -> Vec<AppCatalogItem> {
    crate::builtin_managed_app_definitions()
        .into_iter()
        .filter(crate::is_launchable_managed_definition)
        .map(|definition| definition.launcher)
        .collect()
}

fn builtin_app_ids() -> BTreeSet<String> {
    crate::builtin_managed_app_definitions()
        .into_iter()
        .map(|definition| definition.launcher.id)
        .collect()
}

fn resolve_entry(
    mut app: AppCatalogItem,
    source: AppSource,
    managed_app_root: Option<&Path>,
    managed_app_ids: &BTreeSet<String>,
) -> CatalogEntry {
    let mut launcher_env = app.env.clone().unwrap_or_default();
    let command = app.command.clone().unwrap_or_default();
    let managed_id = if source == AppSource::Builtin && managed_app_ids.contains(&app.id) {
        Some(app.id.clone())
    } else if managed_app_ids.contains(&command) {
        Some(command.clone())
    } else {
        None
    };
    if let (Some(root), Some(managed_id)) = (managed_app_root, managed_id.as_deref()) {
        let bin = root
            .join("node-package")
            .join(managed_id)
            .join("node_modules")
            .join(".bin");
        let candidate = bin.join(managed_id);
        let existing = launcher_env
            .get("PATH")
            .cloned()
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        launcher_env.insert(
            "PATH".to_string(),
            std::iter::once(bin.display().to_string())
                .chain((!existing.is_empty()).then_some(existing))
                .collect::<Vec<_>>()
                .join(if cfg!(windows) { ";" } else { ":" }),
        );
        let executable = resolve_executable(
            candidate.to_string_lossy().as_ref(),
            &launcher_env,
            app.cwd.as_deref(),
        );
        app.command = Some(candidate.display().to_string());
        app.env = Some(launcher_env);
        return CatalogEntry {
            app,
            source,
            executable,
        };
    }
    let mut environment = std::env::vars().collect::<BTreeMap<_, _>>();
    environment.extend(launcher_env.clone());
    let options = ExecutableResolverOptions {
        env: environment,
        cwd: app
            .cwd
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
        ..ExecutableResolverOptions::default()
    };
    let resolution = app
        .command
        .as_deref()
        .and_then(|command| resolve_executable_resolution(command.trim(), &options));
    let executable = resolution
        .as_ref()
        .map(|resolution| resolution.executable.clone());
    if let Some(path) = &executable {
        app.command = Some(path.display().to_string());
        let mut resolved_env = launcher_env;
        if let Some(resolution) = resolution {
            resolved_env.extend(resolution.env);
        }
        app.env = Some(resolved_env);
    }
    CatalogEntry {
        app,
        source,
        executable,
    }
}

pub fn resolve_executable(
    command: &str,
    overrides: &BTreeMap<String, String>,
    cwd: Option<&str>,
) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let mut env = std::env::vars().collect::<BTreeMap<_, _>>();
    env.extend(overrides.clone());
    let mut options = ExecutableResolverOptions {
        env,
        cwd: cwd
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
        ..ExecutableResolverOptions::default()
    };
    if let Some(cwd) = cwd {
        options.cwd = PathBuf::from(cwd);
    }
    resolve_command_executable(command, &CommandInvocationOptions::from(options))
}

fn sanitize_custom_catalog(value: Value) -> Result<CustomAppCatalog, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Custom app catalog must be an object.".to_string())?;
    let schema_version = match root.get("schemaVersion") {
        None => 1,
        Some(value) => value
            .as_u64()
            .filter(|version| *version == 1)
            .ok_or_else(|| "Custom app catalog schemaVersion must be 1.".to_string())?
            as u32,
    };
    if schema_version != 1 {
        return Err("Custom app catalog schemaVersion must be 1.".to_string());
    }
    let items = match root.get("items") {
        None => Vec::new(),
        Some(value) => value
            .as_array()
            .ok_or_else(|| "Custom app catalog items must be an array.".to_string())?
            .iter()
            .cloned()
            .map(|item| parse_custom_catalog_item(item).map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(CustomAppCatalog {
        schema_version,
        items,
    })
}

fn validate_custom_catalog_wire(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Custom app catalog must be an object.".to_string())?;
    reject_unknown_keys(root, &["schemaVersion", "items"], "")?;
    let Some(items) = root.get("items") else {
        return Ok(());
    };
    let items = items
        .as_array()
        .ok_or_else(|| "Custom app catalog items must be an array.".to_string())?;
    for (index, item) in items.iter().enumerate() {
        let item = item
            .as_object()
            .ok_or_else(|| format!("items[{index}]: expected object"))?;
        reject_unknown_keys(
            item,
            &[
                "id",
                "name",
                "kind",
                "description",
                "command",
                "args",
                "cwd",
                "env",
                "display",
                "defaultDisplayTarget",
                "automation",
                "web",
            ],
            &format!("items[{index}]."),
        )?;
        for (key, fields) in [
            ("display", &["width", "height", "depth"][..]),
            ("defaultDisplayTarget", &["mode", "id", "autoCreate"][..]),
            ("automation", &["type", "portArg", "endpointPath"][..]),
            ("web", &["portArg", "readyPath"][..]),
        ] {
            if let Some(value) = item.get(key) {
                let nested = value
                    .as_object()
                    .ok_or_else(|| format!("items[{index}].{key}: expected object"))?;
                reject_unknown_keys(nested, fields, &format!("items[{index}].{key}."))?;
            }
        }
    }
    Ok(())
}

fn reject_unknown_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    prefix: &str,
) -> Result<(), String> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{prefix}{key}: Unrecognized key: \"{key}\""));
    }
    Ok(())
}

fn sanitize_custom_item(value: Value) -> Value {
    let Some(source) = value.as_object() else {
        return value;
    };
    let mut item = serde_json::Map::new();
    for key in [
        "id",
        "name",
        "kind",
        "description",
        "command",
        "args",
        "cwd",
        "env",
    ] {
        if let Some(value) = source.get(key) {
            item.insert(key.to_string(), value.clone());
        }
    }
    for (key, fields) in [
        ("display", &["width", "height", "depth"][..]),
        ("defaultDisplayTarget", &["mode", "id", "autoCreate"][..]),
        ("automation", &["type", "portArg", "endpointPath"][..]),
        ("web", &["portArg", "readyPath"][..]),
    ] {
        if let Some(value) = pick_fields(source.get(key), fields) {
            item.insert(key.to_string(), value);
        }
    }
    // Zod materializes the catalog's optional `args` default in the persisted
    // and returned custom catalog. Keep the same wire shape for old clients.
    item.entry("args".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    Value::Object(item)
}

fn pick_fields(value: Option<&Value>, keys: &[&str]) -> Option<Value> {
    let source = value?.as_object()?;
    Some(Value::Object(
        keys.iter()
            .filter_map(|key| {
                source
                    .get(*key)
                    .map(|value| ((*key).to_string(), value.clone()))
            })
            .collect(),
    ))
}

fn parse_custom_catalog_item(value: Value) -> Result<AppCatalogItem, String> {
    let mut item = serde_json::from_value::<AppCatalogItem>(sanitize_custom_item(value))
        .map_err(|error| error.to_string())?;
    item.id = item.id.trim().to_string();
    item.name = item.name.trim().to_string();
    if let Some(command) = item.command.as_mut() {
        *command = command.trim().to_string();
    }
    if let Some(target) = item.default_display_target.as_mut() {
        if let Some(id) = target.id.as_mut() {
            *id = id.trim().to_string();
        }
    }
    validate_app_catalog_item(&item)?;
    Ok(item)
}

fn recover_custom_catalog(path: &Path) -> Option<CustomAppCatalog> {
    let raw = read_json::<Value>(path).ok()?;
    let source = raw.as_object()?;
    let items = source.get("items")?.as_array()?;
    let builtin = builtin_app_ids();
    let mut seen = BTreeSet::new();
    let recovered = items
        .iter()
        .cloned()
        .filter_map(|item| parse_custom_catalog_item(item).ok())
        .filter(|item| !builtin.contains(&item.id) && seen.insert(item.id.clone()))
        .collect::<Vec<_>>();
    Some(CustomAppCatalog {
        schema_version: 1,
        items: recovered,
    })
}

fn validate_app_catalog_item(item: &AppCatalogItem) -> Result<(), String> {
    if !valid_app_id(&item.id) {
        return Err(format!("Invalid custom app id: {}", item.id));
    }
    if item.name.trim().is_empty() || item.name.chars().count() > 120 {
        return Err("Custom app name is invalid.".to_string());
    }
    if item
        .description
        .as_ref()
        .is_some_and(|value| value.chars().count() > 500)
    {
        return Err("Custom app description is invalid.".to_string());
    }
    let Some(command) = &item.command else {
        return Err("Custom app command is required.".to_string());
    };
    if command.is_empty()
        || command.chars().count() > 512
        || command
            .chars()
            .any(|character| character.is_whitespace() || ";|&<>`$".contains(character))
    {
        return Err("Custom app command must be a single executable path or name.".to_string());
    }
    if item
        .args
        .as_ref()
        .is_some_and(|args| args.len() > 64 || args.iter().any(|arg| arg.chars().count() > 1024))
    {
        return Err("Custom app args are invalid.".to_string());
    }
    if item
        .cwd
        .as_ref()
        .is_some_and(|cwd| cwd.chars().count() > 512)
    {
        return Err("Custom app cwd is invalid.".to_string());
    }
    if item.env.as_ref().is_some_and(|env| {
        env.iter()
            .any(|(name, value)| !valid_environment_name(name) || value.chars().count() > 4096)
    }) {
        return Err("Custom app environment is invalid.".to_string());
    }
    if let Some(display) = &item.display {
        if display
            .width
            .is_some_and(|value| !(320..=7680).contains(&value))
            || display
                .height
                .is_some_and(|value| !(240..=4320).contains(&value))
            || display
                .depth
                .is_some_and(|value| !matches!(value, 16 | 24 | 32))
        {
            return Err("Custom app display is invalid.".to_string());
        }
    }
    if let Some(target) = &item.default_display_target {
        if target.id.as_ref().is_some_and(|id| !valid_app_id(id)) {
            return Err("Custom app display target is invalid.".to_string());
        }
    }
    if item
        .automation
        .as_ref()
        .is_some_and(|automation| automation.kind != "cdp")
    {
        return Err("Custom app automation type must be cdp.".to_string());
    }
    Ok(())
}

fn valid_environment_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn validate_custom_catalog(catalog: &CustomAppCatalog) -> Result<(), AppRuntimeError> {
    let builtin = builtin_app_ids();
    let mut seen = BTreeSet::new();
    for item in &catalog.items {
        validate_app_catalog_item(item).map_err(AppRuntimeError::catalog_invalid)?;
        if builtin.contains(&item.id) {
            return Err(AppRuntimeError::catalog_invalid(
                "Custom apps cannot override built-in app ids.",
            ));
        }
        if !seen.insert(item.id.clone()) {
            return Err(AppRuntimeError::catalog_invalid(
                "Custom app ids must be unique.",
            ));
        }
    }
    Ok(())
}

fn valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        && id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn managed_node_apps_resolve_from_the_instance_root_without_path_fallback() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("tempdir");
        let managed = root.path().join("managed-apps");
        let repository = AppCatalogRepository::new_with_managed_root(
            root.path().join("app-catalog"),
            Some(managed.clone()),
        );
        let missing = repository.find("codex").expect("codex");
        assert!(missing.executable.is_none());
        assert!(missing
            .app
            .command
            .as_deref()
            .is_some_and(|command| command.contains("managed-apps")));

        let bin = managed
            .join("node-package")
            .join("codex")
            .join("node_modules")
            .join(".bin");
        std::fs::create_dir_all(&bin).expect("bin directory");
        let executable = bin.join("codex");
        std::fs::write(&executable, "#!/bin/sh\nexit 0\n").expect("executable");
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
            .expect("executable permissions");
        let repository = AppCatalogRepository::new_with_managed_root(
            root.path().join("app-catalog"),
            Some(managed),
        );
        let resolved = repository.find("codex").expect("codex");
        assert_eq!(resolved.executable.as_deref(), Some(executable.as_path()));
    }

    #[test]
    fn custom_catalog_rejects_builtin_ids_and_unknown_fields() {
        let root = tempfile::tempdir().expect("tempdir");
        let repository = AppCatalogRepository::new(root.path());
        let error = repository
            .save_custom(json!({
                "schemaVersion": 1,
                "items": [{ "id": "codex", "name": "Mine", "kind": "tty", "command": "sh" }]
            }))
            .expect_err("builtin collision");
        assert_eq!(error.code(), "APP_CATALOG_INVALID");

        let error = repository
            .save_custom(json!({
                "schemaVersion": 1,
                "items": [{ "id": "my-shell", "name": "Mine", "kind": "tty", "command": "sh", "unknown": true }]
            }))
            .expect_err("unknown fields are rejected on save");
        assert_eq!(error.code(), "APP_CATALOG_INVALID");

        let saved = repository
            .save_custom(json!({
                "schemaVersion": 1,
                "items": [{ "id": "my-shell", "name": "Mine", "kind": "tty", "command": "sh" }]
            }))
            .expect("custom catalog");
        assert_eq!(saved.items[0].id, "my-shell");
        assert!(repository.find("my-shell").is_some());
    }

    #[test]
    fn custom_catalog_recovers_valid_entries_when_other_entries_are_invalid() {
        let root = tempfile::tempdir().expect("tempdir");
        let repository = AppCatalogRepository::new(root.path());
        std::fs::write(
            repository.custom_path(),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "items": [
                    { "id": "recovered-app", "name": "Recovered", "kind": "tty", "command": "sh" },
                    { "id": "broken-app", "name": "", "kind": "tty", "command": "sh" },
                    { "id": "codex", "name": "Builtin collision", "kind": "tty", "command": "sh" },
                    { "id": "thctl", "name": "Management-only collision", "kind": "tty", "command": "sh" },
                    { "id": "recovered-app", "name": "Duplicate", "kind": "tty", "command": "sh" },
                    { "id": "bad-kind", "name": "Bad kind", "kind": "desktop", "command": "sh" }
                ]
            }))
            .expect("catalog json"),
        )
        .expect("custom catalog");

        assert_eq!(
            repository.load_custom().expect_err("strict load").code(),
            "APP_CATALOG_INVALID"
        );
        let (recovered, issue) = repository.safe_custom();
        assert_eq!(
            recovered
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["recovered-app"]
        );
        assert_eq!(issue.expect("catalog issue")["code"], "APP_CATALOG_INVALID");
        assert!(repository.find("recovered-app").is_some());
        let inventory = repository.inventory();
        assert_eq!(inventory.issues.len(), 1);
        assert!(inventory
            .items
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some("recovered-app")));
    }

    #[test]
    fn custom_catalog_requires_an_executable_command() {
        let root = tempfile::tempdir().expect("tempdir");
        let repository = AppCatalogRepository::new(root.path());
        let error = repository
            .save_custom(json!({
                "schemaVersion": 1,
                "items": [{ "id": "missing-command", "name": "Missing", "kind": "tty" }]
            }))
            .expect_err("command must be required");
        assert_eq!(error.code(), "APP_CATALOG_INVALID");
    }

    #[test]
    fn executable_availability_refreshes_without_invalidating_the_catalog() {
        let root = tempfile::tempdir().expect("tempdir");
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        let repository = AppCatalogRepository::new(root.path());
        repository
            .save_custom(json!({
                "schemaVersion": 1,
                "items": [{
                    "id": "dynamic-app",
                    "name": "Dynamic",
                    "kind": "tty",
                    "command": "dynamic-app",
                    "env": { "PATH": bin.display().to_string() }
                }]
            }))
            .expect("custom catalog");
        assert!(repository
            .find("dynamic-app")
            .expect("catalog entry")
            .executable
            .is_none());

        let executable = bin.join("dynamic-app");
        std::fs::write(&executable, "#!/bin/sh\n").expect("executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
                .expect("permissions");
        }

        assert_eq!(
            repository
                .find("dynamic-app")
                .expect("refreshed entry")
                .executable,
            Some(executable)
        );
        let inventory = repository.inventory();
        let item = inventory
            .items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some("dynamic-app"))
            .expect("inventory item");
        assert_eq!(item.get("availability"), Some(&json!("available")));
    }

    #[test]
    fn executable_resolution_honors_explicit_path_entries() {
        let root = tempfile::tempdir().expect("tempdir");
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        let command = bin.join("fixture-app");
        std::fs::write(&command, "#!/bin/sh\n").expect("command");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700))
                .expect("permissions");
        }
        let mut env = BTreeMap::new();
        env.insert("PATH".to_string(), bin.display().to_string());
        assert_eq!(resolve_executable("fixture-app", &env, None), Some(command));
    }

    #[test]
    fn inventory_omits_optional_fields_instead_of_serializing_null() {
        let root = tempfile::tempdir().expect("tempdir");
        let inventory = AppCatalogRepository::new(root.path()).inventory();
        let vscode = inventory
            .items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some("vscode-web"))
            .expect("vscode inventory");
        assert!(vscode["capabilities"].get("automation").is_none());
        assert!(vscode.get("diagnosticCode").is_some());
        assert_ne!(vscode.get("diagnosticCode"), Some(&Value::Null));
    }

    #[test]
    fn inventory_capabilities_come_from_managed_app_providers() {
        let root = tempfile::tempdir().expect("tempdir");
        let inventory = AppCatalogRepository::new(root.path()).inventory();
        let capabilities = |id: &str| {
            inventory
                .items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
                .expect("inventory item")["capabilities"]
                .clone()
        };

        assert_eq!(capabilities("terminal-tty")["supportsCwdSelection"], true);
        assert_eq!(capabilities("codex")["supportsCwdSelection"], true);
        assert_eq!(capabilities("terminal-gui")["supportsCwdSelection"], false);
        assert_eq!(capabilities("chromium")["supportsProfiles"], true);
        assert_eq!(capabilities("terminal-gui")["supportsProfiles"], false);
    }

    #[test]
    fn catalog_and_inventory_keep_the_node_definition_order() {
        let root = tempfile::tempdir().expect("tempdir");
        let repository = AppCatalogRepository::new(root.path());
        let definition_ids = builtin_app_catalog()
            .into_iter()
            .map(|app| app.id)
            .collect::<Vec<_>>();
        let inventory_ids = repository
            .inventory()
            .items
            .into_iter()
            .filter_map(|item| item.get("id")?.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        assert!(definition_ids.starts_with(
            &[
                "terminal-tty",
                "codex",
                "opencode",
                "claude",
                "terminal-gui",
                "chromium",
                "vscode-web"
            ]
            .map(ToString::to_string)
        ));
        assert_eq!(inventory_ids, definition_ids);
    }

    #[test]
    fn catalog_preserves_node_optional_args_and_projects_resolved_env() {
        let builtin = builtin_app_catalog();
        let terminal = builtin
            .iter()
            .find(|app| app.id == "terminal-tty")
            .expect("terminal");
        let opencode = builtin
            .iter()
            .find(|app| app.id == "opencode")
            .expect("opencode");
        assert!(terminal.args.is_none());
        assert_eq!(opencode.args, Some(Vec::new()));

        let mut terminal = terminal.clone();
        terminal.command = Some("/bin/sh".to_string());
        let resolved = resolve_entry(terminal, AppSource::Builtin, None, &BTreeSet::new()).app;
        let value = serde_json::to_value(resolved).expect("serialize catalog item");
        assert_eq!(value.get("env"), Some(&json!({})));
        assert!(value.get("args").is_none());
    }
}
