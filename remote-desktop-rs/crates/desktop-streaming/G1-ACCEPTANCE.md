# G1 component acceptance

Date:2026-11-08. Windows native and packaging acceptance update:2026-11-16.
Worktree:`main`. This is an independent
component and test-host delivery; it does not integrate with instance cores,
Control Plane, node-agent, App installation or product UI. Windows window
capture/input and host IPC are implemented with contract coverage; opt-in
active-console display/window WGC/focus/hit/input acceptance, private-desktop
fail-closed checks, MSVC release, development Authenticode and per-user MSI
install/uninstall passed on 2026-11-16. No Git commit or product deployment is
made.

## Functional evidence

| Boundary | Implemented and verified | Evidence |
| --- | --- | --- |
| Private IPC and sessions | Rust/Node framing fixture; boot/owner/target-bound single-use attach; one viewer; dedup/revisions; deadline/hidden/epoch state transitions | `tests/{component_ipc,framing_channels,state_machine}.rs`, `tests/node-host.mjs` |
| WebRTC/media | H264, four negotiated channels, GCC/TWCC/pacing, bounded queues, codec limits, fresh SPS/PPS/IDR, pause/resume and ICE restart | `tests/{codec,annexb,pacing,video,encoder}.rs`, `evidence/linux-lan/` |
| Linux surface | Private Xvfb/Openbox/menu; XShm/XDamage; XTest keys/pointer/wheel/Unicode; opt-in clipboard; viewer retention; process ownership/watchdog/strong-kill cleanup | `tests/linux_surface.rs`, `evidence/linux-lan/native-stage16.log` |
| Linux encoding | OpenH264; optional isolated maintained VA-API helper; bounded protocol, kill/reap, one failure then permanent software fallback including reconfiguration | `platform/{linux_encoder,linux_vaapi}.rs`, `evidence/linux-lan/vaapi-fallback.json` |
| Linux cursor | Actual XFixes shape/hotspot, movement without trails, alpha composition and transparent cursor hiding | `xfixes_cursor_hotspot_motion_and_transparent_hide_update_captured_pixels` |
| macOS display | SCK capture, VideoToolbox hardware and OpenH264 fallback, exact native coordinates, physical keys/Unicode, cursor, permissions, pause/IDR and strong-kill release | `evidence/macos-local/{display-capture,browser-native,videotoolbox,component-sigkill,host-sigkill}.json` |
| macOS window | Retained SCK/AX identity, opaque owner/TTL/single-use refs, actual focus/hit checks, move/resize revision/epoch invalidation, minimize/close errors, no display fallback | `evidence/macos-local/window-lifecycle-{minimize,close}.json`, `window-component-sigkill.json` |
| macOS signing | Developer ID hardened-runtime disposable host/component, stable designated requirement; native window/cursor/Unicode and host-kill release under Terminal TCC | `evidence/macos-local/signed-window-{cursor,host-sigkill}.json` |
| Windows window | Retained HWND/PID identity, DWM geometry, focus/hit validation, per-monitor DPI, real WGC window capture, native click delivery, lease revocation, Rust/Node named-pipe host; opt-in native acceptance passed on an active console session (2026-11-16) | `platform/windows_window.rs`, `tests/{windows_native,windows_ownership}.rs`, `test/remote-desktop-component-host.test.js` |
| Windows display | Interactive display catalog and owner-bound source consumption; real WGC BGRA frames with matching stride/geometry, visible pixels, cursor and input preparation | `tests/windows_native.rs`, `evidence/windows-local/display-capture.json` |
| Windows session boundary | Non-zero active WTS session required; window PID must share the current session; private/non-input desktop rejected without injection or desktop switch; cross-session windows are not selectable | `platform/{windows_access,windows_window}.rs`, `evidence/windows-local/secure-desktop-fail-closed.json` |
| Windows release/signing/installer | MSVC x64 static-CRT 0.0.46 with system-only imports; development Authenticode on executable and MSI; WiX per-user MSI silent install/version/uninstall | `evidence/windows-local/{msvc-release,authenticode,msi-install}.json`, `scripts/build-remote-desktop-windows.ps1`, `packaging/windows/product.wxs` |
| Mapping and privacy | Fractional/Retina scale and negative-origin tests; no OS handles/PID/path in catalog wire, no input/window-title/pixel logging | `tests/{input_guard,catalog}.rs` |

The deterministic native XDamage test proves read->redraw->subtract can lose a
NonEmpty notification. Capture now subtracts before reading the SHM image, so a
redraw after the image boundary retains its notification. This is independently
proven, without claiming it caused earlier browser marker timeouts.

## Acceptance limits and release gates

- The permitted Linux machine has no `/dev/dri`. VA-API helper compilation and
  real initialization failure/software fallback pass; actual GPU encoding is
  unverified and must not be advertised as validated hardware.
- XFixes GetCursorImage reports the cursor image/serial, not the server's
  HideCursor suppression count. Ordinary transparent-cursor hiding is verified;
  universal server-side hidden-state detection is not claimed. The limitation
  must remain visible when deciding the Linux cursor capability.
- Signed Mac tests inherit Terminal's user-granted Screen Recording and
  Accessibility. Independent LaunchServices/installer TCC and other physical
  Retina/display arrangements remain packaging/device-matrix acceptance.
- A preceding stressed run hit a2.5s marker deadline with one native click absent
  at teardown and video drops/freezes. Teardown immediately followed the deadline,
  so this proves a timeout, not permanent reliable-message loss. Root cause is
  unconfirmed. The new trace correlates sequence receipt, native guard ACK and
  independent GUI clicks; failures retain an additional5s observation grace,
  without retry/resume or reclassifying them as passes. Preserve the incident for
  release stress/fault acceptance; do not claim it fixed merely from later passes.
