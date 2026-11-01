import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type ws from "ws";
import { commandInvocation } from "@task-handoff/core/core/command-invocation";
import { spawnPty, type PtyProcess } from "@task-handoff/core/core/pty";
import { ManagedProcessTreeRegistry } from "@task-handoff/core/core/process-tree";
import {
  INSTANCE_SHELL_ACTIVITY_LIMIT,
  INSTANCE_SHELL_PROTOCOL_VERSION,
  INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES,
  INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL,
  InstanceShellDataChannel,
  InstanceShellProtocolError,
  decodeInstanceShellBinaryFrame,
  encodeInstanceShellBinaryFrame,
  parseInstanceShellClientControlFrame,
  type InstanceShellCapabilities,
  type InstanceShellClientControlFrame,
  type InstanceShellErrorFrame,
  type InstanceShellExitFrame,
  type InstanceShellStartFrame,
} from "@task-handoff/protocol/instance-shell";
import { nodeAgentApiRoute } from "./auth.ts";

type InstanceShellSocket = {
  readonly OPEN: number;
  readyState: number;
  bufferedAmount: number;
  protocol: string;
  send: (data: unknown, options?: { binary?: boolean; compress?: boolean }) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
};

type ShellProcess = {
  pid: number;
  tty: boolean;
  write: (bytes: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  closeStdin: () => void;
  signal: (signal: NodeJS.Signals) => void;
  terminate: () => void;
};

export type InstanceShellRuntimeOptions = {
  workspace?: () => string;
  environment?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  maxActivities?: number;
  socketBacklogMaxBytes?: number;
  stopTimeoutMs?: number;
  killTimeoutMs?: number;
  spawnChild?: typeof spawn;
  spawnTerminal?: typeof spawnPty;
};

function defaultWorkspace() {
  return process.env.TASK_HANDOFF_WORKSPACE || process.env.WORKSPACE || "/workspace";
}

function shellCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform === "win32") return env.ComSpec || "cmd.exe";
  return env.SHELL || "/bin/sh";
}

function messageBytes(message: unknown): Buffer {
  if (Buffer.isBuffer(message)) return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message);
  if (ArrayBuffer.isView(message)) return Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  if (Array.isArray(message) && message.every(Buffer.isBuffer)) return Buffer.concat(message);
  throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell binary frame must contain bytes.");
}

function signalName(signal: string | number | undefined): string | undefined {
  if (typeof signal === "string") return signal;
  if (typeof signal !== "number") return undefined;
  const signals = os.constants.signals as Record<string, number>;
  return Object.entries(signals).find(([, value]) => value === signal)?.[0];
}

export class InstanceShellRuntime {
  readonly capabilities: InstanceShellCapabilities = {
    protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
    interactive: true,
    exec: true,
    execTty: true,
  };

  private readonly workspace: () => string;
  private readonly environment: () => NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly maxActivities: number;
  private readonly socketBacklogMaxBytes: number;
  private readonly spawnChild: typeof spawn;
  private readonly spawnTerminal: typeof spawnPty;
  private readonly processTrees: ManagedProcessTreeRegistry;
  private readonly sockets = new Set<InstanceShellSocket>();
  private activeActivities = 0;

  constructor(options: InstanceShellRuntimeOptions = {}) {
    this.workspace = options.workspace || defaultWorkspace;
    this.environment = options.environment || (() => process.env);
    this.platform = options.platform || process.platform;
    this.maxActivities = options.maxActivities ?? INSTANCE_SHELL_ACTIVITY_LIMIT;
    this.socketBacklogMaxBytes = options.socketBacklogMaxBytes ?? INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES;
    this.spawnChild = options.spawnChild || spawn;
    this.spawnTerminal = options.spawnTerminal || spawnPty;
    this.processTrees = new ManagedProcessTreeRegistry({
      stopTimeoutMs: options.stopTimeoutMs,
      killTimeoutMs: options.killTimeoutMs,
    });
  }

  get activeCount() {
    return this.activeActivities;
  }

