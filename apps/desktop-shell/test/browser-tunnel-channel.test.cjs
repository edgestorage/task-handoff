const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  BrowserTunnelFrameType,
  decodeBrowserTunnelFrame,
  encodeBrowserTunnelFrame,
  encodeBrowserTunnelReady,
} = require("../../../dist/browser-tunnel.js");
const { BrowserTunnelChannel } = require("../src/browser-tunnel-channel.cjs");

test("desktop Browser Tunnel multiplexes a SOCKS socket with credit updates", async () => {
  const channel = new BrowserTunnelChannel({ url: "wss://cp.example/browser-relay", token: "secret", WebSocket: FakeWebSocket });
  const connecting = channel.connect();
  const ws = channel.socket;
  ws.readyState = FakeWebSocket.OPEN;
  ws.emit("open");
  assert.equal(JSON.parse(ws.sent[0].data).type, "browser-tunnel.hello");
  ws.emit("message", Buffer.from(encodeBrowserTunnelReady()), false);
  await connecting;

  const local = new LocalSocket();
  const opening = channel.attach({ host: "127.0.0.1", port: 3000 }, local);
  await Promise.resolve();
  const open = binaryFrames(ws).find((frame) => frame.type === BrowserTunnelFrameType.Open);
  assert.ok(open);
  ws.emit("message", encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.OpenOk, streamId: open.streamId, payload: Buffer.alloc(0) }), true);
  await opening;
  local.emit("data", Buffer.from("request"));
  assert.equal(binaryFrames(ws).find((frame) => frame.type === BrowserTunnelFrameType.Data).payload.toString(), "request");

  ws.emit("message", encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.Data, streamId: open.streamId, payload: Buffer.from("response") }), true);
  assert.equal(local.writes.at(-1).toString(), "response");
  assert.ok(binaryFrames(ws).some((frame) => frame.type === BrowserTunnelFrameType.WindowUpdate));
  channel.close();
  assert.equal(local.destroyed, true);
});

function binaryFrames(ws) {
  return ws.sent.filter((entry) => Buffer.isBuffer(entry.data)).map((entry) => decodeBrowserTunnelFrame(entry.data));
}

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  constructor(_url, options) { super(); this.options = options; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; }
  send(data, options) { this.sent.push({ data, options }); }
  close() { this.readyState = 3; }
}

class LocalSocket extends EventEmitter {
  writes = [];
  destroyed = false;
  pause() {}
  resume() {}
  write(data, callback) { this.writes.push(Buffer.from(data)); callback?.(); return true; }
  end() {}
  destroy() { this.destroyed = true; }
}
