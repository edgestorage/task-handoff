fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Maintained SCK bindings embed a Swift bridge. Swift concurrency ships
        // in the OS dyld cache under /usr/lib/swift; it is not in the default
        // @rpath set for a Rust executable. Do not depend on an Xcode install or
        // DYLD_LIBRARY_PATH in a shipped component or its guard executables.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
