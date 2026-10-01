import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CliProfileStore } from "../src/config.ts";
import { runCli } from "../src/program.ts";
import { createFakeControlPlane } from "./helpers/fake-control-plane.js";

const ORIGIN = "http://control-plane.test";
const LABEL = "control-plane.test";

function capture() {
  const out = [];
  const err = [];
  return { streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

async function signedIn() {
  const store = new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-events-")));
  const fake = createFakeControlPlane({ origin: ORIGIN });
  const setup = capture();
  assert.equal(await runCli(["node", "thctl", "profile", "add", ORIGIN], { store, streams: setup.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, setup.stderr());
  let polls = 0;
  const login = capture();
  assert.equal(await runCli(["node", "thctl", "login", "--device"], {
    store,
    streams: login.streams,
    fetchImpl: fake.fetchImpl,
    isTty: false,
    sleep: async () => {
      polls += 1;
      if (polls >= 2) fake.state.deviceApproved = true;
    },
  }), 0, login.stderr());
  return { store, fake };
}

class ScriptedEventSocket {
  constructor(options) {
    this.options = options;
    this.handlers = options.handlers;
    this.sent = [];
    this.closed = undefined;
    this.readyState = 0;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code: code ?? 1000, reason: reason ?? "" };
    queueMicrotask(() => this.handlers.closed({ code: this.closed.code, reason: this.closed.reason }));
  }

  open() {
    this.readyState = 1;
    this.handlers.opened();
  }

  emit(frame) {
    this.handlers.message(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.closed = { code, reason };
    this.handlers.closed({ code, reason });
  }

  fail(message) {
    this.handlers.failed(new Error(message));
  }

  reject(status) {
    this.handlers.rejected(status);
  }
}

function helloFrame(streams = []) {
  return { v: 1, type: "streams.hello", payload: { protocolVersion: 1, streams } };
}

function eventFrame(id, type = "instance.lifecycle.changed", payload = { instanceId: "instance_fake001" }) {
  return { v: 1, id, seq: 1, type, topic: type.startsWith("instance.") ? "instances" : "system", createdAt: new Date().toISOString(), payload };
}

function scriptedSockets() {
  const sockets = [];
  return {
    sockets,
    createEventSocket: (options) => {
      const socket = new ScriptedEventSocket(options);
      sockets.push(socket);
      return socket;
    },
  };
}

async function wsServerAvailable() {
  const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  try {
    await new Promise((resolve, reject) => {
      probe.once("listening", resolve);
      probe.once("error", reject);
    });
    await new Promise((resolve) => probe.close(resolve));
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("events subscribes with normalized topics and prints one JSON line per event", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const controller = new AbortController();
  const { sockets, createEventSocket } = scriptedSockets();

  const run = runCli(["node", "thctl", "events", "--topic", "ai-sessions", "--topic", "instances", "--instance", "instance_fake001"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, signal: controller.signal, createEventSocket,
  });

  await waitFor(() => sockets.length === 1, "the event socket");
  const [socket] = sockets;
  assert.equal(socket.options.url, "ws://control-plane.test/api/events?aiSessionTransient=1&resourceMetricsScope=1&instanceId=instance_fake001");
  assert.equal(socket.options.authorization, `Bearer ${fake.state.sessionToken}`);

  socket.open();
  assert.equal(socket.sent.length, 1);
  const subscribe = socket.sent[0];
  assert.equal(subscribe.v, 1);
  assert.equal(subscribe.type, "subscribe");
  assert.deepEqual(subscribe.topics, ["ai.sessions", "instances"]);
  assert.deepEqual(subscribe.instanceIds, ["instance_fake001"]);
  assert.deepEqual(subscribe.metricInstanceIds, []);
  assert.deepEqual(subscribe.aiSessionTransient, { messageDeltas: { allInstances: false, instanceIds: [] }, timelineAllSessions: false, timelineSessions: [] });

  socket.emit(helloFrame());
  socket.emit(eventFrame("evt_one"));
  socket.emit({ v: 1, type: "pong", sentAt: new Date().toISOString(), receivedAt: new Date().toISOString() });
  await waitFor(() => output.stdout().includes("evt_one"), "the first event line");
  controller.abort();
  assert.equal(await run, 0, output.stderr());

  const lines = output.stdout().trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, "evt_one");
  assert.equal(lines[0].topic, "instances");
  assert.equal(socket.closed.code, 1000);
  assert.equal(fake.state.calls.filter((call) => call.path === "/api/events").length, 0, "events must not fall back to HTTP polling");
});

test("events reconnects after a drop, drops pre-handshake frames and deduplicates replayed events", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const controller = new AbortController();
  const { sockets, createEventSocket } = scriptedSockets();

  const run = runCli(["node", "thctl", "events"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, signal: controller.signal, createEventSocket,
  });

  await waitFor(() => sockets.length === 1, "the first event socket");
  const first = sockets[0];
  first.open();
  assert.deepEqual(first.sent[0].topics, ["*"]);
  // 握手前的帧不是权威快照，必须丢弃。
  first.emit(eventFrame("evt_pre_handshake"));
  first.emit(helloFrame());
  first.emit(eventFrame("evt_one"));
  await waitFor(() => output.stdout().includes("evt_one"), "the first event line");

  first.drop(1006, "network lost");
  await waitFor(() => sockets.length === 2, "the reconnect");

  const second = sockets[1];
  second.open();
  assert.equal(second.sent[0].type, "subscribe");
  second.emit(helloFrame());
  second.emit(eventFrame("evt_one"));
  second.emit(eventFrame("evt_two"));
  await waitFor(() => output.stdout().includes("evt_two"), "the replayed stream");
  controller.abort();
  assert.equal(await run, 0, output.stderr());

  const ids = output.stdout().trim().split("\n").map((line) => JSON.parse(line).id);
  assert.deepEqual(ids, ["evt_one", "evt_two"]);
  assert.match(output.stderr(), /reconnecting \(attempt 1, in 0ms\)/);
  assert.equal(sockets.length, 2);
});

test("events clears the stored credential when the Control Plane rejects the upgrade", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const code = await runCli(["node", "thctl", "events"], {
    store,
    streams: output.streams,
    fetchImpl: fake.fetchImpl,
    isTty: false,
    createEventSocket: ({ handlers }) => {
      queueMicrotask(() => handlers.rejected(401));
      return { send: () => {}, close: () => {} };
    },
  });
  assert.equal(code, 5, output.stderr());
  assert.match(output.stderr(), /CLI_EVENT_STREAM_UNAUTHORIZED/);
  assert.equal(store.secrets().read(LABEL), undefined);
});

test("events fails fast when the first connection cannot be established", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const code = await runCli(["node", "thctl", "events"], {
    store,
    streams: output.streams,
    fetchImpl: fake.fetchImpl,
    isTty: false,
    createEventSocket: ({ handlers }) => {
      queueMicrotask(() => handlers.failed(new Error("connect ECONNREFUSED 127.0.0.1:9")));
      return { send: () => {}, close: () => {} };
    },
  });
  assert.equal(code, 10, output.stderr());
  assert.match(output.stderr(), /CLI_NETWORK_ERROR/);
  assert.doesNotMatch(output.stderr(), /reconnecting/);
});

test("events reports an invisible event scope with the forbidden exit code", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const code = await runCli(["node", "thctl", "events", "--instance", "instance_other"], {
    store,
    streams: output.streams,
    fetchImpl: fake.fetchImpl,
    isTty: false,
    createEventSocket: ({ handlers }) => {
      queueMicrotask(() => handlers.closed({ code: 4003, reason: "The requested event scope is not visible." }));
      return { send: () => {}, close: () => {} };
    },
  });
  assert.equal(code, 6, output.stderr());
  assert.match(output.stderr(), /CLI_EVENT_STREAM_SCOPE_NOT_VISIBLE/);
});

