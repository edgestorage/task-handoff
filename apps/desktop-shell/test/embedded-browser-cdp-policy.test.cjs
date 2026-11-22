const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertEmbeddedBrowserCdpMethod,
  embeddedBrowserCdpMethodKind,
  supportsEmbeddedBrowserCdpEvent,
} = require("../src/embedded-browser-cdp-policy.cjs");

test("the embedded browser accepts page-profile CDP domains", () => {
  for (const method of ["Page.navigate", "Runtime.evaluate", "DOM.getDocument", "Accessibility.getFullAXTree", "Input.dispatchMouseEvent", "Page.captureScreenshot"]) {
    assert.equal(assertEmbeddedBrowserCdpMethod(method), method);
  }
  assert.equal(assertEmbeddedBrowserCdpMethod("Network.enable", { adapterOnly: true }), "Network.enable");
  assert.equal(embeddedBrowserCdpMethodKind("Page.navigate"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Runtime.evaluate"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Accessibility.getFullAXTree"), "read");
  assert.equal(supportsEmbeddedBrowserCdpEvent("Page.lifecycleEvent"), true);
});

test("the embedded browser rejects browser-level, target, and malformed CDP methods", () => {
  for (const method of ["Browser.getVersion", "Target.attachToTarget", "Target.createTarget", "SystemInfo.getInfo", "Storage.getCookies", "Network.enable", "Page", "Page.navigate\nRuntime.evaluate", ""]) {
    assert.throws(() => assertEmbeddedBrowserCdpMethod(method), { code: "BROWSER_OPERATION_UNSUPPORTED" });
  }
  assert.equal(supportsEmbeddedBrowserCdpEvent("Target.targetCreated"), false);
});
