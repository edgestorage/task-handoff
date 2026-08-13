const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createDesktopServiceSupervisor } = require("../src/desktop-service-supervisor.cjs");
const { buildInstanceMenuItems, createDesktopTray, createTrayImage } = require("../src/desktop-tray.cjs");

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
  let settingsOpened = 0;
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
    onSettings: () => { settingsOpened += 1; },
    onQuit: () => undefined,
  });
  supervisor.markStarting();
  supervisor.markNodeAgentRunning();
  supervisor.markRunning("http://127.0.0.1:18081");
  assert.match(tray.tray.tooltip, /运行中/);
  assert.ok(tray.tray.menu.some((item) => item.label === "服务：运行中"));
  assert.ok(tray.tray.menu.some((item) => item.label === "Control Plane：运行中"));
  assert.ok(tray.tray.menu.some((item) => item.label === "Node Agent：运行中"));
  tray.tray.menu.find((item) => item.label === "设置").click();
  assert.equal(settingsOpened, 1);
  tray.destroy();
  assert.equal(tray.tray.destroyed, true);
});

test("tray click activates an existing window while only the explicit menu item opens the main window", () => {
  const supervisor = createDesktopServiceSupervisor();
  const actions = [];
  const { nativeImage } = images();
  const tray = createDesktopTray({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage,
    iconPath: "/icon.png",
    platform: "darwin",
    locale: "en-US",
    supervisor,
    onActivateExisting: () => actions.push("activate"),
    onOpen: () => actions.push("open"),
    onQuit: () => undefined,
  });

  tray.tray.emit("click");
  tray.tray.menu.find((item) => item.label === "Open Main Window").click();
  assert.deepEqual(actions, ["activate", "open"]);
  tray.destroy();
});

test("macOS tray image is resized and marked as a template image", () => {
  const { nativeImage, resized } = images();
  assert.equal(createTrayImage(nativeImage, "/icon.png", "darwin"), resized);
  assert.deepEqual(resized.size, { width: 18, height: 18 });
  assert.equal(resized.template, true);
});

test("tray expands up to ten instances under a first-level node heading", async () => {
  const supervisor = createDesktopServiceSupervisor();
  const opened = [];
  const { nativeImage } = images();
  const tray = createDesktopTray({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage,
    iconPath: "/tray-icon.png",
    platform: "darwin",
    locale: "zh-CN",
    supervisor,
    loadInstances: async () => [{
      nodeId: "node-a",
      nodeName: "Node A",
      instances: [{ id: "instance-a", name: "Instance A" }],
    }],
    onOpenInstance: (instanceId) => opened.push(instanceId),
    onOpen: () => undefined,
    onQuit: () => undefined,
  });
  supervisor.markRunning("http://127.0.0.1:18081");
  await tray.refreshInstances();
  assert.equal(tray.tray.menu.some((item) => item.label === "实例" || item.label === "Instances"), false);
  const node = tray.tray.menu.find((item) => item.label === "Node A");
  const instance = tray.tray.menu.find((item) => item.label === "Instance A");
  assert.equal(node.enabled, false);
  assert.equal(node.submenu, undefined);
  instance.click();
  assert.deepEqual(opened, ["instance-a"]);
  tray.destroy();
});

test("tray collapses only node groups with more than ten instances", () => {
  const groups = [
    {
      nodeId: "node-a",
      nodeName: "Node A",
      instances: Array.from({ length: 10 }, (_, index) => ({ id: `a-${index}`, name: `A ${index}` })),
    },
    {
      nodeId: "node-b",
      nodeName: "Node B",
      instances: Array.from({ length: 11 }, (_, index) => ({ id: `b-${index}`, name: `B ${index}` })),
    },
  ];

  const items = buildInstanceMenuItems(groups, () => undefined);
  const expandedNode = items.find((item) => item.label === "Node A");
  const collapsedNode = items.find((item) => item.label === "Node B");
  assert.equal(expandedNode.enabled, false);
  assert.equal(expandedNode.submenu, undefined);
  assert.deepEqual(items.slice(1, 11).map((item) => item.label), Array.from({ length: 10 }, (_, index) => `A ${index}`));
  assert.deepEqual(collapsedNode.submenu.map((item) => item.label), Array.from({ length: 11 }, (_, index) => `B ${index}`));
});
