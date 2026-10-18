import type { NodeRelaySessionMessage } from "@task-handoff/protocol/node-relay-channel";
import {
  EncryptedNodeRelayChannel,
  NODE_RELAY_DIRECTION_CONTROL_PLANE,
  NODE_RELAY_DIRECTION_NODE,
  nodeRelaySessionError,
  type NodeRelayFrameSocket,
} from "../../shared/cloud-relay/node-relay-session.ts";
import { createNodeAgentHmacHeaders } from "../../shared/security/node-agent-auth.ts";
import { NodeTunnelSessionServer, type NodeTunnelSessionHost } from "../tunnel-session/server.ts";

export type NodeRelayTunnelHost = NodeTunnelSessionHost & {
  currentListenerPort(): number;
};

/**
 * One ws-like socket multiplexed over the encrypted node channel: `main`
 * carries the tunnel's main protocol, every other id is an auxiliary stream
 * the node dialed back (HTTP response streams and proxied WebSockets), exactly
 * like the reverse-tunnel client opens a fresh WebSocket per stream.
 */
export class NodeRelayChannelSocket {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = NodeRelayChannelSocket.OPEN;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private readonly queued: Array<{ raw: unknown; isBinary: boolean }> = [];
  private readonly channel: NodeRelayNodeChannel;
  readonly channelId: string;

  constructor(channel: NodeRelayNodeChannel, channelId: string) {
    this.channel = channel;
    this.channelId = channelId;
  }

  send(data: string | Buffer, options?: { binary?: boolean }) {
    if (this.readyState !== NodeRelayChannelSocket.OPEN) throw nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED");
    // `ws` hands text frames to listeners as Buffers. Honour an explicit
    // `binary` flag first so bridged text frames stay text on the peer.
    this.channel.sendChannelData(this.channelId, data, options?.binary ?? typeof data !== "string");
  }

  close(code = 1000, reason = "normal") {
    if (this.readyState === NodeRelayChannelSocket.CLOSED) return;
    this.readyState = NodeRelayChannelSocket.CLOSED;
    this.channel.emitChannelClose(this.channelId, code, reason);
    this.emit("close", code, reason);
  }

