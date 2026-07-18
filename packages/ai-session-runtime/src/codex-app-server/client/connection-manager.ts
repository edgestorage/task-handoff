import type { CodexAppServerClientLike } from "./contract";
import type { CodexAppServerEvent, CodexThread } from "../protocol/types";

export type CodexAppServerConnection = {
  client: CodexAppServerClientLike;
  epoch: number;
};

type ConnectionState = "idle" | "connecting" | "ready" | "closing";

type ConnectionManagerOptions = {
  injectedClient?: CodexAppServerClientLike;
  createClient: (options: { socketPath?: string }) => CodexAppServerClientLike;
  onEvent: (event: CodexAppServerEvent, connection: CodexAppServerConnection) => void;
  onDisconnect?: (connection: CodexAppServerConnection) => void;
  onInvalidate?: (connection: CodexAppServerConnection) => void;
  retryDelayMs?: number;
};

/** Owns the lifecycle of exactly one Codex app-server connection generation. */
export class CodexAppServerConnectionManager {
  private clientValue?: CodexAppServerClientLike;
  private socketPathValue?: string;
  private state: ConnectionState = "idle";
  private epochValue = 0;
  private retryAfter = 0;
  private startPromise?: Promise<CodexAppServerConnection>;
  private listeners?: {
    client: CodexAppServerClientLike;
    event: (event: CodexAppServerEvent) => void;
    disconnect: () => void;
  };
  private readonly subscribedThreadIds = new Set<string>();
  private readonly subscriptionAttempts = new Map<string, Promise<CodexThread | undefined>>();

  constructor(private readonly options: ConnectionManagerOptions) {
    if (options.injectedClient) {
      this.install(options.injectedClient, undefined);
    }
  }

  get client() {
    return this.clientValue;
  }

  get socketPath() {
    return this.socketPathValue;
  }

  get epoch() {
    return this.epochValue;
  }

  /** Selects the desired endpoint, disposing an older endpoint atomically. */
  configure(socketPath?: string) {
    if (this.options.injectedClient) {
      if (!this.clientValue) {
        this.install(this.options.injectedClient, undefined);
      }
      return this.current();
    }
    if (this.clientValue && this.socketPathValue === socketPath) {
      return this.current();
    }
    this.disposeCurrent();
    this.install(this.options.createClient(socketPath ? { socketPath } : {}), socketPath);
    return this.current();
  }

  current(): CodexAppServerConnection | undefined {
    return this.clientValue ? { client: this.clientValue, epoch: this.epochValue } : undefined;
  }

  isCurrent(connection: CodexAppServerConnection) {
    return connection.client === this.clientValue && connection.epoch === this.epochValue;
  }

  connectionFor(client: CodexAppServerClientLike) {
    return client === this.clientValue ? this.current() : undefined;
  }

  canRetry() {
    return Date.now() >= this.retryAfter;
  }

  /** Starts the current generation once, sharing the in-flight initialization. */
  async ready(options: { respectRetry?: boolean } = {}) {
    const connection = this.current();
    if (!connection) {
      throw new Error("Codex app-server is not configured.");
    }
    if (this.state === "ready") {
      return connection;
    }
    if (options.respectRetry && !this.canRetry()) {
      return undefined;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    // A disconnected generation has its listeners detached. Reattach only
    // when that same client is explicitly started again; this prevents late
    // events emitted by the dead socket from being accepted as current.
    if (!this.listeners || this.listeners.client !== connection.client) {
      this.attachListeners(connection.client, connection.epoch);
    }
    this.state = "connecting";
    const startPromise = connection.client.start().then(() => {
      if (!this.isCurrent(connection)) {
        throw new Error("Codex app-server connection changed while starting.");
      }
      this.state = "ready";
      this.retryAfter = 0;
      return connection;
    }).catch((error) => {
      if (this.isCurrent(connection)) {
        this.state = "idle";
        if (options.respectRetry) {
          this.retryAfter = Date.now() + (this.options.retryDelayMs ?? 30_000);
        }
      }
      throw error;
    }).finally(() => {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  markUnhealthy(connection: CodexAppServerConnection) {
    if (!this.isCurrent(connection)) return;
    this.advanceGeneration();
    connection.client.stop();
  }

  ensureThreadSubscribed(connection: CodexAppServerConnection, threadId: string) {
    const { client, epoch } = connection;
    if (!this.isCurrent(connection) || !client.resumeThread || this.subscribedThreadIds.has(threadId)) {
      return Promise.resolve(undefined);
    }
    const pending = this.subscriptionAttempts.get(threadId);
    if (pending) return pending;
    const attempt = client.resumeThread(threadId).then((thread) => {
      if (client === this.clientValue && epoch === this.epochValue) {
        this.subscribedThreadIds.add(threadId);
      }
      return thread;
    }).finally(() => {
      if (this.subscriptionAttempts.get(threadId) === attempt) {
        this.subscriptionAttempts.delete(threadId);
      }
    });
    this.subscriptionAttempts.set(threadId, attempt);
    return attempt;
  }

  stop() {
    this.disposeCurrent();
    this.retryAfter = 0;
  }

  private install(client: CodexAppServerClientLike, socketPath?: string) {
    this.clientValue = client;
    this.socketPathValue = socketPath;
    this.state = "idle";
    this.epochValue += 1;
    this.attachListeners(client, this.epochValue);
  }

  private attachListeners(client: CodexAppServerClientLike, epoch: number) {
    const event = (value: CodexAppServerEvent) => {
      const connection = { client, epoch };
      if (this.isCurrent(connection)) {
        this.options.onEvent(value, connection);
      }
    };
    const disconnect = () => {
      const connection = { client, epoch };
      if (!this.isCurrent(connection)) return;
      this.advanceGeneration();
      this.options.onDisconnect?.(connection);
    };
    client.on("event", event);
    client.on("disconnect", disconnect);
    this.listeners = { client, event, disconnect };
  }

  private advanceGeneration() {
    const invalidated = this.current();
    this.state = "idle";
    this.retryAfter = Date.now() + (this.options.retryDelayMs ?? 30_000);
    this.startPromise = undefined;
    this.resetSubscriptions();
    this.detachListeners();
    this.epochValue += 1;
    if (invalidated) this.options.onInvalidate?.(invalidated);
  }

  private detachListeners() {
    const listeners = this.listeners;
    if (!listeners) return;
    listeners.client.off("event", listeners.event);
    listeners.client.off("disconnect", listeners.disconnect);
    this.listeners = undefined;
  }

  private disposeCurrent() {
    const client = this.clientValue;
    const invalidated = this.current();
    this.state = "closing";
    this.epochValue += 1;
    this.startPromise = undefined;
    this.detachListeners();
    this.resetSubscriptions();
    client?.stop();
    this.clientValue = undefined;
    this.socketPathValue = undefined;
    this.state = "idle";
    if (invalidated) this.options.onInvalidate?.(invalidated);
  }

  private resetSubscriptions() {
    this.subscribedThreadIds.clear();
    this.subscriptionAttempts.clear();
  }
}
