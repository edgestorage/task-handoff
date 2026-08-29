const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
  BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_TUNNEL_MAX_CHANNEL_BUFFERED_BYTES = 16 * 1024 * 1024,
  BROWSER_TUNNEL_MAX_DATA_BYTES,
  BROWSER_TUNNEL_MAX_WINDOW_BYTES,
  BrowserTunnelFrameType,
  BrowserTunnelReadySchema,
  decodeBrowserTunnelError,
  decodeBrowserTunnelFrame,
  decodeBrowserTunnelWindowUpdate,
  encodeBrowserTunnelFrame,
  encodeBrowserTunnelHello,
  encodeBrowserTunnelOpen,
  encodeBrowserTunnelWindowUpdate,
} = loadBrowserTunnelProtocol();

function loadBrowserTunnelProtocol() {
  try {
    return require(path.resolve(__dirname, "../../../dist/browser-tunnel.js"));
  } catch {
    return require("@task-handoff/protocol/browser-tunnel");
  }
}

class BrowserTunnelChannel extends EventEmitter {
  constructor(options) {
    super();
    this.url = options.url;
    this.token = options.token;
    this.WebSocket = options.WebSocket;
    this.logInfo = options.logInfo || (() => undefined);
    this.logError = options.logError || (() => undefined);
    this.streams = new Map();
    this.nextStreamId = 1;
    this.state = "connecting";
    this.socket = undefined;
  }