  ping() {
    if (this.readyState === NodeRelayChannelSocket.OPEN) this.channel.sendPing();
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const current = this.listeners.get(event) ?? new Set();
    current.add(listener);
    this.listeners.set(event, current);
    if (event === "message" && this.queued.length) {
      for (const item of this.queued.splice(0)) for (const callback of current) callback(item.raw, item.isBinary);
    }
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  /** Inbound frames wait in a small bounded queue until the tunnel attaches a listener. */
  deliver(raw: unknown, isBinary: boolean) {
    const listeners = this.listeners.get("message");
    if (listeners?.size) {
      for (const listener of [...listeners]) listener(raw, isBinary);
      return;
    }
    if (this.queued.length >= 256) {
      this.close(1011, "Cloud relay channel pending frame limit exceeded.");
      return;
    }
    this.queued.push({ raw, isBinary });
  }

  /** The session ended underneath us: nothing more can be sent or received. */
  remoteClosed(code: number, reason: string) {
    if (this.readyState === NodeRelayChannelSocket.CLOSED) return;
    this.readyState = NodeRelayChannelSocket.CLOSED;
    this.emit("close", code, reason);
  }
}

type PendingOpen = {
  resolve(socket: NodeRelayChannelSocket): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * The node end of one account relay channel. It owns the encrypted session and
 * its channel multiplexing (auxiliary streams, heartbeat) and delegates the
 * tunnel protocol itself to the shared session server, so the message set is
 * the same one the reverse-tunnel client serves.
 */
export class NodeRelayNodeChannel {
  private readonly options: {
    nodeId: string;
    pairing: { keyId: string; secret: string };
    host: NodeRelayTunnelHost;
    socket: NodeRelayFrameSocket;
    key: Uint8Array;
    onClosed(reason: string): void;
  };
  private readonly session: EncryptedNodeRelayChannel;
  private readonly mainSocket: NodeRelayChannelSocket;
  private readonly protocol: NodeTunnelSessionServer;
  private readonly aux = new Map<string, NodeRelayChannelSocket>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  private closed = false;
  private closedNotified = false;

  constructor(options: NodeRelayNodeChannel["options"]) {
    this.options = options;
    this.mainSocket = new NodeRelayChannelSocket(this, "main");
    this.session = new EncryptedNodeRelayChannel({
      socket: options.socket,
      key: options.key,
      sendDirection: NODE_RELAY_DIRECTION_NODE,
      receiveDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
      onMessage: (message) => this.handleMessage(message),
      onClosed: (reason) => this.finish(reason),
      onError: (error) => options.host.log.warn({ nodeId: options.nodeId, error: error.message }, "node agent cloud relay channel error"),
    });
    this.protocol = new NodeTunnelSessionServer({
      nodeId: options.nodeId,
      socket: this.mainSocket,
      host: options.host,
      openAuxSocket: (streamId) => this.openAuxChannel(streamId),
      buildLocalHeaders: (route, method, body, headers) => this.requestHeaders(route, method, body, headers),
      injectUrl: (route) => this.localNodeAgentHttpUrl(route).toString(),
      identifyOnOpen: false,
      rejectBinaryMainFrames: true,
      respondToUnsupportedMessages: true,
      labels: {
        topic: "cloud relay",
        displayName: "Cloud relay",
        injectFailureCode: "NODE_AGENT_CLOUD_RELAY_INJECT_FAILED",
      },
    });
  }

  get pairing() {
    return this.options.pairing;
  }

  get readyState() {
    return this.mainSocket.readyState;
  }

  start() {
    this.protocol.attach();
    this.session.start();
  }

  on(event: "pong", listener: () => void) {
    this.mainSocket.on(event, listener as (...args: unknown[]) => void);
  }

  sendPing() {
    if (this.closed) return;
    try {
      this.session.send({ type: "relay-ping" });
    } catch {
      // Racy close; the supervisor notices through the socket state.
    }
  }

  sendChannelData(channelId: string, data: string | Buffer, binary: boolean) {
    this.session.send(binary
      ? { type: "channel-data", channelId, data: Buffer.from(data as Buffer).toString("base64"), binary: true }
      : { type: "channel-data", channelId, data: String(data), binary: false });
  }

  private sendClose(channelId: string, code: number, reason: string) {
    if (this.closed) return;
    try {
      this.session.send({ type: "channel-close", channelId, code, reason: String(reason ?? "").slice(0, 512) });
    } catch {
      // The session may already be gone; local teardown still proceeds.
    }
  }

  emitChannelClose(channelId: string, code: number, reason: string) {
    if (channelId !== "main") {
      const socket = this.aux.get(channelId);
      if (!socket) return;
      this.aux.delete(channelId);
      this.sendClose(channelId, code, reason);
      socket.remoteClosed(code, reason);
      return;
    }
    this.close(reason || "closed");
  }

  close(reason = "normal") {
    if (this.closed) return;
    this.closed = true;
    this.protocol.dispose(reason);
    for (const pending of this.pendingOpens.values()) {
      clearTimeout(pending.timer);
      pending.reject(nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED"));
    }
    this.pendingOpens.clear();
    const aux = [...this.aux.values()];
    this.aux.clear();
    for (const socket of aux) socket.remoteClosed(1001, reason);
    this.mainSocket.remoteClosed(1001, reason);
    this.session.close(reason);
  }

  /** Dials one auxiliary channel back to the Control Plane and waits for its accept. */
  private openAuxChannel(channelId: string) {
    if (this.closed) return Promise.reject(nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED"));
    const existing = this.pendingOpens.get(channelId);
    if (existing) return Promise.reject(nodeRelaySessionError("NODE_RELAY_CHANNEL_DUPLICATE"));
    return new Promise<NodeRelayChannelSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOpens.delete(channelId);
        reject(nodeRelaySessionError("NODE_RELAY_CHANNEL_OPEN_TIMEOUT"));
      }, 15_000);
      timer.unref?.();
      this.pendingOpens.set(channelId, { resolve, reject, timer });
      try {
        this.session.send({ type: "channel-open", channelId });
      } catch (error) {
        clearTimeout(timer);
        this.pendingOpens.delete(channelId);
        reject(error instanceof Error ? error : nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED"));
      }
    });
  }

  private handleMessage(message: NodeRelaySessionMessage) {
    if (this.closed) return;
    if (message.type === "relay-ping") {
      this.session.send({ type: "relay-pong" });
      return;
    }
    if (message.type === "relay-pong") {
      this.mainSocket.emit("pong");
      return;
    }
    if (message.type === "channel-accept") {
      const pending = this.pendingOpens.get(message.channelId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingOpens.delete(message.channelId);
      const socket = new NodeRelayChannelSocket(this, message.channelId);
      this.aux.set(message.channelId, socket);
      pending.resolve(socket);
      return;
    }
    if (message.type === "channel-reject") {
      const pending = this.pendingOpens.get(message.channelId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingOpens.delete(message.channelId);
      pending.reject(nodeRelaySessionError(message.code || "NODE_RELAY_CHANNEL_REJECTED", message.message));
      return;
    }
    if (message.type === "channel-open") {
      // The Control Plane never dials auxiliary channels on a node channel; it
      // answers them. Reject anything else so a confused peer cannot wedge us.
      this.session.send({ type: "channel-reject", channelId: message.channelId, code: "NODE_RELAY_CHANNEL_UNSUPPORTED" });
      return;
    }
    if (message.type === "channel-data") {
      const target = message.channelId === "main" ? this.mainSocket : this.aux.get(message.channelId);
      if (!target) return;
      const binary = message.binary === true;
      target.deliver(binary ? Buffer.from(message.data, "base64") : message.data, binary);
      return;
    }
    if (message.type === "channel-close") {
      const target = message.channelId === "main" ? this.mainSocket : this.aux.get(message.channelId);
      if (!target) return;
      if (message.channelId !== "main") this.aux.delete(message.channelId);
      target.remoteClosed(message.code ?? 1000, message.reason ?? "closed");
      if (message.channelId === "main") this.close("remote-closed");
      return;
    }
  }

  private finish(reason: string) {
    if (!this.closed) this.close(reason);
    this.notifyClosed(reason);
  }

  private notifyClosed(reason: string) {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.options.onClosed(reason);
  }

  private localNodeAgentHttpUrl(route: string) {
    const path = route.startsWith("/") ? route : `/${route}`;
    return new URL(`/api/node-agent${path}`, `http://127.0.0.1:${this.options.host.currentListenerPort()}`);
  }

  private requestHeaders(route: string, method: string, body: string | Buffer | undefined, headers: Record<string, string> = {}) {
    const path = route.startsWith("/") ? route : `/${route}`;
    return {
      ...headers,
      ...createNodeAgentHmacHeaders({
        nodeId: this.options.nodeId,
        keyId: this.options.pairing.keyId,
        secret: this.options.pairing.secret,
        method,
        pathWithQuery: `/api/node-agent${path}`,
        body,
      }),
    };
  }
}
