const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyMainWindowChromeDensity,
  applyWindowsTitleBarTheme,
  desktopTitleBarOptions,
  desktopWindowBackgroundColor,
  desktopWindowChromeMode,
  mainWindowChromeMetrics,
  windowsTitleBarOverlayOptions,
} = require("../src/window-chrome.cjs");

test("main window chrome metrics follow the renderer header density", () => {
  assert.deepEqual(mainWindowChromeMetrics("compact"), {
    height: 44,
    trafficLightPosition: { x: 16, y: 15 },
  });
  assert.deepEqual(mainWindowChromeMetrics("normal"), {
    height: 56,
    trafficLightPosition: { x: 16, y: 21 },
  });
});

test("compact density repositions macOS traffic lights", () => {
  const positions = [];
  const metrics = applyMainWindowChromeDensity({
    setWindowButtonPosition: (position) => positions.push(position),
  }, { density: "compact", platform: "darwin" });
  assert.equal(metrics.height, 44);
  assert.deepEqual(positions, [{ x: 16, y: 15 }]);
});

test("compact density resizes Windows native caption controls", () => {
  const overlays = [];
  const metrics = applyMainWindowChromeDensity({
    setTitleBarOverlay: (options) => overlays.push(options),
  }, { density: "compact", platform: "win32", theme: "light" });
  assert.equal(metrics.height, 44);
  assert.deepEqual(overlays, [{ color: "#00000000", symbolColor: "#17232a", height: 44 }]);
});

test("native window surfaces match the renderer theme while it catches up with resize", () => {
  assert.equal(desktopWindowBackgroundColor("dark"), "#071013");
  assert.equal(desktopWindowBackgroundColor("light"), "#eef3f4");
});

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
  const nativeTheme = { themeSource: "system" };
  const overlays = [];
  applyWindowsTitleBarTheme({ setTitleBarOverlay: (value) => overlays.push(value) }, nativeTheme, { height: 42, theme: "light" });
  assert.equal(nativeTheme.themeSource, "light");
  assert.deepEqual(overlays, [{ color: "#00000000", symbolColor: "#17232a", height: 42 }]);
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
