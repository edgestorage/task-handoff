import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InstanceShellDataChannel,
  encodeInstanceShellBinaryFrame,
  INSTANCE_SHELL_PROTOCOL_VERSION,
} from "@task-handoff/protocol/instance-shell";
import { CliProfileStore } from "../src/config.ts";
import { defaultStreams } from "../src/output.ts";
import { runCli } from "../src/program.ts";
import { createFakeControlPlane } from "./helpers/fake-control-plane.js";

const ORIGIN = "http://control-plane.test";
const LABEL = "control-plane.test";
const INSTANCE = "instance_fake001";

function capture() {
  const out = [];
  const err = [];
  return {
    chunks: { out, err },
    streams: { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk) },
    stdout: () => out.map((chunk) => typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")).join(""),
    stderr: () => err.map((chunk) => typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")).join(""),
  };
}

async function signedIn(options = {}) {
  const store = new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-instance-shell-")));
  const fake = createFakeControlPlane({ origin: ORIGIN, ...options });
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

class FakeStdin extends EventEmitter {
  constructor({ isTTY = false, columns = 100, rows = 30 } = {}) {
    super();
    this.isTTY = isTTY;
    this.columns = columns;
    this.rows = rows;
    this.readableEnded = false;
    this.rawModes = [];
    this.resumed = 0;
    this.paused = 0;
  }

  setRawMode(value) {
    this.rawModes.push(value);
  }

  resume() {
    this.resumed += 1;
  }

  pause() {
    this.paused += 1;
  }
}

class FakeTerminal {
  constructor({ isTTY = false, columns = 100, rows = 30 } = {}) {
    this.stdin = new FakeStdin({ isTTY, columns, rows });
    this.stdout = { isTTY, columns, rows, write: (chunk) => this.writes.push(chunk) };
    this.writes = [];
    this.resizeHandler = undefined;
  }

  onResize(listener) {
    this.resizeHandler = listener;
    return () => {
      if (this.resizeHandler === listener) this.resizeHandler = undefined;
    };
  }

  resize(columns, rows) {
    this.stdin.columns = columns;
    this.stdin.rows = rows;
    this.stdout.columns = columns;
    this.stdout.rows = rows;
    this.resizeHandler?.();
  }
}

class ScriptedShellSocket {
  constructor(options) {
    this.options = options;
    this.handlers = options.handlers;
    this.sent = [];
    this.closed = undefined;
    this.bufferedAmount = 0;
  }

  send(data) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
  }

  open() {
    this.handlers.opened();
  }

  emitText(frame) {
    this.handlers.message(typeof frame === "string" ? frame : JSON.stringify(frame), false);
  }

  emitStarted(mode, tty) {
    this.emitText({ type: "started", protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION, mode, tty });
  }

  emitBinary(channel, payload) {
    this.handlers.message(encodeInstanceShellBinaryFrame(channel, Uint8Array.from(payload)), true);
  }

  exitCode(code) {
    this.emitText({ type: "exit", code });
  }

  exitSignal(signal) {
    this.emitText({ type: "exit", signal });
  }

  remoteError(code, message = "Instance command failed.") {
    this.emitText({ type: "error", code, message });
  }

  reject(status) {
    this.handlers.rejected(status);
  }

  drop(code = 1006, reason = "") {
    this.handlers.closed({ code, reason });
  }

  fail(message) {
    this.handlers.failed(new Error(message));
  }
}

function scriptedSockets() {
  const sockets = [];
  return {
    sockets,
    createWebSocket: (options) => {
      const socket = new ScriptedShellSocket(options);
      sockets.push(socket);
      return socket;
    },
  };
}

function startFrame(socket) {
  return JSON.parse(socket.sent[0]);
}

function dataFrames(socket, channel) {
  return socket.sent
    .filter((value) => value instanceof Uint8Array && value[0] === channel)
    .map((value) => Buffer.from(value.subarray(1)));
}

async function waitFor(predicate, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("exec preserves argv, raw stdin/stdout/stderr, and the remote exit code", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const terminal = new FakeTerminal();
  const { sockets, createWebSocket } = scriptedSockets();
  const argv = ["printf", "", "a b", "--flag", "--json", "你好"];
  const run = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", ...argv], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, terminal, createWebSocket,
  });

  await waitFor(() => sockets.length === 1, "the instance shell socket");
  const [socket] = sockets;
  assert.equal(socket.options.url, `ws://control-plane.test/api/controlled-instances/${INSTANCE}/shell`);
  assert.equal(socket.options.authorization, `Bearer ${fake.state.sessionToken}`);
  assert.deepEqual(socket.options.subprotocols, ["task-handoff.instance-shell.2026-10-31"]);
  socket.open();
  assert.deepEqual(startFrame(socket), { type: "start", mode: "exec", tty: false, command: argv });

  socket.emitStarted("exec", false);
  assert.equal(terminal.stdin.resumed, 1);
  terminal.stdin.emit("data", Uint8Array.of(0xff, 0x00, 0x0d, 0x0a));
  terminal.stdin.readableEnded = true;
  terminal.stdin.emit("end");
  socket.emitBinary(InstanceShellDataChannel.Stderr, [0xf0, 0x00, 0x0a]);
  socket.emitBinary(InstanceShellDataChannel.Output, [0x00, 0xff, 0x0d, 0x0a, 0x80]);
  socket.exitCode(7);

  assert.equal(await run, 7, output.stderr());
  assert.deepEqual(dataFrames(socket, InstanceShellDataChannel.Input), [Buffer.from([0xff, 0x00, 0x0d, 0x0a])]);
  assert.equal(socket.sent.at(-1), JSON.stringify({ type: "stdin-close" }));
  assert.ok(output.chunks.out.at(-1) instanceof Uint8Array);
  assert.ok(output.chunks.err.at(-1) instanceof Uint8Array);
  assert.deepEqual(Array.from(output.chunks.out.at(-1)), [0, 255, 13, 10, 128]);
  assert.deepEqual(Array.from(output.chunks.err.at(-1)), [240, 0, 10]);
  assert.equal(sockets.length, 1, "exec must not reconnect");
  assert.equal(terminal.stdin.rawModes.length, 0);
  assert.equal(terminal.stdin.paused, 1);
});