  handle(socket: InstanceShellSocket) {
    this.sockets.add(socket);
    let started = false;
    let startedFrame: InstanceShellStartFrame | undefined;
    let terminalProcess: ShellProcess | undefined;
    let stdinClosed = false;
    let terminalFrameSent = false;
    let closed = false;
    const pendingFrames: Array<{ channel: number; payload: Buffer }> = [];
    let pendingExit: InstanceShellExitFrame | undefined;
    let activityAccounted = false;

    const isOpen = () => !closed && socket.readyState === socket.OPEN;
    const accountActivity = () => {
      if (activityAccounted) return;
      activityAccounted = true;
      this.activeActivities += 1;
    };
    const releaseActivity = () => {
      if (!activityAccounted) return;
      activityAccounted = false;
      this.activeActivities = Math.max(0, this.activeActivities - 1);
    };
    const close = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      socket.close(code, reason);
    };
    const sendControl = (frame: InstanceShellErrorFrame | InstanceShellExitFrame | {
      type: "started";
      protocolVersion: string;
      mode: "interactive" | "exec";
      tty: boolean;
    }) => {
      if (!isOpen()) return false;
      const payload = JSON.stringify(frame);
      if (socket.bufferedAmount + Buffer.byteLength(payload, "utf8") > this.socketBacklogMaxBytes) {
        terminalProcess?.terminate();
        close(1008, "Instance shell socket backpressure limit reached.");
        return false;
      }
      socket.send(payload, { binary: false, compress: false });
      return true;
    };
    const sendData = (channel: number, payload: Buffer) => {
      if (payload.byteLength === 0 || !isOpen()) return;
      const frame = encodeInstanceShellBinaryFrame(channel as InstanceShellDataChannel, payload);
      if (socket.bufferedAmount + frame.byteLength > this.socketBacklogMaxBytes) {
        terminalProcess?.terminate();
        close(1008, "Instance shell socket backpressure limit reached.");
        return;
      }
      socket.send(frame, { binary: true, compress: false });
    };
    const fail = (code: string, message: string) => {
      if (terminalFrameSent) return;
      terminalFrameSent = true;
      terminalProcess?.terminate();
      sendControl({ type: "error", code, message });
      releaseActivity();
      close(1008, code);
    };
    const finish = (frame: InstanceShellExitFrame) => {
      if (terminalFrameSent) return;
      terminalFrameSent = true;
      releaseActivity();
      if (!started) {
        pendingExit = frame;
        return;
      }
      for (const pending of pendingFrames.splice(0)) sendData(pending.channel, pending.payload);
      sendControl(frame);
      close(1000, "Instance shell process exited.");
    };
    const output = (channel: number, payload: Buffer) => {
      if (!started) {
        pendingFrames.push({ channel, payload });
        return;
      }
      sendData(channel, payload);
    };

    socket.on("close", () => {
      closed = true;
      this.sockets.delete(socket);
      terminalProcess?.terminate();
      releaseActivity();
    });
    socket.on("error", () => {
      closed = true;
      this.sockets.delete(socket);
      terminalProcess?.terminate();
      releaseActivity();
    });

