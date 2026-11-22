const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const viewer = fs.readFileSync('packages/control-plane-ui/src/apps/control-plane/instance-detail/InstanceRemoteDesktopViewer.vue', 'utf8');
const detail = fs.readFileSync('packages/control-plane-ui/src/apps/control-plane/instance-detail/InstanceDetail.vue', 'utf8');
const pane = fs.readFileSync('packages/control-plane-ui/src/apps/control-plane/instance-detail/SessionPaneContent.vue', 'utf8');
const preview = fs.readFileSync('packages/control-plane-ui/src/apps/control-plane/instance-detail/SessionPreview.vue', 'utf8');
const surfaceLayer = fs.readFileSync('packages/control-plane-ui/src/apps/control-plane/instance-detail/RemoteDesktopSurfaceLayer.vue', 'utf8');
const activeSessions = fs.readFileSync('packages/control-plane-ui/src/apps/control-plane/instance-detail/useActiveInstanceSessions.ts', 'utf8');
const api = fs.readFileSync('packages/control-plane-ui/src/api/remoteDesktop.ts', 'utf8');
const settings = fs.readFileSync('packages/control-plane-ui/src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue', 'utf8');
const access = fs.readFileSync('packages/control-plane/src/control-plane/remote-desktop/access.ts', 'utf8');

