# G1 non-Windows component acceptance

Date:2026-11-08. Worktree:`feat/remote-desktop-g1`. This is an independent
component and test-host delivery; it does not integrate with instance cores,
Control Plane, node-agent, App installation or product UI. Windows work is
explicitly deferred by the user. No Git commit or product deployment is made.

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
- All Windows implementation, compilation and runtime acceptance are excluded
  from this continuation; no cross-platform completion claim is made.

No public/persisted schema is changed by this component. Compatibility baseline
is v0.0.49; the new private IPC is a same-version internal boundary. New dimensions,
encoder choice and geometry revisions remain component runtime state, with no
second business-state authority or UI polling.

## Reproduce focused validation

Run from `controlled-instance-rs` using its Rust1.95 toolchain:

```sh
cargo test -p desktop-streaming --all-targets --all-features
cargo clippy -p desktop-streaming --all-targets --all-features -- -D warnings
cargo check --workspace --all-targets
node crates/desktop-streaming/tests/node-host.mjs target/debug/task-handoff-desktop-streaming
```

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

Owned diagnostic hosts, components, surfaces, browser9223 and old test SSH
forwards are cleaned. User browser9222 and product109PIDs609/647 are untouched.
