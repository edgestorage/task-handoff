const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDesktopApplicationMenuTemplate,
  desktopApplicationMenuLabels,
  installDesktopApplicationMenu,
} = require("../src/desktop-application-menu.cjs");

function fakeWindow(contents) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    isFullScreen: () => false,
    setFullScreen: (value) => calls.push(["setFullScreen", value]),
    webContents: {
      isDestroyed: () => false,
      reload: () => calls.push(["reload"]),
      reloadIgnoringCache: () => calls.push(["reloadIgnoringCache"]),
      toggleDevTools: () => calls.push(["toggleDevTools"]),
      getZoomLevel: () => contents?.zoomLevel ?? 0,
      setZoomLevel: (value) => calls.push(["setZoomLevel", value]),
    },
  };
}

function viewMenu(template) {
  return template.find((item) => item.label === "View" || item.label === "视图").submenu;
}

test("application menu actions always target the provided Control Plane window", () => {
  const window = fakeWindow();
  const template = buildDesktopApplicationMenuTemplate({
    platform: "darwin",
    locale: "en-US",
    getWindow: () => window,
  });
  const menu = viewMenu(template);

  menu.find((item) => item.label === "Reload").click();
  menu.find((item) => item.label === "Force Reload").click();
  menu.find((item) => item.label === "Toggle Developer Tools").click();
  menu.find((item) => item.label === "Actual Size").click();
  menu.find((item) => item.label === "Zoom In").click();
  menu.find((item) => item.label === "Zoom Out").click();

  assert.deepEqual(window.calls, [
    ["reload"],
    ["reloadIgnoringCache"],
    ["toggleDevTools"],
    ["setZoomLevel", 0],
    ["setZoomLevel", 1],
    ["setZoomLevel", -1],
  ]);

  menu.find((item) => item.label === "Toggle Full Screen").click();
  assert.deepEqual(window.calls.at(-1), ["setFullScreen", true]);
});

test("application menu resolves the active Control Plane window at click time", () => {
  const first = fakeWindow();
  const second = fakeWindow();
  let active = first;
  const template = buildDesktopApplicationMenuTemplate({
    platform: "linux",
    locale: "zh-CN",
    getWindow: () => active,
  });

  viewMenu(template).find((item) => item.label === "切换开发者工具").click();
  active = second;
  viewMenu(template).find((item) => item.label === "切换开发者工具").click();

  assert.deepEqual(first.calls, [["toggleDevTools"]]);
  assert.deepEqual(second.calls, [["toggleDevTools"]]);
});

test("application menu labels follow the desktop locale", () => {
  assert.equal(desktopApplicationMenuLabels("zh-CN").toggleDeveloperTools, "切换开发者工具");
  assert.equal(desktopApplicationMenuLabels("en-US").toggleDeveloperTools, "Toggle Developer Tools");
});

test("installing the application menu replaces Electron's focus-dependent default menu", () => {
  const installed = [];
  installDesktopApplicationMenu({
    Menu: {
      buildFromTemplate: (template) => template,
      setApplicationMenu: (menu) => installed.push(menu),
    },
    platform: "darwin",
    locale: "en-US",
    getWindow: () => fakeWindow(),
  });

  assert.equal(installed.length, 1);
  assert.equal(installed[0][0].role, "appMenu");
  assert.equal(viewMenu(installed[0]).some((item) => item.role === "viewMenu"), false);
});
