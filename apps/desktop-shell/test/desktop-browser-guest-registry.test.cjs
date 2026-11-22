const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { DesktopBrowserGuestRegistry } = require("../src/desktop-browser-guest-registry.cjs");

function fakeGuest(id = 41, debuggerApi = new EventEmitter()) {
  const guest = new EventEmitter();
  guest.id = id;
  guest.destroyed = false;
  guest.debugger = debuggerApi;
  guest.close = () => {
    guest.destroyed = true;
    guest.emit("destroyed");
  };
  return guest;
}

function fakeHost(id = 11) {
  return { id };
}

function registry(options = {}) {
  let sequence = 0;
  return new DesktopBrowserGuestRegistry({ createId: () => `browser_tab_test_${++sequence}`, ...options });
}

test("register keeps a stable opaque tabRef and never exposes the renderer local session key", () => {
  const store = registry();
  const guest = fakeGuest();
  const host = fakeHost();
  store.addGuest({ host, guest, partition: "persist:instance-a" });

  const first = store.register({ senderId: host.id, webContentsId: guest.id, instanceId: "instance-a", sessionKey: "local-only-key", partition: "persist:instance-a" });
  const second = store.register({ senderId: host.id, webContentsId: guest.id, instanceId: "instance-a", sessionKey: "local-only-key", partition: "persist:instance-a" });

  assert.equal(first.tabRef, "browser_tab_test_1");
  assert.equal(second.tabRef, first.tabRef);
  assert.equal("sessionKey" in first, false);
  assert.equal("webContentsId" in first, false);
  assert.equal(first.pageHost, "renderer-webview");
  assert.deepEqual(first.pageHostCapabilities, {
    backgroundCreation: false,
    surviveHostWindowClose: false,
    crossWindowAdopt: false,
  });
});

test("register keeps the Agent creation reference private for channel completion", () => {
  const changes = [];
  const store = registry({ onChanged: (change) => changes.push(change) });
  const guest = fakeGuest();
  const host = fakeHost();
  store.addGuest({ host, guest, partition: "persist:instance-a" });

  const tab = store.register({
    senderId: host.id,
    webContentsId: guest.id,
    instanceId: "instance-a",
    sessionKey: "local-only-key",
    partition: "persist:instance-a",
    creationRef: "bcr_created",
  });

  assert.equal("creationRef" in tab, false);
  assert.equal(changes[0].creationRef, "bcr_created");
});

test("registry rejects another renderer, partition, or conflicting local session key", () => {
  const store = registry();
  const host = fakeHost();
  const guest = fakeGuest();
  store.addGuest({ host, guest, partition: "persist:instance-a", instanceId: "instance-a" });
  store.register({ senderId: host.id, webContentsId: guest.id, instanceId: "instance-a", sessionKey: "key-a", partition: "persist:instance-a" });

  assert.throws(() => store.register({ senderId: 99, webContentsId: guest.id, instanceId: "instance-a", sessionKey: "key-a" }), { code: "BROWSER_GUEST_NOT_FOUND" });
  assert.throws(() => store.register({ senderId: host.id, webContentsId: guest.id, instanceId: "instance-a", sessionKey: "key-a", partition: "persist:other" }), { code: "BROWSER_GUEST_PARTITION_MISMATCH" });
  assert.throws(() => store.register({ senderId: host.id, webContentsId: guest.id, instanceId: "instance-b", sessionKey: "key-b", partition: "persist:instance-a" }), { code: "BROWSER_GUEST_PARTITION_MISMATCH" });

  const otherGuest = fakeGuest(42);
  store.addGuest({ host, guest: otherGuest, partition: "persist:instance-a" });
  assert.throws(() => store.register({ senderId: host.id, webContentsId: otherGuest.id, instanceId: "instance-a", sessionKey: "key-a", partition: "persist:instance-a" }), { code: "BROWSER_SESSION_KEY_CONFLICT" });
});

test("guest keeps the authorized instance captured at attach after its context lease is gone", () => {
  const store = registry();
  const host = fakeHost();
  const guest = fakeGuest();
  store.addGuest({ host, guest, partition: "persist:instance-a", instanceId: "instance-a" });

  const tab = store.register({ senderId: host.id, webContentsId: guest.id, instanceId: "instance-a", sessionKey: "key-a", partition: "persist:instance-a" });

  assert.equal(tab.instanceId, "instance-a");
});

test("updates and list calls are scoped to the owning renderer and instance", () => {
  const store = registry();
  const hostA = fakeHost(11);
  const hostB = fakeHost(12);
  const guestA = fakeGuest(41);
  const guestB = fakeGuest(42);
  store.addGuest({ host: hostA, guest: guestA, partition: "persist:instance-a" });
  store.addGuest({ host: hostB, guest: guestB, partition: "persist:instance-b" });
  const tabA = store.register({ senderId: hostA.id, webContentsId: guestA.id, instanceId: "instance-a", sessionKey: "key-a", partition: "persist:instance-a", url: "about:blank", state: "ready" });
  store.register({ senderId: hostB.id, webContentsId: guestB.id, instanceId: "instance-b", sessionKey: "key-b", partition: "persist:instance-b" });

  const updated = store.update({ senderId: hostA.id, tabRef: tabA.tabRef, title: "Example", url: "https://example.com", state: "running" });
  assert.equal(updated.title, "Example");
  assert.equal(updated.url, "https://example.com");
  assert.equal(store.list({ senderId: hostA.id }).length, 1);
  assert.equal(store.list({ senderId: hostA.id, instanceId: "instance-b" }).length, 0);
  assert.equal(store.list({ senderId: hostB.id }).length, 1);
  assert.throws(() => store.update({ senderId: hostB.id, tabRef: tabA.tabRef, title: "wrong owner" }), { code: "BROWSER_TAB_NOT_FOUND" });
});

