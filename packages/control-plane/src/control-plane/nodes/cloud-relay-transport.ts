import type { Node } from "@task-handoff/protocol/control-plane";
import type { NodeRelaySessionMessage } from "@task-handoff/protocol/node-relay-channel";
import type { NodeAgentTransport, NodeAgentWebSocket, NodeAgentWebSocketControl } from "./client.ts";
import { NodeTunnelIngress, type NodeAgentTunnelSocket } from "./tunnel-ingress.ts";
import type { ControlPlaneNodeAgentTunnelTransport } from "./tunnel.ts";
import {
  EncryptedNodeRelayChannel,
  NODE_RELAY_DIRECTION_CONTROL_PLANE,
  NODE_RELAY_DIRECTION_NODE,
  nodeRelaySessionError,
  type NodeRelayFrameSocket,
} from "../../shared/cloud-relay/node-relay-session.ts";

/**
 * A ws-like socket whose frames ride one multiplexed relay node channel. The
 * tunnel protocol (main socket and every auxiliary stream) is reused verbatim:
 * the node agent "dials back" by opening a channel id, and the Control Plane
 * attaches it to the pending tunnel channel exactly as it would attach an
 * incoming reverse-tunnel WebSocket.
 */
export class MultiplexedNodeRelaySocket implements NodeAgentTunnelSocket {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = MultiplexedNodeRelaySocket.OPEN;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private readonly queued: Array<{ raw: unknown; isBinary: boolean }> = [];
  private readonly channel: CloudRelayNodeChannel;
  readonly channelId: string;

  constructor(channel: CloudRelayNodeChannel, channelId: string) {
    this.channel = channel;
    this.channelId = channelId;
  }

  send(data: string | Buffer, options?: { binary?: boolean }) {
    if (this.readyState !== MultiplexedNodeRelaySocket.OPEN) throw nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED");
    // `ws` hands text frames to listeners as Buffers. Honour an explicit
    // `binary` flag first so bridged text frames stay text on the peer.
    this.channel.sendData(this.channelId, data, options?.binary ?? typeof data !== "string");
  }

  close(code = 1000, reason = "normal") {
    if (this.readyState === MultiplexedNodeRelaySocket.CLOSED) return;
    this.readyState = MultiplexedNodeRelaySocket.CLOSED;
    this.channel.emitChannelClose(this.channelId, code, reason);
    this.emit("close", code, reason);
  }

  ping() {
    if (this.readyState === MultiplexedNodeRelaySocket.OPEN) this.channel.sendPing();
  }

  terminate() {
    this.close(1011, "terminated");
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
      this.close(1011, "Multiplexed channel pending frame limit exceeded.");
      return;
    }
    this.queued.push({ raw, isBinary });
  }

  /** The session ended underneath us: nothing more can be sent or received. */
  remoteClosed(code: number, reason: string) {
    if (this.readyState === MultiplexedNodeRelaySocket.CLOSED) return;
    this.readyState = MultiplexedNodeRelaySocket.CLOSED;
    this.emit("close", code, reason);
  }

  pause() {}
  resume() {}
}

class CloudRelayNodeChannel {
  readonly mainSocket: MultiplexedNodeRelaySocket;
  private readonly session: EncryptedNodeRelayChannel;
  private readonly ingress: NodeTunnelIngress;
  private readonly nodeId: string;
  private readonly aux = new Map<string, MultiplexedNodeRelaySocket>();
  private readonly onClosed: (reason: string) => void;
  private closed = false;

  constructor(options: { nodeId: string; socket: NodeRelayFrameSocket; key: Uint8Array; ingress: NodeTunnelIngress; onClosed(reason: string): void }) {
    this.nodeId = options.nodeId;
    this.ingress = options.ingress;
    this.onClosed = options.onClosed;
    this.mainSocket = new MultiplexedNodeRelaySocket(this, "main");
    this.session = new EncryptedNodeRelayChannel({
      socket: options.socket,
      key: options.key,
      sendDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
      receiveDirection: NODE_RELAY_DIRECTION_NODE,
      onMessage: (message) => this.handleMessage(message),
      onClosed: (reason) => this.finish(reason),
    });
  }

  start() {
    this.session.start();
    this.ingress.attachMain(this.nodeId, this.mainSocket);
  }