test("events uses the ws transport with the bearer credential by default", async (t) => {
  if (!(await wsServerAvailable())) {
    t.skip("loopback binding is not permitted in this environment");
    return;
  }
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const store = new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-events-ws-")));
  const fake = createFakeControlPlane({ origin });
  const setup = capture();
  assert.equal(await runCli(["node", "thctl", "profile", "add", origin], { store, streams: setup.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, setup.stderr());
  let polls = 0;
  const login = capture();
  assert.equal(await runCli(["node", "thctl", "login", "--device"], {
    store,
    streams: login.streams,
    fetchImpl: fake.fetchImpl,
    isTty: false,
    sleep: async () => {
      polls += 1;
      if (polls >= 2) fake.state.deviceApproved = true;
    },
  }), 0, login.stderr());

  const frames = [];
  server.on("connection", (socket, request) => {
    frames.push({ authorization: request.headers.authorization });
    socket.send(JSON.stringify(helloFrame()));
    socket.send(JSON.stringify(eventFrame("evt_ws")));
  });

  const output = capture();
  const controller = new AbortController();
  const run = runCli(["node", "thctl", "events"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, signal: controller.signal,
  });
  await waitFor(() => output.stdout().includes("evt_ws"), "the WebSocket frame");
  controller.abort();
  assert.equal(await run, 0, output.stderr());
  const lines = output.stdout().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.id), ["evt_ws"]);
  assert.equal(frames[0].authorization, `Bearer ${fake.state.sessionToken}`);
  await new Promise((resolve) => server.close(resolve));
});