test("interactive shell enters raw mode, forwards control bytes, resizes, restores, and maps POSIX signals", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const terminal = new FakeTerminal({ isTTY: true, columns: 132, rows: 43 });
  const { sockets, createWebSocket } = scriptedSockets();
  const run = runCli(["node", "thctl", "instance", "shell", INSTANCE], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: true, terminal, createWebSocket,
  });

  await waitFor(() => sockets.length === 1, "the interactive socket");
  const [socket] = sockets;
  socket.open();
  assert.deepEqual(startFrame(socket), { type: "start", mode: "interactive", tty: true, cols: 132, rows: 43 });
  socket.emitStarted("interactive", true);
  assert.deepEqual(terminal.stdin.rawModes, [true]);

  terminal.stdin.emit("data", Buffer.from([0x03, 0x1b, 0x5b, 0x41]));
  terminal.resize(90, 25);
  assert.deepEqual(dataFrames(socket, InstanceShellDataChannel.Input), [Buffer.from([0x03, 0x1b, 0x5b, 0x41])]);
  assert.equal(socket.sent.at(-1), JSON.stringify({ type: "resize", cols: 90, rows: 25 }));
  socket.emitBinary(InstanceShellDataChannel.Output, [0x1b, 0x5b, 0x33, 0x31, 0x6d]);
  socket.exitSignal("SIGTERM");

  assert.equal(await run, 128 + os.constants.signals.SIGTERM, output.stderr());
  assert.deepEqual(terminal.stdin.rawModes, [true, false]);
  assert.ok(terminal.writes.includes("\u001b[?25h"));
  assert.equal(socket.closed.code, 1000);
  assert.equal(output.stderr(), "");
  assert.equal(terminal.stdin.paused, 1);
});

test("interactive shell rejects non-TTY callers before opening a remote process", async () => {
  const output = capture();
  const { sockets, createWebSocket } = scriptedSockets();
  const code = await runCli(["node", "thctl", "instance", "shell", INSTANCE], {
    streams: output.streams,
    isTty: false,
    terminal: new FakeTerminal({ isTTY: false }),
    createWebSocket,
  });
  assert.equal(code, 2);
  assert.match(output.stderr(), /CLI_INTERACTIVE_TTY_REQUIRED/);
  assert.equal(sockets.length, 0);
});

test("exec rejects --json and --table before the delimiter but accepts them after it", async () => {
  const { store, fake } = await signedIn();
  for (const option of ["--json", "--table"]) {
    const output = capture();
    const { sockets, createWebSocket } = scriptedSockets();
    const code = await runCli(["node", "thctl", "instance", "exec", INSTANCE, option, "--", "printf", "x"], {
      store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, terminal: new FakeTerminal(), createWebSocket,
    });
    assert.equal(code, 2, `${option}: ${output.stderr()}`);
    assert.match(output.stderr(), /CLI_OUTPUT_MODE_UNSUPPORTED/);
    assert.equal(sockets.length, 0);
  }

  const output = capture();
  const { sockets, createWebSocket } = scriptedSockets();
  const run = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", "printf", "--json", "--table"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, terminal: new FakeTerminal(), createWebSocket,
  });
  await waitFor(() => sockets.length === 1, "the literal flag socket");
  const [socket] = sockets;
  socket.open();
  assert.deepEqual(startFrame(socket).command, ["printf", "--json", "--table"]);
  socket.emitStarted("exec", false);
  socket.exitCode(0);
  assert.equal(await run, 0, output.stderr());
});

