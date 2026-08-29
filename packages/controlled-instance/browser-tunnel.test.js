import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import test from "node:test";
import {
  BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_TUNNEL_MAX_WINDOW_BYTES,
  BrowserTunnelFrameType,
  decodeBrowserTunnelFrame,
  decodeBrowserTunnelOpen,
  decodeBrowserTunnelWindowUpdate,
  encodeBrowserTunnelFrame,
  encodeBrowserTunnelHello,
  encodeBrowserTunnelOpen,
  encodeBrowserTunnelWindowUpdate,
} from "../protocol/src/browser-tunnel.ts";
import { attachBrowserTunnel } from "./src/web/browser-tunnel.ts";

class TestWebSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closes = [];
  }
  send(data, options) { this.sent.push({ data, options }); }
  close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; }
}

function nextFrame(ws, type) {
  const entry = ws.sent.map((item) => item.data).filter(Buffer.isBuffer).map(decodeBrowserTunnelFrame).find((frame) => frame.type === type);
  assert.ok(entry, `missing frame type ${type}`);
  return entry;
}

test("controlled instance browser tunnel connects TCP in its runtime and preserves half-close", async (t) => {
  const server = net.createServer((socket) => {
    socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
    socket.on("end", () => socket.end());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const ws = new TestWebSocket();
  attachBrowserTunnel(ws);
  ws.emit("message", encodeBrowserTunnelHello(), false);
  assert.equal(JSON.parse(ws.sent[0].data).type, "browser-tunnel.ready");
  ws.emit("message", encodeBrowserTunnelOpen(1, { host: "127.0.0.1", port: address.port }), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(nextFrame(ws, BrowserTunnelFrameType.OpenOk).streamId, 1);
  ws.emit("message", encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.Data, streamId: 1, payload: Buffer.from("hello") }), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(nextFrame(ws, BrowserTunnelFrameType.Data).payload.toString(), "echo:hello");
  assert.equal(decodeBrowserTunnelWindowUpdate(nextFrame(ws, BrowserTunnelFrameType.WindowUpdate)), 5);
  ws.emit("message", encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.HalfClose, streamId: 1, payload: Buffer.alloc(0) }), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ws.sent.map((item) => item.data).filter(Buffer.isBuffer).map(decodeBrowserTunnelFrame).some((frame) => frame.type === BrowserTunnelFrameType.Close));
});

test("controlled instance browser tunnel isolates duplicate close and flow violations", () => {
  const ws = new TestWebSocket();
  const target = new net.Socket();
  attachBrowserTunnel(ws, { connect: () => target, maxStreams: 1 });
  ws.emit("message", encodeBrowserTunnelHello(BROWSER_TUNNEL_INITIAL_WINDOW_BYTES), false);
  ws.emit("message", encodeBrowserTunnelOpen(2, { host: "localhost", port: 80 }), true);
  ws.emit("message", encodeBrowserTunnelOpen(3, { host: "localhost", port: 81 }), true);
  const limit = nextFrame(ws, BrowserTunnelFrameType.Error);
  assert.equal(limit.streamId, 3);
  ws.emit("message", encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.Close, streamId: 99, payload: Buffer.alloc(0) }), true);
  assert.equal(ws.closes.length, 0);
  ws.emit("message", encodeBrowserTunnelWindowUpdate(2, BROWSER_TUNNEL_MAX_WINDOW_BYTES), true);
  assert.ok(ws.sent.map((item) => item.data).filter(Buffer.isBuffer).map(decodeBrowserTunnelFrame).some((frame) => frame.type === BrowserTunnelFrameType.Error && frame.streamId === 2));
  target.destroy();
});
