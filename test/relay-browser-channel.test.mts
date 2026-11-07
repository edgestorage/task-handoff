import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import { createRequire } from "node:module";
import { decodeRelayFrame, encodeRelayFrame, unpackRelayPayload } from "../packages/cloud-contracts/src/index.ts";
import { inflateRawSync } from "node:zlib";
import { RelayBrowserMultiplexer, encodeRelayBrowserData, decodeRelayBrowserData, isRelayBrowserData, type BrowserChannelMessage } from "../packages/protocol/src/relay-browser-channel.ts";
import { encodeBrowserTunnelHello, encodeBrowserTunnelOpen, encodeBrowserTunnelFrame, decodeBrowserTunnelFrame, BrowserTunnelFrameType } from "../packages/protocol/src/browser-tunnel.ts";
import { attachBrowserTunnel } from "../packages/controlled-instance/src/web/browser-tunnel.ts";
import { BrowserRelayService } from "../packages/control-plane/src/control-plane/instances/browser-relay-service.ts";
import { EncryptedControlPlaneRelaySession } from "../packages/control-plane/src/control-plane/cloud-connectivity/relay-connector.ts";
import { ControlPlaneEventBus } from "../packages/control-plane/src/control-plane/events/bus.ts";
import type { ControlPlaneActor } from "../packages/control-plane/src/control-plane/auth/authorization.ts";

const requireFromControlPlane = createRequire(new URL("../packages/control-plane/package.json", import.meta.url));
const nacl = requireFromControlPlane("tweetnacl");

const actor = { type: "cloud-account", nodeScope: { kind: "all" }, permissionIds: ["instances:interactive"] } as ControlPlaneActor;
const instance = { id: "instance_a", nodeId: "node_a", capabilities: { features: { browserTunnel: true } } };
function nonce(direction: number, counter: number) { const n = new Uint8Array(24); n[0] = direction; new DataView(n.buffer).setBigUint64(16, BigInt(counter), false); return n; }

