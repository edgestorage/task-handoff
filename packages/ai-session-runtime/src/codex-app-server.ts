import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionActionResult, AiSessionApprovalDecision, AiSessionControlProvider, AiSessionSendInput } from "./ai-session-control";
import { aiSessionControlError } from "./ai-session-control";
import { PendingAiSessionApprovalStore } from "./ai-session-control";
import { withAttachmentPathFallback } from "./ai-session-attachments";
import type { AiSessionDiscoveryContext, AiSessionDiscoveryProvider } from "./ai-session-discovery";
import type { AiSessionRegistry } from "./ai-session-registry";
import {
  activeTurnMismatchFoundId,
  approvalResponseForRequest,
  codexApprovalRequest,
  codexNotification,
  CodexSubAgentTracker,
  CodexToolActivityTracker,
  lifecycleForStatus,
  isNoActiveTurnError,
  summarizeThreadTurns,
  turnIdFromResult,
  waitFor,
  type CodexAppServerEvent,
  type CodexApprovalRequest,
  type CodexThread,
  type CodexThreadStatus,
  type CodexToolActivityState,
  type JsonValue,
} from "./codex-app-server-protocol";

type CodexAppServerClientMode =
  | { type: "stdio"; command: string }
  | { type: "unix"; command: string; socketPath: string };

type CodexAppServerClientOptions = {
  command?: string;
  requestTimeoutMs?: number;
  socketPath?: string;
};
type CodexAppServerBridgeOptions = {
  allowSpawn?: boolean;
  createClient?: (options: CodexAppServerClientOptions) => CodexAppServerClientLike;
  onMessageDelta?: (event: {
    sessionId: string;
    providerSessionId: string;
    turnId?: string;
    itemId?: string;
    delta: string;
  }) => void;
};

type CodexAppServerClientLike = EventEmitter & {
  start: () => Promise<void>;
  stop: () => void;
  listLoadedThreadIds: () => Promise<string[]>;
  readThread?: (threadId: string, options?: { includeTurns?: boolean }) => Promise<CodexThread | undefined>;
  listThreads?: () => Promise<CodexThread[]>;
  startTurn?: (threadId: string, message: string) => Promise<{ turnId?: string }>;
  steerTurn?: (threadId: string, turnId: string, message: string) => Promise<{ turnId?: string }>;
  interruptTurn?: (threadId: string, turnId: string) => Promise<void>;
  resumeThread?: (threadId: string) => Promise<CodexThread | undefined>;
  respondToApproval?: (request: CodexApprovalRequest, decision: AiSessionApprovalDecision) => Promise<void>;
};

