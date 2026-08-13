const assert = require("node:assert/strict");
const test = require("node:test");
const { createDesktopDockMenu } = require("../src/desktop-dock-menu.cjs");

test("macOS dock menu mirrors the tray instance grouping and opens an instance window", () => {
  const menus = [];
  const opened = [];
  let mainWindowOpened = 0;
  const dockMenu = createDesktopDockMenu({
    dock: { setMenu: (menu) => menus.push(menu) },
    Menu: { buildFromTemplate: (template) => template },
    locale: "zh-CN",
    onOpen: () => { mainWindowOpened += 1; },
    onOpenInstance: (instanceId) => opened.push(instanceId),
  });

  dockMenu.update({
    state: "ready",
    groups: [{
      nodeId: "node-a",
      nodeName: "Node A",
      instances: [{ id: "instance-a", name: "Instance A" }],
    }],
  });

  const menu = menus.at(-1);
  menu.find((item) => item.label === "打开主窗口").click();
  assert.equal(mainWindowOpened, 1);
  assert.equal(menu[1].type, "separator");
  assert.equal(menu.find((item) => item.label === "Node A").enabled, false);
  menu.find((item) => item.label === "Instance A").click();
  assert.deepEqual(opened, ["instance-a"]);
  dockMenu.destroy();
  assert.deepEqual(menus.at(-1), []);
});

test("macOS dock menu only collapses a node group after ten instances", () => {
  const menus = [];
  const dockMenu = createDesktopDockMenu({
    dock: { setMenu: (menu) => menus.push(menu) },
    Menu: { buildFromTemplate: (template) => template },
    locale: "en-US",
  });
  dockMenu.update({
    state: "ready",
    groups: [{
      nodeId: "node-a",
      nodeName: "Node A",
      instances: Array.from({ length: 11 }, (_, index) => ({ id: `instance-${index}`, name: `Instance ${index}` })),
    }],
  });
  assert.equal(menus.at(-1).find((item) => item.label === "Node A").submenu.length, 11);
});
