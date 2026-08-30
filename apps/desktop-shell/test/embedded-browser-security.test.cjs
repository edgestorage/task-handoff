const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.resolve(__dirname, "../src/main.cjs"), "utf8");
const preload = fs.readFileSync(path.resolve(__dirname, "../src/preload.cjs"), "utf8");

test("trusted control plane windows enable webview tags with enforced guest isolation", () => {
  assert.match(main, /desktopWindowWebPreferences\(webviewTag = false\)/);
  assert.match(main, /will-attach-webview[\s\S]*?delete webPreferences\.preload[\s\S]*?sandbox = true[\s\S]*?nodeIntegration = false/);
  assert.match(main, /desktopBrowserContexts\?\.allows\(host\.id, params\.partition\)/);
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
