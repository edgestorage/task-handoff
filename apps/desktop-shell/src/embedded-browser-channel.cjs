const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
  EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
  EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES,
  EmbeddedBrowserCdpCommandSchema,
  EmbeddedBrowserControlMessageDecoder,
  EmbeddedBrowserFrameDecoder,
  EmbeddedBrowserStreamOpenOkSchema,
  EmbeddedBrowserTargetAttachParamsSchema,
  EmbeddedBrowserTargetDetachParamsSchema,
  EmbeddedBrowserTabsDestroyedParamsSchema,
  EmbeddedBrowserTabsOpenParamsSchema,
  decodeEmbeddedBrowserFrame,
  decodeEmbeddedBrowserStreamOpenOk,
  encodeEmbeddedBrowserControlMessage,
  encodeEmbeddedBrowserFrame,
  encodeEmbeddedBrowserStreamOpen,
} = loadEmbeddedBrowserProtocol();

const CONTROL_STREAM_ID = 1;

function loadEmbeddedBrowserProtocol() {
  try {
    return require(path.resolve(__dirname, "../../../dist/embedded-browser-control.js"));
  } catch {
    // The packaged runtime builds dist first; source tests resolve the workspace export.
    return require("@task-handoff/protocol/embedded-browser-control");
  }
}

class EmbeddedBrowserChannelClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url;
    this.token = options.token;
    this.WebSocket = options.WebSocket;
    this.sourceRef = options.sourceRef;
    this.generation = options.generation;
    this.registryEpoch = options.registryEpoch;
    this.registryRevision = options.registryRevision;
    this.pageHost = options.pageHost;
    this.pageHostCapabilities = options.pageHostCapabilities;
    this.adapter = options.adapter;
    this.logInfo = options.logInfo || (() => undefined);
    this.logError = options.logError || (() => undefined);
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
    this.socket = undefined;
    this.state = "connecting";
    this.frameDecoder = new EmbeddedBrowserFrameDecoder();
    this.controlDecoder = new EmbeddedBrowserControlMessageDecoder();
  }

  connect() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        this.fail(Object.assign(new Error("Browser control handshake timed out."), { code: "BROWSER_CHANNEL_HANDSHAKE_TIMEOUT" }), reject);
      }, this.handshakeTimeoutMs);
      timer.unref?.();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      this.finishHandshake = finish;
      const socket = new this.WebSocket(this.url, {
        headers: { authorization: `BrowserControl ${this.token}` },
        perMessageDeflate: false,
      });
      this.socket = socket;
      socket.once("open", () => {
        this.logInfo(`[desktop-shell] browser control websocket open source=${this.sourceRef} generation=${this.generation}`);
        const payload = encodeEmbeddedBrowserStreamOpen({ streamKind: "control" });
        socket.send(encodeEmbeddedBrowserFrame({ type: "open", streamId: CONTROL_STREAM_ID, payload }), { binary: true, compress: false });
      });
      socket.on("message", (data, isBinary) => {
        try { this.handleSocketMessage(data, isBinary); }
        catch (error) { this.fail(error, reject); }
      });
      socket.once("error", (error) => this.fail(error, reject));
      socket.once("close", (code, reason) => {
        const detail = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
        const error = Object.assign(new Error(`Browser control relay closed code=${code || 0}${detail ? ` reason=${detail}` : ""}.`), { code: "BROWSER_SOURCE_UNAVAILABLE" });
        this.fail(error, reject);
        this.emit("closed", { code, reason: detail });
      });
    });
    return this.readyPromise;
  }

  handleSocketMessage(data, isBinary) {
    if (!isBinary) throw browserChannelError("Browser control relay requires binary frames.");
    for (const frame of this.frameDecoder.push(toUint8Array(data))) {
      if (frame.type === "openOk") {
        decodeEmbeddedBrowserStreamOpenOk(frame.payload);
        this.sendControl({
          jsonrpc: "2.0",
          method: "control.hello",
          params: {
            protocolVersion: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
            sourceRef: this.sourceRef,
            generation: this.generation,
            pageHost: this.pageHost,
            pageHostCapabilities: this.pageHostCapabilities,
            registryEpoch: this.registryEpoch,
            registryRevision: this.registryRevision,
          },
        });
        this.state = "open";
        continue;
      }
      if (frame.type === "data") {
        if (frame.streamId !== CONTROL_STREAM_ID || !["open", "ready"].includes(this.state)) throw browserChannelError("Browser control DATA arrived before OPEN_OK.");
        for (const value of this.controlDecoder.push(frame.payload)) this.handleControlValue(value);
        continue;
      }
      if (frame.type === "error") {
        this.fail(browserChannelError("Browser control relay rejected the control stream."));
        continue;
      }
      if (frame.type === "close" || frame.type === "halfClose") {
        this.close();
      }
    }
  }

  handleControlValue(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw browserChannelError("Browser control JSON-RPC value is invalid.");
    if (typeof value.method === "string") {
      if (value.id === undefined) {
        this.handleNotification(value.method, value.params);
      } else {
        void this.handleRequest(value);
      }
      return;
    }
    if (value.id !== undefined) this.emit("response", value);
  }

  handleNotification(method, params) {
    if (method === "control.ready") {
      this.emit("ready", params);
      return;
    }
    if (method === "control.synced") {
      this.state = "ready";
      this.emit("synced", params);
      this.finishHandshake?.();
      return;
    }
    if (method === "source.syncRequired") {
      this.emit("sync-required", params);
      return;
    }
    if (method === "control.revoke") {
      this.logError(`[desktop-shell] browser control revoked source=${this.sourceRef} generation=${this.generation}`);
      this.close();
    }
  }

  async handleRequest(request) {
    try {
      const params = request.params;
      let result;
      if (request.method === "tabs.open") {
        result = await this.adapter.openTab(EmbeddedBrowserTabsOpenParamsSchema.parse(params));
      } else if (request.method === "target.attach") {
        result = await this.adapter.attachTarget(EmbeddedBrowserTargetAttachParamsSchema.parse(params));
      } else if (request.method === "target.detach") {
        result = await this.adapter.detachTarget(EmbeddedBrowserTargetDetachParamsSchema.parse(params));
      } else if (request.method === "cdp.send") {
        result = await this.adapter.sendCdp(EmbeddedBrowserCdpCommandSchema.parse(params));
      } else if (request.method === "tabs.close") {
        result = await this.adapter.closeTab(params);
      } else if (request.method === "request.cancel") {
        result = await this.adapter.cancelRequest?.(params);
      } else {
        throw Object.assign(browserChannelError("Browser control method is not supported."), { rpcCode: -32601 });
      }
      this.sendControl({ jsonrpc: "2.0", id: request.id, result: result ?? {} });
    } catch (error) {
      this.sendControl({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: Number.isInteger(error?.rpcCode) ? error.rpcCode : -32000,
          message: error instanceof Error ? error.message.slice(0, 500) : "Browser control request failed.",
          data: { code: typeof error?.code === "string" ? error.code : "BROWSER_OPERATION_UNSUPPORTED", execution: "not-started" },
        },
      });
    }
  }

  notifyTabCreated(page, creationRef) {
    return this.sendNotification("tabs.created", {
      sourceRef: this.sourceRef,
      generation: this.generation,
      tabRef: page.tabRef,
      ...(creationRef ? { creationRef } : {}),
      title: page.title || "",
      url: page.url || "about:blank",
      state: page.state || "ready",
    });
  }

  notifyTabDestroyed(tabRef, reason = "destroyed", creationRef) {
    return this.sendNotification("tabs.destroyed", EmbeddedBrowserTabsDestroyedParamsSchema.parse({
      sourceRef: this.sourceRef,
      generation: this.generation,
      tabRef,
      reason,
      ...(creationRef ? { creationRef } : {}),
    }));
  }

  notifyTargetDetached(leaseRef, tabRef, reason = "target-detached") {
    return this.sendNotification("target.detached", EmbeddedBrowserTargetDetachParamsSchema.parse({
      leaseRef,
      tabRef,
      sourceRef: this.sourceRef,
      generation: this.generation,
      reason,
    }));
  }

  notifyCdpEvent(event) {
    return this.sendNotification("cdp.event", { ...event, generation: this.generation });
  }

  sendNotification(method, params) {
    if (this.state !== "ready") return false;
    return this.sendControl({ jsonrpc: "2.0", method, params });
  }

  sendControl(value) {
    if (!this.socket || this.state === "closed") return false;
    const encoded = encodeEmbeddedBrowserControlMessage(value);
    const chunkSize = EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES - 4;
    for (let offset = 0; offset < encoded.byteLength; offset += chunkSize) {
      const payload = encoded.subarray(offset, Math.min(encoded.byteLength, offset + chunkSize));
      this.socket.send(encodeEmbeddedBrowserFrame({ type: "data", streamId: CONTROL_STREAM_ID, payload }), { binary: true, compress: false });
    }
    return true;
  }

  fail(error, reject) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.logError(`[desktop-shell] browser control failure source=${this.sourceRef} generation=${this.generation} error=${error instanceof Error ? error.message : String(error)}`);
    this.finishHandshake?.(error instanceof Error ? error : new Error(String(error)));
    reject?.(error instanceof Error ? error : new Error(String(error)));
    this.close();
  }

  close(reason = "Browser control channel closed.") {
    if (this.socket) {
      try { this.socket.close(1000, reason.slice(0, 120)); } catch { /* socket is already closing */ }
    }
    this.state = "closed";
    this.socket = undefined;
  }
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value);
}

function browserChannelError(message) {
  return Object.assign(new Error(message), { code: "BROWSER_CHANNEL_PROTOCOL_ERROR" });
}

module.exports = { EmbeddedBrowserChannelClient };
