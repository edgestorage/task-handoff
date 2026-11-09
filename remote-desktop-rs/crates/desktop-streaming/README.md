# Independent desktop streaming component

The independent G1 component includes private IPC, component-owned sessions,
a window-reference registry, Linux X11 capture/input/clipboard, macOS SCK display
and window capture/input, hardware/software encoding and explicit native WebRTC
diagnostic harnesses with four actual DataChannels. The synthetic
backend renders test pixels and records input in memory; it never captures a
host desktop or injects OS input. All native platform probes deliberately report
`available: false`. Windows is deferred by the user; the acceptance boundaries
and remaining hardware/release validation are recorded below.

See [G1-ACCEPTANCE.md](G1-ACCEPTANCE.md) for the evidence matrix and exact limits.

No instance runtime depends on this crate. Node/Rust instance adapters, App
installation, CP/node-agent authorization and product UI belong to later groups.
The Node script here is a test host, not the G2 Node instance adapter.

## Run the control contract

From the repository root, with the checked-in Rust toolchain:

```sh
cargo test --manifest-path remote-desktop-rs/Cargo.toml -p desktop-streaming
cargo build --manifest-path remote-desktop-rs/Cargo.toml -p desktop-streaming --bins
remote-desktop-rs/target/debug/desktop-test-host
node remote-desktop-rs/crates/desktop-streaming/tests/node-host.mjs remote-desktop-rs/target/debug/task-handoff-desktop-streaming
```

Windows uses `.exe` binary names. The shared transport supports named pipes;
Windows ACL, actual native backend and strong-kill cleanup remain unverified.
The tests above exercise a spawned component over real local IPC on macOS.
They do not require a product process, display permissions or a managed instance.

## Run the synthetic browser harness

```sh
remote-desktop-rs/target/debug/desktop-test-host --browser
```

Open the printed temporary `http://127.0.0.1:<port>` URL and select Connect.
The bridge binds only loopback, enforces WebSocket Origin, holds test identities
and attach credentials, and forwards component-authoritative snapshots. Video
and input bypass IPC. The component is started explicitly with `--synthetic`.
Ctrl-C stops the owned test viewers and component. This is a disposable diagnostic
bridge, not a product endpoint or UI.

The browser can resume/release synthetic input, commit Unicode, pause/resume video,
request IDR and explicitly enable a memory-only text clipboard. Video bars prove
accepted input and Unicode commits; a synthetic cursor shares the video geometry.
Clipboard enable is acknowledged before another channel may write, and both ends
check the negotiated SCTP message size before enabling it.

`harness/acceptance.mjs` is a reusable bcap/Playwright script for this page. Copy it
into the bcap skill's `sites/127.0.0.1/` library and run it against an owned headless
test tab. It verifies decoded input pixels, pause/resume/IDR, fresh input epochs,
Unicode clipboard, BUSY and stop/reconnect. It stops its viewers and closes its
second test tab. No product services, native permissions or managed instances are
required.

## Private IPC contract (2026-11-07)

The host creates a private temporary directory (0700 on Unix), binds an endpoint
using `controlled_instance_core::local_ipc`, then starts its own component with
`--ipc <endpoint>`. Never discover or adopt an external component.

1. The host writes a framed `{protocolVersion, nonce}` to inherited stdin. The
   256-bit nonce is memory-only, not an argument, environment variable or file.
2. The component connects and sends that hello on IPC. The host authenticates it,
   replies with the same hello, then consumes the component's welcome. Handshake
   deadlines are 5 seconds. This is a private same-version boundary; a framing
   version mismatch fails this handshake without affecting instance connectivity.
3. Welcome carries the component `bootId` and private probe result. Every request
   and response carries `requestId` and `bootId`. A wrong boot cannot mutate state
   or shut down the current component.
4. Every frame is a 4-byte unsigned big-endian body length followed by UTF-8 JSON.
   Length must be 1–1,048,576 bytes, checked before allocation. Partial headers,
   truncated bodies and malformed JSON terminate the connection. Unknown object
   fields are ignored. Unknown command variants fail decoding.
5. Requests are reserve, attach, snapshot, owner stop, shutdown, offer and signaling
   liveness/closure. Answers stay within this private boundary. Events and
   correlated responses are distinct `kind: event|response` packets. Events carry
   the component's snapshot/revision, without credentials or owner identity.
   Snapshot responses are authoritative recovery boundaries; revisions are scoped
   to `(bootId, viewerSessionId)` and consumers must recover gaps using snapshot.
