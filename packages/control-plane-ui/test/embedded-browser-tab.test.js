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
  assert.match(component, /<webview v-if="context\?\.partition"[\s\S]*?src="about:blank"[\s\S]*?:partition="context\.partition"[\s\S]*?allowpopups/);
  assert.match(component, /@dom-ready="handleGuestDomReady"/);
  assert.match(component, /prepareDesktopBrowserContext\(props\.instanceId\)/);
  assert.match(component, /result\.message \|\| \(result\.code/);
  assert.match(component, /releaseDesktopBrowserContext\(context\.value\.contextId\)/);
  assert.match(component, /if \(disposed\)[\s\S]*?releaseDesktopBrowserContext\(result\.contextId\)/);
  assert.match(component, /url\.protocol !== "http:" && url\.protocol !== "https:"/);
});

test("browser guests stay mounted while another tab in the same pane is selected", () => {
  const layer = source("instance-detail/EmbeddedBrowserSurfaceLayer.vue");
  const pane = source("instance-detail/SessionPaneContent.vue");
  assert.match(pane, /data-browser-surface/);
  assert.match(layer, /v-for="\(tabs, instanceId\) in browserSessionTabs"/);
  assert.match(layer, /<EmbeddedBrowserTab/);
  assert.match(layer, /visibility: visible \? "visible" : "hidden"/);
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
  assert.match(browser, /if \(!url \|\| url === "about:blank"\) \{[\s\S]*?address\.value = ""[\s\S]*?emit\("updateTab", \{ url: "about:blank" \}\)/);
  assert.match(browser, /async function dispatchPendingNavigation\(sequence: number\)/);
  assert.match(browser, /void dispatchPendingNavigation\(sequence\)/);
  assert.match(browser, /start-page-active.*webview \{ visibility: hidden; \}/);
});

test("ordinary web builds keep the browser launcher behind desktop bridge and capability", () => {
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  assert.match(sessions, /supportsBrowserTunnel\(activeInstance\.value\.capabilities\) \|\| supportsDirectoryBrowserTunnel\(activeInstance\.value\.capabilities\)/);
});

test("browser popup requests create a sibling browser tab with its initial URL", () => {
  const workbench = source("ControlPlaneWorkbench.vue");
  const sessions = source("instance-detail/useActiveInstanceSessions.ts");
  const layer = source("instance-detail/EmbeddedBrowserSurfaceLayer.vue");
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(workbench, /onBrowserNewTab\?\.\(\(\{ instanceId: sourceInstanceId, url \}\) =>[\s\S]*?openBrowserTab\(instanceId, url\)/);
  assert.match(sessions, /function openBrowserTab\(instanceId: string, initialUrl\?: string\)/);
  assert.match(sessions, /status: initialUrl \? "loading" : "running"/);
  assert.match(sessions, /initialUrl \? \{ initialUrl \} : \{\}/);
  assert.match(layer, /:initial-url="typeof tab\.source\?\.currentUrl === 'string'/);
  assert.match(browser, /initialUrl\?: string/);
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
  assert.match(browser, /emit\("updateTab", \{ title, status: "running" \}\)/);
  assert.match(browser, /emit\("updateTab", \{ url \}\)/);
  assert.match(browser, /emit\("updateTab", \{ status: "loading" \}\)/);
  assert.match(browser, /browser start page ready/);
  assert.match(browser, /did-finish-load/);
  assert.match(browser, /getTitle\?\.\(\)/);
  assert.match(preview, /session\.status === 'loading'/);
  assert.match(preview, /sessionDisplayName\(session, t\)/);
  assert.match(preview, /session\.kind === "embedded-browser"[\s\S]*?currentUrl/);
  assert.match(layer, /\$emit\('updateBrowserTab', instanceId, tab\.key, patch\)/);
  assert.match(workbench, /@update-browser-tab="\(instanceId, sessionKey, patch\) => updateBrowserTab\(instanceId, sessionKey, patch\)"/);
  assert.match(sessions, /function updateBrowserTab\(/);
});