  sendData(channelId: string, data: string | Buffer, binary: boolean) {
    this.session.send(binary || typeof data !== "string"
      ? { type: "channel-data", channelId, data: Buffer.from(data as Buffer).toString("base64"), binary: true }
      : { type: "channel-data", channelId, data, binary: false });
  }

  sendClose(channelId: string, code: number, reason: string) {
    if (this.closed) return;
    try {
      this.session.send({ type: "channel-close", channelId, code, reason: String(reason ?? "").slice(0, 512) });
    } catch {
      // The session may already be closed; local teardown still proceeds.
    }
  }

  sendPing() {
    if (this.closed) return;
    try {
      this.session.send({ type: "relay-ping" });
    } catch {
      // Racy close; the supervisor will notice through the socket state.
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
    const aux = [...this.aux.values()];
    this.aux.clear();
    for (const socket of aux) socket.remoteClosed(1001, reason);
    this.mainSocket.remoteClosed(1001, reason);
    this.session.close(reason);
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
    if (message.type === "channel-open") {
      if (message.channelId === "main" || this.aux.has(message.channelId)) {
        this.session.send({ type: "channel-reject", channelId: message.channelId, code: "NODE_RELAY_CHANNEL_DUPLICATE" });
        return;
      }
      const socket = new MultiplexedNodeRelaySocket(this, message.channelId);
      this.aux.set(message.channelId, socket);
      this.session.send({ type: "channel-accept", channelId: message.channelId });
      if (!this.ingress.attachAuxiliary(this.nodeId, message.channelId, socket)) {
        this.aux.delete(message.channelId);
        this.sendClose(message.channelId, 1008, "Unknown reverse tunnel channel.");
      }
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
    if (message.type === "channel-accept" || message.type === "channel-reject") {
      throw nodeRelaySessionError("NODE_RELAY_SESSION_MESSAGE_UNSUPPORTED");
    }
  }

  private finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    const aux = [...this.aux.values()];
    this.aux.clear();
    for (const socket of aux) socket.remoteClosed(1001, reason);
    this.mainSocket.remoteClosed(1001, reason);
    this.onClosed(reason);
  }
}

/**
 * Resolver-facing transport for `cloud-relay` nodes. All three capabilities
 * delegate to the shared tunnel transport, so business code keeps seeing the
 * same `NodeAgentTransport` surface as reverse-wss.
 */
export class CloudRelayNodeAgentTransport implements NodeAgentTransport {
  private readonly tunnel: ControlPlaneNodeAgentTunnelTransport;
  private readonly ingress: NodeTunnelIngress;
  private readonly channels = new Map<string, CloudRelayNodeChannel>();

  constructor(options: { tunnel: ControlPlaneNodeAgentTunnelTransport; onIdentified?: (nodeId: string) => void | Promise<void> }) {
    this.tunnel = options.tunnel;
    this.ingress = new NodeTunnelIngress(options.tunnel, { onIdentified: options.onIdentified });
  }

  attachNode(nodeId: string, input: { socket: NodeRelayFrameSocket; key: Uint8Array; onClosed?(reason: string): void }) {
    const existing = this.channels.get(nodeId);
    existing?.close("replaced-by-new-channel");
    const channel = new CloudRelayNodeChannel({
      nodeId,
      socket: input.socket,
      key: input.key,
      ingress: this.ingress,
      onClosed: (reason) => {
        if (this.channels.get(nodeId) === channel) this.channels.delete(nodeId);
        this.tunnel.disconnect(nodeId, `Cloud relay channel closed: ${reason}`);
        input.onClosed?.(reason);
      },
    });
    this.channels.set(nodeId, channel);
    channel.start();
    return channel;
  }

  detachNode(nodeId: string, reason = "cloud-relay-disabled") {
    const channel = this.channels.get(nodeId);
    if (!channel) return false;
    this.channels.delete(nodeId);
    channel.close(reason);
    this.tunnel.disconnect(nodeId, reason);
    return true;
  }

  connected(nodeId: string) {
    return this.channels.has(nodeId);
  }

  request(node: Node, route: string, init?: RequestInit) {
    return this.tunnel.request(node, route, init);
  }

  requestStream(node: Node, route: string, init?: RequestInit) {
    return this.tunnel.requestStream(node, route, init);
  }

  proxyWebSocket(node: Node, socket: NodeAgentWebSocket, route: string, protocols?: string | string[], headers?: Record<string, string>): NodeAgentWebSocketControl | void {
    return this.tunnel.proxyWebSocket(node, socket, route, protocols, headers);
  }
}