test("exec --tty requests a PTY and forwards dimensions and EOT", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const terminal = new FakeTerminal({ isTTY: true, columns: 101, rows: 37 });
  const { sockets, createWebSocket } = scriptedSockets();
  const run = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--tty", "--", "htop"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: true, terminal, createWebSocket,
  });
  await waitFor(() => sockets.length === 1, "the tty exec socket");
  const [socket] = sockets;
  socket.open();
  assert.deepEqual(startFrame(socket), {
    type: "start", mode: "exec", tty: true, cols: 101, rows: 37, command: ["htop"],
  });
  socket.emitStarted("exec", true);
  terminal.stdin.readableEnded = true;
  terminal.stdin.emit("end");
  assert.deepEqual(socket.sent.slice(1), [JSON.stringify({ type: "stdin-close" })]);
  socket.exitCode(0);
  assert.equal(await run, 0, output.stderr());
});

test("missing or incompatible shell capabilities close only this command with diagnostics", async () => {
  for (const instanceShellCapabilities of [
    undefined,
    { protocolVersion: "2026-10-30", interactive: true, exec: true, execTty: true },
    { protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION, interactive: false, exec: true, execTty: true },
  ]) {
    const { store, fake } = await signedIn({ instanceShellCapabilities });
    const output = capture();
    const { sockets, createWebSocket } = scriptedSockets();
    const args = instanceShellCapabilities?.interactive === false
      ? ["node", "thctl", "instance", "shell", INSTANCE]
      : ["node", "thctl", "instance", "exec", INSTANCE, "--", "whoami"];
    const terminal = new FakeTerminal({ isTTY: true });
    const code = await runCli(args, {
      store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: true, terminal, createWebSocket,
    });
    assert.equal(code, 14, output.stderr());
    assert.match(output.stderr(), /CLI_CAPABILITY_MISSING/);
    if (instanceShellCapabilities?.protocolVersion === "2026-10-30") assert.match(output.stderr(), /Instance Shell protocol 2026-10-30 differs/);
    assert.equal(sockets.length, 0);
  }
});

test("offline instances, upgrade rejections, and credential rejection map to stable errors", async () => {
  const offline = await signedIn();
  offline.fake.instanceEntry.ready = false;
  const offlineOutput = capture();
  const offlineCode = await runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", "whoami"], {
    store: offline.store,
    streams: offlineOutput.streams,
    fetchImpl: offline.fake.fetchImpl,
    isTty: false,
    terminal: new FakeTerminal(),
    createWebSocket: scriptedSockets().createWebSocket,
  });
  assert.equal(offlineCode, 8);
  assert.match(offlineOutput.stderr(), /CLI_INSTANCE_OFFLINE/);

  const missingRoute = await signedIn();
  const missingOutput = capture();
  const missingScript = scriptedSockets();
  const missingRun = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", "whoami"], {
    store: missingRoute.store,
    streams: missingOutput.streams,
    fetchImpl: missingRoute.fake.fetchImpl,
    isTty: false,
    terminal: new FakeTerminal(),
    createWebSocket: missingScript.createWebSocket,
  });
  await waitFor(() => missingScript.sockets.length === 1, "the rejected socket");
  missingScript.sockets[0].reject(404);
  assert.equal(await missingRun, 14);
  assert.match(missingOutput.stderr(), /CLI_CAPABILITY_MISSING/);

  const unauthorized = await signedIn();
  const unauthorizedOutput = capture();
  const unauthorizedScript = scriptedSockets();
  const unauthorizedRun = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", "whoami"], {
    store: unauthorized.store,
    streams: unauthorizedOutput.streams,
    fetchImpl: unauthorized.fake.fetchImpl,
    isTty: false,
    terminal: new FakeTerminal(),
    createWebSocket: unauthorizedScript.createWebSocket,
  });
  await waitFor(() => unauthorizedScript.sockets.length === 1, "the unauthorized socket");
  unauthorizedScript.sockets[0].reject(401);
  assert.equal(await unauthorizedRun, 5);
  assert.equal(unauthorized.store.secrets().read(LABEL), undefined);
});

