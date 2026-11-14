const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
require("./workspace-require.js").registerWorkspaceRequire();
const { bridgeWebSockets } = require("../packages/protocol/src/websocket-bridge.ts");
const { managedWebSocketBridgeOptions } = require("../packages/runtime-shared/src/remote-desktop-managed.ts");
const { createRemoteDesktopChannel } = require("../packages/control-plane/src/control-plane/remote-desktop/relay-channel.ts");
const { MultiplexedNodeRelaySocket } = require("../packages/control-plane/src/control-plane/nodes/cloud-relay-transport.ts");
const { NodeRelayChannelSocket } = require("../packages/node-agent/src/cloud-relay/channel.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  pauses = 0;
  resumes = 0;
  closes = [];
  send(data, options, callback) { this.sent.push({ data, options }); callback?.(); }
  pause() { this.pauses++; }
  resume() { this.resumes++; }
  close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); }
}

test("native write completion pauses production and preserves ordered binary chunks", async () => {
  const client = new Socket(), upstream = new Socket();
  const callbacks = [];
  client.send = (data, options, callback) => { client.sent.push({ data, options }); callbacks.push(callback); };
  bridgeWebSockets(client, upstream, managedWebSocketBridgeOptions("/instances/inst_a/remote-desktop/fallback/media"));
  upstream.emit("message", Buffer.from([1]), true);
  upstream.emit("message", Buffer.from([2]), true); // Already parsed before pause.
  await tick();
  assert.equal(upstream.pauses, 2);
  assert.equal(client.sent.length, 1);
  callbacks.shift()();
  await tick();
  assert.equal(upstream.resumes, 0);
  assert.equal(client.sent.length, 2);
  callbacks.shift()();
  await tick();
  assert.equal(upstream.resumes, 1);
  assert.deepEqual(client.sent.map(frame => [...frame.data]), [[1], [2]]);
  assert.deepEqual(client.sent[0].options, { binary: true, compress: false });
  assert.deepEqual(client.closes, []);
});

test("only managed fallback routes select long-lived policy; frame and queue limits remain", () => {
  const streaming = managedWebSocketBridgeOptions("/instances/inst_a/remote-desktop/fallback/media?x=1");
  assert.equal(streaming.maxTotalBytes, Infinity);
  for (const route of ["/events", "/instances/a/proxy/ws/api/foo", "/instances/a/remote-desktop/attach", "/instances/a/remote-desktop/fallback/media/extra"]) {
    assert.deepEqual(managedWebSocketBridgeOptions(route), {});
  }
  const client = new Socket(), upstream = new Socket();
  bridgeWebSockets(client, upstream, streaming);
  upstream.emit("message", Buffer.alloc(streaming.maxFrameBytes + 1), true);
  assert.equal(client.closes[0].code, 1009);
});

test("explicit long-lived accounting crosses 1 GiB while ordinary bridges retain their cap", () => {
  for (const maxTotalBytes of [undefined, Infinity]) {
    const client = new Socket(), upstream = new Socket();
    let count = 0;
    client.send = () => count++;
    bridgeWebSockets(client, upstream, { maxTotalBytes });
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (let n = 0; n < 129; n++) upstream.emit("message", chunk, true);
    assert.equal(count, maxTotalBytes === Infinity ? 129 : 128);
    assert.equal(client.closes.length, maxTotalBytes === Infinity ? 0 : 1);
  }
});

test("command-side frame limits do not reject legal larger downstream frames", () => {
  const client = new Socket(), upstream = new Socket();
  bridgeWebSockets(client, upstream, { maxClientFrameBytes: 16, maxFrameBytes: 32 });
  upstream.emit("message", Buffer.alloc(24), true);
  assert.equal(client.sent.length, 1);
  client.emit("message", Buffer.alloc(24), true);
  assert.equal(upstream.sent.length, 0);
  assert.equal(client.closes[0].code, 1009);
});

test("in-flight native writes stay bounded and a closed bridge never resumes its source", async () => {
  const client = new Socket(), upstream = new Socket();
  let complete;
  client.send = (_data, _options, callback) => { complete = callback; };
  bridgeWebSockets(client, upstream, { awaitWrites: true, maxBufferedBytes: 32 });
  upstream.emit("message", Buffer.alloc(16), true);
  await tick();
  upstream.emit("message", Buffer.alloc(17), true);
  assert.equal(client.closes[0].code, 1013);
  assert.equal(upstream.closes[0].code, 1013);
  complete();
  await tick();
  assert.equal(upstream.resumes, 0);
});

test("Relay exposes buffered bytes, waits for downstream credit and releases all writes on close", async () => {
  let release;
  let calls = 0;
  const { socket, channel } = createRemoteDesktopChannel({
    onMessage: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    onClose() {},
  });
  const first = socket.sendAsync(Buffer.alloc(16 * 1024), { binary: true });
  const second = socket.sendAsync(Buffer.alloc(16 * 1024), { binary: true });
  const settlements = Promise.allSettled([first, second]);
  assert.equal(socket.bufferedAmount, 32 * 1024);
  assert.equal(calls, 1);
  let closes = 0;
  socket.on("close", () => closes++);
  channel.close();
  assert.deepEqual((await settlements).map(value => value.status), ["rejected", "rejected"]);
  release();
  await tick();
  assert.equal(socket.bufferedAmount, 0);
  assert.equal(calls, 1);
  assert.equal(closes, 1);
});

test("Relay receive credit stays outstanding while the destination is paused", async () => {
  const { socket, channel } = createRemoteDesktopChannel({ async onMessage() {}, onClose() {} });
  let consumed = 0, settled = false;
  socket.on("message", () => { consumed++; socket.pause(); });
  const pending = channel.send({ bytes: new Uint8Array([1]), binary: true }).then(() => { settled = true; });
  await tick();
  assert.equal(consumed, 1);
  assert.equal(settled, false);
  socket.resume();
  await pending;
  assert.equal(consumed, 1);
  channel.close();
});

test("Relay cannot hide an unbounded synchronous write queue", async () => {
  const { socket } = createRemoteDesktopChannel({ onMessage: () => new Promise(() => {}), onClose() {} });
  let closed = 0;
  socket.on("close", () => closed++);
  for (let n = 0; n < 129; n++) socket.send(Buffer.alloc(16 * 1024), { binary: true });
  await tick();
  assert.equal(socket.readyState, 3);
  assert.equal(socket.bufferedAmount, 0);
  assert.equal(closed, 1);
});

for (const SocketType of [MultiplexedNodeRelaySocket, NodeRelayChannelSocket]) {
  test(`${SocketType.name} awaits peer resume and channel capacity, and rejects blocked writes on close`, async () => {
    const sent = [];
    let release;
    let capacity = Promise.resolve();
    const channel = {
      sendData: (...args) => sent.push(args),
      sendChannelData: (...args) => sent.push(args),
      waitForOutboundCapacity: () => capacity,
      emitChannelClose() {},
    };
    const socket = new SocketType(channel, "aux", 1);
    socket.remotePause();
    const write = socket.sendAsync(Buffer.from([1]), { binary: true });
    await tick();
    assert.equal(sent.length, 0);
    socket.remoteResume();
    await write;
    assert.equal(sent.length, 1);
    capacity = new Promise(resolve => { release = resolve; });
    const blocked = socket.sendAsync(Buffer.from([2]), { binary: true });
    const rejected = assert.rejects(blocked, { code: "NODE_RELAY_CHANNEL_CLOSED" });
    await tick();
    socket.close();
    await rejected;
    release();
    await tick();
    assert.equal(sent.length, 1);
  });
}
