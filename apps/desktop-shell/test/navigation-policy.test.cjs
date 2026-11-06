const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { externalNavigationUrl, isAllowedControlPlaneNavigation } = require("../src/navigation-policy.cjs");

const controlPlaneOrigin = "http://127.0.0.1:18081";
const mainSource = fs.readFileSync(path.resolve(__dirname, "../src/main.cjs"), "utf8");

test("control-plane navigation only allows the trusted origin", () => {
  assert.equal(isAllowedControlPlaneNavigation("http://127.0.0.1:18081/story/one", controlPlaneOrigin), true);
  assert.equal(isAllowedControlPlaneNavigation("https://127.0.0.1:18081/story/one", controlPlaneOrigin), false);
  assert.equal(isAllowedControlPlaneNavigation("http://127.0.0.1:18082/story/one", controlPlaneOrigin), false);
  assert.equal(isAllowedControlPlaneNavigation("http://localhost:18081/story/one", controlPlaneOrigin), false);
  assert.equal(isAllowedControlPlaneNavigation("https://www.baidu.com/", controlPlaneOrigin), false);
  assert.equal(isAllowedControlPlaneNavigation("file:///tmp/story.md", controlPlaneOrigin), false);
  assert.equal(isAllowedControlPlaneNavigation("about:blank", controlPlaneOrigin), true);
});

test("external navigation delegates only supported URLs to the system", () => {
  assert.equal(externalNavigationUrl("https://www.baidu.com/"), "https://www.baidu.com/");
  assert.equal(externalNavigationUrl("mailto:owner@example.com"), "mailto:owner@example.com");
  assert.equal(externalNavigationUrl("file:///tmp/story.md"), undefined);
  assert.equal(externalNavigationUrl("javascript:alert(1)"), undefined);
});

test("both control-plane window kinds install the cross-origin navigation guard", () => {
  assert.match(mainSource, /webContents\.on\("will-navigate", blockExternalNavigation\)/);
  assert.match(mainSource, /webContents\.on\("will-redirect", blockExternalNavigation\)/);
  assert.match(mainSource, /guardControlPlaneNavigation\(mainWindow\.webContents, navigationOrigin\(url\)\)/);
  assert.match(mainSource, /guardControlPlaneNavigation\(controlPlaneWindow\.webContents, parsedUrl\.origin\)/);
});
