const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EMBEDDED_BROWSER_PAGE_HOSTS,
  detectEmbeddedBrowserPagePoolApi,
  resolveEmbeddedBrowserPageHost,
} = require("../src/embedded-browser-page-host.cjs");

test("embedded browser defaults to the official Electron renderer webview host", () => {
  const resolved = resolveEmbeddedBrowserPageHost({});
  assert.equal(resolved.requestedPageHost, EMBEDDED_BROWSER_PAGE_HOSTS.rendererWebview);
  assert.equal(resolved.pageHost, EMBEDDED_BROWSER_PAGE_HOSTS.rendererWebview);
  assert.equal(resolved.degraded, false);
  assert.deepEqual(resolved.capabilities, {
    backgroundCreation: false,
    surviveHostWindowClose: false,
    crossWindowAdopt: false,
  });
});

test("an invalid page host flag degrades to renderer webview with a diagnostic", () => {
  const resolved = resolveEmbeddedBrowserPageHost({ TASK_HANDOFF_EMBEDDED_BROWSER_PAGE_HOST: "unsupported-host" }, true);
  assert.equal(resolved.pageHost, EMBEDDED_BROWSER_PAGE_HOSTS.rendererWebview);
  assert.equal(resolved.degraded, true);
  assert.equal(resolved.degradedReason, "invalid-configuration");
  assert.equal(resolved.customPagePoolAvailable, true);
});

test("requesting the main page pool without the custom API degrades instead of advertising capabilities", () => {
  const resolved = resolveEmbeddedBrowserPageHost({ TASK_HANDOFF_EMBEDDED_BROWSER_PAGE_HOST: "main-page-pool" }, false);
  assert.equal(resolved.requestedPageHost, EMBEDDED_BROWSER_PAGE_HOSTS.mainPagePool);
  assert.equal(resolved.pageHost, EMBEDDED_BROWSER_PAGE_HOSTS.rendererWebview);
  assert.equal(resolved.degraded, true);
  assert.equal(resolved.degradedReason, "page-pool-api-unavailable");
  assert.equal(resolved.capabilities.backgroundCreation, false);
  assert.equal(resolved.capabilities.surviveHostWindowClose, false);
  assert.equal(resolved.capabilities.crossWindowAdopt, false);
});

test("the main page pool is enabled only when the complete runtime API is present", () => {
  const complete = {
    createWebViewPage() {},
    getAllWebViewPages() {},
    fromWebViewPageId() {},
  };
  assert.equal(detectEmbeddedBrowserPagePoolApi(complete), true);
  assert.equal(detectEmbeddedBrowserPagePoolApi({ ...complete, fromWebViewPageId: undefined }), false);
  const resolved = resolveEmbeddedBrowserPageHost({ TASK_HANDOFF_EMBEDDED_BROWSER_PAGE_HOST: "main-page-pool" }, true);
  assert.equal(resolved.pageHost, EMBEDDED_BROWSER_PAGE_HOSTS.mainPagePool);
  assert.equal(resolved.degraded, false);
  assert.deepEqual(resolved.capabilities, {
    backgroundCreation: true,
    surviveHostWindowClose: true,
    crossWindowAdopt: true,
  });
});
