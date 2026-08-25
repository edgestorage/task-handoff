const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const Fastify = require("fastify");
const websocket = require("@fastify/websocket");
const WebSocket = require("ws");

const { TASK_HANDOFF_WEBSOCKET_SERVER_OPTIONS, bridgeWebSockets, closeWebSocket } = require("../packages/protocol/src/websocket-bridge.ts");

class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.closes = [];
    this.sent = [];
    this.throwOnSend = false;
  }

  send(data, options) {
    if (this.throwOnSend) throw new Error("simulated send failure");
    this.sent.push({ data, options });
  }

  close(code, reason) {
    if (code !== undefined && !isSendableCloseCode(code)) {
      throw new TypeError("First argument must be a valid error code number");
    }
    if (reason !== undefined && Buffer.byteLength(reason, "utf8") > 123) {
      throw new RangeError("The message must not be greater than 123 bytes");
    }
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
}

function isSendableCloseCode(code) {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999));
}

test("bridgeWebSockets does not forward non-sendable websocket close codes", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();

  bridgeWebSockets(client, upstream);
  upstream.emit("close", 1006, "abnormal close");

  assert.deepEqual(client.closes, [{ code: undefined, reason: "abnormal close" }]);
});

test("bridgeWebSockets truncates overlong close reasons before forwarding", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();

  bridgeWebSockets(client, upstream);
  upstream.emit("close", 1011, "x".repeat(200));

  assert.equal(client.closes.length, 1);
  assert.equal(client.closes[0].code, 1011);
  assert.equal(Buffer.byteLength(client.closes[0].reason, "utf8"), 123);
});

test("closeWebSocket normalizes runtime close events before forwarding them", () => {
  const socket = new MockWebSocket();

  closeWebSocket(socket, 1006, "x".repeat(200));

  assert.equal(socket.closes.length, 1);
  assert.equal(socket.closes[0].code, undefined);
  assert.equal(Buffer.byteLength(socket.closes[0].reason, "utf8"), 123);
});

test("bridgeWebSockets enforces optional frame and total byte limits", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();
  const frames = [];
  bridgeWebSockets(client, upstream, {
    maxFrameBytes: 4,
    maxTotalBytes: 6,
    onFrame: (direction, bytes) => frames.push({ direction, bytes }),
  });

  client.emit("message", "1234", false);
  upstream.emit("message", Buffer.from("123"), true);

  assert.deepEqual(frames, [
    { direction: "client-to-upstream", bytes: 4 },
    { direction: "upstream-to-client", bytes: 3 },
  ]);
  assert.deepEqual(client.closes.at(-1), { code: 1009, reason: "WebSocket bridge traffic limit exceeded." });
  assert.deepEqual(upstream.closes.at(-1), { code: 1009, reason: "WebSocket bridge traffic limit exceeded." });
});

test("bridgeWebSockets closes both sides when the destination consumer remains buffered", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();
  upstream.bufferedAmount = 9;
  bridgeWebSockets(client, upstream, { maxBufferedBytes: 8 });

  client.emit("message", "opaque", false);

  assert.deepEqual(client.closes.at(-1), { code: 1013, reason: "WebSocket bridge consumer is too slow." });
  assert.deepEqual(upstream.closes.at(-1), { code: 1013, reason: "WebSocket bridge consumer is too slow." });
});

test("bridgeWebSockets includes the current frame in the buffered byte limit", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();
  upstream.bufferedAmount = 7;
  bridgeWebSockets(client, upstream, { maxBufferedBytes: 8 });

  client.emit("message", "12", false);

  assert.equal(upstream.sent.length, 0);
  assert.deepEqual(client.closes.at(-1), { code: 1013, reason: "WebSocket bridge consumer is too slow." });
  assert.deepEqual(upstream.closes.at(-1), { code: 1013, reason: "WebSocket bridge consumer is too slow." });
});

test("bridgeWebSockets includes queued frames in the buffered byte limit", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();
  upstream.readyState = 0;
  upstream.bufferedAmount = 2;
  bridgeWebSockets(client, upstream, { maxBufferedBytes: 8 });

  client.emit("message", "1234", false);
  assert.equal(client.closes.length, 0);
  client.emit("message", "789", false);

  assert.equal(upstream.sent.length, 0);
  assert.deepEqual(client.closes.at(-1), { code: 1013, reason: "WebSocket bridge consumer is too slow." });
  assert.deepEqual(upstream.closes.at(-1), { code: 1013, reason: "WebSocket bridge consumer is too slow." });
});

test("bridgeWebSockets converts destination send exceptions into symmetric closure", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();
  upstream.throwOnSend = true;
  bridgeWebSockets(client, upstream);

  assert.doesNotThrow(() => client.emit("message", "opaque", false));
  assert.deepEqual(client.closes.at(-1), { code: 1011, reason: "WebSocket bridge send failed." });
  assert.deepEqual(upstream.closes.at(-1), { code: 1011, reason: "WebSocket bridge send failed." });
});

test("structured websocket compression uses a bounded low-cost policy", () => {
  assert.deepEqual(TASK_HANDOFF_WEBSOCKET_SERVER_OPTIONS, {
    perMessageDeflate: {
      threshold: 256,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 4,
      zlibDeflateOptions: { level: 1 },
    },
  });
});

test("transparent websocket bridges never recompress opaque frames", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();
  bridgeWebSockets(client, upstream);

  client.emit("message", "opaque-text", false);
  upstream.emit("message", Buffer.from([1, 2, 3]), true);

  assert.deepEqual(upstream.sent[0].options, { binary: false, compress: false });
  assert.deepEqual(client.sent[0].options, { binary: true, compress: false });
});

test("websocket compression is negotiated only with clients that request it", async (context) => {
  const app = Fastify();
  await app.register(websocket, { options: TASK_HANDOFF_WEBSOCKET_SERVER_OPTIONS });
  app.get("/events", { websocket: true }, (socket) => socket.send("x".repeat(300)));
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const address = app.server.address();
  const url = `ws://127.0.0.1:${address.port}/events`;

  const current = new WebSocket(url);
  context.after(() => current.terminate());
  await new Promise((resolve, reject) => {
    current.once("message", resolve);
    current.once("error", reject);
  });
  assert.match(current.extensions, /permessage-deflate/);

  const legacy = new WebSocket(url, { perMessageDeflate: false });
  context.after(() => legacy.terminate());
  await new Promise((resolve, reject) => {
    legacy.once("message", resolve);
    legacy.once("error", reject);
  });
  assert.equal(legacy.extensions, "");
});