6. The service uses a bounded incoming queue and write deadlines. Deadline wakeups
   do not cancel partial frame reads. It never sends video or browser input over
   this management connection.
7. IPC EOF, inherited stdin EOF and normal shutdown all terminate the component.
   The lifetime pipe must remain exclusively host-owned and must not be passed to
   unrelated descendants. Stdin supervision uses a dedicated OS thread to avoid
   Tokio's blocking-stdin runtime shutdown deadlock.

`fixtures/contract.json` is consumed by both the Rust tests and the Node test host.
No private IPC models are exported from the public protocol crate.

## Session invariants

One registry owns the viewer slot, random attach token, owner actor/device,
monotonic revision, input epoch and every deadline. Viewer IDs reuse the existing
protocol entity ID mint. Attach binds the original target, owner and session and
consumes its token once. A malformed attach cannot consume a valid reservation.
BUSY returns no owner. Reserve request dedup lasts 30 seconds, retains consumed
requests across subsequent sessions and has a bounded memory budget.

State transitions are starting → negotiating → active → draining → stopped/failed.
Starting lasts 30 seconds, negotiating 20 seconds, draining at most 5 seconds;
signaling liveness is 6 seconds and healthy-signaling ICE recovery is 15 seconds.
Only a received hidden event starts the 30-minute idle deadline; repeat hidden
cannot extend it. The maximum session deadline is fixed at creation (+8 hours).
All enforcement uses monotonic time. Visible clears idle and requests IDR while
leaving input suspended. A new explicit resume creates a fresh epoch. Input
liveness expires at 1500 ms, irrespective of keyup arrival. State transitions
return required backend effects. An independent input guard now applies native release;
Linux native watchdog/EOF and process-tree evidence is described below.

Window catalogs retain at most 256 native handles inside the backend boundary.
References are random, owner/device-bound, registry/boot-bound, expire at 60 seconds
and are consumed once. Refresh invalidates the preceding generation. Each component
belongs to one instance, so there is no client-controlled instance identifier in
this private registry. The macOS backend retains and revalidates native identity through selection,
reserve, capture and input. Other platforms reject window requests.

## Browser message draft

`channel.rs` defines incoming messages, with per-channel sequences and
`{v,type,seq,payload}` envelopes. Sequence values stay within JavaScript's exact
integer range. Unknown fields are ignored; unknown message types return a bounded
error. A date mismatch is diagnostic and does not prevent schema validation.

| Channel | Negotiated ID | Ordering | Retransmits | Wire limit |
| --- | --- | --- | --- | --- |
| control | 0 | ordered | reliable | 16 KiB |
| input | 1 | ordered | reliable | 16 KiB |
| pointer | 2 | unordered | 0 | 16 KiB |
| clipboard | 3 | ordered | reliable | 64 KiB |

Both peers create channels with `negotiated: true` before the offer. rtc 0.21.1's
incoming DCEP path discards retransmit/lifetime metadata; explicit standard channel
negotiation preserves pointer reliability without weakening validation or patching
the dependency. IDs, labels and reliability are shared Node/Rust fixtures.
The component replies with `input.resumed`, `input.suspended`, `clipboard.enabled`,
`clipboard.written`, `clipboard.text` and bounded errors. Clipboard enable carries
its effective enabled flag; input resume carries the newly issued epoch.

Clipboard text is additionally limited to 32 KiB decoded UTF-8. Escaped JSON must
also fit its wire limit; this draft has no fragmentation or reassembly. The synthetic transport checks its negotiated SCTP maximum before enabling
clipboard. This replaces the proposal's unsafe 512 KiB envelope assumption; native
clipboard is opt-in through an isolated worker. Physical repeat is represented
but must be suppressed by the input driver so the remote OS owns key repeat.
Composition preedit is rejected; only a final Unicode text commit is accepted.

## Media behavior and remaining G1 gates

Rust 1.95 is pinned consistently across the workspace, CI and release scripts for
webrtc/rtc 0.21.1. OpenH264 0.9.9 builds from source with a C++ toolchain (Windows
cross-check additionally needs MinGW g++). Only this crate links the media stack;
existing instance runtime dependency graphs remain separate.

OpenH264 emits Annex-B baseline with BT.709 metadata and the negotiated send
level (local ceiling4.0). Default Chrome level3.1 remains capped at720p; a
receiver explicitly offering level4 can receive1080p. Every requested IDR
is tested with fresh decoder state, including SPS/PPS. Media uses the sender's
negotiated H.264 payload type, GCC/TWCC feedback, PLI/FIR observation and one encode
in flight. Pause stops pattern generation, encode and send; resume requests IDR
without opening input. Owned tasks are cancelled on peer close. Raw SDP, input and
clipboard content never enter diagnostics.

