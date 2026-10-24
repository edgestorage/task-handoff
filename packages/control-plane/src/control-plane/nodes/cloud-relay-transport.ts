import type { Node } from "@task-handoff/protocol/control-plane";
import {
  NODE_RELAY_MAIN_STREAM_ID,
  NODE_RELAY_STREAM_HIGH_WATER_BYTES,
  NODE_RELAY_STREAM_MAX_QUEUED_BYTES,
  type NodeRelayDataFrame,
  type NodeRelaySessionMessage,
} from "@task-handoff/protocol/node-relay-channel";
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
import type { NodeRelayTraceRecorder } from "../cloud-connectivity/node-relay-trace.ts";

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
  private readonly queued: Array<{ raw: unknown; isBinary: boolean; bytes: number }> = [];
  private queuedBytes = 0;
  private readonly outbound: Array<{ data: string | Buffer; binary: boolean; bytes: number }> = [];
  private outboundBytes = 0;
  private readonly writableWaiters: Array<() => void> = [];
  private paused = false;
  private remotePaused = false;
  private readonly channel: CloudRelayNodeChannel;
  readonly channelId: string;
  readonly streamId: number;

  constructor(channel: CloudRelayNodeChannel, channelId: string, streamId: number) {
    this.channel = channel;
    this.channelId = channelId;
    this.streamId = streamId;
  }

  send(data: string | Buffer, options?: { binary?: boolean }) {
    if (this.readyState !== MultiplexedNodeRelaySocket.OPEN) throw nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED");
    const binary = options?.binary ?? typeof data !== "string";
    const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    if (this.remotePaused) {
      if (this.outboundBytes + bytes > NODE_RELAY_STREAM_MAX_QUEUED_BYTES) {
        this.close(1013, "Node relay stream writer is too slow.");
        throw nodeRelaySessionError("NODE_RELAY_STREAM_WRITE_QUEUE_LIMIT");
      }
      this.outbound.push({ data, binary, bytes });
      this.outboundBytes += bytes;
      return;
    }
    // `ws` hands text frames to listeners as Buffers. Honour an explicit
    // `binary` flag first so bridged text frames stay text on the peer.
    this.channel.sendData(this.streamId, data, binary);
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
    if (event === "message") {
      // A listener may attach after the high-water mark paused the stream while
      // the tunnel socket was being constructed. Draining now closes that gap;
      // otherwise both peers wait on a resume that only this side can send.
      if (this.paused) this.resume();
      else this.flushInbound();
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
    if (this.readyState !== MultiplexedNodeRelaySocket.OPEN) return;
    const bytes = dataBytes(raw);
    if (!this.paused && this.listeners.get("message")?.size) {
      this.deliverNow(raw, isBinary);
      return;
    }
    if (this.queuedBytes + bytes > NODE_RELAY_STREAM_MAX_QUEUED_BYTES) {
      this.close(1013, "Node relay stream consumer is too slow.");
      return;
    }
    this.queued.push({ raw, isBinary, bytes });
    this.queuedBytes += bytes;
    if (!this.paused && this.queuedBytes >= NODE_RELAY_STREAM_HIGH_WATER_BYTES) this.pause();
  }

  pause() {
    if (this.paused || this.readyState !== MultiplexedNodeRelaySocket.OPEN) return;
    this.paused = true;
    this.channel.sendStreamPause(this.streamId);
  }

  resume() {
    if (!this.paused || this.readyState !== MultiplexedNodeRelaySocket.OPEN) return;
    this.paused = false;
    this.flushInbound();
    if (!this.paused) this.channel.sendStreamResume(this.streamId);
  }

  remotePause() {
    this.remotePaused = true;
  }

  remoteResume() {
    if (!this.remotePaused) return;
    this.remotePaused = false;
    this.flushOutbound();
    for (const resolve of this.writableWaiters.splice(0)) resolve();
  }

  async waitForWritable() {
    if (this.remotePaused || this.outbound.length) {
      await new Promise<void>((resolve) => this.writableWaiters.push(resolve));
    }
    await this.channel.waitForOutboundCapacity();
  }

  /** The session ended underneath us: nothing more can be sent or received. */
  remoteClosed(code: number, reason: string) {
    if (this.readyState === MultiplexedNodeRelaySocket.CLOSED) return;
    this.readyState = MultiplexedNodeRelaySocket.CLOSED;
    this.queued.length = 0;
    this.queuedBytes = 0;
    this.outbound.length = 0;
    this.outboundBytes = 0;
    for (const resolve of this.writableWaiters.splice(0)) resolve();
    this.emit("close", code, reason);
  }

  private deliverNow(raw: unknown, isBinary: boolean) {
    for (const listener of [...(this.listeners.get("message") ?? [])]) listener(raw, isBinary);
  }

  private flushInbound() {
    while (!this.paused && this.listeners.get("message")?.size && this.queued.length) {
      const item = this.queued.shift()!;
      this.queuedBytes -= item.bytes;
      this.deliverNow(item.raw, item.isBinary);
    }
  }

  private flushOutbound() {
    while (!this.remotePaused && this.outbound.length && this.readyState === MultiplexedNodeRelaySocket.OPEN) {
      const item = this.outbound.shift()!;
      this.outboundBytes -= item.bytes;
      try { this.channel.sendData(this.streamId, item.data, item.binary); }
      catch (error) {
        this.remoteClosed(1011, error instanceof Error ? error.message : "Node relay stream write failed.");
        return;
      }
    }
  }
}

