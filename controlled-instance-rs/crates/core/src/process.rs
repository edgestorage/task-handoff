use std::process::Command;

#[cfg(target_os = "linux")]
use std::path::Path;

/// Resolve the host name without relying on the launching shell to export
/// `HOSTNAME`. Local launchd/systemd environments differ here, while the Node
/// runtime used `os.hostname()` and exposed a stable value on every platform.
pub fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0_u8; 256];
        let result = unsafe {
            libc::gethostname(
                buffer.as_mut_ptr().cast::<libc::c_char>(),
                buffer.len() as libc::size_t,
            )
        };
        if result == 0 {
            let end = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            if let Ok(value) = std::str::from_utf8(&buffer[..end]) {
                let value = value.trim();
                if !value.is_empty() {
                    return value.to_string();
                }
            }
        }
    }
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn process_start_identity(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let command_end = stat.rfind(')')?;
        let fields = stat
            .get(command_end + 2..)?
            .split_whitespace()
            .collect::<Vec<_>>();
        return fields.get(19).map(|value| format!("linux:{value}"));
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let output = Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let started_at = String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        return (!started_at.is_empty()).then(|| format!("{}:{started_at}", std::env::consts::OS));
    }
    #[cfg(target_os = "windows")]
    {
        let command =
            format!("(Get-Process -Id {pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks");
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &command])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let ticks = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return (!ticks.is_empty() && ticks.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| format!("win32:{ticks}"));
    }
    #[allow(unreachable_code)]
    None
}

pub fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        return Path::new(&format!("/proc/{pid}")).exists();
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        unsafe {
            let result = libc::kill(pid as libc::pid_t, 0);
            return result == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let command = format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue) -ne $null");
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &command])
            .output()
            .ok();
        return output
            .map(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout)
                        .trim()
                        .eq_ignore_ascii_case("true")
            })
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

pub fn process_matches_start_identity(pid: u32, expected: Option<&str>) -> bool {
    if !pid_is_alive(pid) {
        return false;
    }
    match expected {
        None => true,
        Some(expected) => process_start_identity(pid)
            .map(|actual| actual == expected)
            .unwrap_or(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_has_a_start_identity_when_supported() {
        let identity = process_start_identity(std::process::id());
        if cfg!(target_os = "linux") || cfg!(target_os = "macos") {
            assert!(identity.is_some());
        }
        assert!(pid_is_alive(std::process::id()));
    }

    #[test]
    fn hostname_is_available_without_shell_environment() {
        assert_ne!(hostname(), "unknown");
    }
}
