const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const os = require("node:os");
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
  notifyDownloadEvent(event) { this.notifications.push(["downloads.event", event]); return true; }
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
    publisherId: "desktop_a",
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
    cdpIdentity: {
      chromeVersion: "150.0.7871.47",
      userAgent: "Mozilla/5.0 Chrome/150.0.7871.47 Safari/537.36",
      v8Version: "15.0.245.15-electron.0",
      webkitVersion: "537.36",
    },
  });

  assert.equal(calls.length, 2);
  const expectedDisplayName = Array.from(os.hostname().trim()).slice(0, 160).join("") || "TaskHandoff Desktop";
  assert.equal(JSON.parse(calls[0].init.body).displayName, expectedDisplayName);
  assert.equal(JSON.parse(calls[0].init.body).publisherRef, "desktop:desktop_a:11:instance-a");
  assert.equal(JSON.parse(calls[0].init.body).cdpIdentity.chromeVersion, "150.0.7871.47");
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

test("different desktop installations never share a publisher for the same sender id", async () => {
  FakeChannel.instances.length = 0;
  const publisherRefs = [];
  const pageHostCapabilities = { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === "DELETE") return response(200, {});
    if (path.endsWith("/browser-control/sources")) {
      const body = JSON.parse(init.body);
      publisherRefs.push(body.publisherRef);
      const index = publisherRefs.length;
      return response(201, {
        source: {
          sourceRef: `bsr_${index}`,
          generation: 1,
          panelId: "control_plane_1",
          displayName: "Desktop",
          pageHost: "renderer-webview",
          pageHostCapabilities,
          revision: 0,
        },
        connection: {
          accessId: `bca_${index}`,
          token: "ticket",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          relayPath: "/browser-channel-relay",
          sourceRef: `bsr_${index}`,
          generation: 1,
          registryEpoch: "bep_1",
          registryRevision: 0,
        },
      });
    }
    if (path.endsWith("/snapshot")) {
      return response(200, { registryEpoch: "bep_1", registryRevision: 1, sourceRevision: 1 });
    }
    if (path.endsWith("/deltas")) return response(200, { revision: 1 });
    throw new Error(`unexpected URL ${url}`);
  };

  for (const publisherId of ["desktop_a", "desktop_b"]) {
    const manager = new DesktopEmbeddedBrowserChannelManager({
      fetch,
      WebSocket: class {},
      ChannelClient: FakeChannel,
      registry: { list: () => [], close: async () => true },
      publisherId,
      logError: (message) => { throw new Error(message); },
    });
    await manager.ensureSource({
      controlPlaneUrl: "http://control-plane.test",
      instanceId: "instance-a",
      senderId: 1,
      host: { id: 1, isDestroyed: () => false, send() {} },
      hostLabel: "Desktop",
      pageHost: "renderer-webview",
      pageHostCapabilities,
    });
  }

  assert.deepEqual(publisherRefs, [
    "desktop:desktop_a:1:instance-a",
    "desktop:desktop_b:1:instance-a",
  ]);
});

