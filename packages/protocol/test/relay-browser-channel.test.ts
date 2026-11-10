import assert from "node:assert/strict";
import test from "node:test";
import { RelayBrowserMultiplexer, encodeRelayBrowserData, decodeRelayBrowserData, RELAY_BROWSER_MAX_MESSAGE_BYTES, RELAY_BROWSER_WINDOW_BYTES, type BrowserChannelHandlers, type BrowserChannel, type BrowserChannelMessage, type RelayChannelTarget } from "../src/relay-browser-channel.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const message = (size = 16): BrowserChannelMessage => ({ bytes: new Uint8Array(size), binary: true });
function pair(accept: (target: RelayChannelTarget, handlers: BrowserChannelHandlers) => Promise<BrowserChannel>) {
  const outbound: number[] = [];
  const server = new RelayBrowserMultiplexer({
    control: (value) => queueMicrotask(() => client.control(value)),
    data: (frame) => queueMicrotask(() => client.data(decodeRelayBrowserData(encodeRelayBrowserData(frame)))),
    accept,
  });
  const client = new RelayBrowserMultiplexer({
    control: (value) => queueMicrotask(() => server.control(value)),
    data: (frame) => { outbound.push(frame.bytes.byteLength); queueMicrotask(() => server.data(decodeRelayBrowserData(encodeRelayBrowserData(frame)))); },
  });
  return { server, client, outbound, close() { client.close(); server.close(); } };
}

test("browser frames preserve binary, text and sliced Uint8Array views", () => {
  for (const binary of [true, false]) {
    const original = { tunnelId: 0xffff_ffff, bytes: new Uint8Array([9, 1, 2, 9]).subarray(1, 3), binary };
    const encoded = encodeRelayBrowserData(original);
    const padded = new Uint8Array(encoded.length + 2); padded.set(encoded, 1);
    assert.deepEqual(decodeRelayBrowserData(padded.subarray(1, -1)), original);
  }
  assert.throws(() => decodeRelayBrowserData(new Uint8Array([0x57, 1, 0])));
  assert.throws(() => encodeRelayBrowserData({ tunnelId: 0, ...message() }));
  assert.throws(() => encodeRelayBrowserData({ tunnelId: 1, ...message(RELAY_BROWSER_MAX_MESSAGE_BYTES + 1) }));
});

test("a stalled consumer cannot replenish relay credit; other browser channels keep progressing", async (t) => {
  let release!: () => void;
  const consumed = new Promise<void>((resolve) => { release = resolve; });
  const received: string[] = [];
  const p = pair(async (target) => {
    const id = target.kind === "browser" ? target.instanceId : target.path;
    return { send: async () => { received.push(id); if (id === "slow") await consumed; }, close() {} };
  });
  t.after(p.close);
  const handlers = { onMessage: async () => {}, onClose() {} };
  const slow = await p.client.open("slow", handlers);
  const fast = await p.client.open("fast", handlers);
  const sends = [slow.send(message(64 * 1024)), slow.send(message(64 * 1024)), slow.send(message(64 * 1024))];
  await Promise.all(sends.slice(0, 2));
  let third = false; void sends[2].then(() => { third = true; });
  await fast.send(message());
  await tick();
  assert.equal(third, false);
  assert.ok(received.includes("fast"));
  assert.equal(p.outbound.filter((n) => n === 64 * 1024).reduce((a, b) => a + b, 0), RELAY_BROWSER_WINDOW_BYTES);
  release(); await Promise.all(sends); await tick();
  assert.equal(third, true);
});

test("cancelling an opening browser closes a late upstream without reviving the channel", async (t) => {
  let finish!: (peer: BrowserChannel) => void;
  let closed = 0;
  const p = pair(() => new Promise((resolve) => { finish = resolve; }));
  t.after(p.close);
  const abort = new AbortController();
  const opening = p.client.open("instance", { onMessage: async () => {}, onClose() {} }, abort.signal);
  await Promise.resolve();
  abort.abort();
  await assert.rejects(opening, { code: "BROWSER_CHANNEL_CANCELLED" });
  await Promise.resolve();
  finish({ send: async () => { assert.fail("cancelled channel must not deliver"); }, close: () => { closed++; } });
  await tick();
  assert.equal(closed, 1);
});

test("one target error is isolated and reset rejects pending writes exactly once", async (t) => {
  const p = pair(async (target) => {
    const id = target.kind === "browser" ? target.instanceId : target.path;
    if (id === "denied") throw Object.assign(new Error("denied"), { code: "CONTROL_PLANE_FORBIDDEN" });
    return { send: () => new Promise(() => {}), close() {} };
  });
  t.after(p.close);
  await assert.rejects(p.client.open("denied", { onMessage: async () => {}, onClose() {} }), { code: "CONTROL_PLANE_FORBIDDEN" });
  let closed = 0;
  const good = await p.client.open("allowed", { onMessage: async () => {}, onClose() { closed++; } });
  await good.send(message(64 * 1024)); await good.send(message(64 * 1024));
  const waiting = good.send(message(64 * 1024));
  p.client.close(); p.client.close();
  await assert.rejects(waiting, { code: "BROWSER_CHANNEL_CLOSED" });
  assert.equal(closed, 1);
});

test("remote desktop opens the same multiplexed byte channel without changing browser wire shapes", async (t) => {
  let target: RelayChannelTarget | undefined;
  let upstreamHandlers: BrowserChannelHandlers | undefined;
  const upstreamMessages: BrowserChannelMessage[] = [];
  const p = pair(async (nextTarget, handlers) => {
    target = nextTarget;
    upstreamHandlers = handlers;
    return {
      async send(message) { upstreamMessages.push(message); },
      close() {},
    };
  });
  t.after(p.close);
  const received: BrowserChannelMessage[] = [];
  const channel = await p.client.openRemoteDesktop({
    path: "/api/controlled-instances/instance_a/remote-desktop-sessions/viewer_a/signal?ticket=ticket_a",
    protocols: ["taskhandoff.remote-desktop.2026-11-05"],
  }, {
    onMessage: async (value) => { received.push(value); },
    onClose() {},
  });
  assert.deepEqual(target, {
    kind: "remote-desktop",
    path: "/api/controlled-instances/instance_a/remote-desktop-sessions/viewer_a/signal?ticket=ticket_a",
    protocols: ["taskhandoff.remote-desktop.2026-11-05"],
  });
  const text = new TextEncoder().encode("{\"type\":\"signalAlive\"}");
  await upstreamHandlers!.onMessage({ bytes: text, binary: false });
  await tick();
  assert.deepEqual(received.map(({ bytes, binary }) => ({ bytes, binary })), [{ bytes: text, binary: false }]);
  await channel.send({ bytes: new Uint8Array([1, 2, 3]), binary: true });
  await tick();
  assert.deepEqual(upstreamMessages.map(({ bytes, binary }) => ({ bytes, binary })), [{ bytes: new Uint8Array([1, 2, 3]), binary: true }]);
  await p.client.open("instance_browser", { onMessage: async () => {}, onClose() {} });
  assert.deepEqual(target, { kind: "browser", instanceId: "instance_browser" });
});