test("pre-start remote errors retain their stable code and exit status without reconnecting", async () => {
  const { store, fake } = await signedIn();
  for (const [remoteCode, remoteMessage, expectedExitCode] of [
    ["INSTANCE_SHELL_SPAWN_FAILED", "Instance command could not be started.", 12],
    ["INSTANCE_SHELL_LIMIT_REACHED", "Instance shell activity limit reached.", 9],
  ]) {
    const output = capture();
    const script = scriptedSockets();
    const run = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", "missing"], {
      store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, terminal: new FakeTerminal(), createWebSocket: script.createWebSocket,
    });
    await waitFor(() => script.sockets.length === 1, `${remoteCode} socket`);
    const [socket] = script.sockets;
    socket.open();
    socket.remoteError(remoteCode, remoteMessage);
    assert.equal(await run, expectedExitCode, output.stderr());
    assert.match(output.stderr(), new RegExp(remoteCode));
    assert.match(output.stderr(), new RegExp(remoteMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(output.stderr(), /CLI_PROTOCOL_ERROR/);
    assert.doesNotMatch(output.stderr(), /Cancelling/);
    assert.equal(script.sockets.length, 1);
  }
});

test("an exit frame before started remains a protocol error", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const script = scriptedSockets();
  const run = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", "whoami"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, terminal: new FakeTerminal(), createWebSocket: script.createWebSocket,
  });
  await waitFor(() => script.sockets.length === 1, "the pre-start exit socket");
  const [socket] = script.sockets;
  socket.open();
  socket.exitCode(0);
  assert.equal(await run, 11, output.stderr());
  assert.match(output.stderr(), /CLI_PROTOCOL_ERROR/);
  assert.match(output.stderr(), /exit before the process started/);
});

test("post-upgrade authorization and capability closes map to stable CLI errors", async () => {
  const { store, fake } = await signedIn();
  for (const [reason, expectedCode, expectedMessage] of [
    ["CONTROL_PLANE_AUTH_REQUIRED", 5, /CLI_NOT_AUTHENTICATED/],
    ["CONTROL_PLANE_FORBIDDEN", 6, /CLI_FORBIDDEN/],
    ["CONTROL_PLANE_RESOURCE_NOT_VISIBLE", 7, /CLI_INSTANCE_NOT_FOUND/],
    ["INSTANCE_SHELL_UNSUPPORTED", 14, /CLI_CAPABILITY_MISSING/],
    ["INSTANCE_SHELL_UNAVAILABLE", 8, /CLI_INSTANCE_SHELL_UNAVAILABLE/],
    ["INSTANCE_SHELL_PROTOCOL_ERROR", 11, /CLI_PROTOCOL_ERROR/],
  ]) {
    const output = capture();
    const script = scriptedSockets();
    const run = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", "whoami"], {
      store,
      streams: output.streams,
      fetchImpl: fake.fetchImpl,
      isTty: false,
      terminal: new FakeTerminal(),
      createWebSocket: script.createWebSocket,
    });
    await waitFor(() => script.sockets.length === 1, `${reason} socket`);
    script.sockets[0].drop(1008, reason);
    assert.equal(await run, expectedCode, output.stderr());
    assert.match(output.stderr(), expectedMessage);
  }
});

test("defaultStreams passes Uint8Array through without decoding", () => {
  const original = process.stdout.write;
  let received;
  process.stdout.write = (chunk) => {
    received = chunk;
    return true;
  };
  try {
    const bytes = Uint8Array.of(0xff, 0x00, 0x0d, 0x0a);
    defaultStreams().stdout(bytes);
    assert.equal(received, bytes);
  } finally {
    process.stdout.write = original;
  }
});

test("local SIGINT is forwarded to non-TTY exec and remote signal exit maps without a cancellation warning", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const script = scriptedSockets();
  const run = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", "sleep", "60"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, terminal: new FakeTerminal(), createWebSocket: script.createWebSocket,
  });
  await waitFor(() => script.sockets.length === 1, "the signal socket");
  const [socket] = script.sockets;
  socket.open();
  socket.emitStarted("exec", false);
  assert.equal(process.emit("SIGINT"), true);
  assert.equal(socket.sent.at(-1), JSON.stringify({ type: "signal", signal: "SIGINT" }));
  socket.exitSignal("SIGINT");
  assert.equal(await run, 128 + os.constants.signals.SIGINT, output.stderr());
  assert.doesNotMatch(output.stderr(), /Cancelling/);
});

test("a pre-exit socket disconnect is a network error and is not retried", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  const script = scriptedSockets();
  const run = runCli(["node", "thctl", "instance", "exec", INSTANCE, "--", "whoami"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, terminal: new FakeTerminal(), createWebSocket: script.createWebSocket,
  });
  await waitFor(() => script.sockets.length === 1, "the disconnect socket");
  const [socket] = script.sockets;
  socket.open();
  socket.emitStarted("exec", false);
  socket.drop(1006, "network lost");
  assert.equal(await run, 10, output.stderr());
  assert.match(output.stderr(), /disconnected before reporting a process exit/);
  assert.equal(script.sockets.length, 1);
});
