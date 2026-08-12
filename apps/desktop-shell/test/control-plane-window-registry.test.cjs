const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createControlPlaneWindowRegistry } = require("../src/control-plane-window-registry.cjs");

function fakeWindow() {
  const window = new EventEmitter();
  window.destroyed = false;
  window.focused = 0;
  window.shown = 0;
  window.isDestroyed = () => window.destroyed;
  window.isMinimized = () => false;
  window.show = () => { window.shown += 1; };
  window.focus = () => { window.focused += 1; };
  window.closed = 0;
  window.close = () => { window.closed += 1; window.destroyed = true; window.emit("closed"); };
  return window;
}

test("registry keeps one independent window per instance", () => {
  const registry = createControlPlaneWindowRegistry();
  const first = fakeWindow();
  const duplicate = fakeWindow();
  assert.equal(registry.register(first, { kind: "instance-detail", instanceId: "a" }).action, "registered");
  const result = registry.register(duplicate, { kind: "instance-detail", instanceId: "a" });
  assert.equal(result.action, "focused");
  assert.equal(result.window, first);
  assert.equal(first.focused, 1);
  assert.equal(registry.metadata(duplicate), undefined);
});

test("switch focuses an existing owner without releasing current instance", () => {
  const registry = createControlPlaneWindowRegistry();
  const first = fakeWindow();
  const second = fakeWindow();
  registry.register(first, { kind: "instance-detail", instanceId: "a" });
  registry.register(second, { kind: "instance-detail", instanceId: "b" });
  assert.deepEqual(registry.switchInstance(first, "b"), { action: "focused", instanceId: "b", focused: true });
  assert.equal(registry.metadata(first).instanceId, "a");
  assert.equal(second.focused, 1);
});

test("switch rebinds an unowned instance and close releases ownership", () => {
  const registry = createControlPlaneWindowRegistry();
  const first = fakeWindow();
  registry.register(first, { kind: "instance-detail", instanceId: "a" });
  assert.deepEqual(registry.switchInstance(first, "b"), { action: "switched", instanceId: "b" });
  assert.equal(registry.focusInstance("a"), undefined);
  first.destroyed = true;
  first.emit("closed");
  assert.equal(registry.focusInstance("b"), undefined);
});

test("repository windows do not claim instance ownership", () => {
  const registry = createControlPlaneWindowRegistry();
  const repository = fakeWindow();
  const detail = fakeWindow();
  registry.register(repository, { kind: "repository" });
  assert.equal(registry.register(detail, { kind: "instance-detail", instanceId: "a" }).action, "registered");
  assert.equal(registry.windows().length, 2);
});

test("switch rejects unregistered and non-instance sender windows", () => {
  const registry = createControlPlaneWindowRegistry();
  const unregistered = fakeWindow();
  const repository = fakeWindow();
  registry.register(repository, { kind: "repository" });
  assert.deepEqual(registry.switchInstance(unregistered, "a"), { action: "error", code: "not-instance-window" });
  assert.deepEqual(registry.switchInstance(repository, "a"), { action: "error", code: "not-instance-window" });
});

test("explicit shutdown closes and releases every registered child window", () => {
  const registry = createControlPlaneWindowRegistry();
  const repository = fakeWindow();
  const detail = fakeWindow();
  registry.register(repository, { kind: "repository" });
  registry.register(detail, { kind: "instance-detail", instanceId: "a" });
  registry.closeAll();
  assert.equal(repository.closed, 1);
  assert.equal(detail.closed, 1);
  assert.equal(registry.windows().length, 0);
  assert.equal(registry.focusInstance("a"), undefined);
});