  connect() {
    if (this.socket) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      let handshakeTimer;
      const fail = (error) => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        this.logError(`[desktop-shell] browser tunnel ${this.state} failure: ${error instanceof Error ? error.message : String(error)}`);
        if (this.state === "connecting") reject(error instanceof Error ? error : new Error("Browser relay connection failed."));
        this.close(error);
      };
      handshakeTimer = setTimeout(() => fail(Object.assign(new Error("Browser relay handshake timed out."), { code: "BROWSER_TUNNEL_HANDSHAKE_TIMEOUT" })), 15_000);
      const socket = new this.WebSocket(this.url, { headers: { authorization: `Browser ${this.token}` }, perMessageDeflate: false });
      this.socket = socket;
      socket.once("open", () => {
        this.logInfo("[desktop-shell] browser tunnel websocket open; sending hello");
        socket.send(encodeBrowserTunnelHello(), { binary: false, compress: false });
      });
      socket.on("message", (data, isBinary) => {
        try {
          if (this.state === "connecting") {
            const ready = BrowserTunnelReadySchema.parse(JSON.parse(Buffer.from(data).toString("utf8")));
            this.logInfo(`[desktop-shell] browser tunnel ready received (binary=${Boolean(isBinary)})`);
            this.initialWindowBytes = ready.initialWindowBytes;
            this.state = "ready";
            clearTimeout(handshakeTimer);
            resolve();
            this.emit("ready");
            return;
          }
          if (!isBinary) throw new Error("Browser relay frames must be binary.");
          this.handleFrame(decodeBrowserTunnelFrame(Buffer.from(data)));
        } catch (error) {
          fail(error);
        }
      });
      socket.once("error", fail);
      socket.once("close", (code, reason) => {
        this.logError(`[desktop-shell] browser tunnel websocket closed code=${code || 0} reason=${Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "")}`);
        fail(new Error("Browser relay closed."));
      });
    });
    return this.readyPromise;
  }

  async attach(target, localSocket) {
    await this.connect();
    if (this.state !== "ready") throw new Error("Browser relay is unavailable.");
    const streamId = this.allocateStreamId();
    const stream = {
      id: streamId,
      localSocket,
      state: "opening",
      sendCredit: this.initialWindowBytes || BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
      receiveCredit: BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
      queued: [],
      queuedBytes: 0,
    };
    this.streams.set(streamId, stream);
    localSocket.pause();
    localSocket.on("data", (chunk) => {
      if (stream.state !== "open") return;
      localSocket.pause();
      stream.queued.push(Buffer.from(chunk));
      stream.queuedBytes += chunk.byteLength;
      if (stream.queuedBytes > 1024 * 1024) return this.failStream(stream, new Error("Browser proxy producer exceeded its buffer."));
      this.flush(stream);
    });
    localSocket.on("end", () => stream.state === "open" && this.sendFrame(BrowserTunnelFrameType.HalfClose, stream.id));
    localSocket.on("close", () => this.closeStream(stream, true));
    localSocket.on("error", () => this.closeStream(stream, true));
    this.sendRaw(encodeBrowserTunnelOpen(streamId, target));
    return new Promise((resolve, reject) => {
      stream.resolveOpen = resolve;
      stream.rejectOpen = reject;
    });
  }

  handleFrame(frame) {
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    if (frame.type === BrowserTunnelFrameType.OpenOk) {
      if (stream.state !== "opening") return this.failStream(stream, new Error("Unexpected Browser Tunnel OPEN_OK."));
      stream.state = "open";
      stream.resolveOpen?.();
      stream.localSocket.resume();
      return;
    }
    if (frame.type === BrowserTunnelFrameType.Data) {
      if (stream.state !== "open" || frame.payload.byteLength > stream.receiveCredit) return this.failStream(stream, new Error("Browser Tunnel receive window exceeded."));
      stream.receiveCredit -= frame.payload.byteLength;
      const bytes = frame.payload.byteLength;
      stream.localSocket.write(frame.payload, () => {
        if (stream.state === "closed") return;
        stream.receiveCredit = Math.min(BROWSER_TUNNEL_MAX_WINDOW_BYTES, stream.receiveCredit + bytes);
        this.sendRaw(encodeBrowserTunnelWindowUpdate(stream.id, bytes));
      });
      return;
    }
    if (frame.type === BrowserTunnelFrameType.WindowUpdate) {
      const bytes = decodeBrowserTunnelWindowUpdate(frame);
      if (stream.sendCredit + bytes > BROWSER_TUNNEL_MAX_WINDOW_BYTES) return this.failStream(stream, new Error("Browser Tunnel send window exceeded."));
      stream.sendCredit += bytes;
      this.flush(stream);
      return;
    }
    if (frame.type === BrowserTunnelFrameType.HalfClose) {
      stream.localSocket.end();
      return;
    }
    if (frame.type === BrowserTunnelFrameType.Error) {
      const error = decodeBrowserTunnelError(frame);
      this.failStream(stream, Object.assign(new Error(error.message), { code: error.code }));
      return;
    }
    if (frame.type === BrowserTunnelFrameType.Close) this.closeStream(stream, false);
  }

  flush(stream) {
    while (stream.state === "open" && stream.sendCredit > 0 && stream.queued.length) {
      const current = stream.queued[0];
      const bytes = Math.min(current.byteLength, stream.sendCredit, BROWSER_TUNNEL_MAX_DATA_BYTES);
      this.sendFrame(BrowserTunnelFrameType.Data, stream.id, current.subarray(0, bytes));
      stream.sendCredit -= bytes;
      stream.queuedBytes -= bytes;
      if (bytes === current.byteLength) stream.queued.shift();
      else stream.queued[0] = current.subarray(bytes);
    }
    if (!stream.queued.length && stream.state === "open") stream.localSocket.resume();
  }

  sendFrame(type, streamId, payload = Buffer.alloc(0)) {
    this.sendRaw(encodeBrowserTunnelFrame({ type, streamId, payload }));
  }

  sendRaw(data) {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocket.OPEN) throw new Error("Browser relay is not connected.");
    if ((socket.bufferedAmount || 0) + data.byteLength > BROWSER_TUNNEL_MAX_CHANNEL_BUFFERED_BYTES) throw new Error("Browser relay consumer is too slow.");
    socket.send(data, { binary: true, compress: false });
  }

  failStream(stream, error) {
    stream.rejectOpen?.(error);
    this.closeStream(stream, true);
  }

  closeStream(stream, notify) {
    if (stream.state === "closed") return;
    const wasOpening = stream.state === "opening";
    stream.state = "closed";
    this.streams.delete(stream.id);
    if (wasOpening) stream.rejectOpen?.(new Error("Target connection closed before opening."));
    if (notify && this.state === "ready") {
      try { this.sendFrame(BrowserTunnelFrameType.Close, stream.id); } catch {}
    }
    if (!stream.localSocket.destroyed) stream.localSocket.destroy();
  }

  allocateStreamId() {
    for (let attempts = 0; attempts < 0xffffffff; attempts += 1) {
      const id = this.nextStreamId;
      this.nextStreamId = this.nextStreamId === 0xffffffff ? 1 : this.nextStreamId + 1;
      if (!this.streams.has(id)) return id;
    }
    throw new Error("Browser relay stream ids are exhausted.");
  }

  close(cause = new Error("Browser relay closed.")) {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const stream of [...this.streams.values()]) this.failStream(stream, cause);
    try { this.socket?.close(); } catch {}
    this.emit("close", cause);
  }
}

module.exports = { BrowserTunnelChannel };