macOS VideoToolbox and Linux VA-API helper selection/fallback are implemented;
macOS native display/window correctness is verified. Actual Linux GPU encoding
is unverified on the permitted host because it has no render node. Windows
implementation/acceptance is deferred. Sustained network/latency and packaged
installer permissions remain release gates. The implemented Linux and transport work is detailed
below; passing diagnostic tests do not open product capabilities.

Keep all unverified native platform capabilities unavailable. Do not enter G2
based on a passing synthetic browser harness.

## Native diagnostic progress (G1, not product capability)

`desktop-test-host --browser-native` explicitly captures the current local display;
`--browser-virtual` owns a separate Linux desktop. Native input affects real desktop
applications. The bridge is loopback-only; native ICE media can cross the test LAN.
Do not run this mode against a desktop without authorization. No product entry
point depends on this crate, and native availability remains false until all gates.

Linux surface dependencies are Xvfb, Openbox, Tint2, jgmenu and X11 extensions
MIT-SHM, DAMAGE, XFIXES and XTEST. Linux kernel 5.3+ pidfds are required. The keeper
creates private 0700/0600 Xauthority, a .desktop Applications launcher and XDG menu;
no AppSession display/process is discovered or adopted. Viewer teardown retains
surface/applications. Component lifetime EOF ends the owned group; a dedicated
subreaper also reaps detached launcher descendants, signaling only pinned pidfds
whose parent is the owned keeper. Local host applications are never included.

The independent input guard owns native injection and its 1500 ms monotonic
heartbeat deadline. Suspend ACK follows release; EOF releases without component
work. Enigo implements XTest/CGEvent/SendInput and Chromium keycode mappings provide
physical keys. Unicode commits release physical pressed state first. Native text
calls and platform-specific permission/strong-kill behavior still need the full
platform matrix; Linux xterm UTF-8 and XTest watchdog/EOF tests pass.

Native clipboard is opt-in, bounded text only, with a separate arboard worker and
100 ms call timeout. It is never sampled in the background. Disable/teardown drops
the worker; a failed clipboard request does not authorize larger messages or images.
Independent Linux connections verified Chinese/Japanese/accent/emoji ownership.

The pacer now reuses rtc's maintained token bucket with whole-frame admission,
100 ms / 256 KiB hard bounds (also rate-derived), GOP reset, IDR/SPS/PPS recovery and
old-retransmission rejection. Feedback reduces bitrate, fps and even-dimension
resolution within the negotiated H.264 level and max-fs/max-mbps limits. One blocking capture/convert/encode worker, one latest native sample and bounded
driver buffers limit raw work (SCK requires three OS buffers; WGC uses two). Sparse frames advance RTP time by actual
monotonic gaps rather than compressing idle seconds into one nominal frame.

The browser harness serializes repeated offers and ICE restarts. Gather completion
uses a revision, and unchanged ICE credentials do not wait for a nonexistent new
gathering event. Active negotiation releases input. Transport Checking/Connected
notifications own the recovery deadline; an SDP answer alone is not recovery.

Linux real-host tests (explicit, isolated test machine only):

```sh
cargo test -p desktop-streaming --test linux_surface -- --ignored --nocapture
cargo test -p desktop-streaming subreaper_collects -- --nocapture
```

They cover real capture pixels/XDamage redraw, XTest/watchdog/EOF, xterm UTF-8,
independent clipboard ownership, surface crash/recreate, component SIGKILL tree
cleanup, and detached setsid launcher cleanup. `harness/{restart,native-controls,
native-menu,native-retention,xdg-menu}.mjs` are bcap/Playwright scripts for the
corresponding disposable browser harnesses. Pixel locations assume a 960px rendered
video and the documented 1280x720 test surface; keep runtime evidence with the run.

macOS uses maintained `screencapturekit`11.1.2 for BOTH display and window
capture. CrabGrab0.4's macOS display implementation uses CGDisplayStream, so it
cannot satisfy this boundary; CrabGrab remains Windows-only for WGC. SCK driver
queue depth is its documented minimum3; the application holds latest sample plus
one in flight, without a raw queue. macOS requires a13+SDK to build the12.3
Swift deployment target; this is a dependency build minimum, not a verified
product support promise. Actual local TCC, hardware encoding, input, window lifecycle and stable Developer
ID signing identity evidence is recorded below. LaunchServices/installer TCC
acceptance remains a packaging gate.

