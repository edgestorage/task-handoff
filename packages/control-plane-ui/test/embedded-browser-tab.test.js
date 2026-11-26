import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(path) {
  return fs.readFileSync(new URL(`../src/apps/control-plane/${path}`, import.meta.url), "utf8");
}

test("embedded browser is a local session tab and never launches an AppSession", () => {
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  assert.match(sessions, /kind:\s*"embedded-browser"/);
  assert.match(sessions, /if \(appId === EMBEDDED_BROWSER_APP_ID\)[\s\S]*?openBrowserTab/);
  assert.match(sessions, /session\.kind === "embedded-browser"[\s\S]*?browserSessionTabs/);
});

test("embedded browser mounts an isolated webview only after desktop context preparation", () => {
  const component = source("instance-detail/EmbeddedBrowserTab.vue");
  const addresses = source("instance-detail/browserAddressSuggestions.ts");
  assert.match(component, /<webview\s+v-if="context\?\.partition"[\s\S]*?src="about:blank"[\s\S]*?:partition="context\.partition"[\s\S]*?allowpopups/);
  assert.match(component, /@did-attach="scheduleGuestRegistration\('did-attach'\)"/);
  assert.match(component, /@dom-ready="handleGuestDomReady"/);
  assert.match(component, /prepareDesktopBrowserContext\(props\.instanceId\)/);
  assert.match(component, /result\.message \|\| \(result\.code/);
  assert.match(component, /releaseDesktopBrowserContext\(context\.value\.contextId\)/);
  assert.match(component, /if \(disposed\)[\s\S]*?releaseDesktopBrowserContext\(result\.contextId\)/);
  assert.match(component, /normalizeDesktopBrowserUrl\(value\)/);
  assert.match(addresses, /url\.protocol !== "http:" && url\.protocol !== "https:"/);
});

test("browser guests stay mounted while another tab in the same pane is selected", () => {
  const layer = source("instance-detail/EmbeddedBrowserSurfaceLayer.vue");
  const pane = source("instance-detail/SessionPaneContent.vue");
  assert.match(pane, /data-browser-surface/);
  assert.match(layer, /v-for="pageKey in stablePages\[instanceId\] \|\| \[\]"/);
  assert.match(layer, /const ordered = previous\.filter\(\(key\) => present\.has\(key\)\)/);
  assert.match(layer, /<EmbeddedBrowserTab/);
  assert.match(layer, /visibility: visible \? "visible" : "hidden"/);
});

test("browser tabs are pruned only from a complete authoritative instance directory", () => {
  const workbench = source("ControlPlaneWorkbench.vue");
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  assert.match(sessions, /function pruneBrowserInstances\(validInstanceIds: ReadonlySet<string>\)/);
  assert.match(sessions, /if \(validInstanceIds\.has\(instanceId\)\) continue;[\s\S]*?delete browserTabSlots\[instanceId\][\s\S]*?delete browserPages\[instanceId\]/);
  assert.match(workbench, /const authoritativeInstanceIds = computed<ReadonlySet<string> \| undefined>/);
  assert.match(workbench, /instanceDirectoryComplete\.value[\s\S]*?new Set\(sortedInstances\.value\.map/);
  assert.match(workbench, /watch\(authoritativeInstanceIds,[\s\S]*?pruneBrowserInstances\(instanceIds\)/);
});

test("stable browser host lets the start page and guest fill the pane surface", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /\.embedded-browser \{[^}]*width: 100%; height: 100%;/);
  assert.match(browser, /\.embedded-browser-surface \{[^}]*min-height: 0;/);
  assert.match(browser, /\.embedded-browser-start-page \{[^}]*inset: 0;/);
  assert.match(browser, /\.embedded-browser-device-frame \{[^}]*container-type: inline-size;/);
  assert.match(browser, /\.embedded-browser-start-page \{[^}]*padding: 34px clamp\(12px, 6cqi, 80px\);/);
  assert.match(browser, /\.embedded-browser-start-page \{[^}]*pointer-events: auto;/);
  assert.match(browser, /@click\.stop="addPinned"/);
  assert.match(browser, /browser add pinned clicked/);
  assert.match(browser, /<Dialog v-model:open="pinnedDialogOpen">/);
  assert.doesNotMatch(browser, /window\.prompt/);
});

test("browser navigation keeps about:blank history and dispatches address bar submissions", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /if \(!url \|\| url === "about:blank"\) \{[\s\S]*?address\.value = ""[\s\S]*?publishTabPatch\(\{ url: "about:blank" \}\)/);
  assert.match(browser, /async function dispatchPendingNavigation\(sequence: number\)/);
  assert.match(browser, /void dispatchPendingNavigation\(sequence\)/);
  assert.match(browser, /start-page-active.*webview \{ visibility: hidden; \}/);
});

