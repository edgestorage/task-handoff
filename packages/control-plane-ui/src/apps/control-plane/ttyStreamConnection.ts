import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";

export type TtyStreamDisconnect = {
  attempt: number;
  delayMs: number;
};

export type TtyStreamConnectionHandlers = {
  onOpen?(): void;
  onMessage(event: MessageEvent): void;
  onDisconnect?(disconnect: TtyStreamDisconnect): void;
};

export type TtyStreamConnectionOptions = {
  url: string;
  handlers: TtyStreamConnectionHandlers;
  createSocket?: (url: string) => WebSocket;
  random?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

/**
 * Owns the WebSocket behind one TTY surface.
 *
 * The controlled instance keeps the pty and its screen state when a client detaches and replays a
 * snapshot on the next attach, so a dropped link must be re-established instead of leaving the
 * terminal bound to a dead stream. Reconnects follow the shared reconnect policy and keep running
 * until `stop()`; surfaces dispose on unmount, not on disconnect.
 */
export class TtyStreamConnection {
  private readonly url: string;
  private readonly handlers: TtyStreamConnectionHandlers;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly backoff: StandardReconnectBackoff;
  private socket?: WebSocket;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(options: TtyStreamConnectionOptions) {
    this.url = options.url;
    this.handlers = options.handlers;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.backoff = new StandardReconnectBackoff(options.random);
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start() {
    if (this.stopped || this.socket || this.retryTimer) return;
    this.open();
  }

  send(message: unknown) {
    if (!this.socket || !this.connected) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRetry();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "Client closed");
    this.backoff.reset();
  }

  private open() {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => this.handleOpen(socket));
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.handlers.onMessage(event);
    });
    socket.addEventListener("close", () => this.handleClose(socket));
  }

  private handleOpen(socket: WebSocket) {
    if (this.socket !== socket || this.stopped) return;
    this.backoff.reset();
    this.handlers.onOpen?.();
  }

  private handleClose(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    if (this.stopped) return;
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const { attempt, delay } = this.backoff.next();
    this.handlers.onDisconnect?.({ attempt, delayMs: delay });
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = undefined;
      this.open();
    }, delay);
  }

  private cancelRetry() {
    if (this.retryTimer === undefined) return;
    this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = undefined;
  }
}
