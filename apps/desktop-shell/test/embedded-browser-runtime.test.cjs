const assert = require("node:assert/strict");
const test = require("node:test");
const {
  embeddedBrowserCdpIdentity,
  embeddedBrowserChromeUserAgent,
  webkitVersionFromUserAgent,
} = require("../src/embedded-browser-runtime.cjs");

test("embedded browser presents the Chromium runtime as desktop Chrome", () => {
  const electronUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @task-handoff/desktop-shell/1.0.0 Chrome/150.0.7871.47 Electron/43.1.0 Safari/537.36";
  assert.equal(embeddedBrowserChromeUserAgent({
    userAgent: electronUserAgent,
    versions: { chrome: "150.0.7871.47" },
  }), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36");
  assert.equal(embeddedBrowserChromeUserAgent({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) @task-handoff/desktop-shell/1.0.0 Chrome/150.0.7871.47 Electron/43.1.0 Safari/537.36",
    versions: { chrome: "150.0.7871.47" },
  }), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36");
  assert.equal(embeddedBrowserChromeUserAgent({
    userAgent: "",
    versions: { chrome: "150.0.7871.47" },
    platform: "win32",
    arch: "x64",
  }), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36");
  assert.equal(embeddedBrowserChromeUserAgent({ versions: { chrome: "" } }), "");
});

test("embedded browser CDP identity mirrors the Electron Chromium runtime", () => {
  const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
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
