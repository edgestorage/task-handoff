# Preliminary Linux LAN measurements

These disposable diagnostic runs on 2026-11-07 are **not the G1 performance gate**.
Target: 192.168.139.109, aarch64 Linux; software OpenH264, private1280×720
Xvfb/Openbox/Tint2; owned headless Chromium on macOS over the LAN. The
component and browser exchanged H.264 constrained baseline level3.1/PT108.
No product services were deployed or restarted.

The640×360 random-noise X11 fixture ran at up to30fps for30s with nice10.
The benchmark queried browser video stats and explicitly requested component
metrics at1s intervals. This sampling is confined to the acceptance harness.

- `noise-load.json`:20s high-entropy observation, decoded frames621→794,
  no interval with unchanged decoded-frame count, max queue74891bytes,
  zero queue resets, PLI0. Chrome recorded one short freeze; NACK6→59.
  Actual decoded rate was about9fps, **not30fps**. Conservative whole-frame
  pressure control reduced geometry rather than indefinitely retrying an IDR
  too large for the pacer's100ms budget.
- `noise-recovery.json`: subsequent8s observation, restored1280×720,
  decoded frames985→1208, no queue reset, no added frame-budget drops.
- `limited-network.json`:35s observation includes approximately30s with
  Linux netem on **only UDP source port45609 of owned component PID90647**:
  egress1Mbps,40ms delay,1% configured random loss,30packet queue. Root prio
  directed unmatched traffic into its unaffected default band. Saturation
  added queue drops (648drops total), so effective loss exceeded1%.
  GCC target fell below1Mbps; actual geometry fell to approximately350–528px
  wide during saturation. Queue resets17, no unchanged-frame1s interval.
  Full720p returned by sample30, about2s after fixture/limiter removal.
  **Short browser freezes occurred.** No input-to-photon claim is made.
- `native-controls.json`: after limited-network recovery, native Unicode
  clipboard opt-in/write/read/opt-out and hidden pause/visible IDR passed.

The temporary tc root handle7a10: was removed by a bounded shell trap;
post-check showed eth0's original `noqueue`. Original Node Agent PID609 and
Control Plane PID647 remained running. No capture of user applications or
product desktop was used.

Reproduce with `harness/measure-load.mjs` on the explicit disposable native
harness and `desktop-x11-fixture` with its keeper-owned DISPLAY/XAUTHORITY.
Never discover or apply this fixture to a product/user display. Determine the
current owned UDP source port before applying a filter; never reuse this run's
port against another process. A future benchmark should isolate tc into a
network namespace to avoid replacing a host root qdisc.

Remaining performance gate: declared4vCPU/4GiB1080p30 reference environment,
5min each workload,100input samples, CPU/RSS,20connect/close cycles, exact
proposed network scenarios and percentile latency. These shorter720p probes
establish the timer-quantization fix and adaptation behavior only.

## Follow-up lifetime and input checks

- `small-sctp.json`: peer advertised1024-byte SCTP maximum. The test bypassed
  its UI clipboard gate, observed the component's explicit enabled=false ACK,
  then proved video decoding and fresh input epoch still work. No clipboard
  worker should start before the negotiated transport gate.
- `native-text-ack.json`: owned raw-stdin xterm received exactly58UTF-8 bytes
  (mixed Chinese/Japanese/accent/emoji/ASCII plus one CR). An Enter synchronously
  dispatched before text.committed was suppressed; Enter after ACK was accepted.
- `viewer-cycles.json`:20native connect/close cycles, observed first3decoded
  frames P95=657ms (includes browser/ICE setup), stop64–66ms.
- `viewer-cycles-resources-run.json`: second20cycle run, P95=699ms, stop62–67ms.
  `viewer-cycles-resource-samples.json` samples only component PID99972 at1s
  for45s including this run: RSS68552–103204KiB, final74740KiB,16threads
  at both endpoints. RSS repeatedly decreased between cycles; no monotonic
  growth in this short run. Capture/encode CPU is not comparable to the
  proposal's5min1080p workload, and this excludes keeper/Xvfb/WM/process-tree
  resource totals. No complete CPU/RSS gate claim is made.
- `synthetic.json`: local macOS synthetic browser regression, not Linux native
  capture. Verifies pixels, input/text, four channels, IDR, pause, clipboard,
  BUSY and reconnect. Kept here as a regression accompanying the Linux tests.

An earlier cycle attempt exposed a diagnostic page lifetime race: cleanup awaited
an old socket then dereferenced mutable global ws/pc, allowing it to close a new
connection. The page now detaches captured ownership before await and discards
obsolete connection callbacks/negotiations using a local generation. The two
passing20cycle runs use that fix.

## Negotiated1080p correctness (not a sustained performance result)

`codec-limits.json` uses a separate1920x1080Xvfb :88 and Openbox, with a
private Xauthority and180s bounded teardown (`harness/fullhd-surface.py`).
The browser explicitly advertises receiver H.264 level via its diagnostic SDP:

