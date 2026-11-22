const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildEmbeddedBrowserContextMenuTemplate,
  embeddedBrowserContextMenuLabels,
} = require("../src/embedded-browser-context-menu.cjs");

function fakeGuest(calls) {
  return {
    isDestroyed: () => false,
    openDevTools: (options) => calls.push(["openDevTools", options]),
    inspectElement: (x, y) => calls.push(["inspectElement", x, y]),
  };
}

test("embedded browser context menu exposes localized inspection and developer tools actions", () => {
  assert.deepEqual(embeddedBrowserContextMenuLabels("zh-CN"), {
    inspectElement: "检查元素",
    developerTools: "开发者工具",
  });
  assert.deepEqual(embeddedBrowserContextMenuLabels("en-US"), {
    inspectElement: "Inspect Element",
    developerTools: "Developer Tools",
  });

  const template = buildEmbeddedBrowserContextMenuTemplate({
    guest: fakeGuest([]),
    locale: "zh-CN",
    params: { x: 12, y: 34 },
  });

  assert.deepEqual(template.map((item) => item.label || item.type), ["检查元素", "separator", "开发者工具"]);
});

test("developer tools opens on the embedded page guest window", () => {
  const calls = [];
  const guest = fakeGuest(calls);
  const template = buildEmbeddedBrowserContextMenuTemplate({
    guest,
    locale: "en-US",
    params: { x: 12, y: 34 },
  });

  template.find((item) => item.label === "Developer Tools").click();

  assert.deepEqual(calls, [["openDevTools", { mode: "detach", activate: true }]]);
});

test("inspect element opens developer tools before selecting the clicked node", () => {
  const calls = [];
  const guest = fakeGuest(calls);
  const template = buildEmbeddedBrowserContextMenuTemplate({
    guest,
    locale: "zh-CN",
    params: { x: 12, y: 34 },
  });

  template.find((item) => item.label === "检查元素").click();

  assert.deepEqual(calls, [
    ["openDevTools", { mode: "detach", activate: true }],
    ["inspectElement", 12, 34],
  ]);
});
