import WebSocket from "ws";
import {
  NODE_RELAY_CONTROL_PROTOCOL_VERSION,
  NodeRelayControlServerMessageSchema,
} from "@task-handoff/cloud-contracts";
import { EventConnectionRetryTimer } from "@task-handoff/runtime-shared/events/connection-retry";

const DEFAULT_LEASE_MS = 90_000;
const MAX_HEARTBEAT_MS = 30_000;
const REGISTRATION_TIMEOUT_MS = 15_000;

type Target = { origin: string; credential: string; nodeId: string };

/**
 * Authenticated hint channel from the Coordinator. It never delivers relay
 * state: every wake-up causes the caller to fetch the authoritative allocation
 * snapshot over HTTPS.
 */
export class NodeRelayControlConnection {
  private readonly options: {
    resolveTarget(): Promise<Target | undefined>;
    onSnapshotRequired(): void;
    onCredentialRejected?(error: { code?: string; message: string }): void;
    webSocket?: typeof WebSocket | false;
    now?: () => number;
    random?: () => number;
    log?: { warn?(data: Record<string, unknown>, message?: string): void };
  };
  private readonly retry: EventConnectionRetryTimer;
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private registrationTimer?: ReturnType<typeof setTimeout>;
  private heartbeatIntervalMs?: number;
  private stopped = true;
  private connecting = false;
  private generation = 0;
  private credentialError?: { code?: string; message: string };

  constructor(options: NodeRelayControlConnection["options"]) {
    this.options = options;
    this.retry = new EventConnectionRetryTimer(options.random);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.retry.reset();
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.retry.reset();
    this.generation += 1;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try { socket.close(1000, "node-agent-stopped"); } catch { /* already closed */ }
    }
  }

  /** Reconnect with the current binding credential after bind or credential rotation. */
  restart() {
    if (this.stopped) {
      this.start();
      return;
    }
    this.retry.reset();
    this.generation += 1;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try { socket.close(1000, "credential-rotated"); } catch { /* already closed */ }
    }
    void this.connect();
  }

  private async connect() {
    if (this.stopped || this.connecting || this.socket) return;
    this.connecting = true;
    const generation = ++this.generation;
    try {
      const target = await this.options.resolveTarget();
      if (!target || this.stopped || generation !== this.generation) return;
      const url = new URL("/api/v1/node-relay/v1/connect", target.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const Socket = this.options.webSocket ?? WebSocket;
      if (Socket === false) return;
      const socket = new Socket(url.toString(), {
        headers: { authorization: `Bearer ${target.credential}` },
      } as never);
      this.socket = socket;
      this.registrationTimer = setTimeout(() => {
        this.closeSocket(socket, 4408, "registration-timeout");
      }, REGISTRATION_TIMEOUT_MS);
      this.registrationTimer.unref?.();
      socket.once("open", () => {
        if (this.socket !== socket || this.stopped) return;
        socket.send(JSON.stringify({
          type: "register",
          protocolVersion: NODE_RELAY_CONTROL_PROTOCOL_VERSION,
          nodeId: target.nodeId,
        }));
      });
      socket.on("message", (raw) => this.handleMessage(socket, raw));
      socket.once("error", (error) => {
        this.options.log?.warn?.({ error: error instanceof Error ? error.message : String(error) }, "node relay control socket failed");
      });
      socket.once("close", (code, reason) => this.handleClose(socket, code, reason));
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.options.log?.warn?.({ error: error instanceof Error ? error.message : String(error) }, "node relay control connection failed");
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
      // A stop/start or credential restart can arrive while target resolution is
      // still in flight. That replacement call cannot connect yet, so finish it
      // here instead of dropping the only reconnect attempt.
      if (!this.stopped && generation !== this.generation && !this.socket) void this.connect();
    }
  }

  private handleMessage(socket: WebSocket, raw: WebSocket.RawData) {
    if (this.socket !== socket || this.stopped) return;
    let message;
    try { message = NodeRelayControlServerMessageSchema.parse(JSON.parse(raw.toString())); } catch { this.closeSocket(socket, 1002, "invalid-message"); return; }
    if (message.type === "error") {
      const error = { code: message.code, message: message.message };
      if (message.code === "NODE_RELAY_CREDENTIAL_INVALID" || message.code === "NODE_RELAY_CREDENTIAL_EXPIRED") this.credentialError = error;
      this.closeSocket(socket, 4401, message.code);
      return;
    }
    if (message.type === "node-relay-changed") {
      this.options.onSnapshotRequired();
      return;
    }
    if (this.registrationTimer) clearTimeout(this.registrationTimer);
    this.registrationTimer = undefined;
    this.retry.reset();
    this.credentialError = undefined;
    this.installHeartbeat(message.leaseExpiresAt);
    if (message.type === "registered") this.options.onSnapshotRequired();
  }

  private installHeartbeat(leaseExpiresAt: string) {
    const now = this.now();
    const remaining = Math.max(1, Date.parse(leaseExpiresAt) - now);
    const intervalMs = Math.min(MAX_HEARTBEAT_MS, Math.max(1_000, Math.floor(remaining / 3)));
    if (!this.heartbeat || this.heartbeatIntervalMs !== intervalMs) {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeatIntervalMs = intervalMs;
      this.heartbeat = setInterval(() => {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "heartbeat", protocolVersion: NODE_RELAY_CONTROL_PROTOCOL_VERSION }));
      }, intervalMs);
      this.heartbeat.unref?.();
    }
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      const socket = this.socket;
      if (socket) this.closeSocket(socket, 4408, "lease-expired");
    }, Math.max(1, Math.min(remaining, remaining - 1_000)));
    this.leaseTimer.unref?.();
  }

  private handleClose(socket: WebSocket, code: number, reason: Buffer) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.clearTimers();
    if (this.stopped) return;
    if (this.credentialError) {
      this.options.onCredentialRejected?.(this.credentialError);
      this.credentialError = undefined;
      return;
    }
    this.options.log?.warn?.({ code: "NODE_RELAY_CONTROL_DISCONNECTED", closeCode: code, reason: reason.toString("utf8").slice(0, 120) }, "node relay control disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.socket) return;
    this.retry.schedule(() => { void this.connect(); });
  }

  private closeSocket(socket: WebSocket, code: number, reason: string) {
    this.clearTimers();
    try { socket.close(code, reason.slice(0, 120)); } catch { /* already closed */ }
  }

  private clearTimers() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    if (this.registrationTimer) clearTimeout(this.registrationTimer);
    this.heartbeat = undefined;
    this.leaseTimer = undefined;
    this.registrationTimer = undefined;
    this.heartbeatIntervalMs = undefined;
  }

  private now() {
    return this.options.now ? this.options.now() : Date.now();
  }
}
