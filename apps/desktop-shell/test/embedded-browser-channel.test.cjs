const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const protocol = require("@task-handoff/protocol/embedded-browser-control");
const { EmbeddedBrowserChannelClient } = require("../src/embedded-browser-channel.cjs");

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data) {
    this.sent.push(Buffer.from(data));
  }

  close(code, reason) {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason || ""));
  }

  serverSend(value) {
    const payload = protocol.encodeEmbeddedBrowserControlMessage(value);
    this.emit("message", Buffer.from(protocol.encodeEmbeddedBrowserFrame({ type: "data", streamId: 1, payload })), true);
  }

  serverOpenOk() {
    const payload = protocol.encodeEmbeddedBrowserStreamOpenOk();
    this.emit("message", Buffer.from(protocol.encodeEmbeddedBrowserFrame({ type: "openOk", streamId: 1, payload })), true);
  }
}

test("control channel completes hello/ready/synced and dispatches CDP", async () => {
  FakeWebSocket.instances.length = 0;
  const cdp = [];
  const client = new EmbeddedBrowserChannelClient({
    url: "ws://control-plane/browser-channel-relay",
    token: "ticket",
    WebSocket: FakeWebSocket,
    sourceRef: "bsr_1",
    generation: 2,
    registryEpoch: "bep_1",
    registryRevision: 4,
    pageHost: "renderer-webview",
    pageHostCapabilities: { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false },
    adapter: {
      async openTab() { return { accepted: true }; },
      async attachTarget() { return { attached: true }; },
      async detachTarget() { return { detached: true }; },
      async sendCdp(params) { cdp.push(params); return { result: { ok: true } }; },
      async closeTab() { return { closed: true }; },
    },
  });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances[0];
  assert.match(socket.options.headers.authorization, /^BrowserControl ticket$/);
  await new Promise((resolve) => setImmediate(resolve));
  const openFrame = protocol.decodeEmbeddedBrowserFrame(socket.sent[0]);
  assert.equal(openFrame.type, "open");
  assert.equal(protocol.decodeEmbeddedBrowserStreamOpen(openFrame.payload).streamKind, "control");

  socket.serverOpenOk();
  const helloFrame = protocol.decodeEmbeddedBrowserFrame(socket.sent[1]);
  const hello = new protocol.EmbeddedBrowserControlMessageDecoder().push(helloFrame.payload)[0];
  assert.equal(hello.method, "control.hello");
  assert.equal(hello.params.registryEpoch, "bep_1");

  socket.serverSend({
    jsonrpc: "2.0",
    method: "control.ready",
    params: { protocolVersion: "2026-11-22", sourceRef: "bsr_1", generation: 2 },
  });
  socket.serverSend({
    jsonrpc: "2.0",
    method: "control.synced",
    params: { sourceRef: "bsr_1", generation: 2, registryEpoch: "bep_1", registryRevision: 4 },
  });
  await connecting;

  socket.serverSend({
    jsonrpc: "2.0",
    id: "req_9",
    method: "cdp.send",
    params: {
      leaseRef: "blr_1",
      method: "Page.navigate",
      params: { url: "https://example.com" },
      requestId: "agent_request_1",
      timeoutMs: 10_000,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cdp.length, 1);
  assert.equal(cdp[0].method, "Page.navigate");
  const response = new protocol.EmbeddedBrowserControlMessageDecoder().push(
    protocol.decodeEmbeddedBrowserFrame(socket.sent.at(-1)).payload,
  )[0];
  assert.equal(response.id, "req_9");
  assert.deepEqual(response.result, { result: { ok: true } });
});

test("tab notifications carry only source identity and opaque tabRef", async () => {
  FakeWebSocket.instances.length = 0;
  const client = new EmbeddedBrowserChannelClient({
    url: "ws://control-plane/browser-channel-relay",
    token: "ticket",
    WebSocket: FakeWebSocket,
    sourceRef: "bsr_1",
    generation: 3,
    registryEpoch: "bep_1",
    registryRevision: 5,
    pageHost: "renderer-webview",
    pageHostCapabilities: { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false },
    adapter: {},
  });
  client.state = "ready";
  client.socket = new FakeWebSocket("ws://example", {});
  assert.equal(client.notifyTabCreated({ tabRef: "browser_tab_1", title: "Example", url: "https://example.com", state: "ready" }, "bcr_1"), true);
  const message = new protocol.EmbeddedBrowserControlMessageDecoder().push(
    protocol.decodeEmbeddedBrowserFrame(client.socket.sent[0]).payload,
  )[0];
  assert.equal(message.method, "tabs.created");
  assert.deepEqual(message.params, {
    sourceRef: "bsr_1",
    generation: 3,
    tabRef: "browser_tab_1",
    creationRef: "bcr_1",
    title: "Example",
    url: "https://example.com",
    state: "ready",
  });
});
