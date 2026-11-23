const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertEmbeddedBrowserCdpMethod,
  embeddedBrowserCdpMethodKind,
  supportsEmbeddedBrowserCdpEvent,
} = require("../src/embedded-browser-cdp-policy.cjs");

test("the embedded browser accepts page-profile CDP domains and the Emulation namespace", () => {
  for (const method of ["Page.navigate", "Runtime.evaluate", "DOM.getDocument", "Accessibility.getFullAXTree", "Input.dispatchMouseEvent", "Page.captureScreenshot", "Emulation.setDeviceMetricsOverride", "Emulation.setUserAgentOverride"]) {
    assert.equal(assertEmbeddedBrowserCdpMethod(method), method);
  }
  assert.equal(assertEmbeddedBrowserCdpMethod("Network.enable"), "Network.enable");
  assert.equal(assertEmbeddedBrowserCdpMethod("Runtime.releaseObject"), "Runtime.releaseObject");
  assert.equal(assertEmbeddedBrowserCdpMethod("Page.handleJavaScriptDialog"), "Page.handleJavaScriptDialog");
  assert.equal(assertEmbeddedBrowserCdpMethod("Page.navigateToHistoryEntry"), "Page.navigateToHistoryEntry");
  assert.equal(assertEmbeddedBrowserCdpMethod("Network.emulateNetworkConditions"), "Network.emulateNetworkConditions");
  assert.equal(assertEmbeddedBrowserCdpMethod("Fetch.continueRequest"), "Fetch.continueRequest");
  assert.equal(embeddedBrowserCdpMethodKind("Page.navigate"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Runtime.evaluate"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Accessibility.getFullAXTree"), "read");
  assert.equal(embeddedBrowserCdpMethodKind("Emulation.setDeviceMetricsOverride"), "page-write");
  assert.equal(supportsEmbeddedBrowserCdpEvent("Page.lifecycleEvent"), true);
  assert.equal(supportsEmbeddedBrowserCdpEvent("Runtime.bindingCalled"), true);
  assert.equal(supportsEmbeddedBrowserCdpEvent("Fetch.requestPaused"), true);
});

test("the embedded browser rejects browser-level, target, and malformed CDP methods", () => {
  for (const method of ["Browser.getVersion", "Target.attachToTarget", "Target.createTarget", "SystemInfo.getInfo", "Storage.getCookies", "Page", "Page.navigate\nRuntime.evaluate", ""]) {
    assert.throws(() => assertEmbeddedBrowserCdpMethod(method), { code: "BROWSER_OPERATION_UNSUPPORTED" });
  }
  assert.equal(supportsEmbeddedBrowserCdpEvent("Target.targetCreated"), false);
});
