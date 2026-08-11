const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createDesktopWindowManager } = require("../src/desktop-window-manager.cjs");

function fakeWindow() {
  const window = new EventEmitter();
  window.destroyed = false;
  window.hidden = false;
  window.shown = 0;
  window.focused = 0;
  window.isDestroyed = () => window.destroyed;
  window.isMinimized = () => false;
  window.show = () => { window.hidden = false; window.shown += 1; };
  window.hide = () => { window.hidden = true; };
  window.focus = () => { window.focused += 1; };
  return window;
}

test("desktop window manager backgrounds and restores without recreating services", () => {
  let creates = 0;
  const endpoints = [];
  const manager = createDesktopWindowManager({
    endpoint: () => "http://127.0.0.1:18087",
    create: (endpoint) => { creates += 1; endpoints.push(endpoint); return fakeWindow(); },
  });
  const first = manager.open();
  manager.background();
  assert.equal(first.hidden, true);
  assert.equal(manager.presentation(), "background");
  assert.equal(manager.open(), first);
  assert.equal(creates, 1);
  assert.deepEqual(endpoints, ["http://127.0.0.1:18087"]);
});

test("desktop window manager recreates a destroyed window with the current endpoint", () => {
  let endpoint = "http://127.0.0.1:18081";
  const windows = [];
  const manager = createDesktopWindowManager({
    endpoint: () => endpoint,
    create: () => { const window = fakeWindow(); windows.push(window); return window; },
  });
  const first = manager.open();
  first.destroyed = true;
  first.emit("closed");
  endpoint = "http://127.0.0.1:18082";
  const second = manager.open();
  assert.notEqual(second, first);
  assert.equal(windows.length, 2);
});

test("desktop window manager does not guess a default endpoint while services are starting", () => {
  let creates = 0;
  const manager = createDesktopWindowManager({
    endpoint: () => undefined,
    create: () => { creates += 1; return fakeWindow(); },
  });
  assert.equal(manager.open(), undefined);
  assert.equal(creates, 0);
});