test("source registration deduplicates concurrent setup and reconnects a closed channel", async () => {
  FakeChannel.instances.length = 0;
  let sourceRegistrations = 0;
  const pageHostCapabilities = { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === "DELETE") return response(200, {});
    if (path.endsWith("/browser-control/sources")) {
      sourceRegistrations += 1;
      const sourceRef = `bsr_${sourceRegistrations}`;
      return response(201, {
        source: {
          sourceRef,
          generation: sourceRegistrations,
          panelId: "control_plane_1",
          displayName: "Desktop",
          pageHost: "renderer-webview",
          pageHostCapabilities,
          revision: 0,
        },
        connection: {
          accessId: `bca_${sourceRegistrations}`,
          token: "ticket",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          relayPath: "/browser-channel-relay",
          sourceRef,
          generation: sourceRegistrations,
          registryEpoch: "bep_1",
          registryRevision: 3,
        },
      });
    }
    if (path.endsWith("/snapshot")) {
      return response(200, { registryEpoch: "bep_1", registryRevision: 4, sourceRevision: 1 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const manager = new DesktopEmbeddedBrowserChannelManager({
    fetch,
    WebSocket: class {},
    ChannelClient: FakeChannel,
    registry: { list: () => [], close: async () => true },
    logError: (message) => { throw new Error(message); },
  });
  const input = {
    controlPlaneUrl: "http://control-plane.test",
    instanceId: "instance-a",
    senderId: 11,
    host: { id: 11, isDestroyed: () => false, send() {} },
    hostLabel: "Window A",
    pageHost: "renderer-webview",
    pageHostCapabilities,
  };

  const [first, concurrent] = await Promise.all([manager.ensureSource(input), manager.ensureSource(input)]);
  assert.equal(first, concurrent);
  assert.equal(sourceRegistrations, 1);

  first.channel.state = "closed";
  first.ready = false;
  const reconnected = await manager.ensureSource(input);
  assert.notEqual(reconnected, first);
  assert.equal(sourceRegistrations, 2);
  assert.equal(reconnected.channel.state, "ready");
});

test("agent tabs.close removes the renderer tab shell", async () => {
  const sent = [];
  const closed = [];
  const manager = new DesktopEmbeddedBrowserChannelManager({
    registry: {
      close: async ({ tabRef, senderId }) => {
        closed.push({ tabRef, senderId });
      },
    },
  });
  const session = {
    senderId: 11,
    instanceId: "instance-a",
    host: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
    sourceRef: undefined,
    closed: false,
  };

  const result = await manager.channelAdapter(session).closeTab({ tabRef: "browser_tab_1" });

  assert.deepEqual(result, { closed: true });
  assert.deepEqual(closed, [{ tabRef: "browser_tab_1", senderId: 11 }]);
  assert.deepEqual(sent, [{
    channel: "task-handoff:browser-tab-closed",
    payload: { tabRef: "browser_tab_1", instanceId: "instance-a" },
  }]);
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

test("a revision gap resyncs the source snapshot before retrying the delta", async () => {
  FakeChannel.instances.length = 0;
  const calls = [];
  let deltaAttempts = 0;
  let snapshots = 0;
  const tab = {
    tabRef: "browser_tab_1",
    instanceId: "instance-a",
    pageHost: "renderer-webview",
    pageHostCapabilities: { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false },
    title: "Example",
    url: "https://example.com",
    state: "ready",
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
      snapshots += 1;
      return response(200, { registryEpoch: "bep_1", registryRevision: 3 + snapshots, sourceRevision: 1 });
    }
    if (path.endsWith("/deltas")) {
      deltaAttempts += 1;
      if (deltaAttempts === 1) {
        return errorResponse(409, {
          code: "BROWSER_SNAPSHOT_REQUIRED",
          message: "Browser source revision is not contiguous.",
        });
      }
      return response(200, { revision: 2 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const manager = new DesktopEmbeddedBrowserChannelManager({
    fetch,
    WebSocket: class {},
    ChannelClient: FakeChannel,
    registry: {
      list: () => [tab],
      attachDebugger: () => ({}),
      detachDebugger: () => true,
      sendCommand: async () => ({}),
      close: async () => true,
    },
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

  manager.handleRegistryChange({ type: "updated", senderId: 11, entry: { ...tab, title: "Updated" } });
  await manager.flush(session, [], []);

  assert.equal(deltaAttempts, 2);
  assert.equal(snapshots, 2);
  assert.equal(JSON.parse(calls[2].init.body).baseRevision, 1);
  assert.equal(JSON.parse(calls[4].init.body).baseRevision, 1);
});

test("a second source takeover keeps the first source pages and leases without fallback", async () => {
  FakeChannel.instances.length = 0;
  const calls = [];
  const hostASends = [];
  const hostBSends = [];
  const pageHostCapabilities = { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false };
  const firstPage = {
    tabRef: "browser_tab_a",
    instanceId: "instance-a",
    pageHost: "renderer-webview",
    pageHostCapabilities,
    title: "Shared",
    url: "https://shared.example",
    state: "ready",
  };
  const createdPage = {
    ...firstPage,
    tabRef: "browser_tab_b",
    title: "Shared Again",
  };
  const pagesBySender = new Map([[11, [firstPage]], [12, []]]);
  const registry = {
    list: ({ senderId }) => pagesBySender.get(senderId) || [],
    attachDebugger: ({ tabRef }) => ({ tabRef }),
    detachDebugger: () => true,
    sendCommand: async () => ({}),
    close: async () => true,
  };
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path.endsWith("/browser-control/sources")) {
      const body = JSON.parse(init.body);
      const senderId = Number(body.publisherRef.split(":")[2]);
      const sourceRef = senderId === 11 ? "bsr_a" : "bsr_b";
      return response(201, {
        source: {
          sourceRef,
          generation: 2,
          panelId: `control_plane_${senderId}`,
          displayName: `Desktop ${senderId}`,
          pageHost: "renderer-webview",
          pageHostCapabilities,
          revision: 0,
        },
        connection: {
          accessId: `bca_${senderId}`,
          token: "ticket",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          relayPath: "/browser-channel-relay",
          sourceRef,
          generation: 2,
          registryEpoch: "bep_1",
          registryRevision: 1,
        },
      });
    }
    if (path.endsWith("/snapshot")) {
      return response(200, { registryEpoch: "bep_1", registryRevision: 2, sourceRevision: 1 });
    }
    if (path.endsWith("/deltas")) {
      return response(200, { revision: JSON.parse(init.body).revision });
    }
    if (init.method === "DELETE") return response(200, {});
    throw new Error(`unexpected URL ${url}`);
  };
  const manager = new DesktopEmbeddedBrowserChannelManager({
    fetch,
    WebSocket: class {},
    ChannelClient: FakeChannel,
    registry,
    logError: (message) => { throw new Error(message); },
  });
  const hostA = { id: 11, isDestroyed: () => false, send: (...args) => hostASends.push(args) };
  const hostB = { id: 12, isDestroyed: () => false, send: (...args) => hostBSends.push(args) };
  await manager.ensureSource({
    controlPlaneUrl: "http://control-plane.test",
    instanceId: "instance-a",
    senderId: 11,
    host: hostA,
    hostLabel: "Window A",
    pageHost: "renderer-webview",
    pageHostCapabilities,
  });
  await manager.ensureSource({
    controlPlaneUrl: "http://control-plane.test",
    instanceId: "instance-a",
    senderId: 12,
    host: hostB,
    hostLabel: "Window B",
    pageHost: "renderer-webview",
    pageHostCapabilities,
  });
  const sessionA = manager.sessions.get("11\0instance-a");
  const sessionB = manager.sessions.get("12\0instance-a");
  assert.equal(sessionA.sourceRef, "bsr_a");
  assert.equal(sessionB.sourceRef, "bsr_b");

  await manager.channelAdapter(sessionA).attachTarget({
    tabRef: firstPage.tabRef,
    leaseRef: "lease_a",
    generation: sessionA.generation,
  });

  sessionB.host = { id: 12, isDestroyed: () => true, send: (...args) => hostBSends.push(args) };
  await assert.rejects(
    manager.channelAdapter(sessionB).openTab({ url: firstPage.url, creationRef: "bcr_b" }),
    { code: "BROWSER_WINDOW_UNAVAILABLE" },
  );
  assert.equal(hostASends.length, 0);

  sessionB.host = hostB;
  await manager.channelAdapter(sessionB).openTab({
    url: firstPage.url,
    creationRef: "bcr_b",
    requesterSessionRef: "session_b",
  });
  assert.deepEqual(hostBSends.at(-1), [
    "task-handoff:browser-new-tab",
    {
      url: firstPage.url,
      title: undefined,
      instanceId: "instance-a",
      creationRef: "bcr_b",
      requesterSessionRef: "session_b",
    },
  ]);

  manager.handleRegistryChange({ type: "registered", senderId: 12, creationRef: "bcr_b", entry: createdPage });
  await manager.flush(sessionB, [], []);
  assert.deepEqual(FakeChannel.instances[1].notifications.at(-1)?.[0], "tabs.created");
  assert.equal(FakeChannel.instances[1].notifications.at(-1)?.[2], "bcr_b");

  assert.equal(manager.infoFor(11, "instance-a")?.sourceRef, "bsr_a");
  assert.equal(sessionA.channel.state, "ready");
  assert.equal(sessionA.leases.get("lease_a")?.tabRef, firstPage.tabRef);
  assert.equal(calls.some(({ url, init }) => init.method === "DELETE" && url.includes("bsr_a")), false);

  manager.handleTargetDetached({ tabRef: firstPage.tabRef, reason: "browser-window-closed" });
  assert.equal(sessionA.leases.size, 0);
  assert.deepEqual(FakeChannel.instances[0].notifications.at(-1), [
    "target.detached",
    "lease_a",
    firstPage.tabRef,
    "browser-window-closed",
  ]);
});

test("Agent device metric commands notify the renderer without changing the CDP result", async () => {
  const sends = [];
  const { adapter } = deviceCommandHarness({ hostSend: (...args) => sends.push(args) });

  const result = await adapter.sendCdp({
    leaseRef: "lease_1",
    method: "Emulation.setDeviceMetricsOverride",
    params: {
      width: 800,
      height: 600,
      deviceScaleFactor: 2,
      mobile: true,
      dontSetVisibleSize: true,
      screenOrientation: { type: "landscapePrimary", angle: 90 },
    },
  });

  assert.deepEqual(result, { method: "Emulation.setDeviceMetricsOverride" });
  assert.deepEqual(sends, [[
    "task-handoff:browser-device-metrics-changed",
    {
      tabRef: "browser_tab_1",
      instanceId: "instance-a",
      source: "agent",
      active: true,
      width: 800,
      height: 600,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: "landscapePrimary", angle: 90 },
    },
  ]]);
});

test("device metric notifications are limited to valid overrides on the active lease", async () => {
  const sends = [];
  const { adapter } = deviceCommandHarness({ hostSend: (...args) => sends.push(args) });

  await adapter.sendCdp({ leaseRef: "lease_1", method: "Emulation.clearDeviceMetricsOverride" });
  assert.deepEqual(sends.at(-1), [
    "task-handoff:browser-device-metrics-changed",
    { tabRef: "browser_tab_1", instanceId: "instance-a", source: "agent", active: false },
  ]);

  await adapter.sendCdp({ leaseRef: "lease_1", method: "Emulation.setDeviceMetricsOverride", params: { width: 10_000, height: 600 } });
  await adapter.sendCdp({ leaseRef: "lease_1", method: "Emulation.setDeviceMetricsOverride", params: { width: 800 } });
  await adapter.sendCdp({ leaseRef: "lease_1", method: "Runtime.evaluate", params: { expression: "1" } });
  assert.equal(sends.length, 1);

  await assert.rejects(
    adapter.sendCdp({ leaseRef: "stale_lease", method: "Emulation.clearDeviceMetricsOverride" }),
    { code: "BROWSER_LEASE_STALE" },
  );
  assert.equal(sends.length, 1);
});

test("download events fan out only to the source that owns the guest", () => {
  FakeChannel.instances.length = 0;
  const manager = new DesktopEmbeddedBrowserChannelManager({
    registry: {
      getByGuestId: (webContentsId, senderId) => senderId === 11 && webContentsId === 81
        ? { tabRef: "browser_tab_1", instanceId: "instance-a" }
        : undefined,
    },
    logInfo: () => undefined,
    logError: () => undefined,
  });
  const matchingChannel = new FakeChannel({});
  matchingChannel.state = "ready";
  const otherInstanceChannel = new FakeChannel({});
  otherInstanceChannel.state = "ready";
  manager.sessions.set("11\0instance-a", {
    key: "11\0instance-a",
    instanceId: "instance-a",
    senderId: 11,
    sourceRef: "bsr_a",
    controlPlaneUrl: "http://control-plane.test",
    channel: matchingChannel,
    closed: false,
  });
  manager.sessions.set("12\0instance-b", {
    key: "12\0instance-b",
    instanceId: "instance-b",
    senderId: 12,
    sourceRef: "bsr_b",
    controlPlaneUrl: "http://control-plane.test",
    channel: otherInstanceChannel,
    closed: false,
  });

  manager.handleDownloadEvent({
    instanceId: "instance-a",
    webContentsId: 81,
    senderIds: [11, 12],
    controlPlaneUrl: "http://control-plane.test",
    method: "Browser.downloadWillBegin",
    params: { guid: "download_1", url: "https://example.com/file.txt", suggestedFilename: "file.txt" },
  });

  assert.deepEqual(matchingChannel.notifications, [[
    "downloads.event",
    {
      sourceRef: "bsr_a",
      tabRef: "browser_tab_1",
      method: "Browser.downloadWillBegin",
      params: { guid: "download_1", url: "https://example.com/file.txt", suggestedFilename: "file.txt" },
    },
  ]]);
  assert.deepEqual(otherInstanceChannel.notifications, []);
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return { data: body }; },
  };
}

function deviceCommandHarness({ hostSend = () => undefined } = {}) {
  const manager = new DesktopEmbeddedBrowserChannelManager({
    registry: {
      sendCommand: async ({ method }) => ({ method }),
    },
    logInfo: () => undefined,
    logError: () => undefined,
  });
  const session = {
    instanceId: "instance-a",
    senderId: 11,
    generation: 3,
    host: { isDestroyed: () => false, send: hostSend },
    leases: new Map([["lease_1", { tabRef: "browser_tab_1", generation: 3 }]]),
  };
  return { manager, session, adapter: manager.channelAdapter(session) };
}

function errorResponse(status, error) {
  return {
    ok: false,
    status,
    async json() { return { error }; },
  };
}
