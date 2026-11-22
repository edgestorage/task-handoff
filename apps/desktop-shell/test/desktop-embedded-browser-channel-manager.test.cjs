const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { DesktopEmbeddedBrowserChannelManager } = require("../src/desktop-embedded-browser-channel-manager.cjs");

class FakeChannel extends EventEmitter {
  static instances = [];
  constructor(options) {
    super();
    this.options = options;
    this.state = "connecting";
    this.notifications = [];
    FakeChannel.instances.push(this);
  }
  async connect() {
    this.state = "ready";
  }
  notifyTabCreated(page, creationRef) { this.notifications.push(["tabs.created", page, creationRef]); return true; }
  notifyTabDestroyed(tabRef, reason) { this.notifications.push(["tabs.destroyed", tabRef, reason]); return true; }
  notifyTargetDetached(leaseRef, tabRef, reason) { this.notifications.push(["target.detached", leaseRef, tabRef, reason]); return true; }
  notifyCdpEvent(event) { this.notifications.push(["cdp.event", event]); return true; }
  close() { this.state = "closed"; }
}

test("source registration, snapshot and registry deltas stay ordered", async () => {
  FakeChannel.instances.length = 0;
  const calls = [];
  const tab = {
    tabRef: "browser_tab_1",
    instanceId: "instance-a",
    pageHost: "renderer-webview",
    pageHostCapabilities: { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false },
    title: "Example",
    url: "https://example.com",
    state: "ready",
  };
  const registry = {
    list: ({ senderId, instanceId }) => senderId === 11 && instanceId === "instance-a" ? [tab] : [],
    attachDebugger: () => ({}),
    detachDebugger: () => true,
    sendCommand: async () => ({}),
    close: async () => true,
  };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path.endsWith("/browser-control/sources")) {
      return response(201, {
        source: {
          sourceRef: "bsr_1",
          generation: 2,
          panelId: "control_plane_1",
          displayName: "Desktop",
          pageHost: "renderer-webview",
          pageHostCapabilities: tab.pageHostCapabilities,
          revision: 0,
        },
        connection: {
          accessId: "bca_1",
          token: "ticket",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          relayPath: "/browser-channel-relay",
          sourceRef: "bsr_1",
          generation: 2,
          registryEpoch: "bep_1",
          registryRevision: 3,
        },
      });
    }
    if (path.endsWith("/snapshot")) {
      return response(200, { registryEpoch: "bep_1", registryRevision: 4, sourceRevision: 1 });
    }
    if (path.endsWith("/deltas")) {
      return response(200, { revision: 2 });
    }
    if (init?.method === "DELETE") return response(200, {});
    throw new Error(`unexpected URL ${url}`);
  };
  const manager = new DesktopEmbeddedBrowserChannelManager({
    fetch,
    WebSocket: class {},
    ChannelClient: FakeChannel,
    registry,
    logError: (message) => { throw new Error(message); },
  });
  const host = { id: 11, isDestroyed: () => false, send() {} };
  await manager.ensureSource({
    controlPlaneUrl: "http://control-plane.test",
    instanceId: "instance-a",
    senderId: 11,
    host,
    hostLabel: "Window A",
    pageHost: "renderer-webview",
    pageHostCapabilities: tab.pageHostCapabilities,
  });

  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].init.body).publisherRef, "desktop:11:instance-a");
  const snapshot = JSON.parse(calls[1].init.body);
  assert.equal(snapshot.sourceRef, "bsr_1");
  assert.equal(snapshot.registryEpoch, "bep_1");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.pages[0].tabRef, "browser_tab_1");
  assert.equal(FakeChannel.instances[0].options.registryRevision, 4);

  manager.handleRegistryChange({
    type: "updated",
    senderId: 11,
    entry: { ...tab, title: "Updated" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  const delta = JSON.parse(calls[2].init.body);
  assert.equal(delta.baseRevision, 1);
  assert.equal(delta.revision, 2);
  assert.equal(delta.upserts[0].title, "Updated");
  assert.equal(FakeChannel.instances[0].notifications.length, 0);

  manager.handleRegistryChange({
    type: "registered",
    senderId: 11,
    creationRef: "bcr_created",
    entry: { ...tab, tabRef: "browser_tab_2", title: "Created" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 4);
  const createdDelta = JSON.parse(calls[3].init.body);
  assert.equal(createdDelta.baseRevision, 2);
  assert.equal(createdDelta.revision, 3);
  assert.equal(createdDelta.upserts[0].tabRef, "browser_tab_2");
  assert.equal(FakeChannel.instances[0].notifications[0][0], "tabs.created");
  assert.equal(FakeChannel.instances[0].notifications[0][2], "bcr_created");
});

test("an updated change cannot erase a pending registered creationRef", async () => {
  FakeChannel.instances.length = 0;
  const tab = {
    tabRef: "browser_tab_1",
    instanceId: "instance-a",
    pageHost: "renderer-webview",
    pageHostCapabilities: { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false },
    title: "Created",
    url: "https://example.com",
    state: "ready",
  };
  const registry = {
    list: () => [],
    attachDebugger: () => ({}),
    detachDebugger: () => true,
    sendCommand: async () => ({}),
    close: async () => true,
  };
  let blocked;
  const initialFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/browser-control/sources")) {
      return response(201, {
        source: {
          sourceRef: "bsr_1",
          generation: 2,
          panelId: "control_plane_1",
          displayName: "Desktop",
          pageHost: "renderer-webview",
          pageHostCapabilities: tab.pageHostCapabilities,
          revision: 0,
        },
        connection: {
          accessId: "bca_1",
          token: "ticket",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          relayPath: "/browser-channel-relay",
          sourceRef: "bsr_1",
          generation: 2,
          registryEpoch: "bep_1",
          registryRevision: 3,
        },
      });
    }
    return response(200, { registryEpoch: "bep_1", registryRevision: 4, sourceRevision: 1 });
  };
  const manager = new DesktopEmbeddedBrowserChannelManager({
    fetch: initialFetch,
    WebSocket: class {},
    ChannelClient: FakeChannel,
    registry,
    logError: (message) => { throw new Error(message); },
  });
  await manager.ensureSource({
    controlPlaneUrl: "http://control-plane.test",
    instanceId: "instance-a",
    senderId: 11,
    host: { id: 11, isDestroyed: () => false, send() {} },
    hostLabel: "Window A",
    pageHost: "renderer-webview",
    pageHostCapabilities: tab.pageHostCapabilities,
  });
  const session = manager.sessions.get("11\0instance-a");
  assert.ok(session);

  manager.fetch = async () => new Promise((resolve) => { blocked = resolve; });
  const firstFlush = manager.flush(session, [], [], true);
  await new Promise((resolve) => setImmediate(resolve));
  manager.handleRegistryChange({ type: "registered", senderId: 11, creationRef: "bcr_created", entry: tab });
  manager.handleRegistryChange({ type: "updated", senderId: 11, entry: { ...tab, title: "Updated" } });
  manager.fetch = async () => response(200, { revision: 2 });
  blocked(response(200, { revision: 2 }));
  await firstFlush;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakeChannel.instances[0].notifications.length, 1);
  assert.equal(FakeChannel.instances[0].notifications[0][0], "tabs.created");
  assert.equal(FakeChannel.instances[0].notifications[0][2], "bcr_created");
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return { data: body }; },
  };
}
