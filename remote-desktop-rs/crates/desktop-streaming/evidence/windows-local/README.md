# Local Windows component acceptance (2026-11-16)

This directory records local Windows G1 component acceptance on an active
console session. It does not open product capability, integrate with instance
cores or deploy through TaskHandoff. Environment: Windows 11 Pro for
Workstations 10.0.26200 x64, Session 2, one 1280x800 display, with
`explorer.exe` in the same session.

No screen pixels, window titles, input content, PFX password, private key or
production certificate are stored here. The included `.cer` is the public
development signing certificate only.

## Evidence files

| File | Actual result |
| --- | --- |
| `environment.json` | Host, active session and display catalog summary |
| `display-capture.json` | One display source, real WGC frame 1280x800 BGRA, cursor and input geometry |
| `windows-native.json` | Three native window/display tests passed |
| `secure-desktop-fail-closed.json` | Private-desktop rejection and session-state checks passed |
| `msvc-release.json` | MSVC x64 static-CRT release, version 0.0.46, import audit |
| `authenticode.json` | Development self-signed signatures on the executable and MSI |
| `msi-install.json` | Silent per-user MSI install, version check and uninstall |
| `msi-build.json` | Pipeline hashes, signing mode and install/uninstall flags |
| `TaskHandoffDevelopmentCodeSigning.cer` | Public development signing certificate |

## Display capture

`display_catalog_and_wgc_capture_emit_real_frames` enumerated one display,
consumed its owner-bound source reference, selected the native WGC backend and
received a real frame:

```text
display capture ok: sources=1 geometry=1280x800 frame=1280x800 cursor=true
```

The test also proves catalog/capture geometry agreement, stride
`1280 * 4 = 5120`, BGRA length `5120 * 800 = 4096000`, visible non-zero pixels,
pause, and `NativeInput::prepare` for the same geometry. This is correctness
evidence, not a sustained frame-rate, multi-monitor or hardware-encoding gate.

## Window capture and input

The three opt-in `windows_native` tests passed in 1.74s:

```text
running 3 tests
..display capture ok: sources=1 geometry=1280x800 frame=1280x800 cursor=true
.
test result: ok. 3 passed; 0 failed; 0 ignored
```

The window path published a disposable owned window, retained its HWND/PID
identity, captured real WGC frame data with matching BGRA geometry, used DWM
geometry, performed `AttachThreadInput` foreground activation, validated the
pointer hit, and delivered a native click through `NativeInput`. A direct
window-target WGC diagnostic also passed.

## Lock, secure desktop and cross-session behavior

`windows_access::check` requires a non-zero current session, WTS state
`WTSActive`, an open input desktop matching the thread desktop, and same-session
ownership for window targets. Cross-session windows are not selectable.

`private_desktop_is_rejected_like_a_secure_desktop` passed: after switching the
test thread to a newly created private desktop, `check()` returned
`REMOTE_DESKTOP_DESKTOP_UNAVAILABLE`, with no input injection and no product
desktop switch. An actual lock or RDP-disconnect transition was not triggered on
this working host. Remote unlock of a locked/secure desktop is not implemented
or claimed.

## MSVC release

Target `x86_64-pc-windows-msvc`, Rust 1.95, static CRT, version `0.0.46`.
`llvm-readobj --coff-imports` reports only system DLLs; there are no
`vcruntime140.dll`, `ucrtbase.dll`, `msvcp*.dll` or `concrt*.dll` imports.
Unsigned release size is 12,301,312 bytes; the signed staged executable is
12,303,168 bytes.

## Signing and installer

The pipeline builds a per-user WiX 3.14.1 MSI, signs the staged executable,
builds the MSI around that signed executable, signs the MSI, silently installs
it, checks `--version`, and silently uninstalls it. Both operations returned
exit code 0 and the MSI logs report installation/removal success. The installed
executable reported `0.0.46`, matched the staged SHA-256, and was removed on
uninstall.

The current host has no production code-signing certificate. Development
signing verifies the attached Authenticode signature with the explicitly
exported self-signed certificate and records
`ValidSignatureUntrustedDevelopmentRoot`; the development root is deliberately
not installed into the OS root store because a headless root-store write requires
an interactive consent dialog. A production build must pass `-PfxPath` or
`-Thumbprint` for a certificate whose chain terminates in a trusted
code-signing root.

## Remaining limits

This evidence does not claim multi-session delivery, remote unlock, a machine-wide
or upgrade MSI matrix, interactive strong-kill/key-release acceptance, Windows
Media Foundation encoding, sustained 1080p30 performance, or G6
LAN150ms/TURN/weak-network results. Windows MF remains deferred to OpenH264.

## Reproduce

From the repository root, with Rust 1.95 and the Windows native prerequisites:

```powershell
cargo +1.95.0-x86_64-pc-windows-gnu test -q --manifest-path remote-desktop-rs/Cargo.toml -p desktop-streaming
cargo +1.95.0-x86_64-pc-windows-gnu test -q --manifest-path remote-desktop-rs/Cargo.toml -p desktop-streaming --lib -- --ignored --nocapture
cargo +1.95.0-x86_64-pc-windows-gnu test -q --manifest-path remote-desktop-rs/Cargo.toml -p desktop-streaming --test windows_native -- --ignored --nocapture
```

The MSVC/MSI pipeline and its exact environment arguments are documented in
`remote-desktop-rs/packaging/windows/` and
`scripts/build-remote-desktop-windows.ps1`.
