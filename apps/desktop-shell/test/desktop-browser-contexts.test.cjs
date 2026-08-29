const assert = require("node:assert/strict");
const test = require("node:test");
const { DesktopBrowserContextManager } = require("../src/desktop-browser-contexts.cjs");

test("desktop browser contexts share one instance partition and release by reference", async () => {
  const requests = [];
  const sessions = [];
  const channels = [];
  const socksServers = [];
  const manager = new DesktopBrowserContextManager({
    fetch: async (url) => {
      requests.push(url);
      return response(url.endsWith("/api/control-plane/identity")
        ? { identity: { controlPlaneId: "cp_1" } }
        : { accessId: "access_1", token: "t".repeat(32), expiresAt: new Date(Date.now() + 1000).toISOString(), relayPath: "/browser-relay" });
    },
    WebSocket: class {},
    BrowserTunnelChannel: class {
      constructor(options) { this.options = options; this.closed = false; channels.push(this); }
      async connect() {}
      close() { this.closed = true; }
    },
    BrowserSocksServer: class {
      constructor(channel) { this.channel = channel; this.closed = false; socksServers.push(this); }
      async start() { return { host: "127.0.0.1", port: 12345 }; }
      async close() { this.closed = true; }
    },
    session: {
      fromPartition(partition) {
        const item = {
          partition,
          proxy: undefined,
          closed: false,
          async setProxy(proxy) { this.proxy = proxy; },
          setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; },
          setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; },
          on(event, handler) { this.listener = { event, handler }; },
          removeListener(event, handler) { if (this.listener?.event === event && this.listener.handler === handler) this.listener = undefined; },
          async closeAllConnections() { this.closed = true; },
        };
        sessions.push(item);
        return item;
      },
    },
  });
  const first = await manager.prepare({ controlPlaneUrl: "https://cp.example/instance-detail/instance_1", instanceId: "instance_1", senderId: 10 });
  const second = await manager.prepare({ controlPlaneUrl: "https://cp.example/", instanceId: "instance_1", senderId: 10 });
  assert.equal(first.partition, second.partition);
  assert.notEqual(first.contextId, second.contextId);
  assert.equal(channels.length, 1);
  assert.equal(sessions[0].proxy.proxyRules, "socks5://127.0.0.1:12345");
  assert.equal(sessions[0].proxy.proxyBypassRules, "<-loopback>");
  assert.equal(manager.allows(10, first.partition), true);
  assert.equal(await manager.release(first.contextId, 11), false);
  assert.equal(await manager.release(first.contextId, 10), true);
  assert.equal(channels[0].closed, false);
  assert.equal(await manager.release(second.contextId, 10), true);
  assert.equal(channels[0].closed, true);
  assert.equal(socksServers[0].closed, true);
  assert.equal(sessions[0].closed, true);
  assert.equal(sessions[0].listener, undefined);
  assert.equal(sessions[0].permissionCheckHandler, null);
  assert.equal(sessions[0].permissionRequestHandler, null);
  assert.equal(requests.filter((url) => url.endsWith("/browser-access")).length, 1);
});

