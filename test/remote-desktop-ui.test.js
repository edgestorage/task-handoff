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
  assert.match(activeSessions, /const key = `\$\{REMOTE_DESKTOP_APP_ID\}:\$\{instanceId\}`/);
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
  assert.match(viewer, /watch\(\(\) => props\.active, \(\) => syncVisibility\(\)\)/);
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
  assert.match(viewer, /transportAvailability: transportAvailability\.value/);
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

test('websocket fallback uses the same resolution ceiling as WebRTC', () => {
  const routes = fs.readFileSync('packages/control-plane/src/control-plane/http/remote-desktop-routes.ts', 'utf8');
  const protocolCapability = fs.readFileSync('controlled-instance-rs/crates/protocol/src/remote_desktop.rs', 'utf8');
  const streaming = fs.readFileSync('remote-desktop-rs/crates/desktop-streaming/src/service.rs', 'utf8');
  assert.match(routes, /capability\.video\.maxWidth/);
  assert.match(routes, /Math\.min\(capability\.fallback\.maxWidth, videoMaxWidth\)/);
  assert.doesNotMatch(routes, /Math\.min\(capability\.fallback\.maxWidth \|\| 1280, 1280\)/);
  assert.match(protocolCapability, /max_width: 1920,\s*\n\s*max_height: 1080/);
  assert.match(streaming, /crate::video::FALLBACK_LIMITS/);
  assert.match(streaming, /crate::video::FALLBACK_MAX_WIDTH/);
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
  assert.match(viewer, /TooltipContent[\s\S]*transport\.detail/);
  assert.match(viewer, /parseRemoteDesktopWebRTCStats\(stats\)/);
  assert.doesNotMatch(viewer, /selectedCandidatePairId/);
  assert.match(viewer, /transportCandidateHost/);
  assert.doesNotMatch(viewer, /remote-desktop-transport-mode/);
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
  assert.match(viewer, /activeTransportAvailability\.value = \{ \.\.\.transportAvailability\.value \}/);
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
  assert.match(viewer, /void stopRemoteDesktopSession\(props\.instanceId, closedSession\.snapshot\.viewerSessionId\)/);
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
  assert.match(viewer, /remote-desktop-frame-rate-menu/);
  assert.match(viewer, /DropdownMenuSubTrigger :disabled="!signalingReady \|\| fallbackSwitching">[\s\S]*?transportFrameRate/);
  assert.match(viewer, /const TRANSPORT_FRAME_RATE_PRESETS = \[60, 30, 24, 15\] as const/);
  assert.match(viewer, /maxFrameRate: frameRate/);
  assert.match(viewer, /stream\.resolution/);
  assert.match(viewer, /function setTransportResolution\(value: string\)/);
  assert.match(viewer, /function setTransportFrameRate\(value: string\)/);
  assert.match(viewer, /function applyTransportResolution\(showError = false\)/);
  assert.match(viewer, /transportResolutionRequested/);
  assert.match(viewer, /@resize="updateResolution"/);
  assert.match(viewer, /remote-desktop-menu-danger[\s\S]*instances\.remoteDesktop\.stop/);
  assert.doesNotMatch(viewer, /remote-desktop-action-divider/);
  assert.doesNotMatch(viewer, /remote-desktop-clipboard-popover/);
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
  assert.match(viewer, /if \(!inputRequested\.value \|\| surfacePaused\(\) \|\| visibilityResumePending[\s\S]*?return/);
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
  assert.match(viewer, /scheduleInputResumeRetry\("ack-timeout"\)/);
  assert.match(viewer, /remoteDesktopInputResumeRetryDelayMs\(attempt\)/);
  assert.match(viewer, /inputResumeRetryTimer = setTimeout\(\(\) => \{[\s\S]*?resumeWanted\(\)/);
  assert.match(viewer, /inputResumeAckTimer = setTimeout\(\(\) => \{[\s\S]*?inputResumePending = false;[\s\S]*?scheduleInputResumeRetry\("ack-timeout"\)/);
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

test('remote desktop waits for the foreground visibility snapshot before resuming window input', () => {
  assert.match(viewer, /let visibilityResumePending = false/);
  assert.match(viewer, /let visibilityResumeRevision: number \| undefined/);
  assert.match(viewer, /visibilityResumeRevision = snapshot\.value\?\.sessionRevision/);
  assert.match(viewer, /visibilityResumePending = true/);
  assert.match(viewer, /visibilityResumePending\n\s*&& next\.phase === "active"\n\s*&& !next\.mediaPaused\n\s*&& \(visibilityResumeRevision === undefined \|\| next\.sessionRevision > visibilityResumeRevision\)[\s\S]*?resumeWanted\(\)/);
  assert.match(viewer, /if \(!inputRequested\.value \|\| surfacePaused\(\) \|\| visibilityResumePending[\s\S]*?return/);
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
  assert.match(viewer, /if \(!inputEnabled\.value\) \{\n\s+if \(down\) showControlHint\(\);/);
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
  assert.match(settings, /app\.id === 'remote-desktop'/);
  assert.match(settings, /remoteDesktopSettings\.enabled/);
  assert.match(viewer, /forceStopRemoteDesktopSession/);
  assert.match(viewer, /canManage/);
  assert.match(settings, /remoteDesktopInstalled/);
  assert.match(settings, /activeSection === "apps" && installed/);
});