test('remote desktop opens from the app tab launcher instead of an instance-detail card', () => {
  assert.doesNotMatch(detail, /<InstanceRemoteDesktopViewer/);
  assert.match(detail, /:can-interact-remote-desktop="canInteractRemoteDesktop === true"/);
  assert.match(preview, /<AppLaunchMenuItems :apps="launchableApps"/);
  assert.match(activeSessions, /REMOTE_DESKTOP_APP_ID/);
  assert.match(activeSessions, /remoteDesktopAvailable\(activeInstance\.value\)/);
  assert.match(activeSessions, /id: REMOTE_DESKTOP_APP_ID/);
  assert.match(activeSessions, /function openRemoteDesktopTab/);
  assert.match(activeSessions, /const key = `\$\{REMOTE_DESKTOP_APP_ID\}:\$\{instanceId\}[^`]*`/);
  assert.match(activeSessions, /if \(!tabs\.some\(\(tab\) => tab\.key === key\)\)/);
  assert.match(activeSessions, /kind: "remote-desktop"/);
  assert.match(activeSessions, /remoteDesktopSessionTabs\[instance\.id\] = .*filter\(\(tab\) => tab\.key !== session\.key\)/);
  assert.match(pane, /session\?\.kind === 'remote-desktop'/);
  assert.match(pane, /data-remote-desktop-surface/);
  assert.doesNotMatch(pane, /<InstanceRemoteDesktopViewer/);
  assert.match(surfaceLayer, /<InstanceRemoteDesktopViewer/);
  assert.match(surfaceLayer, /:active="isActiveTab\(instanceId, tab\.key\)"/);
  assert.match(surfaceLayer, /embedded/);
  assert.match(viewer, /embedded\?: boolean/);
  assert.match(viewer, /\.remote-desktop-viewer\.embedded\s*\{[^}]*height: 100%/s);
});

test('remote desktop keeps its session mounted across tabs and instances', () => {
  assert.match(activeSessions, /REMOTE_DESKTOP_TABS_STORAGE_KEY/);
  assert.match(activeSessions, /loadRemoteDesktopSessionTabs\(t\)/);
  assert.match(activeSessions, /persistRemoteDesktopSessionTabs\(tabs\)/);
  assert.match(activeSessions, /remoteDesktopSessionTabs/);
  assert.match(surfaceLayer, /data-remote-desktop-surface/);
  assert.match(surfaceLayer, /visibility: visible \? "visible" : "hidden"/);
  assert.match(viewer, /active\?: boolean/);
  assert.match(viewer, /function surfacePaused\(\)/);
  assert.match(viewer, /props\.active === false/);
  assert.match(viewer, /watch\(\(\) => props\.active, \(\) => \{[\s\S]*?syncVisibility\(\);\s*\}\)/);
  assert.match(viewer, /function sendVisibility\(\)/);
  assert.match(viewer, /wire\(control, "visibility", \{ hidden \}\)/);
});

test('remote desktop viewer preferences survive local reloads', () => {
  assert.match(viewer, /VIEWER_PREFERENCES_PREFIX/);
  assert.match(viewer, /localStorage\?\.getItem/);
  assert.match(viewer, /localStorage\?\.setItem/);
  assert.match(viewer, /target: target\.value/);
  assert.match(viewer, /transportResolution: transportResolution\.value/);
  assert.match(viewer, /transportFrameRate: transportFrameRate\.value/);
  assert.match(viewer, /transportCapturePrecision: transportCapturePrecision\.value/);
  assert.match(viewer, /transportAvailability: transportAvailability\.value/);
  assert.match(viewer, /windowResizeFitActive: windowResizeFitActive\.value/);
  assert.match(viewer, /const windowResizeFitActive = value\?\.windowResizeFitActive === true/);
});

test('remote desktop web wheel events are frame-batched and preserve the remainder', () => {
  assert.match(viewer, /RemoteDesktopWheelPump/);
  assert.match(viewer, /wheelPump\.add\(event\.deltaX, event\.deltaY\)/);
  assert.match(viewer, /wheelFrame = requestAnimationFrame\(flushWheelFrame\)/);
  assert.match(viewer, /const delta = wheelPump\.take\(\);[\s\S]*?send\("wheel"/);
  assert.match(viewer, /function stopWheelPump\(\)[\s\S]*?wheelPump\.clear\(\)/);
  assert.doesNotMatch(viewer, /send\("wheel", \{ \.\.\.normalizedPointer\(event as unknown as PointerEvent\), deltaX: event\.deltaX, deltaY: event\.deltaY/);
});

test('remote desktop source directory loads when capabilities arrive after mount', () => {
  assert.match(viewer, /function syncSourceProviders\(\)/);
  assert.match(viewer, /watch\(\(\) => hasSourceProvider\.value, available => \{[\s\S]*?if \(available\) syncSourceProviders\(\);[\s\S]*?\}, \{ immediate: true \}\);/);
  const mounted = viewer.slice(viewer.indexOf('onMounted(() => {'), viewer.indexOf('onBeforeUnmount(() => {'));
  assert.doesNotMatch(mounted, /loadSources\(\)/);
});

test('a closed window returns to source selection with a neutral prompt', () => {
  assert.match(viewer, /isRemoteDesktopSourceEndedError\(next\.reason\)/);
  assert.match(viewer, /sourceEndedNotice\.value = translateApiError/);
  assert.match(viewer, /if \(sourceEnded\) void loadSources\(\)/);
  assert.match(viewer, /remote-desktop-source-ended/);
});

test('websocket fallback uses the same resolution and bitrate budget as WebRTC', () => {
  const routes = fs.readFileSync('packages/control-plane/src/control-plane/http/remote-desktop-routes.ts', 'utf8');
  const protocolCapability = fs.readFileSync('controlled-instance-rs/crates/protocol/src/remote_desktop.rs', 'utf8');
  const streaming = fs.readFileSync('remote-desktop-rs/crates/desktop-streaming/src/service.rs', 'utf8');
  assert.match(routes, /capability\.video\.maxWidth/);
  assert.match(routes, /Math\.min\(capability\.fallback\.maxWidth, videoMaxWidth\)/);
  assert.match(routes, /maxBitrate: capability\.fallback\.maxBitrate/);
  assert.doesNotMatch(routes, /maxBitrate: Math\.min\([^\n]*4_000_000/);
  assert.doesNotMatch(routes, /Math\.min\(capability\.fallback\.maxWidth \|\| 1280, 1280\)/);
  assert.match(protocolCapability, /max_width: 1920,\s*\n\s*max_height: 1080/);
  assert.match(protocolCapability, /max_frame_rate: 60/);
  assert.match(streaming, /crate::video::fallback_limits/);
  assert.match(streaming, /crate::video::FALLBACK_DEFAULT_FRAME_RATE/);
  assert.match(streaming, /crate::video::FALLBACK_MAX_WIDTH/);
  assert.match(streaming, /crate::video::FALLBACK_MAX_FRAME_RATE/);
  assert.match(viewer, /avc1\.42E02A/);
  assert.match(viewer, /hvc1\.1\.6\.L123\.90/);
});

test('remote desktop UI does not reuse AppSession/VNC frame URLs', () => {
  assert.doesNotMatch(viewer, /sessionFrameUrl|AppSessionViewer|iframe/);
  assert.match(viewer, /RTCPeerConnection/);
  assert.ok(viewer.includes("addTransceiver(\"video\", { direction: \"recvonly\" })"));
  assert.match(viewer, /input\.resume/);
  assert.match(viewer, /input\.suspend/);
  assert.doesNotMatch(viewer, /input\.releaseAll/);
  assert.match(viewer, /input\.alive/);
  assert.match(viewer, /signalAlive/);
  assert.match(viewer, /iceRestarted/);
  assert.match(viewer, /onicecandidate/);
  assert.match(viewer, /keyboard\?\.lock/);
  assert.match(viewer, /clipboard\.enable/);
  assert.match(viewer, /loadedmetadata/);
  assert.match(viewer, /videoWidth/);
  assert.match(viewer, /REMOTE_DESKTOP_MAX_MESSAGE_BYTES/);
  assert.match(api, /remote-desktop-sessions/);
});


test('remote desktop negotiation errors preserve the session for fallback', () => {
  assert.match(access, /message\.type === "error"[\s\S]*REMOTE_DESKTOP_OPERATION_FAILED/);
  assert.match(access, /send\(\{ type: "error", code \}\)/);
  assert.match(viewer, /fallbackState\.value === "idle"[\s\S]*beginFallback\("recovery-timeout", code\)/);
  assert.match(viewer, /fallbackState\.value === "active"\) return t\("instances\.remoteDesktop\.connected"\)/);
});

test('remote desktop starts fallback early and upgrades to WebRTC without replacing the session', () => {
  assert.match(viewer, /const FALLBACK_HEAD_START_MS = 500/);
  assert.match(viewer, /function armFallbackHeadStart\(\)/);
  assert.match(viewer, /REMOTE_DESKTOP_ICE_HEAD_START/);
  assert.match(viewer, /function startWebRTCUpgradeWatch\(/);
  assert.match(viewer, /inbound-rtp/);
  assert.match(viewer, /framesDecoded/);
  assert.match(viewer, /transport\.upgrade/);
  assert.match(viewer, /transport\.upgraded/);
  const ready = viewer.slice(viewer.indexOf('function markFallbackReady'), viewer.indexOf('function scheduleFallbackRetry'));
  assert.doesNotMatch(ready, /pc\?\.close\(\)/);
  assert.match(viewer, /function commitTransportUpgrade\(\)/);
  assert.match(viewer, /releaseInputState\(\);\s*\n\s*resetFallbackStateAfterTransport\(\)/);
});

test('remote desktop header keeps active and used paths while failures stay in the tooltip', () => {
  const transportTooltip = viewer.slice(
    viewer.indexOf('<Tooltip v-for="transport in visibleTransportIndicators"'),
    viewer.indexOf('<Tooltip v-if="session">'),
  );
  assert.match(viewer, /remote-desktop-transport-status/);
  assert.match(viewer, /v-if="visibleTransportIndicators\.length"/);
  assert.match(viewer, /v-for="transport in visibleTransportIndicators"/);
  assert.match(viewer, /remote-desktop-transport-indicator/);
  assert.match(viewer, /usedTransportKeys/);
  assert.match(viewer, /indicator\.state !== "failed"/);
  assert.match(viewer, /failedTransportIndicators/);
  assert.match(viewer, /remote-desktop-transport-tooltip-failure/);
  assert.match(viewer, /remote-desktop-transport-tooltip-body/);
  assert.match(viewer, /remote-desktop-transport-tooltip-heading/);
  assert.doesNotMatch(viewer, /<\/TooltipProvider>[\s\S]*?<span v-if="sessionDeadline"/);
  assert.match(transportTooltip, /remote-desktop-transport-tooltip-session[\s\S]*Clock3[\s\S]*sessionDeadline/);
  assert.match(viewer, /TooltipContent[\s\S]*transport\.detail/);
  assert.match(viewer, /parseRemoteDesktopWebRTCStats\(stats, webRTCReceiveSample\)/);
  assert.match(viewer, /parseRemoteDesktopWebRTCReceiveSample\(stats\)/);
  assert.match(viewer, /transportBandwidth/);
  assert.match(viewer, /transportEncoding/);
  assert.match(viewer, /remote-desktop-transport-tooltip-details/);
  assert.doesNotMatch(viewer, /session && !fallbackActive && webRTC(?:Latency|Bandwidth)Detail/);
  assert.doesNotMatch(viewer, /selectedCandidatePairId/);
  assert.match(viewer, /transportCandidateHost/);
  assert.doesNotMatch(viewer, /remote-desktop-transport-mode/);
});

test('remote desktop keeps the transport icon visible in the narrow header', () => {
  const narrowHeader = viewer.slice(
    viewer.indexOf('@container (max-width: 760px)'),
    viewer.indexOf('@container (max-width: 520px)'),
  );
  assert.doesNotMatch(narrowHeader, /\.remote-desktop-live-meta\s*\{[^}]*display:\s*none/);
  assert.match(narrowHeader, /\.remote-desktop-live-meta > span,[\s\S]*?\.remote-desktop-viewer-count\s*\{[\s\S]*?display:\s*none/);
  assert.doesNotMatch(narrowHeader, /\.remote-desktop-transport-status\s*\{[^}]*display:\s*none/);
});

test('remote desktop connection methods can disable any two paths but never the last one', () => {
  assert.match(viewer, /type ConnectionMethodKey = "p2p" \| "websocket" \| "turn"/);
  assert.match(viewer, /const CONNECTION_METHOD_KEYS: ConnectionMethodKey\[\] = \["p2p", "websocket", "turn"\]/);
  assert.match(viewer, /DropdownMenuCheckboxItem/);
  assert.match(viewer, /v-for="method in connectionMethodOptions"/);
  assert.match(viewer, /setConnectionMethodEnabled\(method\.key, Boolean\(\$event\)\)/);
  assert.match(viewer, /if \(!enabled && enabledTransportCount\.value <= 1\) return/);
  assert.match(viewer, /connectionMethodsAtLeastOne/);
  assert.match(viewer, /transportPolicyDirty/);
  assert.match(viewer, /applyConnectionMethods/);
  assert.match(viewer, /activeTransportAvailability\.value = \{ \.\.\.effectiveTransportAvailability\.value \}/);
});

test('remote desktop connection methods remain configurable before a session starts', () => {
  const setup = viewer.slice(viewer.indexOf('remote-desktop-stage-setup'), viewer.indexOf('<div v-else ref="stage"'));
  assert.match(setup, /remote-desktop-setup-methods/);
  assert.match(setup, /v-for="method in connectionMethodOptions"/);
  assert.match(setup, /setConnectionMethodEnabled\(method\.key, Boolean\(\$event\)\)/);
  assert.match(setup, /connectionMethodsHint/);
});

test('remote desktop applies connection methods to ICE, peer setup, and WebSocket fallback', () => {
  assert.match(viewer, /new RTCPeerConnection\(iceConfiguration\(\)\)/);
  assert.doesNotMatch(viewer, /new RTCPeerConnection\(\)/);
  assert.match(viewer, /const relay = \/\^turns\?:\/i\.test\(url\)/);
  assert.match(viewer, /iceTransportPolicy: activeTransportAvailability\.value\.p2p \? "all" : "relay"/);
  assert.match(viewer, /await pc\.setConfiguration\(iceConfiguration\(value\.iceServers\)\)/);
  assert.doesNotMatch(viewer, /setConfiguration\(\{ iceServers: value\.iceServers \}\)/);
  assert.match(viewer, /if \(!pc && fallbackState\.value === "idle" && webRTCTransportEnabled\.value\) await setupPeer\(\)/);
  assert.match(viewer, /REMOTE_DESKTOP_ALL_WEBRTC_TRANSPORTS_DISABLED/);
  assert.match(viewer, /if \(!websocketTransportEnabled\.value\) return "REMOTE_DESKTOP_FALLBACK_DISABLED"/);
  assert.match(viewer, /fallbackState\.value !== "idle" \|\| !websocketTransportEnabled\.value/);
});

test('remote desktop identifiers work outside secure browser contexts', () => {
  assert.match(api, /createBrowserUuid/);
  assert.match(viewer, /createBrowserUuid/);
  assert.doesNotMatch(api, /crypto\.randomUUID/);
  assert.doesNotMatch(viewer, /crypto\.randomUUID/);
});

test('remote desktop blocks insecure contexts before reserving a session', () => {
  assert.match(viewer, /window\.isSecureContext/);
  assert.match(viewer, /isRemoteDesktopLocalNetworkAddress\(window\.location\.hostname\)/);
  assert.match(viewer, /signalTransportReady/);
  assert.match(viewer, /if \(!signalTransportReady\)/);
  assert.match(viewer, /secureTransportHint/);
  assert.match(viewer, /disabled="connecting \|\| !canConnect \|\| !signalTransportReady"/);
  assert.match(viewer, /if \(current\) void stopRemoteDesktopSession\(props\.instanceId, current\.snapshot\.viewerSessionId\)/);
});

test('remote desktop target selection is explicit and provider driven', () => {
  assert.match(viewer, /sourceProviders/);
  assert.match(viewer, /sourceRef/);
  assert.match(viewer, /sourceProviderOptions/);
  assert.match(viewer, /!item\.capturable/);
  assert.match(viewer, /target\.kind === provider\.kind/);
  assert.match(viewer, /sourceQuery/);
  assert.match(viewer, /remote-desktop-source-list/);
  assert.match(viewer, /role="option"/);
  assert.doesNotMatch(viewer, /windowRef|selectWindow/);
  assert.doesNotMatch(viewer, /sessionFrameUrl|vnc|AppSession/);
});

test('remote desktop exposes one viewer per client link without channel controls', () => {
  assert.doesNotMatch(surfaceLayer, /RemoteDesktopWorkspace/);
  assert.doesNotMatch(surfaceLayer, /v-for="channel/);
  assert.doesNotMatch(viewer, /name="toolbar-start"/);
  assert.doesNotMatch(viewer, /channelId|channelRemovable|removeChannel/);
  assert.doesNotMatch(viewer, /remoteDesktop\.channel|remoteDesktop\.addChannel|remoteDesktop\.removeChannel/);
  assert.match(viewer, /function viewerPreferencesKey\(instanceId: string\)/);
  assert.match(viewer, /viewerPreferencesKey\(instanceId\)/);
});

test('remote desktop viewer separates setup, connection and live-session states', () => {
  assert.match(viewer, /remote-desktop-setup/);
  assert.match(viewer, /remote-desktop-connect-panel/);
  assert.match(viewer, /remote-desktop-stage/);
  assert.match(viewer, /remote-desktop-surface/);
  assert.match(viewer, /remote-desktop-head is-live/);
  assert.match(viewer, /remote-desktop-stage-setup/);
  assert.match(viewer, /remote-desktop-live-toolbar/);
  assert.match(viewer, /if \(!session\.value\) \{\n\s+target\.value = next;/);
  assert.equal((viewer.match(/<header\b/g) ?? []).length, 1);
  assert.doesNotMatch(viewer, /remote-desktop-stage-bar/);
  assert.doesNotMatch(viewer, /remote-desktop-controls/);
  assert.match(viewer, /role="radiogroup"/);
  assert.match(viewer, /aria-checked/);
  assert.match(viewer, /ScrollArea/);
  assert.match(viewer, /AlertDialog/);
});

test('remote desktop live actions collapse into one menu with resolution and frame-rate caps', () => {
  assert.match(viewer, /DropdownMenuTrigger/);
  assert.match(viewer, /remote-desktop-actions-menu/);
  assert.match(viewer, /DropdownMenuRadioGroup/);
  assert.match(viewer, /transportResolutionOptions/);
  assert.match(viewer, /transportFrameRateOptions/);
  assert.match(viewer, /transportCapturePrecisionOptions/);
  assert.match(viewer, /remote-desktop-frame-rate-menu/);
  assert.match(viewer, /DropdownMenuSubTrigger :disabled="!signalingReady \|\| fallbackSwitching">[\s\S]*?transportFrameRate/);
  assert.match(viewer, /const TRANSPORT_FRAME_RATE_PRESETS = \[60, 30, 24, 15\] as const/);
  assert.match(viewer, /maxFrameRate: frameRate/);
  assert.match(viewer, /capturePrecision: transportCapturePrecision\.value/);
  assert.match(viewer, /stream\.resolution/);
  assert.match(viewer, /function setTransportResolution\(value: string\)/);
  assert.match(viewer, /function setTransportFrameRate\(value: string\)/);
  assert.match(viewer, /function setTransportCapturePrecision\(value: string\)/);
  assert.match(viewer, /function applyTransportResolution\(showError = false\)/);
  assert.match(viewer, /transportResolutionRequested/);
  assert.match(viewer, /@resize="updateResolution"/);
  assert.match(viewer, /remote-desktop-menu-danger[\s\S]*instances\.remoteDesktop\.stop/);
  assert.doesNotMatch(viewer, /remote-desktop-action-divider/);
  assert.doesNotMatch(viewer, /remote-desktop-clipboard-popover/);
});

test('remote desktop quality presets expose 4K and 2K without retired resolutions', () => {
  assert.match(viewer, /type TransportResolutionValue = "auto" \| "4k" \| "2k" \| "1080p" \| "540p"/);
  assert.match(viewer, /const TRANSPORT_RESOLUTION_PRESETS = \[[\s\S]*?value: "4k" as const, width: 3840, height: 2160[\s\S]*?value: "2k" as const, width: 2560, height: 1440[\s\S]*?value: "1080p" as const/);
  assert.doesNotMatch(viewer, /value: "(?:720p|360p)" as const/);
  assert.match(viewer, /label: option\.value\.toUpperCase\(\)/);
});

test('remote desktop teleported menus and tooltips keep a bounded width and wrap long copy', () => {
  assert.match(viewer, /:global\(\.remote-desktop-actions-menu\)/);
  assert.match(viewer, /:global\(\.remote-desktop-actions-menu\),[\s\S]*?width: min\(288px,/);
  assert.match(viewer, /:global\(\.remote-desktop-actions-hint\)[\s\S]*?white-space: normal;/);
  assert.match(viewer, /:global\(\.remote-desktop-connection-option small\)[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(viewer, /:global\(\.remote-desktop-transport-tooltip\)[\s\S]*?max-width: min\(280px, calc\(100vw - 24px\)\);/);
});

test('remote desktop suppresses the browser context menu on the remote surface', () => {
  assert.match(viewer, /class="remote-desktop-surface"[\s\S]*?@contextmenu\.prevent/);
});

test('remote desktop maps pointer input through the rendered video content box', () => {
  assert.match(viewer, /const intrinsicWidth = fallbackActive\.value \? fallbackSize\.value\?\.width \?\? 0 : video\.value\?\.videoWidth \?\? 0/);
  assert.match(viewer, /Math\.min\(rect\.width \/ intrinsicWidth, rect\.height \/ intrinsicHeight\)/);
  assert.match(viewer, /rect\.left \+ \(rect\.width - contentWidth\) \/ 2/);
  assert.match(viewer, /\(event\.clientX - left\) \/ contentWidth/);
  assert.match(viewer, /\(event\.clientY - top\) \/ contentHeight/);
});

test('remote desktop uses the local system cursor when the capture omits a remote cursor', () => {
  assert.match(viewer, /remote-desktop-system-cursor/);
  assert.match(viewer, /capture\.cursor === false/);
  assert.match(viewer, /cursor: default/);
});

test('remote desktop preserves the reactive input intent across focus loss', () => {
  assert.match(viewer, /const inputRequested = ref\(true\)/);
  assert.match(viewer, /let inputResumeGeneration = 0/);
  assert.match(viewer, /function resumeWanted\(\)/);
  assert.match(viewer, /if \((?:props\.preview \|\| )?!inputRequested\.value \|\| surfacePaused\(\) \|\| visibilityResumePending[\s\S]*?return/);
  assert.match(viewer, /inputRequested\.value = false/);
  assert.match(viewer, /@focus="surfaceFocus"/);
  assert.match(viewer, /window\.addEventListener\("focus", windowFocus\)/);
  assert.match(viewer, /window\.addEventListener\("blur", windowBlur\)/);
  assert.match(viewer, /generation !== inputResumeGeneration/);
  assert.match(viewer, /signalAliveNow\(\)/);
});

test('remote desktop retries input resume after a lost acknowledgement or stale revision', () => {
  assert.match(viewer, /REMOTE_DESKTOP_INPUT_RESUME_ACK_TIMEOUT_MS/);
  assert.match(viewer, /isRecoverableRemoteDesktopInputResumeError\(code\)/);
  assert.match(viewer, /inputResumeRetryTimer !== undefined/);
  assert.match(viewer, /inputResumePending\n\s+\|\| inputResumeRetryTimer !== undefined/);
  assert.match(viewer, /scheduleInputResumeRetry\("ack-timeout"\)/);
  assert.match(viewer, /remoteDesktopInputResumeRetryDelayMs\(attempt\)/);
  assert.match(viewer, /inputResumeRetryTimer = setTimeout\(\(\) => \{[\s\S]*?resumeWanted\(\)/);
  assert.match(viewer, /inputResumeAckTimer = setTimeout\(\(\) => \{[\s\S]*?inputResumePending = false;[\s\S]*?scheduleInputResumeRetry\("ack-timeout"\)/);
  assert.match(viewer, /inputEnabled\.value = true;[\s\S]*?error\.value = "";/);
});

test('remote desktop enables clipboard once per session without overriding a manual disable', () => {
  assert.match(viewer, /let clipboardAutoEnableAttempted = false/);
  assert.match(viewer, /function enableClipboardByDefault\(\)/);
  assert.match(viewer, /if \(clipboardAutoEnableAttempted \|\| !clipboardSupported\.value\) return/);
  assert.match(viewer, /clipboardAutoEnableAttempted = true;[\s\S]*?requestClipboardEnabled\(true, true\)/);
  assert.match(viewer, /resumeWanted\(\);\n\s+enableClipboardByDefault\(\);/);
  assert.match(viewer, /channel\.onopen = \(\) => \{[\s\S]*?enableClipboardByDefault\(\);/);
  assert.match(viewer, /watch\(clipboardSupported, supported => \{[\s\S]*?enableClipboardByDefault\(\)/);
  assert.match(viewer, /const automatic = clipboardRequestAutomatic/);
  assert.match(viewer, /!clipboard\.value && !automatic/);
});

test('remote desktop clipboard syncs automatically in both directions', () => {
  assert.doesNotMatch(viewer, /sendLocalClipboard|readRemoteClipboard|ClipboardCopy|ClipboardPaste/);
  assert.doesNotMatch(viewer, /"clipboard\.read"/);
  assert.match(viewer, /const CLIPBOARD_SYNC_INTERVAL_MS = 750/);
  assert.match(viewer, /clipboardSyncTimer = setInterval\(\(\) => \{[\s\S]*?syncLocalClipboard\(\)/);
  assert.match(viewer, /async function syncLocalClipboard\(\)[\s\S]*?navigator\.clipboard\.readText\(\)[\s\S]*?wire\(channel, "clipboard\.write"/);
  assert.match(viewer, /function queueRemoteClipboardText\(text: string\)/);
  assert.match(viewer, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(viewer, /let clipboardRemoteWriteGeneration = 0/);
  assert.match(viewer, /if \(written && pendingRemoteClipboardText !== undefined\) \{\s*void flushPendingRemoteClipboard\(\)/);
  assert.match(viewer, /if \(canUseDesktopClipboard\(\)\) \{[\s\S]*?onDesktopClipboardChanged\(text =>/);
  assert.match(viewer, /function readLocalClipboardText\(\): Promise<string> \{[\s\S]*?readDesktopClipboardText\(\)/);
  assert.match(viewer, /function writeLocalClipboardText\(text: string\): Promise<void> \{[\s\S]*?writeDesktopClipboardText\(text\)/);
  assert.match(viewer, /if \(clipboard\.value\) startClipboardSync\(\);\s*else stopClipboardSync\(true\)/);
  assert.match(viewer, /function windowFocus\(\) \{[\s\S]*?syncClipboardAfterFocus\(\)/);
  assert.match(viewer, /function visibility\(\) \{[\s\S]*?syncClipboardAfterFocus\(\)/);
  assert.match(viewer, /clipboardRequestAutomatic = false;\s*stopClipboardSync\(true\)/);
});

test('remote desktop waits for the foreground visibility snapshot before resuming window input', () => {
  assert.match(viewer, /let visibilityResumePending = false/);
  assert.match(viewer, /let visibilityResumeRevision: number \| undefined/);
  assert.match(viewer, /visibilityResumeRevision = snapshot\.value\?\.sessionRevision/);
  assert.match(viewer, /visibilityResumePending = true/);
  assert.match(viewer, /visibilityResumePending\n\s*&& next\.phase === "active"\n\s*&& !next\.mediaPaused\n\s*&& \(visibilityResumeRevision === undefined \|\| next\.sessionRevision > visibilityResumeRevision\)[\s\S]*?resumeWanted\(\)/);
  assert.match(viewer, /if \((?:props\.preview \|\| )?!inputRequested\.value \|\| surfacePaused\(\) \|\| visibilityResumePending[\s\S]*?return/);
});

test('remote desktop viewers share one transferable control lease', () => {
  assert.match(viewer, /control\.request/);
  assert.match(viewer, /function requestControl\(\)/);
  assert.match(viewer, /function releaseInputState\(resetRetry = true\)/);
  assert.match(viewer, /const isController = computed/);
  assert.match(viewer, /const hasController = computed/);
  assert.match(viewer, /const viewerCount = computed/);
  assert.match(viewer, /!next\.isController/);
  assert.match(viewer, /inputRequested\.value = false/);
  assert.match(viewer, /viewingByOther/);
  assert.match(viewer, /controlAvailable/);
  assert.match(viewer, /requestingControl/);
});

test('remote desktop prompts surface taps when another viewer owns control', () => {
  assert.match(viewer, /function showControlHint\(\)/);
  assert.match(viewer, /if \(inputEnabled\.value \|\| isController\.value\) return/);
  assert.match(viewer, /function pointerButton[\s\S]*?if \(!inputEnabled\.value\) \{\n\s+if \(down\) \{[\s\S]*?else showControlHint\(\);/);
  assert.match(viewer, /class="remote-desktop-interaction-hint"/);
  assert.match(viewer, /@pointerdown\.stop @click\.stop="requestControl"/);
});

test('remote desktop live scope is switchable through a fresh session', () => {
  assert.match(viewer, /remote-desktop-scope-trigger/);
  assert.match(viewer, /remote-desktop-scope-popover/);
  assert.match(viewer, /resolveRefreshedSource/);
  assert.match(viewer, /selectedSourceInfo\.value/);
  assert.match(viewer, /function selectScopeSource\(/);
  const switchBlock = viewer.slice(viewer.indexOf('async function switchScope'), viewer.indexOf('function selectScopeSource'));
  assert.ok(switchBlock.indexOf('await closeCurrentSession()') >= 0);
  assert.ok(switchBlock.indexOf('await connect()') > switchBlock.indexOf('await closeCurrentSession()'));
  assert.match(viewer, /if \(!session\.value\)/);
  assert.doesNotMatch(viewer, /scopeSwitchBlocked/);
  assert.doesNotMatch(viewer, /scopeSwitchBusy/);
  assert.match(viewer, /:disabled="switchingScope"/);
  assert.match(viewer, /independentScopeHint/);
  assert.doesNotMatch(viewer, /remote-desktop-control-meta/);
  assert.doesNotMatch(viewer, /remote-desktop-scope-note-stage/);
});

test('remote desktop fullscreen keeps controls and portalled dialogs inside the fullscreen tree', () => {
  assert.match(viewer, /ConfigProvider :teleport-to="portalHost"/);
  assert.match(viewer, /ref="portalHost"/);
  assert.match(viewer, /viewer\.value\?\.requestFullscreen\(\)/);
  assert.match(viewer, /fullscreenElement === viewer\.value/);
  assert.match(viewer, /\.remote-desktop-viewer:fullscreen/);
  assert.doesNotMatch(viewer, /\.remote-desktop-stage:fullscreen/);
  assert.match(viewer, /viewer\.value\?\.contains\(next\)/);
  assert.match(viewer, /\.remote-desktop-layout\s*\{[^}]*container-type: inline-size/s);
  assert.doesNotMatch(viewer, /\.remote-desktop-viewer\s*\{[^}]*container-type/s);
});

test('remote desktop installation and enabled intent stay in the existing app management entry', () => {
  assert.match(api, /remote-desktop\/settings/);
  assert.match(api, /force-stop/);
  assert.match(settings, /getRemoteDesktopSettings/);
  assert.match(settings, /updateRemoteDesktopSettings/);
  assert.match(settings, /remoteDesktopVisibleForPlatform/);
  assert.match(settings, /visibleManagedApps[\s\S]*?app\.id !== "remote-desktop"/);
  assert.match(settings, /remoteDesktopSettings\.enabled/);
  assert.match(viewer, /forceStopRemoteDesktopSession/);
  assert.match(viewer, /canManage/);
  assert.match(settings, /remoteDesktopInstalled/);
  assert.match(settings, /activeSection === "remote-desktop" && installed/);
});

test('remote desktop window resize is capability-driven and gated to controlled window sessions', () => {
  assert.match(viewer, /remoteDesktopSupportsWindowResize/);
  assert.match(viewer, /features\.windowResize/);
  assert.match(viewer, /windowResizePresets/);
  assert.match(viewer, /windowResizeViewportFitSupported/);
  assert.match(viewer, /fitToViewport === true/);
  assert.match(viewer, /v-for="preset in windowResizePresets"/);
  assert.match(viewer, /v-if="windowResizeViewportFitSupported"/);

  const visibility = viewer.slice(viewer.indexOf('const windowResizeMenuVisible'), viewer.indexOf('const windowResizeAvailable'));
  assert.match(visibility, /session\.value/);
  assert.match(visibility, /!props\.preview/);
  assert.match(visibility, /target\.value\.kind === "window"/);
  assert.match(visibility, /snapshot\.value\?\.isController === true/);
  assert.match(visibility, /snapshot\.value\?\.phase === "active"/);
  assert.match(visibility, /snapshot\.value\?\.mediaPaused !== true/);
  assert.match(visibility, /signalingReady\.value/);
  assert.match(visibility, /streamReady\.value/);
  assert.match(visibility, /!surfacePaused\(\)/);
  assert.match(visibility, /!fallbackSwitching\.value/);
  assert.match(visibility, /remoteDesktopSupportsWindowResize\(remote\.value\)/);
});

test('remote desktop window resize sends preset or viewport wire payloads without touching stream resolution', () => {
  const request = viewer.slice(viewer.indexOf('function requestWindowResize'), viewer.indexOf('function resizeRemoteWindowPreset'));
  assert.match(request, /RemoteDesktopWindowResizeRequestSchema\.safeParse/);
  assert.match(request, /RemoteDesktopWindowResizeRequestSchema\.safeParse\(\{ requestId, \.\.\.target \}\)/);
  assert.match(request, /wire\(control, "window\.resize", parsed\.data\)/);
  assert.doesNotMatch(request, /stream\.resolution|applyTransportResolution|transportResolution|transportFrameRate|transportCapturePrecision/);
  assert.match(viewer, /@select="resizeRemoteWindowPreset\(preset\)"/);
  assert.match(viewer, /:model-value="windowResizeFitActive"/);
  assert.match(viewer, /class="remote-desktop-window-resize-fit-item gap-2 px-2 pr-8 \[&>svg\]:size-4 \[&>svg\]:shrink-0"/);
  assert.match(viewer, /class="remote-desktop-window-resize-fit-option"/);
  assert.match(viewer, /\.remote-desktop-window-resize-fit-item > span:first-child[\s\S]*?right: 8px;[\s\S]*?left: auto;/);
  assert.match(viewer, /@update:model-value="setWindowResizeFit\(Boolean\(\$event\)\)"/);
  assert.match(viewer, /@select\.prevent/);
  assert.match(viewer, /windowResizePresets\.value\.some\(\(candidate\) => candidate\.width === preset\.width && candidate\.height === preset\.height\)/);
});

test('remote desktop fit measures the video surface rather than the viewer chrome', () => {
  const fit = viewer.slice(viewer.indexOf('function windowResizeViewportTarget'), viewer.indexOf('function setWindowResizeFit'));
  assert.match(fit, /surface\.value\?\.getBoundingClientRect\(\)/);
  assert.doesNotMatch(fit, /viewer\.value/);
  assert.match(fit, /const width = Math\.round\(rect\.width\)/);
  assert.match(fit, /const height = Math\.round\(rect\.height\)/);
  assert.match(fit, /requestWindowResize\(\{\s+mode: "viewport"/);
  assert.doesNotMatch(fit, /screen|work.?area|window\.innerWidth|window\.innerHeight/);
});

test('remote desktop fit mode follows viewer size changes instead of fitting once', () => {
  assert.match(viewer, /const windowResizeFitActive = ref\(!props\.preview && viewerPreferences\?\.windowResizeFitActive === true\)/);
  assert.match(viewer, /new ResizeObserver\(\(\) => scheduleWindowResizeFit\(\)\)/);
  assert.match(viewer, /const element = surface\.value/);
  assert.match(viewer, /windowResizeFitObserver\.observe\(element\)/);
  assert.match(viewer, /window\.addEventListener\("resize", scheduleWindowResizeFit\)/);
  assert.match(viewer, /window\.removeEventListener\("resize", scheduleWindowResizeFit\)/);
  assert.match(viewer, /windowResizeFitPendingTarget = target/);
  assert.match(viewer, /window\.requestAnimationFrame/);
  assert.match(viewer, /window\.cancelAnimationFrame/);
  assert.match(viewer, /function flushWindowResizeFit\(\)[\s\S]*?windowResizePending\.value\) return/);
  assert.match(viewer, /function flushWindowResizeFit\(\)[\s\S]*?sameWindowResizeSize\(target, windowResizeFitLastAttempt\)/);
  assert.match(viewer, /watch\(windowResizeMenuVisible, \(visible, previous\) => \{[\s\S]*?windowResizeFitLastAttempt = undefined/);
  assert.match(viewer, /watch\(windowResizeViewportFitSupported, supported => \{[\s\S]*?queueWindowResizeFitFlush\(\)/);

  const resized = viewer.slice(viewer.indexOf('function handleWindowResizedValue'), viewer.indexOf('function handleWindowResizeFailedValue'));
  assert.match(resized, /queueWindowResizeFitFlush\(\)/);

  const preset = viewer.slice(viewer.indexOf('function resizeRemoteWindowPreset'), viewer.indexOf('function handleWindowResizedValue'));
  assert.match(preset, /setWindowResizeFit\(false\)/);
});

test('remote desktop fit sends are throttled while retaining the latest size', () => {
  assert.match(viewer, /const WINDOW_RESIZE_FIT_THROTTLE_MS = 120/);
  assert.match(viewer, /let windowResizeFitLastSentAt = 0/);
  assert.match(viewer, /function clearWindowResizeFitThrottle\(\)/);
  assert.match(viewer, /function scheduleWindowResizeFitThrottle\(delay: number\)/);
  assert.match(viewer, /function stopWindowResizeFitScheduling\(\)[\s\S]*?clearWindowResizeFitThrottle\(\)/);
  const flush = viewer.slice(viewer.indexOf('function flushWindowResizeFit'), viewer.indexOf('function queueWindowResizeFitFlush'));
  assert.match(flush, /WINDOW_RESIZE_FIT_THROTTLE_MS - \(Date\.now\(\) - windowResizeFitLastSentAt\)/);
  assert.match(flush, /windowResizeFitPendingTarget = target;[\s\S]*?scheduleWindowResizeFitThrottle\(remainingThrottleMs\)/);
  assert.match(flush, /windowResizeFitLastSentAt = Date\.now\(\)[\s\S]*?requestWindowResize\(\{ mode: "viewport"/);
});

test('remote desktop window resize prevents duplicate requests and correlates actual-size responses', () => {
  assert.match(viewer, /const windowResizePending = ref\(false\)/);
  assert.match(viewer, /function requestWindowResize[\s\S]*?if \(!windowResizeAvailable\.value\) return/);
  assert.match(viewer, /windowResizePending\.value = true/);
  assert.match(viewer, /WINDOW_RESIZE_RESPONSE_TIMEOUT_MS/);
  assert.match(viewer, /windowResizeTimer = setTimeout\(\(\) => \{[\s\S]*?windowResizeRequestId\.value !== requestId/);
  assert.match(viewer, /RemoteDesktopWindowResizedPayloadSchema\.safeParse/);
  assert.match(viewer, /parsed\.data\.requestId !== windowResizeRequestId\.value/);
  assert.match(viewer, /windowResizeActual\.value = \{ width: parsed\.data\.width, height: parsed\.data\.height \}/);
  assert.match(viewer, /windowResizePending\.value = false/);
});

test('remote desktop window resize reports actual, constrained, fit, and structured failure states', () => {
  const status = viewer.slice(viewer.indexOf('const windowResizeStatusText'), viewer.indexOf('const viewerCount'));
  const constrained = status.indexOf('actual.width !== request.width || actual.height !== request.height');
  const viewportFit = status.indexOf('request.mode === "viewport"');
  const presetSuccess = status.indexOf('windowResizeApplied"');
  assert.ok(constrained >= 0);
  assert.ok(viewportFit > constrained);
  assert.ok(presetSuccess > viewportFit);
  assert.match(status, /windowResizeConstrained/);
  assert.match(status, /windowResizeAppliedFit/);
  assert.match(viewer, /windowResizeConstrained/);
  assert.match(viewer, /windowResizeAppliedFit/);
  assert.match(viewer, /windowResizeApplied/);
  assert.match(viewer, /RemoteDesktopWindowResizeFailedPayloadSchema\.safeParse/);
  assert.match(viewer, /failWindowResize\(parsed\.data\.code/);
  assert.match(viewer, /translateApiError\(\s*\{ code \}/);
  assert.match(viewer, /windowResizeTimedOut/);
  assert.doesNotMatch(viewer, /class="remote-desktop-inline-status" role="status" :title="windowResizeStatusText"/);
  assert.match(viewer, /const windowResizeNoticeText = ref\(""\)/);
  assert.match(viewer, /WINDOW_RESIZE_NOTICE_DURATION_MS = 3_000/);
  assert.match(viewer, /function showWindowResizeNotice\(text: string\)/);
  assert.match(viewer, /class="remote-desktop-window-resize-notice"/);
  assert.match(viewer, /watch\(windowResizeStatusText, text => \{[\s\S]*?showWindowResizeNotice\(text\)/);
  assert.match(viewer, /value\.type === "window\.resized"/);
  assert.match(viewer, /value\.type === "window\.resize\.failed"/);
});

test('remote desktop window resize clears in-flight state but retains the fit preference', () => {
  assert.match(viewer, /function cleanup\(\) \{\n\s+usedTransportKeys\.value = new Set\(\);\n\s+resetWindowResizeState\(\);/);
  assert.match(viewer, /function resetWindowResizeState\(\)[\s\S]*?clearWindowResizeTimer\(\)/);
  assert.match(viewer, /function resetWindowResizeState\(\)[\s\S]*?clearWindowResizeNotice\(\)/);
  const reset = viewer.slice(viewer.indexOf('function resetWindowResizeState'), viewer.indexOf('function failWindowResize'));
  assert.doesNotMatch(reset, /windowResizeFitActive\.value = false/);
  assert.match(viewer, /function resetWindowResizeState\(\)[\s\S]*?stopWindowResizeFitScheduling\(\)/);
  assert.match(viewer, /windowResizeStatus\.value = "idle"/);
  assert.match(viewer, /windowResizeRequestId\.value = ""/);
  assert.match(viewer, /function setWindowResizeFit\(active: boolean\)[\s\S]*?windowResizeFitActive\.value = active/);
});