function dataBytes(value: unknown) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Buffer.byteLength(String(value), "utf8");
}

class CloudRelayNodeChannel {
  readonly mainSocket: MultiplexedNodeRelaySocket;
  private readonly session: EncryptedNodeRelayChannel;
  private readonly ingress: NodeTunnelIngress;
  private readonly nodeId: string;
  private readonly trace?: NodeRelayTraceRecorder;
  private readonly nodeHandle?: string;
  private readonly relayChannelId?: string;
  private readonly aux = new Map<string, MultiplexedNodeRelaySocket>();
  private readonly auxByStreamId = new Map<number, MultiplexedNodeRelaySocket>();
  private readonly onClosed: (reason: string) => void;
  private closed = false;

  constructor(options: { nodeId: string; socket: NodeRelayFrameSocket; key: Uint8Array; ingress: NodeTunnelIngress; onClosed(reason: string): void; trace?: NodeRelayTraceRecorder; nodeHandle?: string; relayChannelId?: string }) {
    this.nodeId = options.nodeId;
    this.ingress = options.ingress;
    this.onClosed = options.onClosed;
    this.trace = options.trace;
    this.nodeHandle = options.nodeHandle;
    this.relayChannelId = options.relayChannelId;
    this.mainSocket = new MultiplexedNodeRelaySocket(this, "main", NODE_RELAY_MAIN_STREAM_ID);
    this.session = new EncryptedNodeRelayChannel({
      socket: options.socket,
      key: options.key,
      sendDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
      receiveDirection: NODE_RELAY_DIRECTION_NODE,
      onMessage: (message) => this.handleMessage(message),
      onData: (frame) => this.handleData(frame),
      onClosed: (reason) => this.finish(reason),
      onTrace: (event) => this.trace?.record({
        channelId: this.relayChannelId ?? this.nodeId,
        nodeId: this.nodeId,
        ...(this.nodeHandle ? { nodeHandle: this.nodeHandle } : {}),
        ...(this.relayChannelId ? { relayChannelId: this.relayChannelId } : {}),
        ...event,
      }),
    });
  }

  start() {
    this.session.start();
    this.ingress.attachMain(this.nodeId, this.mainSocket);
  }

  sendData(streamId: number, data: string | Buffer, binary: boolean) {
    this.session.sendData(streamId, data, binary);
  }

  waitForOutboundCapacity() {
    return this.session.waitForOutboundCapacity();
  }

  sendStreamPause(streamId: number) {
    if (this.closed) return;
    try { this.session.send({ type: "stream-pause", streamId }); }
    catch { /* a closing channel has no reader left to pause */ }
  }