test("browser address suggestions use local history and accessible keyboard navigation", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /role="combobox"/);
  assert.match(browser, /aria-autocomplete="list"/);
  assert.match(browser, /browserAddressSuggestions\(pinned\.value, recent\.value, address\.value\)/);
  assert.match(browser, /sanitizeBrowserStartPageData\(JSON\.parse/);
  assert.match(browser, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(browser, /event\.key === "Tab" && activeSuggestionIndex\.value >= 0/);
  assert.match(browser, /@interact-outside="handleSuggestionsInteractOutside"/);
  assert.match(browser, /addressAnchor\.value\?\.contains\(target\)[\s\S]*?event\.preventDefault\(\)/);
  assert.match(browser, /function submitAddress\(\)[\s\S]*?navigate\(suggestion\?\.url \|\| address\.value\)/);
  assert.match(browser, /onDesktopBrowserFocusAddress\(\(\{ webContentsId \}\) => \{[\s\S]*?getWebContentsId\?\.\(\) !== webContentsId[\s\S]*?focusAddress\(\)/);
});

test("browser address submission writes the completed URL back before navigation", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /function navigate\(value: string\)[\s\S]*?const url = normalizeDesktopBrowserUrl\(value\);[\s\S]*?address\.value = url;[\s\S]*?pendingNavigation\.value = url;/);
});

test("ordinary web builds keep the browser launcher behind desktop bridge and capability", () => {
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  assert.match(sessions, /supportsBrowserTunnel\(activeInstance\.value\.capabilities\) \|\| supportsDirectoryBrowserTunnel\(activeInstance\.value\.capabilities\)/);
  assert.match(sessions, /uniqueLaunchableApps\(\[\.\.\.remoteDesktopApps, \.\.\.catalogApps, \.\.\.browser\]\)/);
  assert.match(sessions, /uniqueLaunchableApps\(\[\.\.\.remoteDesktopApps, \.\.\.ids\.map\([\s\S]*?\), \.\.\.browser\]\)/);
});