- Formal LAN150ms/TURN/weak-network performance, distribution/licensing,
  deployment, product authorization and capability opening belong to later
  groups. G1 diagnostics deliberately retain `available:false`.
- On 2026-11-16 the opt-in Windows tests passed on an active Session 2 console:
  real display and window WGC frames with matching BGRA/DWM geometry,
  `AttachThreadInput` foreground activation, pointer hit validation, native click
  delivery, and input preparation for the captured display. A dimming system
  security/consent prompt keeps input fail-closed until the desktop is clear.
  Cross-session windows are filtered, and a private desktop returns
  `REMOTE_DESKTOP_DESKTOP_UNAVAILABLE` without injection or a product desktop
  switch. MSVC release, development Authenticode and the per-user MSI
  install/uninstall cycle are verified in `evidence/windows-local/`.

  An actual lock or RDP-disconnect transition was not triggered on the working
  host. The private-desktop test exercises the same fail-closed boundary; remote
  unlock of a locked/secure desktop is not implemented or claimed. Multi-session
  delivery and interactive strong-kill/key-release acceptance remain open.
  Development signing uses an explicitly exported self-signed certificate and
  records the untrusted-root chain rather than installing OS trust headlessly.
  Production signing requires a PFX or certificate thumbprint from a trusted
  code-signing chain. A machine-wide/upgrade MSI matrix and uninstall UI are not
  covered.

No public/persisted schema is changed by this component. Compatibility baseline
is v0.0.49; the new private IPC is a same-version internal boundary. New dimensions,
encoder choice and geometry revisions remain component runtime state, with no
second business-state authority or UI polling.

## Reproduce focused validation

Run from `remote-desktop-rs` using its Rust1.95 toolchain:

```sh
cargo test -p desktop-streaming --all-targets --all-features
cargo clippy -p desktop-streaming --all-targets --all-features -- -D warnings
cargo check --workspace --all-targets
node crates/desktop-streaming/tests/node-host.mjs target/debug/task-handoff-desktop-streaming
```

On an active Windows console session, additionally:

```powershell
cargo test -p desktop-streaming --lib -- --ignored --nocapture
cargo test -p desktop-streaming --test windows_native -- --ignored --nocapture
```

The opt-in tests consume the active display and a disposable top-level window,
capture both through WGC with matching BGRA/DWM geometry, focus and hit-validate
the retained window, deliver a native click, and prove a private desktop rejects
input as `REMOTE_DESKTOP_DESKTOP_UNAVAILABLE`. A locked or disconnected session
must fail closed; the product path never switches desktops.

The MSVC/MSI pipeline is `scripts/build-remote-desktop-windows.ps1`. It accepts
`-WixBin`, `-XwinRoot`, `-VcRuntimeDir` and exactly one signing source
(`-SignDevelopment`, `-PfxPath` or `-Thumbprint`), then writes `build.json`,
`authenticode.json`, staged artifacts and install/uninstall logs under the output
directory. `evidence/windows-local/README.md` records the exact local invocation
and results.

On the explicitly authorized isolated109Linux host, additionally:

```sh
cargo test -p desktop-streaming --test linux_surface -- --ignored --nocapture
CROS_LIBVA_H_PATH=/path/to/pinned/libva-2.22.0-sdk cargo test -p desktop-streaming --all-targets --features vaapi
CROS_LIBVA_H_PATH=/path/to/pinned/libva-2.22.0-sdk cargo clippy -p desktop-streaming --all-targets --features vaapi -- -D warnings
target/release/desktop-automatic-encoder-probe --expect-software
```

The browser runner requires an explicitly owned bcap session and creates only its
own display/cgroup/fixture/tab. Keep other browser actions and compilation out of
measurements. See the platform evidence READMEs for raw results and limitations.

## Final current-host regression

`evidence/linux-lan/reference-diagnostics/stage16-final-300s` records300.155s,
100measured clicks+1warmup, all202input sequences acknowledged and101native
fixture clicks. Output1920x1080 at30.0045fps, no added decode drops/freezes/PLI,
25NACK, process-tree CPU37.50%, peak summedRSS302.76MiB. P95=154.5ms/max155.1ms
still fails the G6LAN150ms threshold. The separate configured slowdown16 run
also delivers101/101clicks with no added drops/freezes/PLI. Neither pass resolves
the historical stressed timeout's unconfirmed cause.

Final checks pass: macOS60tests/allfeatures, Clippy-Dwarnings, workspace all-target
check, shared Node IPC contract, Linux feature-enabled suite/Clippy/release and
4actual native X11 tests. The native cursor diagnostic confirms server HideCursor
leaves GetCursorImage image/serial unchanged on this test server. All JSON evidence,
Python/JavaScript/shell syntax, Rust formatting and diff whitespace checks pass.
The earlier aborted sampler's empty raw file is retained as `resources.json.empty`
with explicit unavailable metadata, rather than presented as valid metrics.

On Windows on 2026-11-16, formatting, 32 library tests (1 ignored), all
integration tests, the ignored private-desktop test and 3 native WGC tests
passed. The MSVC x64 static-CRT release and per-user MSI
install/version/uninstall pipeline also succeeded; see `evidence/windows-local/`.

Owned diagnostic hosts, components, surfaces, browser9223 and old test SSH
forwards are cleaned. User browser9222 and product109PIDs609/647 are untouched.
