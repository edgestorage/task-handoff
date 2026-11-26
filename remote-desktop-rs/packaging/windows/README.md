# Windows MSVC and MSI packaging

`product.wxs` is a WiX 3 MSI for the native desktop-streaming component. The
package installs per user under
`%LOCALAPPDATA%\TaskHandoff\RemoteDesktop`, uses HKCU registry key paths, and
removes the install and parent TaskHandoff directories on uninstall.

## Requirements

- Rust 1.95 MSVC target and `cargo-xwin` CRT/SDK files.
- `clang-cl`, `lld-link` and `llvm-lib` on PATH.
- WiX Toolset 3.14.x with `candle.exe` and `light.exe`.
- A directory containing `vcruntime140.dll` only when the local clang-cl
  toolchain needs it to start; the final executable uses the static CRT.

## Build

```powershell
$env:Path="$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\winlibs\mingw64\bin;$env:Path"
.\scripts\build-remote-desktop-windows.ps1 `
  -Version 0.0.46 `
  -WixBin C:\th-spike\tools\wix314 `
  -XwinRoot "$env:LOCALAPPDATA\cargo-xwin\splat5" `
  -VcRuntimeDir C:\th-spike\tools\vc-runtime-min\System64 `
  -SignDevelopment `
  -OutputDirectory C:\th-spike\repo\task-handoff\release\windows
```

`-SkipBuild` reuses an existing MSVC release binary; `-SkipInstallTest` skips
the silent install/version/uninstall cycle.

## Signing modes

Choose exactly one:

- `-SignDevelopment`: creates or reuses a current-user self-signed code-signing
  certificate. The executable and MSI are signed, and the verification evidence
  records `ValidSignatureUntrustedDevelopmentRoot` because the development root
  is deliberately not written to the OS root store.
- `-PfxPath <file> -PfxPassword <password>`: signs with a production PFX. The
  signature must verify as `Valid` against the OS-trusted chain.
- `-Thumbprint <sha1>`: signs with a code-signing certificate in
  `Cert:\CurrentUser\My`.

Use `-TimestampUrl` to set the RFC3161 timestamp server for non-development
signing. Never store a PFX password or private key in the repository.

## Outputs

- `TaskHandoffRemoteDesktop-<version>-x64.msi`
- `stage/<version>/task-handoff-desktop-streaming.exe` and component metadata
- `build.json` with hashes, signing mode and install/uninstall results
- `authenticode.json` for the MSI and `prepackage-signature/authenticode.json`
  for the executable embedded in the MSI
- `install-<version>.log` and `uninstall-<version>.log`

The local acceptance result for version 0.0.46 is recorded in
`remote-desktop-rs/crates/desktop-streaming/evidence/windows-local/`.

The npm release workflow builds this executable with `+crt-static` and `/MT`
and rejects any artifact that imports `VCRUNTIME*.dll`, `MSVCP*.dll`,
`CONCRT*.dll`, `UCRTBASE.dll`, or the UCRT API-set DLLs. The component must run
without a separately installed Visual C++ Redistributable.