test("encrypted browser subchannel reaches instance loopback, preserves text/binary, and closes on instance stop", async (t) => {
  const targetSockets = new Set<net.Socket>();
  const target = net.createServer((socket) => { targetSockets.add(socket); socket.on("data", (data) => socket.write(data)); socket.on("close", () => targetSockets.delete(socket)); });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  t.after(async () => { for (const socket of targetSockets) socket.destroy(); await new Promise<void>((resolve) => target.close(() => resolve())); });
  const port = (target.address() as net.AddressInfo).port;
  const events = new ControlPlaneEventBus();
  const relay = new BrowserRelayService({
    async requireControlledInstance(id: string) { assert.equal(id, instance.id); return instance; },
    async proxyInstanceWebSocket(id: string, socket: any, path: string) {
      assert.equal(id, instance.id); assert.equal(path, "/api/browser-tunnel");
      socket.OPEN = 1;
      attachBrowserTunnel(socket);
    },
  } as never, events);
  const key = nacl.randomBytes(32);
  const socket = new EventEmitter() as EventEmitter & { readyState: number; bufferedAmount: number; send(raw: Uint8Array): void; close(): void };
  socket.readyState = 1; socket.bufferedAmount = 0;
  let clientCounter = 0; let serverCounter = 0;
  const client = new RelayBrowserMultiplexer({
    control: (value) => deliver(new TextEncoder().encode(JSON.stringify(value))),
    data: (value) => deliver(encodeRelayBrowserData(value)),
  });
  function deliver(bytes: Uint8Array) {
    const counter = clientCounter++;
    const frame = encodeRelayFrame({ kind: "data", sequence: counter + 1, payload: nacl.secretbox(bytes, nonce(1, counter), key) });
    queueMicrotask(() => socket.emit("message", Buffer.from(frame), true));
  }
  socket.send = (raw) => {
    const frame = decodeRelayFrame(raw);
    assert.equal(frame.sequence, serverCounter + 1);
    const opened = nacl.secretbox.open(frame.payload, nonce(2, serverCounter++), key);
    assert.ok(opened);
    const bytes = unpackRelayPayload(opened, frame.flags ?? 0, inflateRawSync);
    queueMicrotask(() => isRelayBrowserData(bytes) ? client.data(decodeRelayBrowserData(bytes)) : client.control(JSON.parse(Buffer.from(bytes).toString())));
  };
  socket.close = () => { socket.readyState = 3; socket.emit("close", 1000, Buffer.alloc(0)); };
  const session = new EncryptedControlPlaneRelaySession(socket as never, "channel_a", key, actor, { openBrowser: (who, id, handlers) => relay.open(who, id, handlers) } as never);
  session.start();
  t.after(async () => { client.close(); await session.close("test complete"); });
  const received = new EventEmitter();
  let closes = 0;
  const channel = await client.open(instance.id, { onMessage: async (message) => { received.emit("message", message); }, onClose() { closes++; } });
  const ready = once(received, "message");
  await channel.send({ bytes: Buffer.from(encodeBrowserTunnelHello()), binary: false });
  const [hello] = await ready as [BrowserChannelMessage];
  assert.equal(hello.binary, false);
  assert.equal(JSON.parse(Buffer.from(hello.bytes).toString()).type, "browser-tunnel.ready");
  const opened = once(received, "message");
  await channel.send({ bytes: encodeBrowserTunnelOpen(1, { host: "127.0.0.1", port }), binary: true });
  assert.equal(decodeBrowserTunnelFrame(Buffer.from((await opened)[0].bytes)).type, BrowserTunnelFrameType.OpenOk);
  const echo = new Promise<Buffer>((resolve) => {
    const listener = (message: BrowserChannelMessage) => {
      const frame = decodeBrowserTunnelFrame(Buffer.from(message.bytes));
      if (frame.type === BrowserTunnelFrameType.Data) { received.off("message", listener); resolve(frame.payload); }
    };
    received.on("message", listener);
  });
  await channel.send({ bytes: encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.Data, streamId: 1, payload: Buffer.from("instance-loopback") }), binary: true });
  assert.equal((await echo).toString(), "instance-loopback");
  // Cross both the inner TCP window and the outer Relay window repeatedly.
  // Only actual target writes / client consumption may replenish either one.
  const content = Buffer.alloc(2 * 1024 * 1024);
  for (let index = 0; index < content.length; index++) content[index] = index % 251;
  let credit = 256 * 1024 - Buffer.byteLength("instance-loopback");
  let total = 0;
  const chunks: Buffer[] = [];
  const progress = new EventEmitter();
  let finish!: () => void;
  let failed!: (error: unknown) => void;
  const transferred = new Promise<void>((resolve, reject) => { finish = resolve; failed = reject; });
  received.on("message", (message: BrowserChannelMessage) => {
    const frame = decodeBrowserTunnelFrame(Buffer.from(message.bytes));
    if (frame.type === BrowserTunnelFrameType.WindowUpdate) {
      credit += frame.payload.readUInt32BE();
      progress.emit("credit");
    } else if (frame.type === BrowserTunnelFrameType.Data) {
      chunks.push(frame.payload);
      total += frame.payload.length;
      const increment = Buffer.alloc(4); increment.writeUInt32BE(frame.payload.length);
      void channel.send({ bytes: encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.WindowUpdate, streamId: 1, payload: increment }), binary: true }).catch(failed);
      if (total === content.length) finish();
    } else if (frame.type === BrowserTunnelFrameType.HalfClose) progress.emit("half-close");
  });
  for (let offset = 0; offset < content.length; offset += 32 * 1024) {
    const payload = content.subarray(offset, offset + 32 * 1024);
    while (credit < payload.length) await once(progress, "credit");
    credit -= payload.length;
    await channel.send({ bytes: encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.Data, streamId: 1, payload }), binary: true });
  }
  await transferred;
  assert.deepEqual(Buffer.concat(chunks), content);
  const halfClosed = once(progress, "half-close");
  await channel.send({ bytes: encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.HalfClose, streamId: 1, payload: Buffer.alloc(0) }), binary: true });
  await halfClosed;
  events.publish("instance.stopped", { instanceId: instance.id });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  await assert.rejects(channel.send({ bytes: Buffer.from("late"), binary: true }), { code: "BROWSER_CHANNEL_CLOSED" });
});

test("browser authority rejects viewers and out-of-scope targets, allows interactive-only cloud actors", async () => {
  let calls = 0;
  const relay = new BrowserRelayService({ async requireControlledInstance() { return instance; }, async proxyInstanceWebSocket() { calls++; } } as never, new ControlPlaneEventBus());
  const handlers = { onMessage: async () => {}, onClose() {} };
  await assert.rejects(relay.open({ ...actor, permissionIds: ["instances:read"] } as ControlPlaneActor, instance.id, handlers), { code: "CONTROL_PLANE_FORBIDDEN" });
  await assert.rejects(relay.open({ ...actor, nodeScope: { kind: "selected", nodeIds: ["other"] } } as never, instance.id, handlers), { code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE" });
  const channel = await relay.open(actor, instance.id, handlers);
  assert.equal(calls, 1); channel.close();
});
