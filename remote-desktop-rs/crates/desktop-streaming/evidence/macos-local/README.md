# Local macOS component acceptance (2026-11-08)

Explicit user authorization permits native acceptance on this Mac; Windows
runtime acceptance is deferred. This does not enable product capability or
change any existing managed runtime/service. Environment: macOS27.2,arm64,
main display2560x1080. Retina/DPI on other display configurations is not proven.

The OS-responsible application is Terminal (responsibility API returned PID740
for the active agent). User enabled Terminal Screen Recording and Accessibility; a new component
reported both permissions true. The earlier screen permission request did not
display an actual dialog.

- `display-capture.json`: actual SCK capture from the main display, two10-frame
  availability phases separated by pause/resume. OpenH264 IDR1280x540 decodes in
  a fresh decoder from a2560x1080source. Samples can reuse the latest idle frame;
  this is not a count of distinct OS callbacks or a sustained performance gate.
- `window-capture.json`: retained fixture window selection -> one-use windowRef
  -> actual desktop-independent SCK capture640x392. Two10-frame phases and fresh
  H.264 decoding pass; replay is rejected. Later end-to-end window input and
  focus/hit protection evidence is recorded below.
- `input-permission-denied.json`: two real browser Attach attempts both receive
  REMOTE_DESKTOP_INPUT_PERMISSION_REQUIRED; no BUSY leak or silent empty video.
  The harness now forwards typed Attach errors instead of discarding them.

The first window-only probe crashed with CGS_REQUIRE_INIT in
SLSGetDisplaysWithRect -> SCContentFilter(desktopIndependentWindow:). The
maintained screencapturekit11.1.2 window example explicitly calls its initializer
(CGMainDisplayID). Platform preflight now initializes once through the public
CoreGraphics wrapper, so window capture no longer relies on a previous display
path to initialize the connection. Both native probes passed on that final fix.

`harness/macos-fixture.swift` is an independently compiled disposable AppKit
window. It emits counters, own geometry and a synthetic expected-text boolean;
never typed text or unrelated input. During this stage the user manually clicked
and moved the window. These local events are not remote-input evidence. A later independently launched fixture verified actual native input via the guard.
`native-input.json` records successful click, physical key, exact synthetic Unicode
commit (37 characters), independent watchdog release, parent SIGKILL release
(9.61ms) and guard process exit. The runner verifies the owned fixture remains
frontmost before each input. It quits its fixture and restores prior foreground
application on exit. No screen pixels or user desktop
images are saved in this directory.

`browser-native.json` proves actual browser H264/four channels and native owned
fixture click/physical key/Unicode/pause/IDR, without enabling system clipboard.
A pause-induced browser freeze counter is expected and is not steady-state
performance evidence. `browser-coordinate-baseline.json` preserves the failed
coordinate regression: requested fixture x500 arrived at stale x100. The macOS
mouse adapter now emits coordinate-bearing CGEvents through maintained bindings;
three alternating positions pass without a preceding pointer packet or delay.
`browser-click-failed.json` retains the earlier missing-click diagnostic.

`videotoolbox.json` exercises12synthetic hardware-required frames with independently
decodable forced IDRs. Native browser metrics now report `encoder:videotoolbox`,
so the browser proof includes actual hardware selection. Frame-budget drops,
queue resets and additional freeze counters remain in the raw metrics; this
short correctness test is not sustained performance acceptance.

`component-sigkill.json` holds a real key and mouse button through browser
DataChannels, force-kills the actual component, verifies both native releases
(13.61ms in this run), and checks its component/guard are no longer running.
`host-sigkill.json` runs the corresponding actual test-host death case.

Shared RGB conversion now uses maintained yuv0.8.20 with explicit BT.709
limited-range coefficients. OpenH264's built-in converter used601 while VUI
claimed709; a red-pixel Y63/U102/V240 regression detects this discrepancy. VT
consumes matching420vNV12 and declares709metadata. Unsupported VT profile/device
or encode errors fall back permanently to OpenH264 for that stream with fresh
SPS/PPS/IDR; a negotiated-level1.0 test exercises unsupported-profile fallback.

Later display/window probes assert each phase's OS sample timestamp is newer
than its resume boundary. One background-window attempt failed without persisted
stderr; a later background attempt and foreground attempt passed. No fixed
root-cause claim is made for that transient result.

## Complete native window and signed-host diagnostics

`window-lifecycle-minimize.json` and `window-lifecycle-close.json` verify actual
window-only capture, four channels, VideoToolbox, alternating exact clicks,
physical key, 37-character Unicode, wheel, pause/IDR, held-key release on move and
resize, stale revision rejection, explicit new epoch, focus theft and real
floating-window occlusion. Media continues when input loses focus; minimizing
or closing the selected window returns WINDOW_UNAVAILABLE, without display
fallback. `window-component-sigkill.json` records release in13.816ms.

`signed-window-cursor.json` repeats native correctness with disposable Developer
ID signed, hardened-runtime component/host copies. The designated requirement
uses Apple anchor+team+stable identifier rather than an ad-hoc cdhash. Cursor
hide/show changes70pixels in each direction in an owned40x40video crop; no image
arrays are saved. `signed-window-host-sigkill.json` verifies held key/button
release in12.380ms and child exit. All owned hosts, fixtures and tabs were removed.

`harness/sign-macos-fixture.sh` reproduces signing with an explicit existing
identity and a new disposable output directory. These runs inherit the user's
Terminal TCC grants; independent LaunchServices/installer TCC is not claimed.
Other physical display scale/topology combinations remain release-matrix work;
unit tests cover1/1.25/1.5/2scales and negative display origins.
