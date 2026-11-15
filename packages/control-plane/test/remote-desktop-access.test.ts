import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ControlPlaneActor } from "../src/control-plane/auth/authorization.ts";
import type { NodeAgentWebSocket } from "../src/control-plane/nodes/client.ts";
import { DesktopAccess, type DesktopPrincipal } from "../src/control-plane/remote-desktop/access.ts";

const principal: DesktopPrincipal = {
  actor: {
    type: "user",
    identityId: "identity_a",
    userId: "user_a",
    roles: [],
    permissions: [],
    nodeScope: { kind: "all" },
    instanceScope: { kind: "inherit-node-scope" },
    authorizationRevision: 1,
    requiresPasswordChange: false,
  } satisfies ControlPlaneActor,
  deviceSessionId: "device_a",
};

const snapshot = {
  viewerSessionId: "rdv_a",
  sessionRevision: 1,
  phase: "starting",
  captureSelection: { sourceRef: "display-primary" },
  sessionExpiresAt: Date.now() + 30_000,
  idleExpiresAt: null,
  mediaPaused: true,
  reason: null,
};

class FakeSocket extends EventEmitter {
  readyState = 1;
  closeCode: number | undefined;
  sent: unknown[] = [];

  send(data: unknown) { this.sent.push(data); }
  close(code: number) { this.closeCode = code; this.readyState = 3; }
}

test("signal liveness before the first component snapshot is accepted and forwarded after ready", async () => {
  let upstream: FakeSocket | undefined;
  const upstreamMessages: unknown[] = [];
  let releaseAttach: (() => void) | undefined;
  const attached = new Promise<void>((resolve) => { releaseAttach = resolve; });
  const access = new DesktopAccess({
    async request(_instanceId, operation) {
      if (operation === "reserve") return { type: "reserved", attachToken: "attach_a", attachExpiresAt: Date.now() + 30_000, snapshot };
      if (operation === "stop") return { type: "stopped" };
      throw new Error(`unexpected ${operation}`);
    },
    async attach(_instanceId, socket) {
      upstream = socket as unknown as FakeSocket;
      socket.on("message", (data: unknown) => upstreamMessages.push(data));
      await attached;
    },
    async renewAuthorization() { return true; },
    issueIce() { return { iceServers: [], iceCredentialsExpiresAt: null }; },
  });

  const created = await access.create(principal, "inst_a", "node_a", "request_a", { sourceRef: "display-primary" });
  const entry = access.consume(principal, "inst_a", created.snapshot.viewerSessionId, created.ticket);
  const socket = new FakeSocket();
  const connecting = access.connect(entry, socket as never);

  await Promise.resolve();
  socket.emit("message", Buffer.from(JSON.stringify({ type: "signalAlive", requestId: "alive_a" })), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socket.closeCode, undefined);
  assert.equal(upstreamMessages.some((value) => String(value).includes("signalAlive")), false);

  upstream!.send(JSON.stringify({ type: "snapshot", snapshot }));
  releaseAttach!();
  await connecting;

  assert.equal(socket.closeCode, undefined);
  assert.equal(socket.sent.some((value) => String(value).includes("\"type\":\"snapshot\"")), true);

  socket.emit("message", Buffer.from(JSON.stringify({ type: "signalAlive", requestId: "alive_b" })), false);
  assert.equal(upstreamMessages.some((value) => String(value).includes("alive_b")), true);
});

test("an attach failure code reaches the viewer before the dead session closes", async () => {
  const requests: string[] = [];
  let relay: NodeAgentWebSocket | undefined;
  const access = new DesktopAccess({
    async request(_instanceId, operation) {
      requests.push(operation);
      if (operation === "reserve") return { type: "reserved", attachToken: "attach_a", attachExpiresAt: Date.now() + 30_000, snapshot };
      if (operation === "stop") return { type: "stopped" };
      throw new Error(`unexpected ${operation}`);
    },
    async attach(_instanceId, socket) {
      relay = socket;
    },
    async renewAuthorization() { return true; },
    issueIce() { return { iceServers: [], iceCredentialsExpiresAt: null }; },
  });

  const created = await access.create(principal, "inst_a", "node_a", "request_a", { sourceRef: "display-primary" });
  const entry = access.consume(principal, "inst_a", created.snapshot.viewerSessionId, created.ticket);
  const socket = new FakeSocket();
  await access.connect(entry, socket as never);

  relay!.send(JSON.stringify({ type: "error", code: "REMOTE_DESKTOP_WINDOW_UNAVAILABLE" }));
  await new Promise((resolve) => setImmediate(resolve));

  const messages = socket.sent.map((value) => JSON.parse(String(value)));
  assert.deepEqual(messages.filter((value) => value.type === "error"), [
    { type: "error", code: "REMOTE_DESKTOP_WINDOW_UNAVAILABLE" },
  ]);
  assert.equal(socket.closeCode, 1000);
  assert.equal(requests.includes("stop"), true);
});

