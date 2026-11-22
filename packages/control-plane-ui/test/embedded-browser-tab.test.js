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
  assert.match(component, /<webview v-if="context\?\.partition"[\s\S]*?src="about:blank"[\s\S]*?:partition="context\.partition"[\s\S]*?allowpopups/);
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
  assert.match(layer, /v-for="\(tabs, instanceId\) in browserSessionTabs"/);
  assert.match(layer, /<EmbeddedBrowserTab/);
  assert.match(layer, /visibility: visible \? "visible" : "hidden"/);
});

test("browser tabs are pruned only from a complete authoritative instance directory", () => {
  const workbench = source("ControlPlaneWorkbench.vue");
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  assert.match(sessions, /function pruneBrowserInstances\(validInstanceIds: ReadonlySet<string>\)/);
  assert.match(sessions, /if \(validInstanceIds\.has\(instanceId\)\) continue;[\s\S]*?delete browserSessionTabs\[instanceId\]/);
  assert.match(workbench, /const authoritativeInstanceIds = computed<ReadonlySet<string> \| undefined>/);
  assert.match(workbench, /instanceDirectoryComplete\.value[\s\S]*?new Set\(sortedInstances\.value\.map/);
  assert.match(workbench, /watch\(authoritativeInstanceIds,[\s\S]*?pruneBrowserInstances\(instanceIds\)/);
});

test("stable browser host lets the start page and guest fill the pane surface", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /\.embedded-browser \{[^}]*width: 100%; height: 100%;/);
  assert.match(browser, /\.embedded-browser-surface \{[^}]*min-height: 0;/);
  assert.match(browser, /\.embedded-browser-start-page \{[^}]*inset: 0;/);
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
  assert.match(workbench, /onBrowserNewTab\?\.\(\(\{ instanceId: sourceInstanceId, url, title, creationRef \}\) =>[\s\S]*?openBrowserTab\(instanceId, url, \{ title, creationRef \}\)/);
  assert.match(sessions, /function openBrowserTab\(instanceId: string, initialUrl\?: string, options: \{ title\?: string; creationRef\?: string \} = \{\}\)/);
  assert.match(sessions, /options\.creationRef \? \{ creationRef: options\.creationRef \} : \{\}/);
  assert.match(sessions, /status: initialUrl \? "loading" : "running"/);
  assert.match(sessions, /initialUrl \? \{ initialUrl \} : \{\}/);
  assert.match(layer, /:initial-url="typeof tab\.source\?\.currentUrl === 'string'/);
  assert.match(browser, /initialUrl\?: string/);
  assert.match(browser, /creationRef\?: string/);
  assert.match(browser, /props\.creationRef \? \{ creationRef: props\.creationRef \} : \{\}/);
  assert.match(browser, /await waitForGuestReady\(\)/);
  assert.match(browser, /function waitForGuestReady\(\)/);
  assert.match(browser, /function handleGuestDomReady\(\)/);
  assert.match(browser, /if \(!removeGuestListeners\) bindGuest\(\)/);
  assert.match(browser, /guest\.value\?\.loadURL\(url\)/);
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
  assert.match(layer, /\$emit\('updateBrowserTab', instanceId, tab\.key, patch\)/);
  assert.match(workbench, /@update-browser-tab="updateCombinedBrowserTab"/);
  assert.match(workbench, /function updateCombinedBrowserTab\(instanceId: string, sessionKey: string, patch:/);
  assert.match(sessions, /function updateBrowserTab\(/);
});

test("browser guests register their live tab identity after dom-ready and clear it on teardown", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  const bridge = fs.readFileSync(new URL("../src/lib/desktopBridge.ts", import.meta.url), "utf8");
  assert.match(browser, /function handleGuestDomReady\(\) \{\s*applyBackgroundThrottling\(\);\s*void registerGuestTab\(\);/);
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
  assert.match(layer, /@close-tab="\$emit\('closeBrowserTab', instanceId, tab\.key\)"/);
  assert.match(workbench, /@close-browser-tab="closeCombinedBrowserTab"/);
  assert.match(workbench, /function closeCombinedBrowserTab\(instanceId: string, sessionKey: string\)[\s\S]*?storyResourceSidebar\.removeBrowser\(storyResource\)[\s\S]*?stopSelectedAppSession\(instance, session\)/);
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
  assert.match(browser, /did-fail-load", failed as EventListener/);
  assert.match(browser, /class="embedded-browser-state-detail"/);
  assert.match(browser, /@click="retry"/);
  assert.match(browser, /t\("sessions\.browser\.retry"\)/);
});