type CodexAppSession = {
  id?: unknown;
  appId?: unknown;
  title?: unknown;
  status?: unknown;
  createdAt?: unknown;
  launch?: {
    args?: unknown;
  };
  tty?: {
    cwd?: unknown;
  };
  ai?: {
    activeThreadId?: unknown;
    threadIds?: unknown;
    appServer?: {
      socketPath?: unknown;
    };
  };
};

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexAppServerClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private proxyChild?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly mode: CodexAppServerClientMode;
  private readonly requestTimeoutMs: number;

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    this.mode = options.socketPath
      ? { type: "unix", command: options.command || process.env.TASK_HANDOFF_CODEX_APP_SERVER_COMMAND || process.env.TASK_HANDOFF_CODEX_COMMAND || "codex", socketPath: options.socketPath }
      : { type: "stdio", command: options.command || process.env.TASK_HANDOFF_CODEX_APP_SERVER_COMMAND || process.env.TASK_HANDOFF_CODEX_COMMAND || "codex" };
    this.requestTimeoutMs = options.requestTimeoutMs || Number(process.env.TASK_HANDOFF_CODEX_APP_SERVER_TIMEOUT_MS) || 5_000;
  }

  get connected() {
    return Boolean((this.child && !this.child.killed) || (this.proxyChild && !this.proxyChild.killed) || this.socket?.readyState === WebSocket.OPEN);
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

  async readThread(threadId: string, options: { includeTurns?: boolean } = {}) {
    const result = await this.request("thread/read", { threadId, includeTurns: Boolean(options.includeTurns) });
    const thread = result.thread && typeof result.thread === "object" ? result.thread as CodexThread : undefined;
    return thread;
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
        threads.push(...result.data.filter((thread): thread is CodexThread => Boolean(thread && typeof thread === "object" && !Array.isArray(thread))));
      } else if (Array.isArray(result.threads)) {
        threads.push(...result.threads.filter((thread): thread is CodexThread => Boolean(thread && typeof thread === "object" && !Array.isArray(thread))));
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor) {
        break;
      }
    }
    return threads;
  }

  async startTurn(threadId: string, message: string) {
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: message, text_elements: [] }],
    });
    return { turnId: turnIdFromResult(result) };
  }

  async steerTurn(threadId: string, turnId: string, message: string) {
    const result = await this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: message, text_elements: [] }],
    });
    return { turnId: typeof result.turnId === "string" ? result.turnId : turnId };
  }

  async interruptTurn(threadId: string, turnId: string) {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async resumeThread(threadId: string) {
    const result = await this.request("thread/resume", { threadId });
    return result.thread && typeof result.thread === "object" ? result.thread as CodexThread : undefined;
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
    await this.request("initialize", { clientInfo: { name: "task-handoff", version: "1.0.0" }, capabilities: { experimentalApi: true } });
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
          fail(new Error(`Codex app-server proxy exited before connect: code=${exitCode ?? "null"} signal=${signal ?? "null"}.`));
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
        const error = message.error && typeof message.error === "object" ? message.error as JsonValue : undefined;
        if (error) {
          request.reject(new Error(String(error.message || "Codex app-server error.")));
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

export class CodexAppServerSessionBridge implements AiSessionControlProvider, AiSessionDiscoveryProvider {
  readonly id = "codex-app-server";
  readonly agent = "codex";
  private client?: CodexAppServerClientLike;
  private started = false;
  private retryAfter = 0;
  private activeSocketPath?: string;
  private appSessions: CodexAppSession[] = [];
  private readonly subscribedThreadIds = new Set<string>();
  private readonly threadSubscriptionAttempts = new Map<string, Promise<CodexThread | undefined>>();
  private subscriptionEpoch = 0;
  private readonly approvals = new PendingAiSessionApprovalStore();
  private readonly toolActivityByThread = new Map<string, CodexToolActivityTracker>();
  private readonly subAgentsByThread = new Map<string, CodexSubAgentTracker>();
  private readonly injectedClient?: CodexAppServerClientLike;
  private readonly options: CodexAppServerBridgeOptions;

  constructor(
    private readonly registry: AiSessionRegistry,
    clientOrOptions: CodexAppServerClientLike | CodexAppServerBridgeOptions = {},
    injectedOptions: CodexAppServerBridgeOptions = {},
  ) {
    if ("start" in clientOrOptions && "listLoadedThreadIds" in clientOrOptions) {
      this.injectedClient = clientOrOptions;
      this.options = { allowSpawn: true, ...injectedOptions };
      this.attachClient(this.injectedClient);
    } else {
      this.options = clientOrOptions;
    }
  }

  async sync(appSessions: CodexAppSession[] = []) {
    const socketPath = this.setAppSessions(appSessions);
    const previousSocketPath = this.activeSocketPath;
    if (!this.injectedClient && !socketPath && !this.options.allowSpawn) {
      this.stop();
      return;
    }
    if (!this.injectedClient && (!this.client || previousSocketPath !== socketPath)) {
      this.stop();
      this.client = this.createClient(socketPath ? { socketPath } : {});
      this.attachClient(this.client);
    }
    this.activeSocketPath = socketPath;
    const client = this.client;
    if (!client) {
      return;
    }
    if (!this.started) {
      if (Date.now() < this.retryAfter) {
        return;
      }
      try {
        await client.start();
        this.started = true;
      } catch {
        this.retryAfter = Date.now() + 30_000;
        return;
      }
    }
    try {
      const loadedThreadIds = await client.listLoadedThreadIds();
      const threadsById = new Map<string, CodexThread>();
      if (client.listThreads) {
        for (const thread of await client.listThreads()) {
          const id = typeof thread.id === "string" ? thread.id : undefined;
          if (id) {
            threadsById.set(id, thread);
          }
        }
      }
      for (const threadId of loadedThreadIds) {
        let thread = threadsById.get(threadId);
        if (client.readThread) {
          try {
            thread = {
              ...(thread || {}),
              ...await client.readThread(threadId, { includeTurns: true }),
            };
          } catch {
            thread ||= { id: threadId };
          }
        }
        this.upsertThread(thread || { id: threadId }, { bindAppSession: true });
        if (client.resumeThread) {
          try {
            const resumed = await this.ensureThreadSubscribed(client, threadId);
            if (resumed) {
              this.upsertThread(resumed, { bindAppSession: true });
            }
          } catch {
            // A failed subscription is retried on the next discovery pass without
            // preventing other loaded threads from being synchronized.
          }
        }
      }
    } catch {
      this.started = false;
      this.resetThreadSubscriptions();
      client.stop();
    }
  }

  async refresh(context: AiSessionDiscoveryContext) {
    await this.sync(context.appSessions);
  }

  stop() {
    this.client?.stop();
    if (!this.injectedClient) {
      this.client = undefined;
    }
    this.started = false;
    this.activeSocketPath = undefined;
    this.resetThreadSubscriptions();
    this.retryAfter = 0;
  }

  async sendMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const client = await this.requireReadyClient();
    const threadId = this.requireThreadId(session);
    const result = await withAttachmentPathFallback(input.message, input.attachments, (providerMessage) => (
      this.steerOrStartTurnForCompatibility(client, threadId, session, providerMessage)
    ));
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: result.started ? "send-ack" : "user-message",
      activeTurnId: result.turnId,
      providerTurnId: result.turnId,
      userPrompt: input.message,
      source: "control",
    }) || session;
    return { session: updated, provider: this.agent, action: result.started ? "send" : "steer", turnId: updated.activeTurnId, providerTurnId: result.turnId };
  }

  async startMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const client = await this.requireReadyClient();
    const threadId = this.requireThreadId(session);
    const result = await withAttachmentPathFallback(input.message, input.attachments, (providerMessage) => (
      this.startTurn(client, threadId, providerMessage)
    ));
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: "send-ack",
      activeTurnId: result.turnId,
      providerTurnId: result.turnId,
      userPrompt: input.message,
      source: "control",
    }) || session;
    return { session: updated, provider: this.agent, action: "send", turnId: updated.activeTurnId, providerTurnId: result.turnId };
  }

  async steerMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const client = await this.requireReadyClient();
    const threadId = this.requireThreadId(session);
    const result = await withAttachmentPathFallback(input.message, input.attachments, (providerMessage) => (
      this.steerTurn(client, threadId, session, providerMessage)
    ));
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: "user-message",
      activeTurnId: result.turnId,
      providerTurnId: result.turnId,
      userPrompt: input.message,
      source: "control",
    }) || session;
    return { session: updated, provider: this.agent, action: "steer", turnId: updated.activeTurnId, providerTurnId: result.turnId };
  }

  private async steerTurn(client: CodexAppServerClientLike, threadId: string, session: AiSessionStatus, message: string) {
    if (!session.activeTurnId) {
      throw aiSessionControlError("AI_SESSION_NO_ACTIVE_TURN", "AI session has no active turn to steer.", 409);
    }
    if (!client.steerTurn) {
      throw aiSessionControlError("AI_SESSION_STEER_UNSUPPORTED", "Codex app-server client does not support turn steering.");
    }
    try {
      return { turnId: (await client.steerTurn(threadId, session.activeTurnId, message)).turnId || session.activeTurnId };
    } catch (error) {
      const currentTurnId = activeTurnMismatchFoundId(error);
      if (currentTurnId) {
        return { turnId: (await client.steerTurn(threadId, currentTurnId, message)).turnId || currentTurnId };
      }
      throw error;
    }
  }

  private async steerOrStartTurnForCompatibility(client: CodexAppServerClientLike, threadId: string, session: AiSessionStatus, message: string) {
    const shouldSteer = Boolean(session.activeTurnId && (session.status === "running" || session.status === "waiting"));
    if (!shouldSteer) {
      return this.startTurn(client, threadId, message);
    }
    try {
      return { ...(await this.steerTurn(client, threadId, session, message)), started: false };
    } catch (error) {
      if (!isNoActiveTurnError(error)) {
        throw error;
      }
      return this.startTurn(client, threadId, message);
    }
  }

  private async startTurn(client: CodexAppServerClientLike, threadId: string, message: string) {
    if (!client.startTurn) {
      throw aiSessionControlError("AI_SESSION_SEND_UNSUPPORTED", "Codex app-server client does not support starting turns.");
    }
    return { turnId: (await client.startTurn(threadId, message)).turnId, started: true };
  }

  async interrupt(session: AiSessionStatus): Promise<AiSessionActionResult> {
    const client = await this.requireReadyClient();
    const threadId = this.requireThreadId(session);
    const turnId = session.activeTurnId;
    if (!turnId) {
      throw aiSessionControlError("AI_SESSION_NO_ACTIVE_TURN", "AI session has no active turn to interrupt.");
    }
    if (!client.interruptTurn) {
      throw aiSessionControlError("AI_SESSION_INTERRUPT_UNSUPPORTED", "Codex app-server client does not support turn interruption.");
    }
    try {
      await client.interruptTurn(threadId, turnId);
    } catch (error) {
      const currentTurnId = activeTurnMismatchFoundId(error);
      if (currentTurnId) {
        await client.interruptTurn(threadId, currentTurnId);
        const updated = this.registry.applyRealtimeEvent(session.id, {
          kind: "lifecycle",
          activeTurnId: currentTurnId,
          status: "running",
          phase: "unknown",
          source: "control",
        }) || session;
        return { session: updated, provider: this.agent, action: "interrupt", providerTurnId: currentTurnId };
      }
      if (!isNoActiveTurnError(error)) {
        throw error;
      }
      const updated = this.registry.applyRealtimeEvent(session.id, {
        kind: "turn-completed",
        activeTurnId: undefined,
        status: "idle",
        phase: "unknown",
        text: "Codex turn is no longer active.",
        source: "control",
      }) || session;
      return { session: updated, provider: this.agent, action: "interrupt", providerTurnId: turnId };
    }
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: "lifecycle",
      status: "running",
      phase: "unknown",
      source: "control",
    }) || session;
    return { session: updated, provider: this.agent, action: "interrupt", providerTurnId: turnId };
  }

  async resolveApproval(session: AiSessionStatus, decision: AiSessionApprovalDecision): Promise<AiSessionActionResult> {
    const pendingApproval = await this.resolveAttachedApproval(session, decision);
    if (pendingApproval) {
      const updated = this.registry.applyRealtimeEvent(session.id, {
        kind: "lifecycle",
        status: decision === "skip" ? "idle" : "running",
        phase: decision === "skip" ? "unknown" : "thinking",
        source: "control",
      }) || session;
      return { session: updated, provider: this.agent, action: "approval", decision };
    }
    throw aiSessionControlError(
      "AI_SESSION_APPROVAL_NOT_ATTACHED",
      "Codex approval request is not attached to this control connection. The app-server did not replay a pending approval request for this session.",
      409,
    );
  }

  private async resolveAttachedApproval(session: AiSessionStatus, decision: AiSessionApprovalDecision) {
    const attached = await this.approvals.resolveForSession(session.id, decision);
    if (attached) {
      return attached;
    }
    await this.attachPendingApprovalRequest(session);
    return this.approvals.resolveForSession(session.id, decision);
  }

  private async attachPendingApprovalRequest(session: AiSessionStatus) {
    const client = await this.requireReadyClient();
    if (!client.resumeThread || this.approvals.latestForSession(session.id)) {
      return;
    }
    const threadId = this.requireThreadId(session);
    const resumed = await client.resumeThread(threadId);
    if (resumed) {
      this.upsertThread(resumed, { bindAppSession: true });
    }
    await waitFor(() => Boolean(this.approvals.latestForSession(session.id)), 1_000);
  }

  private attachClient(client: CodexAppServerClientLike) {
    client.on("event", (event: CodexAppServerEvent) => this.applyProviderEvent(event));
    client.on("disconnect", () => {
      this.started = false;
      this.resetThreadSubscriptions();
      this.retryAfter = Date.now() + 30_000;
    });
    this.client = client;
  }

  private ensureThreadSubscribed(client: CodexAppServerClientLike, threadId: string) {
    if (!client.resumeThread || this.subscribedThreadIds.has(threadId)) {
      return Promise.resolve(undefined);
    }
    const pending = this.threadSubscriptionAttempts.get(threadId);
    if (pending) return pending;
    const epoch = this.subscriptionEpoch;
    const attempt = client.resumeThread(threadId).then((thread) => {
      if (this.client === client && this.subscriptionEpoch === epoch) {
        this.subscribedThreadIds.add(threadId);
      }
      return thread;
    }).finally(() => {
      if (this.threadSubscriptionAttempts.get(threadId) === attempt) {
        this.threadSubscriptionAttempts.delete(threadId);
      }
    });
    this.threadSubscriptionAttempts.set(threadId, attempt);
    return attempt;
  }

  private resetThreadSubscriptions() {
    this.subscriptionEpoch += 1;
    this.subscribedThreadIds.clear();
    this.threadSubscriptionAttempts.clear();
  }

  private createClient(options: CodexAppServerClientOptions) {
    return this.options.createClient ? this.options.createClient(options) : new CodexAppServerClient(options);
  }

  private codexAppServerSocketPath(appSessions: CodexAppSession[]) {
    return appSessions
      .map((session) => session.ai?.appServer?.socketPath)
      .find((socketPath): socketPath is string => typeof socketPath === "string" && socketPath.trim().length > 0);
  }

  private setAppSessions(appSessions: CodexAppSession[]) {
    this.appSessions = appSessions;
    return this.codexAppServerSocketPath(appSessions);
  }

  private appSessionIdForThread(threadId: string) {
    if (!this.activeSocketPath) {
      return undefined;
    }
    for (const appSession of this.appSessions) {
      if (typeof appSession.id !== "string") {
        continue;
      }
      if (appSession.appId !== "codex" || appSession.ai?.appServer?.socketPath !== this.activeSocketPath) {
        continue;
      }
      if (appSession.status !== "running") {
        continue;
      }
      if (appSession.ai?.activeThreadId === threadId) {
        return appSession.id;
      }
      if (Array.isArray(appSession.ai?.threadIds) && appSession.ai.threadIds.includes(threadId)) {
        return appSession.id;
      }
    }
    return undefined;
  }

  private applyProviderEvent(event: CodexAppServerEvent) {
    if (event.type === "thread") {
      this.upsertThread(event.thread, { bindAppSession: true });
      return;
    }
    if (event.type === "approval-request") {
      this.applyApprovalRequest(event.request);
      return;
    }
    const session = this.registry.list().find((entry) => entry.agent === "codex" && entry.providerSessionId === event.threadId);
    if (!session) {
      return;
    }
    if (event.type === "thread-closed") {
      this.approvals.clearSession(session.id);
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).clearActiveTools());
      this.registry.applyRealtimeEvent(session.id, { kind: "turn-completed", activeTurnId: session.activeTurnId, status: "idle", phase: "unknown", text: "Codex thread closed.", source: "realtime" });
      return;
    }
    if (event.type === "thread-status") {
      const providerLifecycle = lifecycleForStatus(event.status);
      if (providerLifecycle.phase !== "approval") {
        this.approvals.clearSession(session.id);
      }
      const lifecycle = this.lifecycleWithAttachedApproval(session.id, providerLifecycle);
      this.registry.applyRealtimeEvent(session.id, {
        kind: "lifecycle",
        activeTurnId: session.activeTurnId,
        status: lifecycle.status,
        phase: lifecycle.phase,
        source: "realtime",
      });
      return;
    }
    if (event.type === "turn-started") {
      this.registry.applyRealtimeEvent(session.id, { kind: "turn-started", activeTurnId: event.turnId, providerTurnId: event.turnId, source: "realtime" });
      return;
    }
    if (event.type === "tool-item-started") {
      if (event.subAgents?.length) this.applySubAgentUpdates(session.id, event.threadId, event.subAgents);
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).started(event.tool));
      return;
    }
    if (event.type === "tool-item-completed") {
      if (event.subAgents?.length) this.applySubAgentUpdates(session.id, event.threadId, event.subAgents);
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).completed(event.tool));
      return;
    }
    if (event.type === "sub-agent-activity") {
      this.applySubAgentUpdates(session.id, event.threadId, [event.subAgent]);
      return;
    }
    if (event.type === "user-message") {
      this.registry.applyRealtimeEvent(session.id, { kind: "user-message", activeTurnId: event.turnId || session.activeTurnId, providerTurnId: event.turnId || session.activeTurnId, userPrompt: event.text, source: "realtime" });
      return;
    }
    if (event.type === "turn-completed") {
      this.approvals.clearSession(session.id);
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).clearActiveTools());
      this.registry.applyRealtimeEvent(session.id, {
        kind: "turn-completed",
        activeTurnId: event.turnId,
        providerTurnId: event.turnId,
        status: event.status === "failed" ? "failed" : "idle",
        error: event.status === "failed" ? event.error : undefined,
        source: "realtime",
      });
      return;
    }
    if (event.type === "agent-message-delta") {
      this.options.onMessageDelta?.({
        sessionId: session.id,
        providerSessionId: event.threadId,
        turnId: event.turnId || session.activeTurnId,
        itemId: event.itemId,
        delta: event.delta,
      });
      return;
    }
    if (event.type === "agent-message-completed") {
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).resetForAgentMessage());
      this.registry.applyRealtimeEvent(session.id, { kind: "assistant-message", activeTurnId: event.turnId || session.activeTurnId, providerTurnId: event.turnId || session.activeTurnId, text: event.text, status: session.status, source: "realtime" });
    }
  }

  private toolTracker(threadId: string) {
    let tracker = this.toolActivityByThread.get(threadId);
    if (!tracker) {
      tracker = new CodexToolActivityTracker();
      this.toolActivityByThread.set(threadId, tracker);
    }
    return tracker;
  }

  private subAgentTracker(threadId: string) {
    let tracker = this.subAgentsByThread.get(threadId);
    if (!tracker) {
      tracker = new CodexSubAgentTracker();
      this.subAgentsByThread.set(threadId, tracker);
    }
    return tracker;
  }

  private applyToolActivity(sessionId: string, state: CodexToolActivityState) {
    this.registry.applyRealtimeEvent(sessionId, {
      kind: "tool-activity",
      currentTool: state.currentTool || null,
      toolCallsSinceLastMessage: state.toolCallsSinceLastMessage,
      source: "realtime",
    });
  }

  private applySubAgentUpdates(sessionId: string, threadId: string, updates: Parameters<CodexSubAgentTracker["apply"]>[0]) {
    this.applySubAgentActivity(sessionId, this.subAgentTracker(threadId).apply(updates, new Date().toISOString()));
  }

  private applySubAgentActivity(sessionId: string, subAgents: ReturnType<CodexSubAgentTracker["snapshot"]>) {
    this.registry.applyRealtimeEvent(sessionId, {
      kind: "sub-agent-activity",
      subAgents,
      source: "realtime",
    });
  }

  private upsertThread(thread: CodexThread, options: { bindAppSession: boolean }) {
    const id = typeof thread.id === "string" ? thread.id : undefined;
    if (!id || thread.ephemeral === true) {
      return;
    }
    const existing = this.registry.list().find((entry) => entry.agent === "codex" && entry.providerSessionId === id);
    const pendingApproval = existing ? this.approvals.latestForSession(existing.id) : undefined;
    const lifecycle = this.lifecycleWithAttachedApproval(existing?.id, lifecycleForStatus(thread.status || {}));
    const appSessionId = options.bindAppSession ? this.appSessionIdForThread(id) : undefined;
    const history = summarizeThreadTurns(thread);
    const toolActivity = Array.isArray(thread.turns)
      ? this.toolTracker(id).replace(history.toolActivity)
      : this.toolTracker(id).snapshot();
    const subAgents = Array.isArray(thread.turns)
      ? this.subAgentTracker(id).replace(history.subAgents)
      : this.subAgentTracker(id).snapshot();
    this.registry.applyAdapterSnapshot({
      source: "adapter-snapshot",
      agent: "codex",
      appId: appSessionId ? "codex" : "codex-app-server",
      appSessionId,
      providerSessionId: id,
      appBindingKeys: appSessionId ? [`app:${appSessionId}`] : undefined,
      actions: {
        send: true,
        interrupt: lifecycle.status === "running" || lifecycle.status === "waiting",
        approval: lifecycle.status === "waiting" && lifecycle.phase === "approval",
      },
      title: typeof thread.name === "string" ? thread.name : undefined,
      cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
      activeTurnId: history.activeTurnId,
      userPrompt: history.userPrompt,
      turns: history.turns,
      summary: pendingApproval?.summary || history.summary,
      lastMessage: history.lastMessage,
      currentTool: toolActivity.currentTool,
      toolCallsSinceLastMessage: toolActivity.toolCallsSinceLastMessage,
      subAgents,
      status: lifecycle.status,
      phase: lifecycle.phase,
      replaceActivity: true,
    });
  }

  private lifecycleWithAttachedApproval(
    sessionId: string | undefined,
    lifecycle: ReturnType<typeof lifecycleForStatus>,
  ): ReturnType<typeof lifecycleForStatus> {
    if (lifecycle.phase !== "approval" || sessionId && this.approvals.latestForSession(sessionId)) {
      return lifecycle;
    }
    return { status: "waiting", phase: "thinking" };
  }

  private applyApprovalRequest(request: CodexApprovalRequest) {
    const session = this.registry.list().find((entry) => entry.agent === "codex" && entry.providerSessionId === request.threadId);
    if (!session) {
      return;
    }
    const client = this.client;
    if (!client?.respondToApproval) {
      return;
    }
    this.approvals.register({
      id: `${request.threadId}:${request.id}`,
      sessionId: session.id,
      provider: this.agent,
      summary: request.summary,
      metadata: { kind: request.kind, requestId: request.id, itemId: request.itemId },
      resolve: (decision) => client.respondToApproval?.(request, decision),
    });
    this.registry.applyRealtimeEvent(session.id, {
      kind: "approval-requested",
      activeTurnId: request.turnId || session.activeTurnId,
      providerTurnId: request.turnId || session.activeTurnId,
      status: "waiting",
      phase: "approval",
      summary: request.summary,
      counters: { approvals: 1 },
      source: "realtime",
    });
  }

  private async requireReadyClient() {
    const client = this.client;
    if (!client) {
      throw aiSessionControlError("AI_SESSION_CONTROL_NOT_CONNECTED", "Codex app-server is not connected.", 503);
    }
    if (!this.started) {
      await client.start();
      this.started = true;
    }
    return client;
  }

  private requireThreadId(session: AiSessionStatus) {
    if (!session.providerSessionId) {
      throw aiSessionControlError("AI_SESSION_THREAD_NOT_FOUND", "AI session is not bound to a Codex thread.");
    }
    return session.providerSessionId;
  }
}
