fn main() {
    tauri_build::build();

    // Windows test executables are not given the app manifest, so they fail to start with
    // STATUS_ENTRYPOINT_NOT_FOUND (comctl32 v6 is required by the webview stack). Embed one for tests only.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{dir}\\test.manifest");
        println!("cargo:rerun-if-changed=test.manifest");
    }
}