  sendStreamResume(streamId: number) {
    if (this.closed) return;
    try { this.session.send({ type: "stream-resume", streamId }); }
    catch { /* a closing channel has no reader left to resume */ }
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
      this.session.discardDataAssembly(socket.streamId);
      this.aux.delete(channelId);
      this.auxByStreamId.delete(socket.streamId);
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
    this.auxByStreamId.clear();
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
      if (message.channelId === "main" || this.aux.has(message.channelId) || this.auxByStreamId.has(message.streamId)) {
        this.session.send({ type: "channel-reject", channelId: message.channelId, code: "NODE_RELAY_CHANNEL_DUPLICATE" });
        return;
      }
      const socket = new MultiplexedNodeRelaySocket(this, message.channelId, message.streamId);
      this.aux.set(message.channelId, socket);
      this.auxByStreamId.set(message.streamId, socket);
      if (!this.ingress.attachAuxiliary(this.nodeId, message.channelId, socket)) {
        this.aux.delete(message.channelId);
        this.auxByStreamId.delete(message.streamId);
        this.sendClose(message.channelId, 1008, "Unknown reverse tunnel channel.");
        return;
      }
      // Attach first: the peer opens optimistically and may already be
      // producing response data by the time this accept reaches it.
      this.session.send({ type: "channel-accept", channelId: message.channelId, streamId: message.streamId });
      return;
    }
    if (message.type === "channel-close") {
      const target = message.channelId === "main" ? this.mainSocket : this.aux.get(message.channelId);
      if (!target) return;
      this.session.discardDataAssembly(target.streamId);
      if (message.channelId !== "main") {
        this.aux.delete(message.channelId);
        this.auxByStreamId.delete(target.streamId);
      }
      target.remoteClosed(message.code ?? 1000, message.reason ?? "closed");
      if (message.channelId === "main") this.close("remote-closed");
      return;
    }
    if (message.type === "stream-pause") {
      const target = message.streamId === NODE_RELAY_MAIN_STREAM_ID ? this.mainSocket : this.auxByStreamId.get(message.streamId);
      target?.remotePause();
      return;
    }
    if (message.type === "stream-resume") {
      const target = message.streamId === NODE_RELAY_MAIN_STREAM_ID ? this.mainSocket : this.auxByStreamId.get(message.streamId);
      target?.remoteResume();
      return;
    }
    if (message.type === "channel-accept" || message.type === "channel-reject") {
      throw nodeRelaySessionError("NODE_RELAY_SESSION_MESSAGE_UNSUPPORTED");
    }
  }

  private handleData(frame: NodeRelayDataFrame) {
    if (this.closed) return;
    const target = frame.streamId === NODE_RELAY_MAIN_STREAM_ID ? this.mainSocket : this.auxByStreamId.get(frame.streamId);
    if (!target) return;
    const bytes = Buffer.isBuffer(frame.data)
      ? frame.data
      : Buffer.from(frame.data.buffer as ArrayBuffer, frame.data.byteOffset, frame.data.byteLength);
    target.deliver(frame.binary ? bytes : bytes.toString("utf8"), frame.binary);
  }

  private finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    const aux = [...this.aux.values()];
    this.aux.clear();
    this.auxByStreamId.clear();
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
  private readonly trace?: NodeRelayTraceRecorder;
  private readonly channels = new Map<string, CloudRelayNodeChannel>();

  constructor(options: { tunnel: ControlPlaneNodeAgentTunnelTransport; onIdentified?: (nodeId: string) => void | Promise<void>; trace?: NodeRelayTraceRecorder }) {
    this.tunnel = options.tunnel;
    this.ingress = new NodeTunnelIngress(options.tunnel, { onIdentified: options.onIdentified });
    this.trace = options.trace;
  }

  attachNode(nodeId: string, input: { socket: NodeRelayFrameSocket; key: Uint8Array; onClosed?(reason: string): void; nodeHandle?: string; relayChannelId?: string }) {
    const existing = this.channels.get(nodeId);
    existing?.close("replaced-by-new-channel");
    const channel = new CloudRelayNodeChannel({
      nodeId,
      socket: input.socket,
      key: input.key,
      ingress: this.ingress,
      trace: this.trace,
      nodeHandle: input.nodeHandle,
      relayChannelId: input.relayChannelId,
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
