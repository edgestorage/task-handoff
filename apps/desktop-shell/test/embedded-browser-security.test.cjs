const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.resolve(__dirname, "../src/main.cjs"), "utf8");
const preload = fs.readFileSync(path.resolve(__dirname, "../src/preload.cjs"), "utf8");

test("trusted control plane windows enable webview tags with enforced guest isolation", () => {
  assert.match(main, /desktopWindowWebPreferences\(webviewTag = false\)/);
  assert.match(main, /will-attach-webview[\s\S]*?delete webPreferences\.preload[\s\S]*?sandbox = true[\s\S]*?nodeIntegration = false/);
  assert.match(main, /desktopBrowserContexts\?\.allows\(host\.id, partition\)/);
  assert.match(main, /browserTabUrlAllowed\(params\.src\)/);
});

test("guest navigation is limited to HTTP(S) while browser credentials remain in main", () => {
  assert.match(main, /url\.href === "about:blank" \|\| url\.protocol === "http:" \|\| url\.protocol === "https:"/);
  assert.match(main, /task-handoff:browser-context-prepare/);
  assert.match(main, /browserContextDiagnosticMessage\(code, error\)/);
  assert.match(main, /trustedControlPlaneSenderUrl\(event\.sender\)/);
  assert.match(main, /senderUrl\.origin !== controlPlaneUrl\.origin/);
  assert.doesNotMatch(preload, /browser.*token/i);
  assert.match(preload, /prepareBrowserContext/);
  assert.match(preload, /releaseBrowserContext/);
});

test("guest popups are routed to the renderer as browser tabs", () => {
  assert.match(main, /guest\.setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?host\.send\("task-handoff:browser-new-tab", \{ url: String\(url\),/);
  assert.match(preload, /onBrowserNewTab/);
});

test("guest address shortcuts are routed to the owning browser tab", () => {
  assert.match(main, /guest\.on\("before-input-event"[\s\S]*?input\.key\?\.toLowerCase\(\) !== "l"[\s\S]*?event\.preventDefault\(\)[\s\S]*?!host\.isDestroyed\(\)[\s\S]*?host\.send\("task-handoff:browser-focus-address", \{ webContentsId: guest\.id \}\)/);
  assert.match(preload, /onBrowserFocusAddress[\s\S]*?task-handoff:browser-focus-address/);
});

test("embedded browser context menu targets the guest page developer tools", () => {
  assert.match(main, /guest\.on\("context-menu"[\s\S]*?buildEmbeddedBrowserContextMenuTemplate\(\{[\s\S]*?guest,[\s\S]*?locale: app\.getLocale\(\)/);
  assert.match(main, /menu\.popup\(\{[\s\S]*?window: ownerWindow/);
});

test("application view menu targets the Control Plane renderer instead of the focused webview guest", () => {
  assert.match(main, /installDesktopApplicationMenu\(\{[\s\S]*?getWindow: activeControlPlaneWindow/);
  assert.match(main, /function isControlPlaneWindow\(window\)[\s\S]*?controlPlaneWindows\.metadata\(window\)/);
  assert.match(main, /function activeControlPlaneWindow\(\)[\s\S]*?BrowserWindow\.getFocusedWindow\(\)[\s\S]*?lastActiveControlPlaneWindow[\s\S]*?desktopWindows\?\.current\?\.\(\)/);
  assert.doesNotMatch(main, /role: "viewMenu"/);
});

test("browser tab control is scoped to a trusted renderer, partition, and opaque tabRef", () => {
  assert.match(main, /desktopBrowserRegistry\?\.addGuest\(\{ host, guest, partition, instanceId \}\)/);
  assert.match(main, /desktopBrowserRegistry\.getByGuestId\(webContentsId, event\.sender\.id\)/);
  assert.match(main, /entry\.instanceId \|\| desktopBrowserContexts\?\.instanceIdForPartition\(event\.sender\.id, entry\.partition\)/);
  assert.match(main, /task-handoff:browser-tab-register[\s\S]*?trustedControlPlaneSenderUrl\(event\.sender\)/);
  assert.match(main, /task-handoff:browser-tab-list[\s\S]*?listForRenderer\(\{ senderId: event\.sender\.id/);
  assert.match(main, /task-handoff:browser-tabs-changed/);
  assert.match(main, /task-handoff:browser-target-attach[\s\S]*?trustedControlPlaneSenderUrl\(event\.sender\)/);
  assert.match(main, /task-handoff:browser-cdp-send[\s\S]*?trustedControlPlaneSenderUrl\(event\.sender\)/);
  assert.match(preload, /registerBrowserTab[\s\S]*?task-handoff:browser-tab-register/);
  assert.match(preload, /onBrowserTabsChanged[\s\S]*?task-handoff:browser-tabs-changed/);
  assert.match(preload, /sendBrowserCdpCommand[\s\S]*?task-handoff:browser-cdp-send/);
  assert.doesNotMatch(preload, /partition.*ipcRenderer|ipcRenderer.*partition/);
});

test("same-document SPA navigation does not release renderer browser contexts", () => {
  assert.match(main, /host\.on\("did-start-navigation", \(_event, url, isInPlace, isMainFrame\) => \{[\s\S]*?if \(!isMainFrame \|\| isInPlace\) return;[\s\S]*?releaseSender\(host\.id\)/);
});

test("webview partition is captured from will-attach instead of relying on Session.getPartition", () => {
  const contexts = fs.readFileSync(path.resolve(__dirname, "../src/desktop-browser-contexts.cjs"), "utf8");
  assert.match(main, /queueBrowserWebviewAttachment\(host, \{ partition, instanceId \}\)/);
  assert.match(main, /instanceIdForSession\(host\.id, guest\.session\)/);
  assert.match(main, /takeBrowserWebviewAttachment\(host, sessionInstanceId\)/);
  assert.doesNotMatch(main, /guest\.session\?\.getPartition\?\.\(\)/);
  assert.match(contexts, /instanceIdForSession\(senderId, session\)/);
});
