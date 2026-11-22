const assert = require("node:assert/strict");
const test = require("node:test");
const {
  embeddedBrowserCdpIdentity,
  webkitVersionFromUserAgent,
} = require("../src/embedded-browser-runtime.cjs");

test("embedded browser CDP identity mirrors the Electron Chromium runtime", () => {
  const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @task-handoff/desktop-shell/1.0.0 Chrome/150.0.7871.47 Electron/43.1.0 Safari/537.36";
  assert.deepEqual(embeddedBrowserCdpIdentity({
    userAgent,
    versions: { chrome: "150.0.7871.47", v8: "15.0.245.15-electron.0" },
  }), {
    chromeVersion: "150.0.7871.47",
    userAgent,
    v8Version: "15.0.245.15-electron.0",
    webkitVersion: "537.36",
  });
  assert.equal(webkitVersionFromUserAgent("no webkit token"), "537.36");
  assert.equal(embeddedBrowserCdpIdentity({ userAgent, versions: {} }), undefined);
});