test("renderer snapshots expose local session keys without widening the control DTO", () => {
  const store = registry();
  const host = fakeHost();
  const guest = fakeGuest();
  store.addGuest({ host, guest, partition: "persist:instance-a" });
  store.register({
    senderId: host.id,
    webContentsId: guest.id,
    instanceId: "instance-a",
    sessionKey: "embedded-browser:local",
    partition: "persist:instance-a",
    title: "Example",
    url: "https://example.com",
  });

  assert.equal("sessionKey" in store.list({ senderId: host.id })[0], false);
  assert.deepEqual(store.listForRenderer({ senderId: host.id, instanceId: "instance-a" }).map((tab) => ({
    sessionKey: tab.sessionKey,
    title: tab.title,
    url: tab.url,
    hasTabRef: Boolean(tab.tabRef),
  })), [{
    sessionKey: "embedded-browser:local",
    title: "Example",
    url: "https://example.com",
    hasTabRef: true,
  }]);
});

test("CDP attach, send and detach stay bound to the registered guest", async () => {
  const debuggerApi = new EventEmitter();
  const calls = [];
  debuggerApi.attach = (version) => calls.push(["attach", version]);
  debuggerApi.detach = () => calls.push(["detach"]);
  debuggerApi.isAttached = () => false;
  debuggerApi.sendCommand = async (method, params) => ({ method, params });
  const store = registry();
  const host = fakeHost();
  const guest = fakeGuest(41, debuggerApi);
  store.addGuest({ host, guest, partition: "persist:instance-a" });
  const tab = store.register({ senderId: host.id, webContentsId: guest.id, instanceId: "instance-a", sessionKey: "key-a", partition: "persist:instance-a" });

  store.attachDebugger({ tabRef: tab.tabRef, senderId: host.id });
  assert.deepEqual(calls, [["attach", "1.3"]]);
  assert.deepEqual(await store.sendCommand({ tabRef: tab.tabRef, senderId: host.id, method: "Page.getNavigationHistory", params: {} }), { method: "Page.getNavigationHistory", params: {} });
  debuggerApi.emit("detach");
  await assert.rejects(store.sendCommand({ tabRef: tab.tabRef, senderId: host.id, method: "Page.reload" }), { code: "BROWSER_TARGET_NOT_ATTACHED" });
  store.attachDebugger({ tabRef: tab.tabRef, senderId: host.id });
  store.detachDebugger({ tabRef: tab.tabRef, senderId: host.id });
  assert.deepEqual(calls.map(([name]) => name), ["attach", "attach", "detach"]);
});

test("Page.reload stays scoped to the guest webContents instead of the embedding renderer", async () => {
  const debuggerCalls = [];
  const reloads = [];
  const debuggerApi = new EventEmitter();
  debuggerApi.attach = () => undefined;
  debuggerApi.isAttached = () => false;
  debuggerApi.sendCommand = async (method, params) => {
    debuggerCalls.push([method, params]);
    return { method, params };
  };
  const store = registry();
  const host = fakeHost();
  const guest = fakeGuest(41, debuggerApi);
  guest.reload = () => reloads.push("reload");
  guest.reloadIgnoringCache = () => reloads.push("reloadIgnoringCache");
  store.addGuest({ host, guest, partition: "persist:instance-a" });
  const tab = store.register({ senderId: host.id, webContentsId: guest.id, instanceId: "instance-a", sessionKey: "key-a", partition: "persist:instance-a" });

  store.attachDebugger({ tabRef: tab.tabRef, senderId: host.id });
  assert.deepEqual(await store.sendCommand({ tabRef: tab.tabRef, senderId: host.id, method: "Page.reload", params: {} }), {});
  assert.deepEqual(await store.sendCommand({ tabRef: tab.tabRef, senderId: host.id, method: "Page.reload", params: { ignoreCache: true } }), {});
  assert.deepEqual(reloads, ["reload", "reloadIgnoringCache"]);
  assert.deepEqual(debuggerCalls, []);
});

test("guest and host destruction clear tabRefs and debugger ownership", () => {
  const removals = [];
  const store = registry({ onRemoved: (entry) => removals.push(entry) });
  const host = fakeHost();
  const guest = fakeGuest(41, { attach() {}, detach() { removals.push({ detached: true }); }, sendCommand() {}, isAttached: () => false, on() {} });
  store.addGuest({ host, guest, partition: "persist:instance-a" });
  const tab = store.register({ senderId: host.id, webContentsId: guest.id, instanceId: "instance-a", sessionKey: "key-a", partition: "persist:instance-a" });
  store.attachDebugger({ tabRef: tab.tabRef, senderId: host.id });
  guest.destroyed = true;
  guest.emit("destroyed");

  assert.equal(store.get(tab.tabRef), undefined);
  assert.equal(store.getByGuestId(guest.id), undefined);
  assert.equal(removals.find((entry) => entry.reason === "destroyed")?.tabRef, tab.tabRef);
  assert.equal(removals.some((entry) => entry.detached), true);

  const secondGuest = fakeGuest(42);
  store.addGuest({ host, guest: secondGuest, partition: "persist:instance-a" });
  const secondTab = store.register({ senderId: host.id, webContentsId: secondGuest.id, instanceId: "instance-a", sessionKey: "key-b", partition: "persist:instance-a" });
  store.removeHost(host);
  assert.equal(store.get(secondTab.tabRef), undefined);
});
