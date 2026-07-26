const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  desktopTitleBarOptions,
  desktopWindowChromeMode,
  windowsTitleBarOverlayOptions,
} = require("../src/window-chrome.cjs");

const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");

test("Windows uses native window controls overlay", () => {
  assert.equal(desktopWindowChromeMode("win32"), "windows-overlay");
  assert.deepEqual(desktopTitleBarOptions({ platform: "win32", height: 56 }), {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#e6f0f2",
      height: 56,
    },
  });
});

test("Windows overlay stays transparent and follows the content theme", () => {
  assert.deepEqual(windowsTitleBarOverlayOptions({ height: 42, theme: "dark" }), {
    color: "#00000000",
    symbolColor: "#e6f0f2",
    height: 42,
  });
  assert.deepEqual(windowsTitleBarOverlayOptions({ height: 42, theme: "light" }), {
    color: "#00000000",
    symbolColor: "#17232a",
    height: 42,
  });
});

test("Windows native caption hover follows the renderer theme", () => {
  assert.match(mainSource, /nativeTheme\.themeSource = theme;\s*targetWindow\.setTitleBarOverlay/);
});

test("macOS keeps its native inset traffic lights", () => {
  assert.equal(desktopWindowChromeMode("darwin"), "macos-overlay");
  assert.deepEqual(desktopTitleBarOptions({
    platform: "darwin",
    height: 56,
    trafficLightPosition: { x: 16, y: 21 },
  }), {
    frame: false,
    titleBarStyle: "hiddenInset",
    titleBarOverlay: { height: 56 },
    trafficLightPosition: { x: 16, y: 21 },
  });
});

test("other platforms retain the custom frame", () => {
  assert.equal(desktopWindowChromeMode("linux"), "custom");
  assert.deepEqual(desktopTitleBarOptions({ platform: "linux" }), { frame: false });
});
