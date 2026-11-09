#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    desktop_streaming::platform::linux_vaapi::run()
}
#[cfg(not(target_os = "linux"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("VAAPI is Linux-only")
}
