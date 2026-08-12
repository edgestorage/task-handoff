import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { AiSessionApprovalDecision } from "../../ai-session-control";
import type { CodexThreadForkCapabilities, CodexThreadForkOptions, CodexThreadStartOptions, CodexTurnPermissionOverrides } from "./contract";
import { approvalResponseForRequest, codexApprovalRequest } from "../protocol/approvals";
import { codexNotification } from "../protocol/events";
import { turnIdFromResult } from "../protocol/turn-control";
import type {
  CodexAppServerEvent,
  CodexApprovalRequest,
  CodexThread,
  CodexUserInput,
  JsonValue,
} from "../protocol/types";

export type CodexAppServerClientMode =
  | { type: "stdio"; command: string }
  | { type: "unix"; command: string; socketPath: string };

export type CodexAppServerClientOptions = {
  command?: string;
  requestTimeoutMs?: number;
  socketPath?: string;
};

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
    readonly rpcData?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

const FULL_HISTORY_FORK_MIN_VERSION = [0, 129, 0] as const;

export function codexThreadForkCapabilities(userAgent: string | undefined): CodexThreadForkCapabilities {
  const match = userAgent?.match(/(?:^|\s|\/)(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/);
  if (!match) return { fullHistory: false, throughTurn: false };
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  // Compatibility for v0.0.21: older managed Codex artifacts may expose the
  // method but predate the stable persistent-fork parameters used below.
  const fullHistory = compareVersion(version, FULL_HISTORY_FORK_MIN_VERSION) >= 0;
  // Codex added stable lastTurnId in the 0.143.0 pre-release line after
  // rust-v0.137.0. Unknown and older managed artifacts must fail closed.
  const throughTurn = compareVersion(version, [0, 143, 0]) >= 0;
  return { fullHistory, throughTurn };
}

function compareVersion(left: readonly number[], right: readonly number[]) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export class CodexAppServerClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private proxyChild?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly mode: CodexAppServerClientMode;
  private readonly requestTimeoutMs: number;
  private serverUserAgent?: string;
  private forkMethodAvailable = true;

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    const command = options.command
      || process.env.TASK_HANDOFF_CODEX_APP_SERVER_COMMAND
      || process.env.TASK_HANDOFF_CODEX_COMMAND
      || "codex";
    this.mode = options.socketPath
      ? { type: "unix", command, socketPath: options.socketPath }
      : { type: "stdio", command };
    this.requestTimeoutMs = options.requestTimeoutMs
      || Number(process.env.TASK_HANDOFF_CODEX_APP_SERVER_TIMEOUT_MS)
      || 5_000;
  }

  get connected() {
    return Boolean((this.child && !this.child.killed)
      || (this.proxyChild && !this.proxyChild.killed)
      || this.socket?.readyState === WebSocket.OPEN);
  }

  async start() {
    if (this.connected) {
      return;
    }
    if (this.mode.type === "unix") {
      await this.startUnixSocket(this.mode.command, this.mode.socketPath);
      return;
    }
    const child = spawn(this.mode.command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: process.env,
    });
    this.child = child;
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.once("exit", () => {
      this.child = undefined;
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(new Error("Codex app-server exited."));
        this.pending.delete(id);
      }
      this.emit("disconnect");
    });
    await this.initialize();
  }

  stop() {
    if (this.child && !this.child.killed) {
      this.child.removeAllListeners();
      this.child.kill("SIGTERM");
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.removeAllListeners();
      this.socket.close();
    }
    if (this.proxyChild && !this.proxyChild.killed) {
      this.proxyChild.removeAllListeners();
      this.proxyChild.kill("SIGTERM");
    }
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex app-server stopped."));
      this.pending.delete(id);
    }
    this.child = undefined;
    this.proxyChild = undefined;
    this.socket = undefined;
  }

  async listLoadedThreadIds() {
    const ids: string[] = [];
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request("thread/loaded/list", { cursor, limit: 100 });
      if (Array.isArray(result.data)) {
        ids.push(...result.data.filter((id): id is string => typeof id === "string"));
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!cursor) {
        break;
      }
    }
    return ids;
  }

  async startThread(options: CodexThreadStartOptions) {
    const result = await this.request("thread/start", {
      model: options.model || null,
      modelProvider: options.modelProvider || null,
      cwd: options.cwd,
      runtimeWorkspaceRoots: options.runtimeWorkspaceRoots || [options.cwd],
      ...(options.permissions || {}),
      ephemeral: false,
      sessionStartSource: "startup",
      threadSource: "user",
    });
    const thread = result.thread && typeof result.thread === "object" && !Array.isArray(result.thread)
      ? result.thread as CodexThread
      : undefined;
    if (!thread || typeof thread.id !== "string" || !thread.id.trim()) {
      throw new Error("Codex thread/start returned no persistent thread identity.");
    }
    if (thread.ephemeral === true) {
      throw new Error("Codex thread/start returned an ephemeral thread.");
    }
    if (typeof thread.cwd !== "string" || !thread.cwd.trim()) {
      throw new Error("Codex thread/start returned no cwd.");
    }
    return thread;
  }

  threadForkCapabilities() {
    const capability = codexThreadForkCapabilities(this.serverUserAgent);
    return this.forkMethodAvailable ? capability : { fullHistory: false, throughTurn: false };
  }

  async forkThread(options: CodexThreadForkOptions) {
    const capability = this.threadForkCapabilities();
    if (!capability.fullHistory || (options.lastTurnId && !capability.throughTurn)) {
      throw new CodexAppServerRpcError("Codex app-server does not support the requested thread/fork operation.", -32601);
    }
    try {
      const result = await this.request("thread/fork", {
        threadId: options.threadId,
        ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ephemeral: false,
      });
      const thread = result.thread && typeof result.thread === "object" && !Array.isArray(result.thread)
        ? result.thread as CodexThread
        : undefined;
      if (!thread || typeof thread.id !== "string" || !thread.id.trim() || thread.id === options.threadId) {
        throw new Error("Codex thread/fork returned no unique persistent thread identity.");
      }
      if (thread.ephemeral === true) throw new Error("Codex thread/fork returned an ephemeral thread.");
      if (typeof thread.cwd !== "string" || !thread.cwd.trim()) throw new Error("Codex thread/fork returned no cwd.");
      return thread;
    } catch (error) {
      if (error instanceof CodexAppServerRpcError && error.rpcCode === -32601) {
        this.forkMethodAvailable = false;
      }
      throw error;
    }
  }

  async readThread(threadId: string, options: { includeTurns?: boolean } = {}) {
    const result = await this.request("thread/read", { threadId, includeTurns: Boolean(options.includeTurns) });
    return result.thread && typeof result.thread === "object" ? result.thread as CodexThread : undefined;
  }

  async listThreads() {
    const threads: CodexThread[] = [];
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: null,
        sortDirection: null,
        modelProviders: null,
        sourceKinds: [],
        archived: false,
        cwd: null,
        useStateDbOnly: false,
        searchTerm: null,
      });
      if (Array.isArray(result.data)) {
        threads.push(...result.data.filter((thread): thread is CodexThread => (
          Boolean(thread && typeof thread === "object" && !Array.isArray(thread))
        )));
      } else if (Array.isArray(result.threads)) {
        threads.push(...result.threads.filter((thread): thread is CodexThread => (
          Boolean(thread && typeof thread === "object" && !Array.isArray(thread))
        )));
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor) {
        break;
      }
    }
    return threads;
  }

  async activeThreadExists(threadId: string) {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    while (true) {
      const result = await this.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: null,
        sortDirection: null,
        modelProviders: null,
        sourceKinds: [],
        archived: false,
        cwd: null,
        useStateDbOnly: false,
        searchTerm: null,
      });
      const candidates = Array.isArray(result.data)
        ? result.data
        : Array.isArray(result.threads) ? result.threads : [];
      if (candidates.some((thread) => (
        Boolean(thread && typeof thread === "object" && !Array.isArray(thread) && thread.id === threadId)
      ))) return true;
      const nextCursor = typeof result.nextCursor === "string" && result.nextCursor
        ? result.nextCursor
        : undefined;
      if (!nextCursor) return false;
      if (seenCursors.has(nextCursor)) {
        throw new Error("Codex thread/list returned a repeated cursor while verifying an active thread.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async startTurn(threadId: string, message: string, inputs?: CodexUserInput[], permissions?: CodexTurnPermissionOverrides) {
    const result = await this.request("turn/start", {
      threadId,
      input: inputs || [{ type: "text", text: message, text_elements: [] }],
      ...permissions,
    });
    return { turnId: turnIdFromResult(result) };
  }

  async steerTurn(threadId: string, turnId: string, message: string, inputs?: CodexUserInput[]) {
    const result = await this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: inputs || [{ type: "text", text: message, text_elements: [] }],
    });
    return { turnId: typeof result.turnId === "string" ? result.turnId : turnId };
  }

  async interruptTurn(threadId: string, turnId: string) {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  listSkills(cwd: string) {
    return this.request("skills/list", { cwds: [cwd], forceReload: false });
  }

  listPlugins(cwd: string) {
    return this.request("plugin/list", { cwds: [cwd], marketplaceKinds: null });
  }

  listApps(threadId: string) {
    return this.request("app/list", { cursor: null, limit: 1000, threadId, forceRefetch: false });
  }

  async startFuzzyFileSearch(sessionId: string, cwd: string) {
    await this.request("fuzzyFileSearch/sessionStart", { sessionId, roots: [cwd] });
  }

  async updateFuzzyFileSearch(sessionId: string, query: string) {
    await this.request("fuzzyFileSearch/sessionUpdate", { sessionId, query });
  }

  async stopFuzzyFileSearch(sessionId: string) {
    await this.request("fuzzyFileSearch/sessionStop", { sessionId });
  }

  async resumeThread(threadId: string) {
    const result = await this.request("thread/resume", { threadId });
    return result.thread && typeof result.thread === "object" ? result.thread as CodexThread : undefined;
  }

  async archiveThread(threadId: string) {
    await this.request("thread/archive", { threadId });
  }

  async unarchiveThread(threadId: string) {
    await this.request("thread/unarchive", { threadId });
  }

  async deleteThread(threadId: string) {
    await this.request("thread/delete", { threadId });
  }

  async unsubscribeThread(threadId: string) {
    await this.request("thread/unsubscribe", { threadId });
  }

  async startReview(threadId: string) {
    const result = await this.request("review/start", {
      threadId,
      target: { type: "uncommittedChanges" },
    });
    return { turnId: turnIdFromResult(result) };
  }

  async setThreadName(threadId: string, name: string) {
    await this.request("thread/name/set", { threadId, name });
  }

  setThreadGoal(threadId: string, objective: string) {
    return this.request("thread/goal/set", { threadId, objective });
  }

  getThreadGoal(threadId: string) {
    return this.request("thread/goal/get", { threadId });
  }

  async compactThread(threadId: string) {
    await this.request("thread/compact/start", { threadId });
  }

  async respondToApproval(request: CodexApprovalRequest, decision: AiSessionApprovalDecision) {
    this.sendResponse(request.id, approvalResponseForRequest(request, decision));
  }

  private request(method: string, params: JsonValue) {
    const canWriteStdio = this.child?.stdin.writable;
    const canWriteSocket = this.socket?.readyState === WebSocket.OPEN;
    if (!canWriteStdio && !canWriteSocket) {
      return Promise.reject(new Error("Codex app-server is not connected."));
    }
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (canWriteSocket) {
        this.socket?.send(message);
      } else {
        this.child?.stdin.write(`${message}\n`);
      }
    });
  }

  private async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "task-handoff", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.serverUserAgent = typeof result.userAgent === "string" ? result.userAgent : undefined;
    this.forkMethodAvailable = true;
    this.notify("initialized", {});
  }

  private notify(method: string, params: JsonValue) {
    const message = JSON.stringify({ method, params });
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(message);
      return;
    }
    if (this.child?.stdin.writable) {
      this.child.stdin.write(`${message}\n`);
    }
  }

  private sendResponse(id: number, response: JsonValue) {
    const message = JSON.stringify({ id, result: response });
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(message);
      return;
    }
    if (this.child?.stdin.writable) {
      this.child.stdin.write(`${message}\n`);
    }
  }

  private startUnixSocket(command: string, socketPath: string) {
    return new Promise<void>((resolve, reject) => {
      const proxy = spawn(command, ["app-server", "proxy", "--sock", socketPath], {
        stdio: ["pipe", "pipe", "ignore"],
        env: process.env,
      });
      this.proxyChild = proxy;
      const socket = new WebSocket("ws://localhost/rpc", {
        createConnection: () => websocketProxyStream(proxy),
        perMessageDeflate: false,
      });
      this.socket = socket;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.socket = undefined;
        this.proxyChild = undefined;
        if (!proxy.killed) {
          proxy.kill("SIGTERM");
        }
        reject(error);
      };
      proxy.once("error", fail);
      proxy.once("exit", (exitCode, signal) => {
        if (!settled) {
          fail(new Error(
            `Codex app-server proxy exited before connect: code=${exitCode ?? "null"} signal=${signal ?? "null"}.`,
          ));
          return;
        }
        if (this.proxyChild === proxy) {
          this.proxyChild = undefined;
          this.emit("disconnect");
        }
      });
      socket.once("error", fail);
      socket.once("open", () => {
        settled = true;
        proxy.off("error", fail);
        socket.off("error", fail);
        socket.on("message", (data) => this.handleLine(data.toString()));
        socket.once("close", () => {
          this.socket = undefined;
          if (this.proxyChild === proxy) {
            this.proxyChild = undefined;
          }
          if (!proxy.killed) {
            proxy.kill("SIGTERM");
          }
          for (const [id, request] of this.pending) {
            clearTimeout(request.timer);
            request.reject(new Error("Codex app-server disconnected."));
            this.pending.delete(id);
          }
          this.emit("disconnect");
        });
        this.initialize()
          .then(() => resolve())
          .catch((error) => {
            socket.close();
            reject(error);
          });
      });
    });
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.handleLine(line);
      }
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.buffer = "";
    }
  }

  private handleLine(line: string) {
    let message: JsonValue;
    try {
      message = JSON.parse(line) as JsonValue;
    } catch {
      return;
    }
    const id = Number(message.id);
    if (Number.isInteger(id)) {
      const request = this.pending.get(id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(id);
        const error = message.error && typeof message.error === "object"
          ? message.error as JsonValue
          : undefined;
        if (error) {
          request.reject(new CodexAppServerRpcError(
            String(error.message || "Codex app-server error."),
            typeof error.code === "number" ? error.code : undefined,
            error.data,
          ));
        } else {
          request.resolve((message.result && typeof message.result === "object" ? message.result : {}) as JsonValue);
        }
        return;
      }
    }
    const method = String(message.method || "");
    const params = message.params && typeof message.params === "object" ? message.params as JsonValue : {};
    if (Number.isInteger(id)) {
      const approval = codexApprovalRequest(id, method, params);
      if (approval) {
        this.emit("event", { type: "approval-request", request: approval } satisfies CodexAppServerEvent);
      }
      return;
    }
    this.emit("notification", { method, params });
    const event = codexNotification(method, params);
    if (event) {
      this.emit("event", event);
    }
  }
}

function websocketProxyStream(child: ChildProcessWithoutNullStreams) {
  const stream = new Duplex({
    read() {
      child.stdout.resume();
    },
    write(chunk, _encoding, callback) {
      child.stdin.write(chunk, callback);
    },
    final(callback) {
      child.stdin.end(callback);
    },
    destroy(error, callback) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      callback(error);
    },
  });
  child.stdout.on("data", (chunk) => {
    if (!stream.push(chunk)) {
      child.stdout.pause();
    }
  });
  child.stdout.on("end", () => stream.push(null));
  child.stdout.on("error", (error) => stream.destroy(error));
  child.stdin.on("error", (error) => stream.destroy(error));
  const socketLike = stream as Duplex & {
    setTimeout: (timeout: number, callback?: () => void) => typeof stream;
    setNoDelay: () => typeof stream;
    setKeepAlive: () => typeof stream;
  };
  socketLike.setTimeout = () => stream;
  socketLike.setNoDelay = () => stream;
  socketLike.setKeepAlive = () => stream;
  return socketLike;
}
