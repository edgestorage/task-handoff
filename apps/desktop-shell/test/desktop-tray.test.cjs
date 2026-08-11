const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createDesktopServiceSupervisor } = require("../src/desktop-service-supervisor.cjs");
const { createDesktopTray, createTrayImage } = require("../src/desktop-tray.cjs");

class FakeTray extends EventEmitter {
  constructor(image) { super(); this.image = image; }
  setToolTip(value) { this.tooltip = value; }
  setContextMenu(value) { this.menu = value; }
  destroy() { this.destroyed = true; }
}

function images() {
  const resized = { setTemplateImage(value) { this.template = value; } };
  return {
    resized,
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: (size) => { resized.size = size; return resized; } }) },
  };
}

test("tray menu shows authoritative aggregate and component service status", () => {
  const supervisor = createDesktopServiceSupervisor();
  const { nativeImage } = images();
  const tray = createDesktopTray({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage,
    iconPath: "/icon.png",
    platform: "win32",
    locale: "zh-CN",
    supervisor,
    onOpen: () => undefined,
    onQuit: () => undefined,
  });
  supervisor.markStarting();
  supervisor.markNodeAgentRunning();
  supervisor.markRunning("http://127.0.0.1:18081");
  assert.match(tray.tray.tooltip, /运行中/);
  assert.ok(tray.tray.menu.some((item) => item.label === "服务：运行中"));
  assert.ok(tray.tray.menu.some((item) => item.label === "Control Plane：运行中"));
  assert.ok(tray.tray.menu.some((item) => item.label === "Node Agent：运行中"));
  tray.destroy();
  assert.equal(tray.tray.destroyed, true);
});

test("macOS tray image is resized and marked as a template image", () => {
  const { nativeImage, resized } = images();
  assert.equal(createTrayImage(nativeImage, "/icon.png", "darwin"), resized);
  assert.deepEqual(resized.size, { width: 18, height: 18 });
  assert.equal(resized.template, true);
});