test("an attach transport failure still reaches the viewer as a desktop error", async () => {
  const access = new DesktopAccess({
    async request(_instanceId, operation) {
      if (operation === "reserve") return { type: "reserved", attachToken: "attach_a", attachExpiresAt: Date.now() + 30_000, snapshot };
      if (operation === "stop") return { type: "stopped" };
      throw new Error(`unexpected ${operation}`);
    },
    async attach() { throw new Error("Instance inst_a is not ready."); },
    async renewAuthorization() { return true; },
    issueIce() { return { iceServers: [], iceCredentialsExpiresAt: null }; },
  });

  const created = await access.create(principal, "inst_a", "node_a", "request_a", { sourceRef: "display-primary" });
  const entry = access.consume(principal, "inst_a", created.snapshot.viewerSessionId, created.ticket);
  const socket = new FakeSocket();
  await access.connect(entry, socket as never);

  const messages = socket.sent.map((value) => JSON.parse(String(value)));
  assert.deepEqual(messages.filter((value) => value.type === "error"), [
    { type: "error", code: "REMOTE_DESKTOP_ATTACH_FAILED" },
  ]);
  assert.equal(socket.closeCode, 1000);
});

test("a resumed signal ticket replaces the browser tunnel without re-attaching the component", async () => {
  let attaches = 0;
  let upstream: FakeSocket | undefined;
  const upstreamMessages: unknown[] = [];
  const access = new DesktopAccess({
    async request(_instanceId, operation) {
      if (operation === "reserve") return { type: "reserved", attachToken: "attach_a", attachExpiresAt: Date.now() + 30_000, snapshot };
      if (operation === "stop") return { type: "stopped" };
      throw new Error(`unexpected ${operation}`);
    },
    async attach(_instanceId, socket) {
      attaches += 1;
      upstream = socket as unknown as FakeSocket;
      socket.on("message", (data: unknown) => upstreamMessages.push(data));
    },
    async renewAuthorization() { return true; },
    issueIce() { return { iceServers: [], iceCredentialsExpiresAt: null }; },
  });

  const created = await access.create(principal, "inst_a", "node_a", "request_a", { sourceRef: "display-primary" });
  const firstEntry = access.consume(principal, "inst_a", created.snapshot.viewerSessionId, created.ticket);
  const first = new FakeSocket();
  await access.connect(firstEntry, first as never);
  assert.equal(attaches, 1);

  upstream!.send(JSON.stringify({ type: "snapshot", snapshot }));
  const configure = first.sent.map((value) => JSON.parse(String(value))).find((value) => value.type === "configureIce");
  assert.ok(configure?.requestId);
  upstream!.send(JSON.stringify({ type: "acknowledged", requestId: configure.requestId }));
  assert.equal(first.sent.some((value) => String(value).includes("\"type\":\"ready\"")), true);

  const issued = access.issueSignalTicket(principal, "inst_a", created.snapshot.viewerSessionId);
  const resumedEntry = access.consume(principal, "inst_a", created.snapshot.viewerSessionId, issued.ticket);
  const resumed = new FakeSocket();
  await access.connect(resumedEntry, resumed as never);

  assert.equal(attaches, 1, "signal resume must not attach a second component viewer");
  assert.equal(first.closeCode, 1000);
  const replayed = resumed.sent.map((value) => JSON.parse(String(value)));
  assert.equal(replayed.some((value) => value.type === "snapshot"), true);
  assert.equal(replayed.some((value) => value.type === "ready"), true);

  resumed.emit("message", Buffer.from(JSON.stringify({ type: "signalAlive", requestId: "resumed_alive" })), false);
  assert.equal(upstreamMessages.some((value) => String(value).includes("resumed_alive")), true);
});

