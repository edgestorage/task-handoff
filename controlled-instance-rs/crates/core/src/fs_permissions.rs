use std::io;
use std::path::Path;

#[cfg(unix)]
pub fn restrict_path(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
pub fn restrict_path(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub fn restrict_file(path: &Path) -> io::Result<()> {
    restrict_path(path, 0o600)
}

#[cfg(not(unix))]
pub fn restrict_file(_path: &Path) -> io::Result<()> {
    Ok(())
}