Windows checks its own active nonzero WTS session and input desktop before native
capture/injection, and requests per-monitorV2 DPI awareness. It never switches
or adopts a desktop/session. Native catalogs filter OS metadata on demand and
invalidate preceding references before enumeration. Windows catalogs are not wired into
the component service yet; same-process handle reuse, focus/hit and geometry
transitions still block window availability. All native capabilities remain off.

`harness/run-linux-reference.py` serializes3×100s/100input samples for each
static/scroll/drag synthetic workload on the explicitly permitted109host. Each
workload owns a fresh4CPU/4GiB cgroup and private1920×1080surface, retains raw
CPU/RSS/decode/latency evidence and shuts down its owned process tree. The
caller supplies an explicitly owned bcap session; no concurrent tab actions.
The default `reference` measurement includes automation click preparation. The
`photon` measurement separately records trusted pointerdown-to-decoded-marker
on the same browser clock, expected display time and API-call latency. Preserve
the chosen clock and raw failures in reports; never auto-resume lost input
authority between measurement chunks. The synthetic GUI logs only marker count,
value, elapsed time and expiry for input-delivery diagnostics.

The non-Windows implementation includes Linux VA-API/fallback and native macOS
window catalog/focus/hit/geometry handling. The permitted Linux host proves
software fallback only; actual VA-API hardware is not claimed. Windows MF,
Job Object/interactive desktop/cursor/DPI acceptance remains deferred. Formal LAN/TURN/weak-network
performance thresholds belong toG6. Local macOS hardware/browser/input/strong-kill
evidence is recorded below. Mac Local window targets use owner-bound catalog
selection retained through reserve/attach. Other modes/platforms reject window
requests, preventing a window request from falling through to display capture. Stable typed backend failures preserve permission/platform
codes and redact unknown library failures. No G2 integration is included.

Display capture and the independent native input guard derive a process-local
monitor identity from the initial actuator rectangle. They revalidate its origin
and dimensions before capture/injection, including each character of a text
commit. A moved/disconnected display fails closed even if captured pixel dimensions
are unchanged; held keys/buttons can still be released. Ambiguous mirrored display
rectangles are rejected. This is safe failure on topology change, not live geometry
recovery or window focus protection. Local macOS runtime evidence is recorded
below; Windows runtime acceptance is deferred. Cross-compilation alone does not
establish native Windows behavior.

## Preliminary runtime evidence

`evidence/linux-lan/README.md` records the environment, actual limits and raw
measurements for high-entropy load, feedback adaptation/recovery, native clipboard
and pause, small-SCTP clipboard rejection and native Unicode completion ACK. These
short720p probes are not the proposal's1080p30 performance gate. In particular,
the measured720p high-entropy workload decoded approximately9fps, and limited-network runs
recorded short freezes. Product availability remains false.

`harness/{measure-load,measure-native-menu,small-sctp,text-ack,xdg-retention}.mjs`
contain reusable diagnostic scripts. The text ACK fixture requires an explicitly
owned raw-stdin terminal and a byte-for-byte check of its captured input; a browser
ACK alone does not establish correct OS text.

`harness/{codec-limits,codec-renegotiation}.mjs` verify a separately owned
1920x1080X11 fixture, including level3.1→720p, level4→1080p and receiver
max-fs/max-mbps constraints. The bounded `harness/fullhd-surface.py` creates that
explicit test display; it never discovers/adopts a user or product display.
Codec format changes invalidate queued RTP and force fresh SPS/PPS/IDR.

## Windows process ownership (runtime acceptance pending)

The standalone Rust host owns an unnamed, non-inheritable kill-on-close Job for
its component. Child assignment happens before the IPC bootstrap. Each clipboard
worker also belongs to a Job owned by the component process, so killing the
component closes that handle and reclaims the worker. Assignment failure kills
and reaps the still-unbootstrapped child, then returns a typed ownership error.

The input guard uses explicit `CREATE_BREAKAWAY_FROM_JOB`; its host Job permits
breakaway, while inherited stdin EOF and the independent lease still own key
release and exit. An embedding Job that forbids breakaway makes input unavailable;
there is no retry inside a Job that could kill the guard before release. No Job
handle is inherited by children or serialized into IPC. Node/core host adoption
of this ownership contract remains G2/G3 work.

On an authorized Windows target, `cargo test -p desktop-streaming --test
windows_ownership` tests actual kernel cleanup and scope using children that
never receive bootstrap or touch a desktop. These tests have only been
cross-compiled here; interactive strong-kill/key-release acceptance remains open.