test("signaling loss keeps the reservation long enough for fallback to take over", async () => {
  const requests: string[] = [];
  const access = new DesktopAccess({
    async request(_instanceId, operation) {
      requests.push(operation);
      if (operation === "reserve") return { type: "reserved", attachToken: "attach_a", attachExpiresAt: Date.now() + 30_000, snapshot };
      if (operation === "stop") return { type: "stopped" };
      throw new Error(`unexpected ${operation}`);
    },
    async attach() {},
    async fallback() {},
    async renewAuthorization() { return true; },
    issueIce() { return { iceServers: [], iceCredentialsExpiresAt: null }; },
  });

  const created = await access.create(principal, "inst_a", "node_a", "request_a", { sourceRef: "display-primary" });
  const entry = access.consume(principal, "inst_a", created.snapshot.viewerSessionId, created.ticket);
  const signal = new FakeSocket();
  await access.connect(entry, signal as never);

  signal.readyState = 3;
  signal.emit("close");

  const issued = access.issueFallback(principal, "inst_a", created.snapshot.viewerSessionId);
  assert.match(issued.mediaUrl, /\/fallback\/media\?ticket=/);
  assert.equal(requests.includes("stop"), false, "a signaling close must not stop the session while fallback can attach");
});

test("browser signaling loss keeps the upstream attach alive until fallback takes over", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const requests: string[] = [];
  const upstreamMessages: string[] = [];
  let relay: NodeAgentWebSocket | undefined;
  let relayClosed = false;
  const access = new DesktopAccess({
    async request(_instanceId, operation) {
      requests.push(operation);
      if (operation === "reserve") return { type: "reserved", attachToken: "attach_a", attachExpiresAt: Date.now() + 30_000, snapshot };
      if (operation === "stop") return { type: "stopped" };
      throw new Error(`unexpected ${operation}`);
    },
    async attach(_instanceId, socket) {
      relay = socket;
      socket.on("message", (data: unknown) => upstreamMessages.push(String(data)));
      socket.on("close", () => { relayClosed = true; });
    },
    async fallback() {},
    async renewAuthorization() { return true; },
    issueIce() { return { iceServers: [], iceCredentialsExpiresAt: null }; },
  });

  const created = await access.create(principal, "inst_a", "node_a", "request_a", { sourceRef: "display-primary" });
  const entry = access.consume(principal, "inst_a", created.snapshot.viewerSessionId, created.ticket);
  const signal = new FakeSocket();
  await access.connect(entry, signal as never);

  const alive = () => upstreamMessages.filter((value) => value.includes("\"type\":\"signalAlive\"")).length;
  const initial = alive();
  assert.ok(initial >= 1, "the Control Plane heartbeats the component immediately after attach");

  signal.readyState = 3;
  signal.emit("close");
  assert.equal(relayClosed, false, "a browser signaling close must not close the upstream attach");

  t.mock.timers.tick(12_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(alive() - initial >= 6, "the upstream attach stays alive across the component's six-second lease");
  assert.equal(relayClosed, false);
  assert.equal(requests.includes("stop"), false);
  assert.match(access.issueFallback(principal, "inst_a", created.snapshot.viewerSessionId).mediaUrl, /\/fallback\/media\?ticket=/);

  await access.stop(principal, "inst_a", created.snapshot.viewerSessionId, "stop_a");
  await new Promise((resolve) => setImmediate(resolve));

  const beforeClose = alive();
  assert.equal(requests.includes("stop"), true);
  assert.equal(relayClosed, true, "an explicit stop closes the upstream attach");
  t.mock.timers.tick(10_000);
  assert.equal(alive(), beforeClose, "the upstream heartbeat stops after the reservation closes");
  assert.ok(relay);
});

