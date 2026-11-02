use chrono::{DateTime, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub const DEFAULT_MANAGED_BACKUP_LIMIT: usize = 10;

pub fn prune_managed_backups(path: &Path, limit: usize) -> io::Result<Vec<PathBuf>> {
    let Some(directory) = path.parent() else {
        return Ok(Vec::new());
    };
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let prefix = format!("{file_name}.bak.");
    let mut backups = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let generation = name.strip_prefix(&prefix)?;
            if parse_generation(generation).is_some() {
                Some((name, entry.path()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| left.0.cmp(&right.0));
    let remove_count = backups.len().saturating_sub(limit);
    let removed = backups
        .into_iter()
        .take(remove_count)
        .map(|(_, path)| path)
        .collect::<Vec<_>>();
    for path in &removed {
        fs::remove_file(path)?;
    }
    Ok(removed)
}

fn parse_generation(value: &str) -> Option<DateTime<Utc>> {
    const STAMP_LEN: usize = 24;
    let stamp = if value.len() == STAMP_LEN {
        value
    } else if value.len() > STAMP_LEN + 1
        && value.as_bytes().get(STAMP_LEN) == Some(&b'-')
        && value[STAMP_LEN + 1..]
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    {
        &value[..STAMP_LEN]
    } else {
        return None;
    };
    if !stamp.ends_with('Z') {
        return None;
    }
    NaiveDateTime::parse_from_str(&stamp[..stamp.len() - 1], "%Y-%m-%dT%H-%M-%S-%3f")
        .ok()
        .map(|value| Utc.from_utc_datetime(&value))
}

pub fn create_managed_backup(path: &Path) -> io::Result<PathBuf> {
    create_managed_backup_at(path, Utc::now())
}

pub fn create_managed_backup_at(path: &Path, now: DateTime<Utc>) -> io::Result<PathBuf> {
    let base = format!(
        "{}.bak.{}",
        path.display(),
        now.to_rfc3339_opts(SecondsFormat::Millis, true)
            .replace([':', '.'], "-")
    );
    let mut target = PathBuf::from(&base);
    for tie in 1.. {
        if !target.exists() {
            break;
        }
        target = PathBuf::from(format!("{base}-{tie}"));
    }
    fs::copy(path, &target)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600))?;
    }
    prune_managed_backups(path, DEFAULT_MANAGED_BACKUP_LIMIT)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_backups_are_bounded_and_ignore_unrelated_files() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let path = temporary.path().join("settings.json");
        fs::write(&path, "current").expect("settings");
        fs::write(temporary.path().join("settings.json.bak.keep"), "unrelated").expect("unrelated");
        for index in 0..12 {
            let now = DateTime::parse_from_rfc3339(&format!("2026-01-01T00:00:{index:02}Z"))
                .expect("timestamp")
                .with_timezone(&Utc);
            create_managed_backup_at(&path, now).expect("backup");
        }
        let backups = fs::read_dir(temporary.path())
            .expect("entries")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.bak.2026-")
            })
            .count();
        assert_eq!(backups, DEFAULT_MANAGED_BACKUP_LIMIT);
        assert!(temporary.path().join("settings.json.bak.keep").exists());
    }
}
