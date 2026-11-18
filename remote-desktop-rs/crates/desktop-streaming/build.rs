const VERSION_ENV: &str = "TASK_HANDOFF_REMOTE_DESKTOP_VERSION";

fn valid_version(value: &str) -> bool {
    let core = value.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<_> = core.split('.').collect();
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
        && parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn main() {
    println!("cargo:rerun-if-env-changed={VERSION_ENV}");
    let fallback =
        std::env::var("CARGO_PKG_VERSION").expect("Cargo did not provide CARGO_PKG_VERSION");
    let version = std::env::var(VERSION_ENV).unwrap_or(fallback);
    if !valid_version(&version) {
        panic!("{VERSION_ENV} must be an exact semantic version, got {version:?}");
    }
    println!("cargo:rustc-env={VERSION_ENV}={version}");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Maintained SCK bindings embed a Swift bridge. Swift concurrency ships
        // in the OS dyld cache under /usr/lib/swift; it is not in the default
        // @rpath set for a Rust executable. Do not depend on an Xcode install or
        // DYLD_LIBRARY_PATH in a shipped component or its guard executables.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