test("simultaneous signal and fallback loss keeps the reservation for a replacement pair", async () => {
  const requests: string[] = [];
  const access = new DesktopAccess({
    async request(_instanceId, operation) {
      requests.push(operation);
      if (operation === "reserve") return { type: "reserved", attachToken: "attach_a", attachExpiresAt: Date.now() + 30_000, snapshot };
      if (operation === "stop") return { type: "stopped" };
      throw new Error(`unexpected ${operation}`);
    },
    async attach() {},
    async fallback() {},
    async renewAuthorization() { return true; },
    issueIce() { return { iceServers: [], iceCredentialsExpiresAt: null }; },
  });

  const created = await access.create(principal, "inst_a", "node_a", "request_a", { sourceRef: "display-primary" });
  const entry = access.consume(principal, "inst_a", created.snapshot.viewerSessionId, created.ticket);
  const signal = new FakeSocket();
  await access.connect(entry, signal as never);

  const first = access.issueFallback(principal, "inst_a", created.snapshot.viewerSessionId);
  const mediaTicket = new URL(first.mediaUrl, "http://localhost").searchParams.get("ticket")!;
  const controlTicket = new URL(first.controlUrl, "http://localhost").searchParams.get("ticket")!;
  const media = access.consumeFallback(principal, "inst_a", created.snapshot.viewerSessionId, "media", mediaTicket);
  const control = access.consumeFallback(principal, "inst_a", created.snapshot.viewerSessionId, "control", controlTicket);
  const mediaSocket = new FakeSocket();
  const controlSocket = new FakeSocket();
  await access.connectFallback(media.entry, "media", media.generation, mediaSocket as never);
  await access.connectFallback(control.entry, "control", control.generation, controlSocket as never);

  // A Relay reconnect closes the signal and both fallback sockets together.
  signal.readyState = 3;
  signal.emit("close");
  mediaSocket.readyState = 3;
  mediaSocket.emit("close");
  controlSocket.readyState = 3;
  controlSocket.emit("close");
  await new Promise((resolve) => setImmediate(resolve));

  const replacement = access.issueFallback(principal, "inst_a", created.snapshot.viewerSessionId);
  assert.match(replacement.mediaUrl, /\/fallback\/media\?ticket=/);
  assert.equal(requests.includes("stop"), false, "a shared transport loss must not stop the component session before recovery");
});

test("fallback closing before signal still gets the full replacement grace window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: string[] = [];
  const access = new DesktopAccess({
    async request(_instanceId, operation) {
      requests.push(operation);
      if (operation === "reserve") return { type: "reserved", attachToken: "attach_a", attachExpiresAt: Date.now() + 30_000, snapshot };
      if (operation === "stop") return { type: "stopped" };
      throw new Error(`unexpected ${operation}`);
    },
    async attach() {},
    async fallback() {},
    async renewAuthorization() { return true; },
    issueIce() { return { iceServers: [], iceCredentialsExpiresAt: null }; },
  });

  const created = await access.create(principal, "inst_a", "node_a", "request_a", { sourceRef: "display-primary" });
  const entry = access.consume(principal, "inst_a", created.snapshot.viewerSessionId, created.ticket);
  const signal = new FakeSocket();
  await access.connect(entry, signal as never);

  const first = access.issueFallback(principal, "inst_a", created.snapshot.viewerSessionId);
  const mediaTicket = new URL(first.mediaUrl, "http://localhost").searchParams.get("ticket")!;
  const controlTicket = new URL(first.controlUrl, "http://localhost").searchParams.get("ticket")!;
  const media = access.consumeFallback(principal, "inst_a", created.snapshot.viewerSessionId, "media", mediaTicket);
  const control = access.consumeFallback(principal, "inst_a", created.snapshot.viewerSessionId, "control", controlTicket);
  const mediaSocket = new FakeSocket();
  const controlSocket = new FakeSocket();
  await access.connectFallback(media.entry, "media", media.generation, mediaSocket as never);
  await access.connectFallback(control.entry, "control", control.generation, controlSocket as never);

  // The Relay closes the fallback pair first and reports the signaling close last.
  mediaSocket.readyState = 3;
  mediaSocket.emit("close");
  signal.readyState = 3;
  signal.emit("close");
  t.mock.timers.tick(6_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.includes("stop"), false, "a 5 second signal-only window would have stopped the session");
  const replacement = access.issueFallback(principal, "inst_a", created.snapshot.viewerSessionId);
  assert.match(replacement.mediaUrl, /\/fallback\/media\?ticket=/);
});
