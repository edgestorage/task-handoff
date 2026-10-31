import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import {
  INSTANCE_SHELL_PROTOCOL_VERSION,
  INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL,
  InstanceShellDataChannel,
  encodeInstanceShellBinaryFrame,
  parseInstanceShellServerControlFrame,
} from "@task-handoff/protocol/instance-shell";
import { InstanceShellRuntime, registerInstanceShellRoute } from "./src/web/instance-shell.ts";

type SentFrame = { data: unknown; binary: boolean };

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  protocol = INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL;
  readonly sent: SentFrame[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: unknown, options?: { binary?: boolean }) {
    this.sent.push({ data, binary: options?.binary === true });
  }

  close(code?: number, reason?: string) {
    if (this.readyState !== this.OPEN) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close");
  }

  sendControl(frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  waitForClose(timeoutMs = 5_000) {
    if (this.readyState !== this.OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
      this.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function serverControls(socket: FakeSocket) {
  return socket.sent
    .filter((frame) => !frame.binary)
    .map((frame) => parseInstanceShellServerControlFrame(Buffer.from(frame.data as string).toString("utf8")));
}

function serverData(socket: FakeSocket) {
  return socket.sent.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.data as Uint8Array));
}

test("non-TTY exec streams raw stdout and stderr separately, preserves stdin bytes, and returns the remote exit status", async () => {
  const runtime = new InstanceShellRuntime({ workspace: () => process.cwd() });
  const socket = new FakeSocket();
  runtime.handle(socket);
  socket.sendControl({ type: "start", mode: "exec", command: ["node", "-e", "process.stdin.pipe(process.stdout); process.stderr.write(Buffer.from([0xff,0,13,10])); process.exitCode=7"], tty: false });
  const payload = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80]);
  socket.emit("message", encodeInstanceShellBinaryFrame(InstanceShellDataChannel.Input, payload), true);
  socket.sendControl({ type: "stdin-close" });
  socket.sendControl({ type: "stdin-close" });
  await socket.waitForClose();

  const controls = serverControls(socket);
  assert.deepEqual(controls[0], {
    type: "started",
    protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
    mode: "exec",
    tty: false,
  });
  assert.deepEqual(controls.at(-1), { type: "exit", code: 7 });
  const frames = serverData(socket);
  assert.ok(frames.some((frame) => frame[0] === InstanceShellDataChannel.Output && frame.subarray(1).equals(payload)));
  assert.ok(frames.some((frame) => frame[0] === InstanceShellDataChannel.Stderr && frame.subarray(1).equals(Buffer.from([0xff, 0, 13, 10]))));
  assert.equal(runtime.activeCount, 0);
});

test("exec --tty uses one merged output channel and supports shell-compatible PTY execution", { skip: process.platform === "win32" }, async () => {
  const runtime = new InstanceShellRuntime({ workspace: () => process.cwd() });
  const socket = new FakeSocket();
  runtime.handle(socket);
  socket.sendControl({ type: "start", mode: "exec", command: [process.env.SHELL || "/bin/sh", "-c", "printf 'tty-ok\\n'"], tty: true, cols: 100, rows: 30 });
  await socket.waitForClose();

  const controls = serverControls(socket);
  assert.deepEqual(controls[0], {
    type: "started",
    protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
    mode: "exec",
    tty: true,
  });
  assert.equal(controls.at(-1)?.type, "exit");
  const output = Buffer.concat(serverData(socket).filter((frame) => frame[0] === InstanceShellDataChannel.Output).map((frame) => frame.subarray(1))).toString("utf8");
  assert.match(output, /tty-ok/);
  assert.equal(runtime.activeCount, 0);
});

test("PTY input keeps UTF-8 code points intact across WebSocket frames", async () => {
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: string | number }) => void> = [];
  const fakePty = {
    pid: 987_654,
    runtime: "node" as const,
    processGroupLeader: false,
    write(data: string) { writes.push(data); },
    resize(cols: number, rows: number) { resizes.push([cols, rows]); },
    kill() {},
    onData() { return { dispose() {} }; },
    onExit(listener: (event: { exitCode: number; signal?: string | number }) => void) {
      exitListeners.push(listener);
      return { dispose() {} };
    },
  };
  const runtime = new InstanceShellRuntime({
    workspace: () => process.cwd(),
    spawnTerminal: () => fakePty,
  });
  const socket = new FakeSocket();
  runtime.handle(socket);
  socket.sendControl({ type: "start", mode: "interactive", tty: true, cols: 80, rows: 24 });
  for (const byte of [0xe4, 0xbd, 0xa0]) {
    socket.emit("message", encodeInstanceShellBinaryFrame(InstanceShellDataChannel.Input, Buffer.from([byte])), true);
  }
  socket.sendControl({ type: "resize", cols: 120, rows: 40 });
  socket.sendControl({ type: "stdin-close" });
  assert.deepEqual(resizes, [[120, 40]]);
  assert.deepEqual(writes, ["你", "\u0004"]);
  for (const listener of exitListeners) listener({ exitCode: 0 });
  await socket.waitForClose();
});

