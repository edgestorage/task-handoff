import net from "node:net";
import WebSocket, { WebSocketServer } from "ws";

type CodexRpcMessage = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type CodexPendingBindingRequest = {
  method: string;
  threadId?: string;
};

export class CodexAppServerConnectionProxy {
  private server?: WebSocketServer;
  private port?: number;
  private stopped = false;

  constructor(
    private readonly socketPath: string,
    private readonly onThreadBound: (threadId: string) => void,
  ) {}

  get endpoint() {
    return this.port ? `ws://127.0.0.1:${this.port}` : undefined;
  }

  start(port: number) {
    if (this.server) {
      return;
    }
    this.port = port;
    const server = new WebSocketServer({ host: "127.0.0.1", port });
    this.server = server;
    server.on("connection", (client) => this.attach(client));
  }

  stop() {
    this.stopped = true;
    this.server?.close();
    for (const client of this.server?.clients || []) {
      client.close();
    }
    this.server = undefined;
  }

  private attach(client: WebSocket) {
    if (this.stopped) {
      client.close();
      return;
    }
    const upstream = new WebSocket("ws://localhost/rpc", {
      createConnection: () => net.createConnection(this.socketPath),
      perMessageDeflate: false,
    });
    const pending = new Map<string, CodexPendingBindingRequest>();
    const upstreamQueue: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

    client.on("message", (data, isBinary) => {
      if (!isBinary) {
        this.observeClientMessage(data.toString(), pending);
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        upstreamQueue.push({ data, isBinary });
      }
    });
    upstream.on("open", () => {
      while (upstream.readyState === WebSocket.OPEN && upstreamQueue.length > 0) {
        const queued = upstreamQueue.shift();
        if (queued) {
          upstream.send(queued.data, { binary: queued.isBinary });
        }
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (!isBinary) {
        this.observeServerMessage(data.toString(), pending);
      }
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    const closeBoth = () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close();
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    };
    client.on("close", closeBoth);
    client.on("error", closeBoth);
    upstream.on("close", closeBoth);
    upstream.on("error", closeBoth);
  }

  private observeClientMessage(raw: string, pending: Map<string, CodexPendingBindingRequest>) {
    const message = parseCodexRpcMessage(raw);
    if (!message) {
      return;
    }
    const id = codexRequestId(message.id);
    const method = typeof message.method === "string" ? message.method : "";
    const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
    if (id && (method === "thread/start" || method === "thread/resume" || method === "thread/fork")) {
      pending.set(id, { method, threadId: typeof params.threadId === "string" ? params.threadId : undefined });
      if (typeof params.threadId === "string") {
        this.onThreadBound(params.threadId);
      }
      return;
    }
    if (typeof params.threadId === "string" && (method === "turn/start" || method === "turn/steer" || method === "turn/interrupt" || method === "thread/unsubscribe")) {
      this.onThreadBound(params.threadId);
    }
  }

  private observeServerMessage(raw: string, pending: Map<string, CodexPendingBindingRequest>) {
    const message = parseCodexRpcMessage(raw);
    if (!message) {
      return;
    }
    const id = codexRequestId(message.id);
    if (!id) {
      return;
    }
    const request = pending.get(id);
    if (!request) {
      return;
    }
    pending.delete(id);
    if (message.error) {
      return;
    }
    const threadId = threadIdFromCodexResult(message.result) || request.threadId;
    if (threadId) {
      this.onThreadBound(threadId);
    }
  }
}

function parseCodexRpcMessage(raw: string): CodexRpcMessage | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CodexRpcMessage : undefined;
  } catch {
    return undefined;
  }
}

function codexRequestId(id: unknown) {
  if (typeof id === "string" && id) {
    return id;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  return undefined;
}

function threadIdFromCodexResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const value = result as Record<string, unknown>;
  const thread = value.thread && typeof value.thread === "object" && !Array.isArray(value.thread) ? value.thread as Record<string, unknown> : undefined;
  if (typeof thread?.id === "string") {
    return thread.id;
  }
  return typeof value.threadId === "string" ? value.threadId : undefined;
}