test("browser popup requests create a sibling browser tab with its initial URL", () => {
  const workbench = source("ControlPlaneWorkbench.vue");
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  const layer = source("instance-detail/EmbeddedBrowserSurfaceLayer.vue");
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(workbench, /onBrowserNewTab\?\.\(\(\{ instanceId: sourceInstanceId, url, title, creationRef, requesterSessionRef \}\) =>/);
  assert.match(workbench, /openBrowserTab\(instanceId, url, \{ title, creationRef \}\)/);
  assert.match(sessions, /function openBrowserTab\(\s*instanceId: string,\s*initialUrl\?: string,\s*options: \{ title\?: string; creationRef\?: string; activate\?: boolean \} = \{\},\s*\)/);
  assert.match(sessions, /input\.creationRef \? \{ creationRef: input\.creationRef \} : \{\}/);
  assert.match(sessions, /status: initialUrl \? "loading" : "running"/);
  assert.match(sessions, /input\.initialUrl \? \{ initialUrl: input\.initialUrl \} : \{\}/);
  assert.match(layer, /:initial-url="pageInitialUrl\(instanceId, pageKey\)"/);
  assert.match(browser, /initialUrl\?: string/);
  assert.match(browser, /creationRef\?: string/);
  assert.match(browser, /props\.creationRef \? \{ creationRef: props\.creationRef \} : \{\}/);
  assert.match(browser, /await waitForGuestReady\(\)/);
  assert.match(browser, /function waitForGuestReady\(\)/);
  assert.match(browser, /function handleGuestDomReady\(\)/);
  assert.match(browser, /if \(!removeGuestListeners\) bindGuest\(\)/);
  assert.match(browser, /guest\.value\?\.loadURL\(url\)/);
});

test("Agent-created pages follow the requester Session without stealing the current view", () => {
  const workbench = source("ControlPlaneWorkbench.vue");
  const sidebar = source("story/useStoryResourceSidebar.ts");
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  const bridge = fs.readFileSync(new URL("../src/lib/desktopBridge.ts", import.meta.url), "utf8");
  assert.match(workbench, /requesterSessionRef/);
  assert.match(workbench, /storySessionSelectionForAiSession\(instanceId, requesterSessionRef, boardInstancesWithAiSessions\.value\)/);
  assert.match(workbench, /storyResourceSidebar\.openBrowserForAiSession\(instanceId, requesterSessionRef, url, \{ title, creationRef \}\)/);
  assert.match(workbench, /openBrowserTab\(instanceId, url, \{ title, creationRef, activate: false \}\)/);
  assert.match(sidebar, /function openBrowserForAiSession\(/);
  assert.match(sidebar, /if \(resourceContextKey === contextKey\.value\) select\(resource\)/);
  assert.match(sessions, /if \(options\.activate === false\) return;/);
  assert.match(bridge, /requesterSessionRef\?: string/);
});

test("browser tabs publish page title and loading state", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  const layer = source("instance-detail/EmbeddedBrowserSurfaceLayer.vue");
  const preview = source("instance-detail/SessionPreview.vue");
  const workbench = source("ControlPlaneWorkbench.vue");
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  assert.match(browser, /page-title-updated/);
  assert.match(browser, /publishTabPatch\(\{ title, status: "running" \}\)/);
  assert.match(browser, /publishTabPatch\(\{ url \}\)/);
  assert.match(browser, /publishTabPatch\(\{ status: "loading" \}\)/);
  assert.match(browser, /browser start page ready/);
  assert.match(browser, /did-finish-load/);
  assert.match(browser, /getTitle\?\.\(\)/);
  assert.match(preview, /session\.status === 'loading'/);
  assert.match(preview, /sessionDisplayName\(session, t\)/);
  assert.match(preview, /session\.kind === "embedded-browser"[\s\S]*?currentUrl/);
  assert.match(layer, /\$emit\('updateBrowserTab', instanceId, pageKey, patch\)/);
  assert.match(workbench, /@update-browser-tab="updateCombinedBrowserTab"/);
  assert.match(workbench, /function updateCombinedBrowserTab\(instanceId: string, sessionKey: string, patch:/);
  assert.match(sessions, /function updateBrowserTab\(/);
});

test("browser guests register their live tab identity after dom-ready and clear it on teardown", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  const bridge = fs.readFileSync(new URL("../src/lib/desktopBridge.ts", import.meta.url), "utf8");
  assert.match(browser, /function handleGuestDomReady\(\) \{\s*applyBackgroundThrottling\(\);\s*scheduleGuestRegistration\("dom-ready"\);/);
  assert.match(browser, /function scheduleGuestRegistration\(reason: string\)/);
  assert.match(browser, /browser tab registration waiting for webContentsId attempt=/);
  assert.match(browser, /resolveGuestWebContentsId\(\)/);
  assert.match(browser, /if \(!registeredTabRef\) scheduleGuestRegistration\("did-finish-load"\)/);
  assert.match(browser, /registerDesktopBrowserTab\(\{[\s\S]*?webContentsId[\s\S]*?instanceId: props\.instanceId[\s\S]*?sessionKey: localSessionKey/);
  assert.match(browser, /registeredTabRef = result\.tab\.tabRef/);
  assert.match(browser, /updateDesktopBrowserTab\(\{ tabRef: registeredTabRef, \.\.\.patch \}\)/);
  assert.match(browser, /function unregisterGuestTab\(\)[\s\S]*?unregisterDesktopBrowserTab/);
  assert.match(browser, /onBeforeUnmount\(\(\) => \{[\s\S]*?unregisterGuestTab\(\)/);
  assert.match(browser, /recoveringContext = true;[\s\S]*?unregisterGuestTab\(\)/);
  assert.match(bridge, /registerBrowserTab/);
  assert.match(bridge, /sendBrowserCdpCommand/);
  assert.match(bridge, /onBrowserTabClosed/);
});

test("an authoritative tab close is matched by opaque tabRef and removes the owning local tab", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  const layer = source("instance-detail/EmbeddedBrowserSurfaceLayer.vue");
  const workbench = source("ControlPlaneWorkbench.vue");
  assert.match(browser, /onDesktopBrowserTabClosed\(\(\{ tabRef, instanceId \}\) => \{[\s\S]*?tabRef !== registeredTabRef[\s\S]*?emit\("closeTab"\)/);
  assert.match(layer, /@close-tab="\$emit\('closeBrowserTab', instanceId, hostTabKey\(instanceId, pageKey\) \|\| pageKey\)"/);
  assert.match(workbench, /@close-browser-tab="closeCombinedBrowserTab"/);
  assert.match(workbench, /function closeCombinedBrowserTab\(instanceId: string, sessionKey: string\)[\s\S]*?storyResourceSidebar\.removeBrowser\(storyResource\)[\s\S]*?stopSelectedAppSession\(instance, session\)/);
});

test("opening an open page keeps the current tab and gives the page its own tab", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  const layer = source("instance-detail/EmbeddedBrowserSurfaceLayer.vue");
  const workbench = source("ControlPlaneWorkbench.vue");
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  const pageTabs = source("instance-detail/browserPageTabs.ts");
  // The page host is identified independently from the tab slot so opening it
  // in a tab never re-orders or re-mounts the live <webview>.
  assert.match(layer, /v-for="pageKey in stablePages\[instanceId\] \|\| \[\]"/);
  assert.match(layer, /:data-browser-page-key="pageKey"/);
  assert.match(layer, /:page-key="pageKey"/);
  assert.match(sessions, /import \{ ensureBrowserPageSlot, type BrowserPageSurface, type BrowserTabSlot \} from "\.\/browserPageTabs"/);
  assert.match(sessions, /browserTabSlots = reactive<Record<string, BrowserTabSlot\[\]>>\(\{\}\)/);
  assert.match(pageTabs, /export function ensureBrowserPageSlot\(/);
  assert.match(pageTabs, /return \{ slot: existing, created: false \}/);
  assert.match(pageTabs, /slots\.push\(slot\)/);
  assert.match(sessions, /function openBrowserPageTab\(/);
  assert.match(sessions, /ensureBrowserPageSlot\(slots, pageKey/);
  assert.match(browser, /emit\("openPage", page\)/);
  assert.match(layer, /@open-page="\(page\) => \$emit\('openBrowserPage', instanceId, page\)"/);
  assert.match(workbench, /async function openCombinedBrowserPage\(instanceId: string, page:/);
  assert.match(workbench, /const sessionKey = openBrowserPageTab\(instanceId, metadata\)/);
  assert.match(workbench, /const instanceChanged = activeInstanceId\.value !== instanceId;[\s\S]*?if \(instanceChanged \|\| workbenchView\.value !== "instance"\) \{[\s\S]*?await nextTick\(\);/);
  assert.match(workbench, /selectSession\(sessionKey\)/);
});

test("page rows close the owning tab or Story resource directly", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  const layer = source("instance-detail/EmbeddedBrowserSurfaceLayer.vue");
  const workbench = source("ControlPlaneWorkbench.vue");
  assert.match(browser, /class="embedded-browser-page-close"[\s\S]*?@click\.stop="closePage\(page\.key\)"/);
  assert.match(browser, /function closePage\(pageKey: string\)[\s\S]*?emit\("closePage", pageKey\)/);
  assert.match(layer, /@close-page="\(targetPageKey\) => \$emit\('closeBrowserPage', instanceId, targetPageKey\)"/);
  assert.match(workbench, /function closeCombinedBrowserPage\(instanceId: string, pageKey: string\)/);
  assert.match(workbench, /const localTab = browserSessionTabs\.value\[instanceId\]\?\.find\(\(tab\) => tab\.source\?\.pageKey === pageKey\)/);
  assert.match(workbench, /void stopSelectedAppSession\(instance, localTab\)/);
  assert.match(workbench, /storyResourceSidebar\.browserPageKeyOf\(resource\) === pageKey[\s\S]*?storyResourceSidebar\.removeBrowser\(storyResource\)/);
});

test("page opening moves a page across instance tabs and Story resources without replacing the current tab", () => {
  const workbench = source("ControlPlaneWorkbench.vue");
  const sidebar = source("story/useStoryResourceSidebar.ts");
  // Both cross-context branches bind the live page into the new target first,
  // then remove the source tab. Reversing that order would unmount the <webview>.
  assert.match(sidebar, /function openBrowserPageForAiSession\(/);
  assert.match(sidebar, /browserPageKeyByResource\[storyResourceKey\(resource\)\] = pageKey/);
  assert.match(workbench, /const resource = storyResourceSidebar\.openBrowserPageForAiSession\(instanceId, storyResourceTargetAiSessionId\.value, pageKey, metadata\)[\s\S]*?if \(sourceStory\) \{[\s\S]*?storyResourceSidebar\.removeBrowser\(sourceStory\)/);
  assert.match(workbench, /const sessionKey = openBrowserPageTab\(instanceId, metadata\)[\s\S]*?if \(sourceStory\) storyResourceSidebar\.removeBrowser\(sourceStory\)/);
  assert.doesNotMatch(workbench, /moveCombinedBrowserPage|moveBrowserPageToTab/);
});

test("the browser session tab projection is consumed as a computed ref", () => {
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  const workbench = source("ControlPlaneWorkbench.vue");
  // browserSessionTabs is derived from page hosts + tab slots, so it is a
  // ComputedRef. Indexing the ref object itself silently yields undefined and
  // breaks the surface layer; every read must go through .value.
  assert.match(sessions, /const browserSessionTabs = computed<Record<string, SessionTab\[\]>>/);
  assert.doesNotMatch(sessions, /browserSessionTabs\[/);
  assert.match(sessions, /browserSessionTabs\.value\[instanceId\]/);
  assert.match(sessions, /Object\.keys\(browserSessionTabs\.value\)/);
  assert.doesNotMatch(workbench, /browserSessionTabs\[/);
  assert.match(workbench, /Object\.keys\(browserSessionTabs\.value\)/);
  assert.match(workbench, /browserSessionTabs\.value\[instanceId\]/);
});

test("a degraded main page pool is reported while the renderer webview keeps working", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /getDesktopBrowserControlInfo\(props\.instanceId\)/);
  assert.match(browser, /if \(!info\?\.ok \|\| disposed\) return;[\s\S]*?if \(!info\.degraded\) return;/);
  assert.match(browser, /pageHostNotice\.value = t\("sessions\.browser\.pageHostDegraded"\)/);
  assert.match(browser, /class="embedded-browser-host-notice"/);
});

test("browser context lease loss rebuilds the guest instead of leaving a dead surface", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /browser context lease renewal rejected; rebuilding context/);
  assert.match(browser, /void recoverContext\(contextId\)/);
  assert.match(browser, /context\.value = undefined;[\s\S]*?await nextTick\(\);[\s\S]*?await establishContext\(\)/);
  assert.match(browser, /startContextHeartbeat\(result\.contextId\)/);
});

test("browser load failures show an actionable prompt instead of a silent guest", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /onDesktopBrowserLoadFailure\(\(input\) => handleLoadFailure\(input\)\)/);
  assert.match(browser, /function showLoadFailure\(\)/);
  assert.match(browser, /error\.value = t\(browserLoadFailureKey\(\{ chromiumCode: lastChromiumError\?\.code, tunnelCode: tunnelFailure\?\.code \}\)\)/);
  assert.match(browser, /const failed = \(event: Event & \{ errorCode\?: number;/);
  assert.match(browser, /if \(!isBrowserPageLoadFailure\(event\)\) return;/);
  assert.match(browser, /did-fail-load", failed as EventListener/);
  assert.match(browser, /class="embedded-browser-state-detail"/);
  assert.match(browser, /@click="retry"/);
  assert.match(browser, /t\("sessions\.browser\.retry"\)/);
});

test("embedded browser device mode resizes the real guest and mirrors Agent emulation commands", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  const bridge = fs.readFileSync(new URL("../src/lib/desktopBridge.ts", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../../../apps/desktop-shell/src/preload.cjs", import.meta.url), "utf8");
  assert.match(browser, /class="embedded-browser-device-toggle"[\s\S]*?@click="toggleDeviceMode"[\s\S]*?<MonitorSmartphone/);
  assert.match(browser, /class="embedded-browser-device-toolbar"[\s\S]*?sessions\.browser\.deviceWidth[\s\S]*?sessions\.browser\.deviceHeight[\s\S]*?sessions\.browser\.deviceZoomFit[\s\S]*?@click="rotateDevice"/);
  assert.match(browser, /const fixedScale = browserDeviceZoomScale\(selectedDeviceZoomId\.value\);/);
  assert.match(browser, /\.embedded-browser-device-toolbar :deep\(\.embedded-browser-device-zoom-select\) \{ width: 124px/);
  assert.match(browser, /\.embedded-browser-device-stage \{[^}]*align-items: safe center;[^}]*justify-content: safe center;[^}]*overflow: auto;/);
  assert.match(browser, /\.embedded-browser-pages-active, \.embedded-browser-device-toggle-active, \.embedded-browser-agent-access-active \{ color: var\(--text\); background: var\(--surface-hover\); \}/);
  assert.doesNotMatch(browser, /:value="deviceMetrics\.(?:width|height)"[\s\S]{0,120}?:disabled="deviceControlBusy"/);
  assert.match(browser, /class="embedded-browser-surface" :class="\{ 'device-mode': deviceMode \}"/);
  assert.match(browser, /\.embedded-browser-surface\.device-mode \.embedded-browser-device-stage \{[^}]*background: #16181d/);
  assert.match(browser, /\.embedded-browser-surface\.device-mode \.embedded-browser-device-frame \{[^}]*border: 0;[^}]*border-radius: 18px;[^}]*box-shadow: 0 20px 60px/);
  assert.doesNotMatch(browser, /\.embedded-browser\.device-mode/);
  assert.match(browser, /Emulation\.setDeviceMetricsOverride/);
  assert.match(browser, /Emulation\.clearDeviceMetricsOverride/);
  assert.match(browser, /Promise\.race\(\[[\s\S]*?sendDeviceCdp\(method, params\)[\s\S]*?DEVICE_COMMAND_TIMEOUT_MS/);
  assert.match(browser, /width: `\$\{deviceMetrics\.width\}px`[\s\S]*?height: `\$\{deviceMetrics\.height\}px`[\s\S]*?transform: `scale\(\$\{deviceScale\.value\}\)`/);
  assert.match(browser, /onDesktopBrowserDeviceMetricsChanged\(\(input\) => handleDeviceMetricsChanged\(input\)\)/);
  assert.match(browser, /input\.source !== "agent"/);
  assert.match(browser, /deviceMode\.value = true;\s*void nextTick\(updateDeviceScale\)/);
  assert.match(browser, /deviceMode\.value = false;\s*logDesktopBrowserDiagnostic\("browser device mode cleared by agent"/);
  assert.match(bridge, /onBrowserDeviceMetricsChanged/);
  assert.match(preload, /task-handoff:browser-device-metrics-changed/);
});

test("connected contexts stay in the pages menu and are not shown on the start page", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /t\("sessions\.browser\.browserContexts"\)/);
  assert.match(browser, /<div v-if="creationPanels\.length && !creationContextUnsupported" class="embedded-browser-pages-context">/);
  assert.match(browser, /pageHostLabel\(panel\.pageHost\)/);
  assert.doesNotMatch(browser, /embedded-browser-start-context/);
  assert.doesNotMatch(browser, /<section v-if="creationPanels\.length && !creationContextUnsupported" class="embedded-browser-start-section">/);
  assert.match(browser, /v-if="openPages\.length" class="embedded-browser-start-section"/);
});

test("browser popovers use collision-aware sizing and keep Agent panel actions in the list row", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /<PopoverContent class="embedded-browser-pages-menu p-0"/);
  assert.match(browser, /<PopoverContent class="embedded-browser-agent-access-menu p-0"/);
  assert.match(browser, /\.embedded-browser-pages-menu \{ display: flex; width: min\(360px, var\(--reka-popover-content-available-width\)\)/);
  assert.match(browser, /:global\(\.embedded-browser-agent-access-menu\) \{[^}]*width: min\(360px, var\(--reka-popover-content-available-width\)\); max-height: var\(--reka-popover-content-available-height\)/);
  assert.match(browser, /\.embedded-browser-pages-menu-head \{[^}]*padding: 8px 12px 6px;/);
  assert.match(browser, /<ScrollArea v-else-if="creationPanels\.length" class="embedded-browser-creation-panel-scroll"/);
  assert.match(browser, /<ul class="embedded-browser-creation-panel-list"[^>]*>\s*<li v-for="panel in creationPanels"/);
  assert.match(browser, /\.embedded-browser-creation-panel \{[^}]*grid-template-columns: 16px minmax\(0, 1fr\) auto;/);
  assert.match(browser, /<div class="embedded-browser-creation-panel-trailing">[\s\S]*?<Button\s+size="sm"[^>]*>\s*\{\{ t\(hasDefaultCreationContext \? "sessions\.browserDefaultActions\.takeOver" : "sessions\.browserDefaultActions\.set"\) \}\}/);
  assert.match(browser, /@click="revokeCreationContextForOwnPanel\(panel\)"\s*>\s*\{\{ t\("sessions\.browserDefaultActions\.clear"\) \}\}/);
  assert.match(browser, /<TooltipContent[^>]*>[\s\S]*?creationContextClaimHint[\s\S]*?<\/TooltipContent>/);
});

test("the Agent access popover exposes only the current panel's default switch", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /function isOwnCreationPanel\(panel: EmbeddedBrowserCreationPanel\)/);
  assert.match(browser, /panel\.sourceRef === browserSourceRef\.value/);
  assert.match(browser, /v-if="canClaimCreationPanel\(panel\)"/);
  assert.match(browser, /v-else-if="canRevokeCreationPanel\(panel\)"/);
  assert.match(browser, /creationContextTakeOver/);
  assert.match(browser, /creationContextRequestDefault/);
  assert.match(browser, /\.embedded-browser-pages-active, \.embedded-browser-device-toggle-active, \.embedded-browser-agent-access-active \{ color: var\(--text\); background: var\(--surface-hover\); \}/);
});

test("creation-context changes refresh the authoritative snapshot and explain default handoff", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  const events = source("useControlPlaneEvents.ts");
  assert.match(browser, /BROWSER_CREATION_CONTEXT_CHANGED_EVENT/);
  assert.match(browser, /EmbeddedBrowserCreationContextChangedEventSchema\.safeParse\([\s\S]*?\.\.\.payload[\s\S]*?type: "browser\.creation-context\.changed"/);
  assert.match(browser, /previousBrowserContextId === browserSourceRef\.value/);
  assert.match(browser, /refreshBrowserCreationContext\(\)\.then/);
  assert.match(browser, /creationContextTakenOver/);
  assert.match(browser, /BROWSER_DEFAULT_CONTEXT_CONFLICT/);
  assert.match(browser, /creationContextNoDefault/);
  assert.match(browser, /defaultCreationOffline/);
  assert.match(events, /BROWSER_CREATION_CONTEXT_CHANGED_EVENT, \{\}\)/);
});