test("non-TTY exec forwards SIGINT and SIGTERM to the instance process", { skip: process.platform === "win32" }, async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const runtime = new InstanceShellRuntime({ workspace: () => process.cwd() });
    const socket = new FakeSocket();
    runtime.handle(socket);
    socket.sendControl({
      type: "start",
      mode: "exec",
      tty: false,
      command: [
        process.execPath,
        "-e",
        `process.on('${signal}', () => { process.stdout.write('${signal}'); process.exit(0); }); process.stdout.write('ready'); setInterval(() => {}, 1000);`,
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    socket.sendControl({ type: "signal", signal });
    await socket.waitForClose();
    assert.deepEqual(serverControls(socket).at(-1), { type: "exit", code: 0 });
    assert.match(Buffer.concat(serverData(socket).map((frame) => frame.subarray(1))).toString("utf8"), new RegExp(signal));
    assert.equal(runtime.activeCount, 0);
  }
});

test("protocol failures close before creating a process and reject input after stdin-close", async () => {
  const runtime = new InstanceShellRuntime({ workspace: () => process.cwd() });
  const socket = new FakeSocket();
  runtime.handle(socket);
  socket.emit("message", Buffer.from(JSON.stringify({ type: "stdin-close" })), false);
  await socket.waitForClose();
  assert.deepEqual(serverControls(socket).at(-1), {
    type: "error",
    code: "INSTANCE_SHELL_PROTOCOL_ERROR",
    message: "Instance shell must start before control messages.",
  });
  assert.equal(runtime.activeCount, 0);

  const second = new FakeSocket();
  runtime.handle(second);
  second.sendControl({ type: "start", mode: "exec", command: ["node", "-e", "process.stdin.pipe(process.stdout)"], tty: false });
  second.sendControl({ type: "stdin-close" });
  second.emit("message", encodeInstanceShellBinaryFrame(InstanceShellDataChannel.Input, Buffer.from("late")), true);
  await second.waitForClose();
  assert.equal(serverControls(second).at(-1)?.type, "error");
  assert.equal(runtime.activeCount, 0);
});

test("a missing workspace fails without starting a process", async () => {
  const runtime = new InstanceShellRuntime({ workspace: () => path.join(process.cwd(), ".missing-instance-shell-workspace") });
  const socket = new FakeSocket();
  runtime.handle(socket);
  socket.sendControl({ type: "start", mode: "interactive", tty: true });
  await socket.waitForClose();
  assert.deepEqual(serverControls(socket).at(-1), {
    type: "error",
    code: "INSTANCE_SHELL_WORKSPACE_UNAVAILABLE",
    message: "Instance workspace is unavailable.",
  });
});

test("the private websocket route rejects standalone, invalid tokens, and missing or extra subprotocols before upgrade", async () => {
  const previousToken = process.env.TASK_HANDOFF_REGISTRATION_TOKEN;
  const previousMode = process.env.TASK_HANDOFF_CONTROL_MODE;
  process.env.TASK_HANDOFF_REGISTRATION_TOKEN = "registration-token";
  process.env.TASK_HANDOFF_CONTROL_MODE = "controlled";
  const app = Fastify();
  await app.register(websocket);
  const runtime = new InstanceShellRuntime({ workspace: () => process.cwd() });
  registerInstanceShellRoute(app, runtime);
  await app.ready();
  try {
    assert.equal(runtime.handleProtocols(new Set([INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL]), { url: "/api/internal/instance-shell" } as never), INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL);
    assert.equal(runtime.handleProtocols(new Set(), { url: "/api/internal/instance-shell" } as never), false);
    assert.equal(runtime.handleProtocols(new Set(["other", INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL]), { url: "/api/internal/instance-shell" } as never), false);
    assert.equal(runtime.handleProtocols(new Set([INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL]), { url: "/api/events" } as never), undefined);
    const rejected = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/internal/instance-shell", headers });
    assert.equal((await rejected({ authorization: "Bearer wrong", "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL })).statusCode, 403);
    assert.equal((await rejected({ authorization: "Bearer registration-token" })).statusCode, 400);
    assert.equal((await rejected({ authorization: "Bearer registration-token", "sec-websocket-protocol": `other, ${INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL}` })).statusCode, 400);
    process.env.TASK_HANDOFF_CONTROL_MODE = "standalone";
    assert.equal((await rejected({ authorization: "Bearer registration-token", "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL })).statusCode, 403);
    process.env.TASK_HANDOFF_CONTROL_MODE = "controlled";
  } finally {
    await app.close();
    if (previousToken === undefined) delete process.env.TASK_HANDOFF_REGISTRATION_TOKEN;
    else process.env.TASK_HANDOFF_REGISTRATION_TOKEN = previousToken;
    if (previousMode === undefined) delete process.env.TASK_HANDOFF_CONTROL_MODE;
    else process.env.TASK_HANDOFF_CONTROL_MODE = previousMode;
  }
});

test("spawn failures, repeated starts, and activity limits return structured errors without leaking slots", async () => {
  const runtime = new InstanceShellRuntime({ workspace: () => process.cwd(), maxActivities: 1 });
  const failed = new FakeSocket();
  runtime.handle(failed);
  failed.sendControl({ type: "start", mode: "exec", command: ["/definitely/missing-instance-shell-command"], tty: false });
  await failed.waitForClose();
  assert.deepEqual(serverControls(failed).at(-1), {
    type: "error",
    code: "INSTANCE_SHELL_SPAWN_FAILED",
    message: "Instance command could not be started.",
  });
  assert.equal(runtime.activeCount, 0);

  const first = new FakeSocket();
  runtime.handle(first);
  first.sendControl({ type: "start", mode: "exec", command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"], tty: false });
  assert.equal(runtime.activeCount, 1);
  const second = new FakeSocket();
  runtime.handle(second);
  second.sendControl({ type: "start", mode: "exec", command: ["printf", "blocked"], tty: false });
  await second.waitForClose();
  assert.deepEqual(serverControls(second).at(-1), {
    type: "error",
    code: "INSTANCE_SHELL_LIMIT_REACHED",
    message: "Instance shell activity limit reached.",
  });

  first.sendControl({ type: "start", mode: "exec", command: ["printf", "duplicate"], tty: false });
  await first.waitForClose();
  assert.deepEqual(serverControls(first).at(-1), {
    type: "error",
    code: "INSTANCE_SHELL_PROTOCOL_ERROR",
    message: "Instance shell has already started.",
  });
  assert.equal(runtime.activeCount, 0);
});

test("socket backpressure closes the shell and releases its activity slot", async () => {
  const runtime = new InstanceShellRuntime({
    workspace: () => process.cwd(),
    socketBacklogMaxBytes: 1,
  });
  const socket = new FakeSocket();
  runtime.handle(socket);
  socket.sendControl({ type: "start", mode: "exec", command: [process.execPath, "-e", "process.stdout.write('backpressure')"], tty: false });
  socket.bufferedAmount = 2;
  await socket.waitForClose();
  assert.equal(socket.closeCode, 1008);
  assert.equal(socket.closeReason, "Instance shell socket backpressure limit reached.");
  assert.equal(runtime.activeCount, 0);
});

test("closing the websocket terminates the process session and releases the activity slot", async () => {
  const runtime = new InstanceShellRuntime({ workspace: () => process.cwd() });
  const socket = new FakeSocket();
  runtime.handle(socket);
  socket.sendControl({ type: "start", mode: "exec", command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"], tty: false });
  assert.equal(runtime.activeCount, 1);
  socket.close(1000, "client disconnected");
  assert.equal(runtime.activeCount, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runtime.activeCount, 0);
});

test("socket close escalates a signal-ignoring process group to SIGKILL", { skip: process.platform === "win32" }, async () => {
  let childPid: number | undefined;
  const runtime = new InstanceShellRuntime({
    workspace: () => process.cwd(),
    stopTimeoutMs: 10,
    killTimeoutMs: 100,
    spawnChild: ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      childPid = child.pid;
      return child;
    }) as typeof spawn,
  });
  const socket = new FakeSocket();
  runtime.handle(socket);
  socket.sendControl({
    type: "start",
    mode: "exec",
    command: [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    tty: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(childPid);
  assert.doesNotThrow(() => process.kill(-childPid!, 0));
  socket.close(1000, "client disconnected");
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-childPid!, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      // Some process-group probes briefly report EPERM after SIGKILL even
      // though the group can no longer be signalled by this process. Keep
      // waiting until the deadline instead of treating that probe as success.
      if (code !== "EPERM") throw error;
    }
  }
  assert.fail("the signal-ignoring shell process tree was not terminated");
});

test("runtime shutdown drains active shells and process groups before restart", { skip: process.platform === "win32" }, async () => {
  let childPid: number | undefined;
  const runtime = new InstanceShellRuntime({
    workspace: () => process.cwd(),
    stopTimeoutMs: 50,
    killTimeoutMs: 100,
    spawnChild: ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      childPid = child.pid;
      return child;
    }) as typeof spawn,
  });
  const socket = new FakeSocket();
  runtime.handle(socket);
  socket.sendControl({
    type: "start",
    mode: "exec",
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    tty: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(childPid);
  assert.equal(runtime.activeCount, 1);

  await runtime.shutdown(1001, "Controlled instance is draining.");

  assert.equal(socket.closeCode, 1001);
  assert.equal(socket.closeReason, "Controlled instance is draining.");
  assert.equal(runtime.activeCount, 0);
  assert.throws(() => process.kill(-childPid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
});
