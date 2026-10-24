import {
  NODE_RELAY_MAIN_STREAM_ID,
  NODE_RELAY_STREAM_HIGH_WATER_BYTES,
  NODE_RELAY_STREAM_MAX_QUEUED_BYTES,
  type NodeRelayDataFrame,
  type NodeRelaySessionMessage,
} from "@task-handoff/protocol/node-relay-channel";
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
  private readonly queued: Array<{ raw: unknown; isBinary: boolean; bytes: number }> = [];
  private queuedBytes = 0;
  private readonly outbound: Array<{ data: string | Buffer; binary: boolean; bytes: number }> = [];
  private outboundBytes = 0;
  private readonly writableWaiters: Array<() => void> = [];
  private paused = false;
  private remotePaused = false;
  private readonly channel: NodeRelayNodeChannel;
  readonly channelId: string;
  readonly streamId: number;

  constructor(channel: NodeRelayNodeChannel, channelId: string, streamId: number) {
    this.channel = channel;
    this.channelId = channelId;
    this.streamId = streamId;
  }

  send(data: string | Buffer, options?: { binary?: boolean }) {
    if (this.readyState !== NodeRelayChannelSocket.OPEN) throw nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED");
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
    this.channel.sendChannelData(this.streamId, data, binary);
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
    if (this.readyState !== NodeRelayChannelSocket.OPEN) return;
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
    if (this.paused || this.readyState !== NodeRelayChannelSocket.OPEN) return;
    this.paused = true;
    this.channel.sendStreamPause(this.streamId);
  }

  resume() {
    if (!this.paused || this.readyState !== NodeRelayChannelSocket.OPEN) return;
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
    if (this.readyState === NodeRelayChannelSocket.CLOSED) return;
    this.readyState = NodeRelayChannelSocket.CLOSED;
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
    while (!this.remotePaused && this.outbound.length && this.readyState === NodeRelayChannelSocket.OPEN) {
      const item = this.outbound.shift()!;
      this.outboundBytes -= item.bytes;
      try { this.channel.sendChannelData(this.streamId, item.data, item.binary); }
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

type PendingOpen = {
  streamId: number;
  socket: NodeRelayChannelSocket;
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
  private readonly auxByStreamId = new Map<number, NodeRelayChannelSocket>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  private nextAuxStreamId = 1;
  private closed = false;
  private closedNotified = false;

  constructor(options: NodeRelayNodeChannel["options"]) {
    this.options = options;
    this.mainSocket = new NodeRelayChannelSocket(this, "main", NODE_RELAY_MAIN_STREAM_ID);
    this.session = new EncryptedNodeRelayChannel({
      socket: options.socket,
      key: options.key,
      sendDirection: NODE_RELAY_DIRECTION_NODE,
      receiveDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
      onMessage: (message) => this.handleMessage(message),
      onData: (frame) => this.handleData(frame),
      onClosed: (reason) => this.finish(reason),
      onError: (error) => options.host.log.warn({
        nodeId: options.nodeId,
        code: (error as { code?: unknown }).code,
        error: error.message,
      }, "node agent cloud relay channel error"),
    });
    this.protocol = new NodeTunnelSessionServer({
      nodeId: options.nodeId,
      socket: this.mainSocket,
      host: options.host,
      openAuxSocket: (streamId) => this.openAuxChannel(streamId),
      buildLocalHeaders: (route, method, body, headers) => this.requestHeaders(route, method, body, headers),
      injectUrl: (route) => this.localNodeAgentHttpUrl(route).toString(),
      sendFrame: async (socket, data, binary) => {
        await (socket as NodeRelayChannelSocket & { waitForWritable?(): Promise<void> }).waitForWritable?.();
        socket.send(data, { binary });
      },
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

  sendChannelData(streamId: number, data: string | Buffer, binary: boolean) {
    this.session.sendData(streamId, data, binary);
  }

  waitForOutboundCapacity() {
    return this.session.waitForOutboundCapacity();
  }

  sendStreamPause(streamId: number) {
    if (this.closed) return;
    try { this.session.send({ type: "stream-pause", streamId }); }
    catch { /* the session may already be gone */ }
  }

  sendStreamResume(streamId: number) {
    if (this.closed) return;
    try { this.session.send({ type: "stream-resume", streamId }); }
    catch { /* the session may already be gone */ }
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
      const pending = this.pendingOpens.get(channelId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingOpens.delete(channelId);
      }
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
    this.protocol.dispose(reason);
    for (const pending of this.pendingOpens.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingOpens.clear();
    const aux = [...this.aux.values()];
    this.aux.clear();
    this.auxByStreamId.clear();
    for (const socket of aux) socket.remoteClosed(1001, reason);
    this.mainSocket.remoteClosed(1001, reason);
    this.session.close(reason);
  }

  /**
   * Dials one auxiliary channel back to the Control Plane. The local socket is
   * usable immediately: the Control Plane creates its peer synchronously when
   * it receives `channel-open`, and Relay frames are ordered. This hides the
   * open/accept round trip behind the local HTTP or WebSocket handshake instead
   * of adding it to every proxied request. `channel-accept` still confirms the
   * stream, while `channel-reject` tears the optimistic socket down.
   */
  private openAuxChannel(channelId: string) {
    if (this.closed) return Promise.reject(nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED"));
    if (this.pendingOpens.has(channelId) || this.aux.has(channelId)) return Promise.reject(nodeRelaySessionError("NODE_RELAY_CHANNEL_DUPLICATE"));
    if (this.nextAuxStreamId > 0xffff_ffff) return Promise.reject(nodeRelaySessionError("NODE_RELAY_STREAM_ID_EXHAUSTED"));
    const streamId = this.nextAuxStreamId++;
    const socket = new NodeRelayChannelSocket(this, channelId, streamId);
    const timer = setTimeout(() => {
      const pending = this.pendingOpens.get(channelId);
      if (!pending) return;
      this.pendingOpens.delete(channelId);
      socket.close(1011, "Node relay channel open timed out.");
    }, 15_000);
    timer.unref?.();
    this.pendingOpens.set(channelId, { streamId, socket, timer });
    this.aux.set(channelId, socket);
    this.auxByStreamId.set(streamId, socket);
    try {
      this.session.send({ type: "channel-open", channelId, streamId });
    } catch (error) {
      clearTimeout(timer);
      this.pendingOpens.delete(channelId);
      this.removeAux(channelId, socket);
      socket.remoteClosed(1011, "Node relay channel open failed.");
      return Promise.reject(error instanceof Error ? error : nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED"));
    }
    return Promise.resolve(socket);
  }

  private removeAux(channelId: string, socket: NodeRelayChannelSocket) {
    this.session.discardDataAssembly(socket.streamId);
    if (this.aux.get(channelId) === socket) this.aux.delete(channelId);
    if (this.auxByStreamId.get(socket.streamId) === socket) this.auxByStreamId.delete(socket.streamId);
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
      if (pending.streamId !== message.streamId || this.auxByStreamId.get(message.streamId) !== pending.socket) {
        throw nodeRelaySessionError("NODE_RELAY_STREAM_ID_MISMATCH");
      }
      clearTimeout(pending.timer);
      this.pendingOpens.delete(message.channelId);
      return;
    }
    if (message.type === "channel-reject") {
      const pending = this.pendingOpens.get(message.channelId);
      const socket = pending?.socket ?? this.aux.get(message.channelId);
      if (!pending || !socket) return;
      clearTimeout(pending.timer);
      this.pendingOpens.delete(message.channelId);
      this.removeAux(message.channelId, socket);
      socket.remoteClosed(1011, message.message || message.code || "Control Plane rejected the node relay channel.");
      return;
    }
    if (message.type === "channel-open") {
      // The Control Plane never dials auxiliary channels on a node channel; it
      // answers them. Reject anything else so a confused peer cannot wedge us.
      this.session.send({ type: "channel-reject", channelId: message.channelId, code: "NODE_RELAY_CHANNEL_UNSUPPORTED" });
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