    const start = (frame: InstanceShellStartFrame) => {
      if (startedFrame) return fail("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell has already started.");
      if (this.activeActivities >= this.maxActivities) {
        return fail("INSTANCE_SHELL_LIMIT_REACHED", "Instance shell activity limit reached.");
      }
      const workspace = path.resolve(this.workspace());
      try {
        if (!fs.statSync(workspace).isDirectory()) throw new Error("Workspace is not a directory.");
      } catch {
        return fail("INSTANCE_SHELL_WORKSPACE_UNAVAILABLE", "Instance workspace is unavailable.");
      }
      const env = this.environment();
      const cols = frame.cols ?? 120;
      const rows = frame.rows ?? 40;
      accountActivity();
      startedFrame = frame;
      started = true;
      try {
        if (frame.mode === "interactive" || frame.tty) {
          const argv = frame.mode === "interactive" ? [shellCommand(env, this.platform)] : frame.command!;
          const invocation = commandInvocation(argv[0]!, argv.slice(1), { env, cwd: workspace });
          const pty = this.spawnTerminal(invocation.executable, invocation.args, {
            name: "xterm-256color", cols, rows, cwd: workspace, env: invocation.env,
          });
          this.trackPty(pty);
          // node-pty accepts text. Keep one decoder for the session so a UTF-8
          // code point split across WebSocket frames is not corrupted.
          const inputDecoder = new StringDecoder("utf8");
          terminalProcess = {
            pid: pty.pid,
            tty: true,
            write: (bytes) => {
              const text = inputDecoder.write(bytes);
              if (text) pty.write(text);
            },
            resize: (nextCols, nextRows) => pty.resize(nextCols, nextRows),
            closeStdin: () => {
              const tail = inputDecoder.end();
              pty.write(`${tail}\u0004`);
            },
            signal: (signal) => this.processTrees.signal(pty.pid, signal, undefined, pty),
            terminate: () => this.processTrees.requestStop(pty.pid, "SIGTERM", undefined, pty),
          };
          pty.onData((data) => output(InstanceShellDataChannel.Output, Buffer.from(data, "utf8")));
          pty.onExit((event) => {
            const signal = signalName(event.signal);
            finish(signal ? { type: "exit", signal } : { type: "exit", code: event.exitCode });
          });
        } else {
          const invocation = commandInvocation(frame.command![0]!, frame.command!.slice(1), { env, cwd: workspace });
          const child = this.spawnChild(invocation.executable, invocation.args, {
            cwd: workspace,
            env: invocation.env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: this.platform !== "win32",
            windowsHide: true,
          }) as ChildProcessWithoutNullStreams;
          if (child.pid) {
            this.processTrees.track({ pid: child.pid, child, rootExited: false });
            child.once("exit", () => this.processTrees.markRootExited(child.pid!));
          }
          terminalProcess = {
            pid: child.pid || 0,
            tty: false,
            write: (bytes) => child.stdin.write(bytes),
            resize: () => {},
            closeStdin: () => child.stdin.end(),
            signal: (signal) => {
              if (child.pid) this.processTrees.signal(child.pid, signal, child);
            },
            terminate: () => {
              if (child.pid) this.processTrees.requestStop(child.pid, "SIGTERM", child);
            },
          };
          // A short command can exit while local stdin is still being forwarded.
          // EPIPE is expected in that race; other stdin failures use the normal
          // structured terminal-error path instead of crashing the instance.
          child.stdin.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code !== "EPIPE") fail("INSTANCE_SHELL_STDIN_FAILED", "Instance command stdin failed.");
          });
          child.stdout.on("data", (data: Buffer) => output(InstanceShellDataChannel.Output, data));
          child.stderr.on("data", (data: Buffer) => output(InstanceShellDataChannel.Stderr, data));
          child.once("error", () => fail("INSTANCE_SHELL_SPAWN_FAILED", "Instance command could not be started."));
          // `exit` can fire before piped stdout/stderr have drained. Keep the
          // session open until `close`, which guarantees both stdio streams are
          // finished before the terminal exit frame is sent.
          child.once("close", (code, signal) => {
            finish(signal ? { type: "exit", signal } : { type: "exit", code: code ?? 1 });
          });
        }
        sendControl({
          type: "started",
          protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
          mode: frame.mode,
          tty: frame.tty,
        });
        for (const pending of pendingFrames.splice(0)) sendData(pending.channel, pending.payload);
        if (pendingExit) {
          const exit = pendingExit;
          pendingExit = undefined;
          finish(exit);
        }
      } catch {
        fail("INSTANCE_SHELL_SPAWN_FAILED", "Instance command could not be started.");
      }
    };

    socket.on("message", (message, isBinary) => {
      if (closed) return;
      try {
        if (isBinary) {
          if (!started || !startedFrame || !terminalProcess) {
            throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell has not started.");
          }
          if (stdinClosed) {
            throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell stdin is already closed.");
          }
          const decoded = decodeInstanceShellBinaryFrame(messageBytes(message), "client-to-instance");
          terminalProcess.write(Buffer.from(decoded.payload));
          return;
        }
        const text = Buffer.isBuffer(message) ? message.toString("utf8") : Array.isArray(message) ? Buffer.concat(message).toString("utf8") : String(message);
        const frame = parseInstanceShellClientControlFrame(text);
        if (frame.type === "start") {
          if (startedFrame) throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell has already started.");
          start(frame);
          return;
        }
        if (!started || !startedFrame || !terminalProcess) {
          throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell must start before control messages.");
        }
        if (frame.type === "stdin-close") {
          if (!stdinClosed) {
            stdinClosed = true;
            terminalProcess.closeStdin();
          }
          return;
        }
        if (frame.type === "resize") {
          if (!startedFrame.tty) throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Resize is only valid for a PTY.");
          terminalProcess.resize(frame.cols, frame.rows);
          return;
        }
        if (startedFrame.mode !== "exec" || startedFrame.tty) {
          throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Remote signal is only valid for non-TTY exec.");
        }
        terminalProcess.signal(frame.signal);
      } catch (error) {
        fail(
          error instanceof InstanceShellProtocolError ? error.code : "INSTANCE_SHELL_PROTOCOL_ERROR",
          error instanceof InstanceShellProtocolError ? error.message : "Instance shell protocol error.",
        );
      }
    });
  }

  async shutdown(code = 1001, reason = "Controlled instance is shutting down.") {
    for (const socket of [...this.sockets]) {
      try {
        socket.close(code, reason.slice(0, 123));
      } catch {
        // The socket may already be closed; process-tree cleanup below remains authoritative.
      }
    }
    const stops = new Set<Promise<void>>();
    for (const processTree of this.processTrees.values()) {
      if (!processTree.stopPromise) {
        this.processTrees.requestStop(processTree.pid, "SIGTERM", processTree.child, processTree.pty);
      }
      if (processTree.stopPromise) stops.add(processTree.stopPromise);
    }
    await Promise.allSettled([...stops]);
    this.sockets.clear();
  }

  handleProtocols(protocols: Set<string>, request: IncomingMessage): string | false | undefined {
    const pathname = request.url ? new URL(request.url, "http://localhost").pathname : "";
    const values = Array.from(protocols);
    if (pathname === "/api/internal/instance-shell") {
      return values.length === 1 && values[0] === INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL
        ? INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL
        : false;
    }
    return values[0];
  }

  private trackPty(pty: PtyProcess) {
    this.processTrees.track({ pid: pty.pid, pty, rootExited: false });
    pty.onExit(() => this.processTrees.markRootExited(pty.pid));
  }
}

export function registerInstanceShellRoute(app: FastifyInstance, runtime: InstanceShellRuntime) {
  const auth = nodeAgentApiRoute({
    code: "INSTANCE_SHELL_UNAUTHORIZED",
    message: "Instance registration token is required.",
    requireControlled: true,
  });
  app.get("/api/internal/instance-shell", {
    ...auth,
    websocket: true,
    preHandler: [
      auth.preHandler,
      async (request: FastifyRequest, reply) => {
        const protocols = (request.headers["sec-websocket-protocol"] || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        if (protocols.length !== 1 || protocols[0] !== INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL) {
          return reply.code(400).send({ error: { code: "INSTANCE_SHELL_PROTOCOL_ERROR", message: "Instance shell subprotocol is required." } });
        }
      },
    ],
  }, (socket, request) => {
    if (socket.protocol !== INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL) {
      socket.close(1002, "Instance shell subprotocol is required.");
      return;
    }
    runtime.handle(socket as unknown as InstanceShellSocket);
  });
  app.websocketServer.options.handleProtocols = (protocols, request) => runtime.handleProtocols(protocols, request);
}