- level3.1 (`42e01f`) → decoded1280x720
- level4 (`42e028`) → decoded1920x1080
- level4 plus max-fs1200/max-mbps12000 → decoded728x408 (1196MB/frame)

`codec-renegotiation.json` changes those constraints on one live viewer:
1080p→720p→1080p→728x408, with the same session, increasing decoded keyframe
counts, input suspended for each negotiation, and no browser freeze/drop in this
short run. `ice-restart.json` separately verifies3ordinary offers and2ICE
restarts retain a viewer and invalidate old input epochs.

The negotiated format/limits are derived only in media memory from the maintained
stack's negotiated sender parameters; no new public or persisted capability is
introduced. RFC6184receiver limits are applied before conversion/encode, and a
format change discards pending encoded/RTP work before a fresh IDR. Large valid
receiver allowances are clamped to local support, unknown optional parameters
are ignored. The original720p stress evidence above remains720p; it is not
retroactively reclassified as1080p30.

## 1080p static reference with native marker authority (2026-11-08)

`reference-diagnostics/marker-authority-static` retains a serialized300.174s
release run,100measured pointerdown samples plus one warmup. The synthetic GUI
log confirms all101native clicks and marker transitions. Output1920x1080 at
30.006fps; zero added decode drops/freezes/PLI;4CPU/4GiB owned process tree
CPU37.38%,peak summedRSS244.04MiB. Trusted pointerdown-to-decoded-marker
P95=168.3ms/max169.7ms. It fails the formal150ms latency threshold (G6);
these basic measurements do not enable native capability or complete G1.

`quality-headroom-failed` preserves the preceding intermittent marker deadline
at~250s, with live video/epoch and15decode drops. This final run did not reproduce
that failure; it does not establish a root cause or a fix. The three
`baseline-photon-*` directories preserve the earlier pre-quality-fix300s
static/scroll/drag measurements. No result is silently discarded or relabeled.

## Non-Windows continuation: VA-API boundary, capture race, native cursor

`vaapi-fallback.json` verifies the actual sibling VA-API helper on the permitted
host without `/dev/dri`: one failed hardware initialization, permanent OpenH264
selection across reconfiguration,12encoded frames and independently decoded
IDRs0/5/10. The feature-enabled helper compiles against pinned official libva2.22.0
headers; the system runtime is libva.so.2. `readelf` verifies the main component
has no libva/GBM dynamic dependency. No actual GPU encoding is claimed.

`native-stage16.log` records four actual isolated X11 tests: capture/Unicode/
clipboard/watchdog/EOF, surface crash and component SIGKILL cleanup, XDamage
ordering, and cursor shape/hotspot/motion/transparent-hide pixel checks. The
cursor test uses a private window and server-defined cursor/mask, never a user
desktop. XFixes HideCursor server suppression cannot be queried by GetCursorImage;
these results specifically prove transparent cursors used by ordinary X11 apps.

The XDamage reproduction proves that NonEmpty damage must be subtracted before
image readback. A redraw between read and subtraction otherwise leaves stale
cached pixels without another notification. The actual capture now acknowledges
before SHM read; it does not infer refresh from polling or broaden frame queues.

`reference-diagnostics/stage16-traced-static` retains90.181s/100measured inputs,
plus warmup. All202button-message sequences0..201 reach the actor and receive
native guard ACK; the independent GUI sees101clicks. Output1080p30, zero added
decode drops/freezes/PLI. P95=153.1ms/max153.9ms, so this is not a passing G6
latency result. Guard ACK counts and GUI counts are distinct observations; native
guard State.interactions is a synthetic-backend counter and is not used as proof.

`reference-diagnostics/stage15-clean-static` preserves the preceding clean pass
(P95=168.7ms), and `stage15-marker-timeout` preserves the preceding failure with
one missing native click and video loss during concurrent compilation. A later
pass cannot establish that failure's root cause. The XDamage fix is independently
proven; no claim ties it to the missing-click incident. Keep this incident open
for release stress/failure acceptance and do not enable product capability.

The diagnostic runner accepts `--receiver-slowdown 1|4|8|16` for an explicitly
throttled owned browser page, records the configured slowdown, and retains a
failed sample before a5s observation grace. Grace sends no replacement click and
never turns a deadline failure into a pass. Normal acceptance uses slowdown1.
`G1_DESKTOP_INPUT_TRACE=1` enables at most1024numeric input sequence receipts and
native guard confirmations per component process; no key/text/coordinates log.

`reference-diagnostics/stage16-final-300s` is the final normal-speed serialized
300.155s run:100measured+1warmup clicks, all202wire sequences/native guard ACKs,
101independent GUI clicks,1080p30.0045, no added drops/freezes/PLI,25NACK.
CPU37.50%,peak summedRSS302.76MiB; P95=154.5ms/max155.1ms still misses the G6
150ms gate. `stage16-receiver-slow16` separately records configured receiver CPU
slowdown16, also101/101clicks and no added drops/freezes/PLI. These passes do not
prove the preceding stressed timeout's root cause or establish a G6pass.
The final native log confirms HideCursor leaves image/serial unchanged on this
server, directly demonstrating the visibility limitation noted above.