## Local macOS acceptance and hardware selection

Explicitly authorized local acceptance is recorded in
`evidence/macos-local/README.md`. Fresh-process diagnostics
`--check-native-permissions` report Screen Recording/Accessibility without
prompting or injecting events. Explicit request flags are diagnostic only.

Native macOS streams prefer maintained VideoToolbox0.21.2 with hardware required,
real-time baseline H264 and frame reordering disabled. The shared SIMD BGRA
conversion explicitly produces BT.709 limited-range I420; VT receives matching
NV12/video-range data and color metadata. AVCC conversion repeats SPS/PPS at
every IDR. Unsupported profile/device or runtime encode failure selects OpenH264
for the remaining stream and starts a fresh IDR. Diagnostic metrics report the
encoder actually used after encoding; platform alone cannot establish this.
Synthetic harnesses retain explicit software selection. Linux attempts the
optional sibling VA-API helper and permanently falls back to OpenH264 on failure.
Windows MF remains deferred and currently uses OpenH264.

`desktop-videotoolbox-probe` uses synthetic pixels to verify real hardware and
independent keyframe decoding. `run-macos-browser.py` runs an owned AppKit fixture
and verifies actual native clicks at alternating coordinates, wheel targeting,
physical keys, Unicode, pause and IDR resume. It records counters only, stops the
viewer and restores foreground focus. The caller owns the loopback host/browser
tab and must close those afterward. `run-macos-input.py` additionally verifies
independent watchdog release and key/button release after parent SIGKILL.

The macOS mouse adapter uses maintained CoreGraphics event wrappers with explicit
actuator coordinates: Enigo0.6.1 reads old OS pointer position immediately after
an asynchronous move, which the real fixture reproduced as requestedx500 /
receivedx100. No preceding pointer packet or delay is required by the corrected
button/wheel path. Enigo continues to own physical-key mapping and Unicode.

Native capability remains unavailable while remaining platform acceptance
and the remaining platform gates are incomplete. Windows runtime acceptance is
deferred by the user. Formal LAN150ms/TURN/weak-network gates belong toG6.

## macOS window lifecycle evidence

The private host supports owner-bound `listWindows` and window reserve/attach.
Each selection retains its SCK filter and AX window authority. No raw OS IDs
cross that boundary. Input resume requires the current sessionRevision and
only publishes an epoch after actual foreground/AX focus validation. Native
pointer/button/wheel hit tests exclude the OS-defined noninteractive cursor
layer, while real overlays still suspend and release input. Moves/resizes
release the old epoch before capture/input reconfiguration; transient AX/CG
coordinate disagreement is bounded without sending stale frames.

The loopback diagnostic viewer `/?target=window` returns its catalog on the same
owner-bound WebSocket. `harness/run-macos-browser.py --window` selects only its
owned AppKit fixture. `--window-negative minimize|close` verifies held-key
release, move/resize revision rejection, focus loss, actual floating overlay
hit rejection, continuing media and typed terminal failure. Saved evidence
contains catalog counts, no unrelated window titles or pixels.

## Optional Linux VA-API helper

Build the same crate with `--features vaapi --bins` to deliver the sibling
`desktop-vaapi-encoder`. It uses maintained cros-codecs0.0.6/cros-libva0.0.12,
baseline receiver level, low-delay prediction, NV12 and explicit BT709 limited
VUI. Its native objects never leave its process. One encode request/response
is in flight; timeout, native failure or missing helper permanently selects
OpenH264 for that stream with a fresh IDR. Reconfiguration never retries a
failed device. No executable is resolved from PATH.

The helper links libva.so.2 and libva-drm.so.2 (unused GBM linkage is stripped); the main component must have
no DT_NEEDED dependency on these libraries. Its build requires pkg-config,
libva-dev, libgbm-dev and libclang. cros-libva0.0.12 supports VA-API headers
through1.22;1.23 adds VP9 struct members not supported by that release. Use a
pinned1.22 SDK via `CROS_LIBVA_H_PATH` when the system headers are newer.
The verified SDK is libva2.22.0 tag commit
`217da1c28336d6a7e9c0c4cb8f1c303968a675f1`; it remains ABI-compatible with the
newer libva.so.2 runtime. No upstream crate source is patched.
Optional helper build failure must not prevent shipping/starting the software
component. On a device without a render node, verify actual fallback with
`desktop-automatic-encoder-probe --expect-software`; a GPU run omits that flag
and must report `vaapi` before hardware support is claimed.
