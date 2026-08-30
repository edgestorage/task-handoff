import net from "node:net";
import {
  BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_TUNNEL_MAX_DATA_BYTES,
  BROWSER_TUNNEL_MAX_WINDOW_BYTES,
  BrowserTunnelFrameType,
  BrowserTunnelHelloSchema,
  decodeBrowserTunnelFrame,
  decodeBrowserTunnelOpen,
  decodeBrowserTunnelWindowUpdate,
  encodeBrowserTunnelError,
  encodeBrowserTunnelFrame,
  encodeBrowserTunnelReady,
  encodeBrowserTunnelWindowUpdate,
  type BrowserTunnelErrorPayload,
} from "@task-handoff/protocol/browser-tunnel";

export const BROWSER_TUNNEL_MAX_STREAMS = 128;
export const BROWSER_TUNNEL_MAX_QUEUED_BYTES_PER_STREAM = 1024 * 1024;
export const BROWSER_TUNNEL_MAX_CHANNEL_BUFFERED_BYTES = 16 * 1024 * 1024;
export const BROWSER_TUNNEL_CONNECT_TIMEOUT_MS = 10_000;
export const BROWSER_TUNNEL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

type BrowserTunnelWebSocket = {
  OPEN: number;
  readyState: number;
  bufferedAmount?: number;
  send(data: unknown, options?: { binary?: boolean; compress?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: (...args: any[]) => void): void;
};

type BrowserTunnelStream = {
  id: number;
  socket: net.Socket;
  state: "connecting" | "open" | "closed";
  receiveCredit: number;
  sendCredit: number;
  queued: Buffer[];
  queuedBytes: number;
  lastActivityAt: number;
  connectTimer?: NodeJS.Timeout;
};

export type BrowserTunnelRuntimeOptions = {
  connect?: (port: number, host: string) => net.Socket;
  maxStreams?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
};

export function attachBrowserTunnel(socket: BrowserTunnelWebSocket, options: BrowserTunnelRuntimeOptions = {}) {
  const connect = options.connect || ((port: number, host: string) => net.connect(port, host));
  const maxStreams = options.maxStreams || BROWSER_TUNNEL_MAX_STREAMS;
  const connectTimeoutMs = options.connectTimeoutMs || BROWSER_TUNNEL_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs || BROWSER_TUNNEL_IDLE_TIMEOUT_MS;
  const now = options.now || Date.now;
  const streams = new Map<number, BrowserTunnelStream>();
  let ready = false;
  let closed = false;
  let peerInitialWindow = BROWSER_TUNNEL_INITIAL_WINDOW_BYTES;

  const send = (data: string | Buffer, binary = Buffer.isBuffer(data)) => {
    if (closed || socket.readyState !== socket.OPEN) return false;
    if ((socket.bufferedAmount || 0) + Buffer.byteLength(data) > BROWSER_TUNNEL_MAX_CHANNEL_BUFFERED_BYTES) {
      closeChannel(1013, "Browser tunnel consumer is too slow.");
      return false;
    }
    socket.send(data, { binary, compress: false });
    return true;
  };

  const sendFrame = (type: number, streamId: number, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)) => send(encodeBrowserTunnelFrame({
    type: type as typeof BrowserTunnelFrameType[keyof typeof BrowserTunnelFrameType],
    streamId,
    payload,
  }));

  const removeStream = (stream: BrowserTunnelStream, destroy = true) => {
    if (stream.state === "closed") return;
    stream.state = "closed";
    streams.delete(stream.id);
    if (stream.connectTimer) clearTimeout(stream.connectTimer);
    stream.queued.length = 0;
    stream.queuedBytes = 0;
    if (destroy && !stream.socket.destroyed) stream.socket.destroy();
  };

  const streamError = (stream: BrowserTunnelStream, error: BrowserTunnelErrorPayload) => {
    send(encodeBrowserTunnelError(stream.id, error));
    removeStream(stream);
  };

  const closeChannel = (code = 1000, reason = "Browser tunnel closed.") => {
    if (closed) return;
    closed = true;
    clearInterval(idleTimer);
    for (const stream of streams.values()) removeStream(stream);
    streams.clear();
    try { socket.close(code, reason); } catch { /* The socket is already unusable. */ }
  };

  const flushTargetData = (stream: BrowserTunnelStream) => {
    while (stream.state === "open" && stream.sendCredit > 0 && stream.queued.length) {
      const current = stream.queued[0];
      const bytes = Math.min(current.byteLength, stream.sendCredit, BROWSER_TUNNEL_MAX_DATA_BYTES);
      const chunk = current.subarray(0, bytes);
      if (!sendFrame(BrowserTunnelFrameType.Data, stream.id, chunk)) return;
      stream.sendCredit -= bytes;
      stream.queuedBytes -= bytes;
      stream.lastActivityAt = now();
      if (bytes === current.byteLength) stream.queued.shift();
      else stream.queued[0] = current.subarray(bytes);
    }
    if (!stream.queued.length && stream.state === "open") stream.socket.resume();
  };

  const openStream = (streamId: number, payload: ReturnType<typeof decodeBrowserTunnelOpen>) => {
    if (streams.has(streamId)) {
      send(encodeBrowserTunnelError(streamId, { code: "BROWSER_TUNNEL_PROTOCOL_ERROR", message: "Stream id is already open." }));
      return;
    }
    if (streams.size >= maxStreams) {
      send(encodeBrowserTunnelError(streamId, { code: "BROWSER_TUNNEL_STREAM_LIMIT", message: "Browser tunnel stream limit reached." }));
      return;
    }
    const loopbackAlias = /^127-(\d{1,3})-(\d{1,3})-(\d{1,3})\.internal$/.exec(payload.host);
    const targetHost = loopbackAlias && loopbackAlias.slice(1).every((part) => Number(part) <= 255)
      ? `127.${loopbackAlias[1]}.${loopbackAlias[2]}.${loopbackAlias[3]}`
      : payload.host;
    const target = connect(payload.port, targetHost);
    const stream: BrowserTunnelStream = {
      id: streamId,
      socket: target,
      state: "connecting",
      receiveCredit: BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
      sendCredit: peerInitialWindow,
      queued: [],
      queuedBytes: 0,
      lastActivityAt: now(),
    };
    streams.set(streamId, stream);
    stream.connectTimer = setTimeout(() => streamError(stream, {
      code: "BROWSER_TUNNEL_CONNECT_TIMEOUT",
      message: "Target connection timed out.",
    }), connectTimeoutMs);
    stream.connectTimer.unref?.();
    target.pause();
    target.once("connect", () => {
      if (stream.state !== "connecting") return;
      if (stream.connectTimer) clearTimeout(stream.connectTimer);
      stream.connectTimer = undefined;
      stream.state = "open";
      stream.lastActivityAt = now();
      sendFrame(BrowserTunnelFrameType.OpenOk, stream.id);
      target.resume();
    });
    target.on("data", (chunk: Buffer) => {
      if (stream.state !== "open") return;
      target.pause();
      stream.queued.push(Buffer.from(chunk));
      stream.queuedBytes += chunk.byteLength;
      stream.lastActivityAt = now();
      if (stream.queuedBytes > BROWSER_TUNNEL_MAX_QUEUED_BYTES_PER_STREAM) {
        streamError(stream, { code: "BROWSER_TUNNEL_FLOW_CONTROL", message: "Target produced data faster than the browser consumed it." });
        return;
      }
      flushTargetData(stream);
    });
    target.on("end", () => {
      if (stream.state !== "closed") sendFrame(BrowserTunnelFrameType.HalfClose, stream.id);
    });
    target.on("error", () => {
      if (stream.state === "closed") return;
      streamError(stream, { code: "BROWSER_TUNNEL_CONNECT_FAILED", message: "Target connection failed." });
    });
    target.on("close", () => {
      if (stream.state === "closed") return;
      sendFrame(BrowserTunnelFrameType.Close, stream.id);
      removeStream(stream, false);
    });
  };

  const handleFrame = (data: Buffer | ArrayBuffer | ArrayBufferView) => {
    const frame = decodeBrowserTunnelFrame(data);
    if (frame.type === BrowserTunnelFrameType.Open) {
      openStream(frame.streamId, decodeBrowserTunnelOpen(frame));
      return;
    }
    const stream = streams.get(frame.streamId);
    if (!stream) {
      if (frame.type !== BrowserTunnelFrameType.Close) send(encodeBrowserTunnelError(frame.streamId, { code: "BROWSER_TUNNEL_CLOSED", message: "Browser tunnel stream is closed." }));
      return;
    }
    stream.lastActivityAt = now();
    if (frame.type === BrowserTunnelFrameType.Data) {
      if (stream.state !== "open" || frame.payload.byteLength > stream.receiveCredit) {
        streamError(stream, { code: "BROWSER_TUNNEL_FLOW_CONTROL", message: "Browser tunnel receive window exceeded." });
        return;
      }
      stream.receiveCredit -= frame.payload.byteLength;
      const bytes = frame.payload.byteLength;
      stream.socket.write(frame.payload, () => {
        if (stream.state === "closed") return;
        stream.receiveCredit = Math.min(BROWSER_TUNNEL_INITIAL_WINDOW_BYTES, stream.receiveCredit + bytes);
        send(encodeBrowserTunnelWindowUpdate(stream.id, bytes));
      });
      return;
    }
    if (frame.type === BrowserTunnelFrameType.WindowUpdate) {
      const bytes = decodeBrowserTunnelWindowUpdate(frame);
      if (stream.sendCredit + bytes > BROWSER_TUNNEL_MAX_WINDOW_BYTES) {
        streamError(stream, { code: "BROWSER_TUNNEL_FLOW_CONTROL", message: "Browser tunnel send window exceeded." });
        return;
      }
      stream.sendCredit += bytes;
      flushTargetData(stream);
      return;
    }
    if (frame.type === BrowserTunnelFrameType.HalfClose) {
      stream.socket.end();
      return;
    }
    if (frame.type === BrowserTunnelFrameType.Close || frame.type === BrowserTunnelFrameType.Error) removeStream(stream);
  };

  const idleTimer = setInterval(() => {
    const cutoff = now() - idleTimeoutMs;
    for (const stream of streams.values()) {
      if (stream.lastActivityAt >= cutoff) continue;
      send(encodeBrowserTunnelError(stream.id, { code: "BROWSER_TUNNEL_IDLE_TIMEOUT", message: "Browser tunnel stream was idle for too long." }));
      removeStream(stream);
    }
  }, Math.min(30_000, Math.max(1000, idleTimeoutMs)));
  idleTimer.unref?.();

  socket.on("message", (message: unknown, isBinary = false) => {
    try {
      if (!ready) {
        // A transparent relay may preserve the payload as a Buffer while losing
        // the original text opcode. Handshake control frames are self-describing.
        const hello = BrowserTunnelHelloSchema.parse(JSON.parse(Buffer.isBuffer(message) ? message.toString("utf8") : String(message)));
        peerInitialWindow = hello.initialWindowBytes;
        ready = true;
        send(encodeBrowserTunnelReady(), false);
        return;
      }
      if (!isBinary) throw new Error("Browser tunnel frames must be binary.");
      handleFrame(Buffer.isBuffer(message) ? message : message as ArrayBuffer | ArrayBufferView);
    } catch {
      closeChannel(1002, "Browser tunnel protocol error.");
    }
  });
  socket.on("close", () => closeChannel());
  socket.on("error", () => closeChannel(1011, "Browser tunnel transport failed."));

  return { close: closeChannel, streamCount: () => streams.size };
}