test("desktop browser context creation is shared while in flight", async () => {
  let connects = 0;
  let releaseConnect;
  const connectGate = new Promise((resolve) => { releaseConnect = resolve; });
  const manager = managerForFailureTests({
    BrowserTunnelChannel: class {
      async connect() { connects += 1; await connectGate; }
      close() {}
    },
  });
  const first = manager.prepare({ controlPlaneUrl: "https://cp.example/", instanceId: "instance_1", senderId: 10 });
  const second = manager.prepare({ controlPlaneUrl: "https://cp.example/", instanceId: "instance_1", senderId: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connects, 1);
  releaseConnect();
  const [firstContext, secondContext] = await Promise.all([first, second]);
  assert.equal(firstContext.partition, secondContext.partition);
  assert.equal(manager.contexts.size, 1);
});

test("desktop browser context accepts the public identity document shape", async () => {
  const manager = managerForFailureTests({
    fetch: async (url) => response(url.endsWith("/api/control-plane/identity")
      ? { version: 1, kind: "control-plane", controlPlaneId: "cp_public" }
      : { accessId: "access_1", token: "t".repeat(32), expiresAt: new Date(Date.now() + 1000).toISOString(), relayPath: "/browser-relay" }),
  });
  const context = await manager.prepare({ controlPlaneUrl: "https://cp.example/", instanceId: "instance_1", senderId: 10 });
  assert.match(context.partition, /^persist:task-handoff-browser-/);
});

test("desktop browser context accepts the signed identity document payload", async () => {
  const manager = managerForFailureTests({
    fetch: async (url) => response(url.endsWith("/api/control-plane/identity")
      ? { payload: { version: 1, kind: "control-plane", controlPlaneId: "cp_signed" }, signature: "sig" }
      : { accessId: "access_1", token: "t".repeat(32), expiresAt: new Date(Date.now() + 1000).toISOString(), relayPath: "/browser-relay" }),
  });
  const context = await manager.prepare({ controlPlaneUrl: "https://cp.example/", instanceId: "instance_1", senderId: 10 });
  assert.match(context.partition, /^persist:task-handoff-browser-/);
});

test("desktop browser context closes the relay when SOCKS startup fails", async () => {
  let channelClosed = false;
  const manager = managerForFailureTests({
    BrowserTunnelChannel: class {
      async connect() {}
      close() { channelClosed = true; }
    },
    BrowserSocksServer: class {
      async start() { throw new Error("listen failed"); }
      async close() {}
    },
  });
  await assert.rejects(
    manager.prepare({ controlPlaneUrl: "https://cp.example/", instanceId: "instance_1", senderId: 10 }),
    /listen failed/,
  );
  assert.equal(channelClosed, true);
  assert.equal(manager.contexts.size, 0);
  assert.equal(manager.contextCreations.size, 0);
});

test("desktop browser context closes SOCKS and session when proxy setup fails", async () => {
  let channelClosed = false;
  let socksClosed = false;
  let connectionsClosed = false;
  const manager = managerForFailureTests({
    BrowserTunnelChannel: class {
      async connect() {}
      close() { channelClosed = true; }
    },
    BrowserSocksServer: class {
      async start() { return { host: "127.0.0.1", port: 12345 }; }
      async close() { socksClosed = true; }
    },
    session: {
      fromPartition() {
        return {
          async setProxy() { throw new Error("proxy failed"); },
          async closeAllConnections() { connectionsClosed = true; },
        };
      },
    },
  });
  await assert.rejects(
    manager.prepare({ controlPlaneUrl: "https://cp.example/", instanceId: "instance_1", senderId: 10 }),
    /proxy failed/,
  );
  assert.equal(channelClosed, true);
  assert.equal(socksClosed, true);
  assert.equal(connectionsClosed, true);
});

function managerForFailureTests(overrides = {}) {
  return new DesktopBrowserContextManager({
    fetch: async (url) => response(url.endsWith("/api/control-plane/identity")
      ? { identity: { controlPlaneId: "cp_1" } }
      : { accessId: "access_1", token: "t".repeat(32), expiresAt: new Date(Date.now() + 1000).toISOString(), relayPath: "/browser-relay" }),
    WebSocket: class {},
    BrowserTunnelChannel: class { async connect() {} close() {} },
    BrowserSocksServer: class { async start() { return { host: "127.0.0.1", port: 12345 }; } async close() {} },
    session: {
      fromPartition() {
        return {
          async setProxy() {}, setPermissionRequestHandler() {}, on() {}, async closeAllConnections() {},
        };
      },
    },
    ...overrides,
  });
}

function response(data) {
  return { ok: true, status: 200, async json() { return { data }; } };
}
