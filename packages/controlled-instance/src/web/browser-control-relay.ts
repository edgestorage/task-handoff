import crypto from "node:crypto";
import {
  EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES,
  EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
  EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES,
  EMBEDDED_BROWSER_MAX_REQUEST_TIMEOUT_MS,
  EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
  EmbeddedBrowserCdpEventSchema,
  EmbeddedBrowserDownloadEventSchema,
  EmbeddedBrowserChannelErrorSchema,
  EmbeddedBrowserControlHelloSchema,
  EmbeddedBrowserControlMessageDecoder,
  EmbeddedBrowserFrameDecoder,
  EmbeddedBrowserTabsCreatedParamsSchema,
  EmbeddedBrowserTabsDestroyedParamsSchema,
  EmbeddedBrowserTargetAttachParamsSchema,
  EmbeddedBrowserTargetDetachParamsSchema,
  decodeEmbeddedBrowserStreamOpen,
  encodeEmbeddedBrowserChannelError,
  encodeEmbeddedBrowserControlMessage,
  encodeEmbeddedBrowserFrame,
  encodeEmbeddedBrowserStreamOpenOk,
  type EmbeddedBrowserCdpCommand,
  type EmbeddedBrowserDownloadsCancelParams,
  type EmbeddedBrowserDownloadsConfigureParams,
  type EmbeddedBrowserFrame,
  type EmbeddedBrowserTabsCloseParams,
  type EmbeddedBrowserTabsOpenParams,
  type EmbeddedBrowserTargetAttachParams,
  type EmbeddedBrowserTargetDetachParams,
} from "@task-handoff/protocol/embedded-browser-control";
import { BrowserControlError, type BrowserControlService } from "./browser-control";
import { embeddedBrowserTabsOpenParamsForPeer } from "./browser-control-tab-compat";

const CONTROL_STREAM_ID = 1;
const RELAY_RESPONSE_TIMEOUT_MS = EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS;

type RelaySocket = {
  OPEN: number;
  readyState: number;
  bufferedAmount?: number;
  send(data: Buffer | string, options?: { binary?: boolean; compress?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: (...args: any[]) => void): void;
  off?(event: "message" | "close" | "error", listener: (...args: any[]) => void): void;
};

export type BrowserControlRelayContext = {
  panelId: string;
  userId: string;
};

export type BrowserControlCdpEvent = {
  sessionRef: string;
  generation: number;
  leaseRef: string;
  tabRef: string;
  frameSessionRef?: string;
  method: string;
  params?: unknown;
};

export type BrowserControlDownloadEvent = {
  sourceRef: string;
  generation: number;
  tabRef: string;
  method: string;
  params: Record<string, unknown>;
};

type PendingReply = {
  resolve: (value: unknown) => void;
  reject: (error: BrowserControlError) => void;
  timer: NodeJS.Timeout;
};

type RelayConnection = {
  connectionId: number;
  sourceRef: string;
  generation: number;
  peerProtocolVersion: string;
  ready: boolean;
  synchronized: boolean;
  syncRequiredSent: boolean;
  socket: RelaySocket;
  pending: Map<string, PendingReply>;
  close: (code: number, reason: string) => void;
};

type RelaySocketState = {
  socket: RelaySocket;
  context: BrowserControlRelayContext;
  connection?: RelayConnection;
  opened: boolean;
  closed: boolean;
  frameDecoder: EmbeddedBrowserFrameDecoder;
  controlDecoder: EmbeddedBrowserControlMessageDecoder;
};

function messageBytes(data: unknown) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((entry) => Buffer.from(entry)));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}

function rfcError(code: number, message: string, data?: unknown) {
  return { code, message, ...(data === undefined ? {} : { data }) };
}

function staticErrorCode(value: unknown) {
  if (typeof value !== "string") return "BROWSER_OPERATION_UNSUPPORTED";
  return value.startsWith("BROWSER_") ? value : "BROWSER_OPERATION_UNSUPPORTED";
}

export class BrowserControlRelayRegistry {
  private readonly connections = new Map<string, RelayConnection>();
  private readonly cdpListeners = new Set<(event: BrowserControlCdpEvent) => void>();
  private readonly downloadListeners = new Set<(event: BrowserControlDownloadEvent) => void>();
  private nextConnection = 0;
  private nextRequest = 0;

  constructor(private readonly service: BrowserControlService) {}

  subscribeCdpEvent(listener: (event: BrowserControlCdpEvent) => void) {
    this.cdpListeners.add(listener);
    return () => this.cdpListeners.delete(listener);
  }

  subscribeDownloadEvent(listener: (event: BrowserControlDownloadEvent) => void) {
    this.downloadListeners.add(listener);
    return () => this.downloadListeners.delete(listener);
  }

  notifyBrowserStateChanged() {
    for (const connection of this.connections.values()) {
      try { this.activateConnection(connection); } catch { /* A stale connection is closed by its socket handler. */ }
    }
  }

  attach(socket: RelaySocket, context: BrowserControlRelayContext) {
    const state: RelaySocketState = {
      socket,
      context,
      opened: false,
      closed: false,
      frameDecoder: new EmbeddedBrowserFrameDecoder(),
      controlDecoder: new EmbeddedBrowserControlMessageDecoder(),
    };
    const cleanup = () => this.cleanup(state);
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("message", (data: unknown, isBinary: boolean) => {
      if (state.closed) return;
      if (!isBinary) {
        this.closeSocket(state, 1002, "Browser control requires binary frames.");
        return;
      }
      let frames: EmbeddedBrowserFrame[];
      try {
        frames = state.frameDecoder.push(messageBytes(data));
      } catch {
        this.closeSocket(state, 1002, "Browser control protocol error.");
        return;
      }
      for (const frame of frames) {
        try {
          if (!this.handleFrame(state, frame)) return;
        } catch {
          this.closeSocket(state, 1002, "Browser control protocol error.");
          return;
        }
      }
    });
  }

  async tabsOpen(params: EmbeddedBrowserTabsOpenParams) {
    const connection = this.connections.get(params.sourceRef);
    const wireParams = embeddedBrowserTabsOpenParamsForPeer(params, connection?.peerProtocolVersion);
    return this.request(params.sourceRef, params.generation, "tabs.open", wireParams, RELAY_RESPONSE_TIMEOUT_MS);
  }

  async tabsClose(params: EmbeddedBrowserTabsCloseParams) {
    return this.request(params.sourceRef, params.generation, "tabs.close", params, RELAY_RESPONSE_TIMEOUT_MS);
  }

  async targetAttach(params: EmbeddedBrowserTargetAttachParams) {
    return this.request(params.sourceRef, params.generation, "target.attach", params, RELAY_RESPONSE_TIMEOUT_MS);
  }

  async targetDetach(params: EmbeddedBrowserTargetDetachParams) {
    return this.request(params.sourceRef, params.generation, "target.detach", params, RELAY_RESPONSE_TIMEOUT_MS);
  }

  async cdpSend(sourceRef: string, generation: number, params: EmbeddedBrowserCdpCommand, timeoutMs = RELAY_RESPONSE_TIMEOUT_MS) {
    return this.request(sourceRef, generation, "cdp.send", params, timeoutMs);
  }

  async downloadsConfigure(params: EmbeddedBrowserDownloadsConfigureParams) {
    return this.request(params.sourceRef, params.generation, "downloads.configure", params, RELAY_RESPONSE_TIMEOUT_MS);
  }

  async downloadsCancel(params: EmbeddedBrowserDownloadsCancelParams) {
    return this.request(params.sourceRef, params.generation, "downloads.cancel", params, RELAY_RESPONSE_TIMEOUT_MS);
  }

  private request(sourceRef: string, generation: number, method: string, params: unknown, timeoutMs: number) {
    const connection = this.connections.get(sourceRef);
    if (!connection || connection.generation !== generation) {
      return Promise.reject(new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "The browser source is not connected.", 409));
    }
    if (!connection.ready) {
      return Promise.reject(new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "The browser source is still synchronizing.", 409));
    }
    const id = `req_${++this.nextRequest}`;
    const boundedTimeout = Math.min(Math.max(timeoutMs, 1), EMBEDDED_BROWSER_MAX_REQUEST_TIMEOUT_MS);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new BrowserControlError("BROWSER_TIMEOUT", "The browser source did not reply in time.", 504));
      }, boundedTimeout);
      timer.unref?.();
      connection.pending.set(id, { resolve, reject, timer });
      const sent = this.sendControlValue(connection, {
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
      if (!sent) {
        clearTimeout(timer);
        connection.pending.delete(id);
        reject(new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "The browser source disconnected before dispatch.", 409));
      }
    });
  }

  private handleFrame(state: RelaySocketState, frame: EmbeddedBrowserFrame) {
    if (frame.type === "open") {
      if (frame.streamId !== CONTROL_STREAM_ID || state.opened) {
        this.sendChannelError(state, frame.streamId, "BROWSER_CHANNEL_PROTOCOL_ERROR", "The control stream is already open or uses an invalid stream id.");
        return true;
      }
      try {
        decodeEmbeddedBrowserStreamOpen(frame.payload);
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error && String(error.code) === "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED"
          ? "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED"
          : "BROWSER_CHANNEL_PROTOCOL_ERROR";
        this.sendChannelError(state, frame.streamId, code, code === "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED" ? "Only the control stream is supported." : "Browser control protocol error.");
        return true;
      }
      state.opened = true;
      return this.sendFrame(state, "openOk", CONTROL_STREAM_ID, encodeEmbeddedBrowserStreamOpenOk());
    }
    if (frame.type === "data") {
      if (frame.streamId !== CONTROL_STREAM_ID || !state.opened) return false;
      for (const value of state.controlDecoder.push(frame.payload)) {
        if (!this.handleControlValue(state, value)) return false;
      }
      return true;
    }
    if (frame.type === "halfClose" || frame.type === "close") return false;
    if (frame.type === "error") return false;
    if (frame.type === "windowUpdate") return true;
    return false;
  }

  private handleControlValue(state: RelaySocketState, value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const requestId = typeof record.id === "string" || typeof record.id === "number" ? record.id : undefined;
    if (typeof record.method !== "string") {
      if (requestId === undefined) return true;
      const connection = state.connection;
      const pending = connection?.pending.get(String(requestId));
      if (!pending) return true;
      clearTimeout(pending.timer);
      connection!.pending.delete(String(requestId));
      const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? record.error as Record<string, unknown>
        : undefined;
      if (error) {
        const data = error.data && typeof error.data === "object" && !Array.isArray(error.data)
          ? error.data as Record<string, unknown>
          : undefined;
        pending.reject(new BrowserControlError(
          staticErrorCode(data?.code),
          typeof error.message === "string" ? error.message : "Browser control request failed.",
          409,
        ));
      } else {
        pending.resolve(record.result);
      }
      return true;
    }
    const method = record.method;
    const params = record.params;
    try {
      const result = this.dispatchControlMethod(state, method, params);
      if (requestId !== undefined && state.connection) {
        this.sendControlValue(state.connection, { jsonrpc: "2.0", id: requestId, result });
      }
      return true;
    } catch (error) {
      const normalized = error instanceof BrowserControlError
        ? error
        : new BrowserControlError("BROWSER_CHANNEL_PROTOCOL_ERROR", error instanceof Error ? error.message : String(error), 400);
      if (requestId !== undefined && state.connection) {
        this.sendControlValue(state.connection, {
          jsonrpc: "2.0",
          id: requestId,
          error: rfcError(-32000, normalized.message, { code: normalized.code, execution: "not-started" }),
        });
      }
      return normalized.code !== "BROWSER_CHANNEL_PROTOCOL_ERROR";
    }
  }

  private dispatchControlMethod(state: RelaySocketState, method: string, params: unknown): unknown {
    if (method === "control.hello") return this.handleHello(state, params);
    if (method === "control.revoke") {
      this.closeSocket(state, 4001, "Browser control was revoked.");
      throw new BrowserControlError("BROWSER_AUTHORIZATION_REVOKED", "Browser control was revoked.", 409);
    }
    if (method === "tabs.created") {
      const parsed = EmbeddedBrowserTabsCreatedParamsSchema.parse(params);
      this.requireBinding(state, parsed.sourceRef, parsed.generation);
      const page = this.service.page(parsed.tabRef);
      if (page.sourceRef !== parsed.sourceRef || page.generation !== parsed.generation) {
        throw new BrowserControlError("BROWSER_LEASE_STALE", "Browser tab does not belong to the bound generation.", 409);
      }
      if (parsed.creationRef) {
        try { this.service.completeCreation(parsed.sourceRef, parsed.creationRef, parsed.tabRef); } catch { /* Page registration is authoritative. */ }
      }
      return {};
    }
    if (method === "tabs.destroyed") {
      const parsed = EmbeddedBrowserTabsDestroyedParamsSchema.parse(params);
      this.requireBinding(state, parsed.sourceRef, parsed.generation);
      if (parsed.creationRef) {
        try { this.service.failCreationIfActive(parsed.sourceRef, parsed.creationRef, parsed.reason); } catch { /* Destruction already removed the page. */ }
      }
      return {};
    }
    if (method === "target.detached") {
      const parsed = EmbeddedBrowserTargetDetachParamsSchema.parse(params);
      this.service.invalidateLease(parsed.leaseRef);
      return {};
    }
    if (method === "cdp.event") {
      const event = EmbeddedBrowserCdpEventSchema.parse(params);
      const binding = state.connection;
      const sessionRef = this.service.leaseSession(
        event.leaseRef,
        event.tabRef,
        binding?.sourceRef || "",
        event.generation,
      );
      if (sessionRef) {
        const payload: BrowserControlCdpEvent = {
          sessionRef,
          generation: event.generation,
          leaseRef: event.leaseRef,
          tabRef: event.tabRef,
          ...(event.frameSessionRef ? { frameSessionRef: event.frameSessionRef } : {}),
          method: event.method,
          ...(event.params === undefined ? {} : { params: event.params }),
        };
        for (const listener of [...this.cdpListeners]) {
          try { listener(payload); } catch { /* A CDP subscriber must not break the relay. */ }
        }
      }
      return {};
    }
    if (method === "downloads.event") {
      const event = EmbeddedBrowserDownloadEventSchema.parse(params);
      this.requireBinding(state, event.sourceRef, event.generation);
      const page = this.service.page(event.tabRef);
      if (page.sourceRef !== event.sourceRef || page.generation !== event.generation) {
        throw new BrowserControlError("BROWSER_LEASE_STALE", "Browser download target does not belong to the bound generation.", 409);
      }
      for (const listener of [...this.downloadListeners]) {
        try {
          listener({
            sourceRef: event.sourceRef,
            generation: event.generation,
            tabRef: event.tabRef,
            method: event.method,
            params: event.params,
          });
        } catch { /* A CDP subscriber must not break the relay. */ }
      }
      return {};
    }
    throw new BrowserControlError("BROWSER_OPERATION_UNSUPPORTED", "Browser control method is not supported.", 409);
  }

  private handleHello(state: RelaySocketState, params: unknown) {
    const hello = EmbeddedBrowserControlHelloSchema.parse(params);
    if (hello.protocolVersion !== EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION) {
      // Protocol mismatch is diagnostic only; the structured fields still decide compatibility.
    }
    const owner = this.service.sourceOwner(hello.sourceRef);
    if (!owner || owner.panelId !== state.context.panelId || owner.ownerRef !== state.context.userId) {
      throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.", 404);
    }
    const source = this.service.sourceBinding(hello.sourceRef, hello.generation);
    if (source.pageHost !== hello.pageHost
      || source.pageHostCapabilities.backgroundCreation !== hello.pageHostCapabilities.backgroundCreation
      || source.pageHostCapabilities.surviveHostWindowClose !== hello.pageHostCapabilities.surviveHostWindowClose
      || source.pageHostCapabilities.crossWindowAdopt !== hello.pageHostCapabilities.crossWindowAdopt) {
      throw new BrowserControlError("BROWSER_OPERATION_UNSUPPORTED", "Browser source capabilities do not match its registration.", 409);
    }
    state.connection = this.registerConnection(state, hello.sourceRef, hello.generation, hello.protocolVersion);
    this.activateConnection(state.connection);
    return {};
  }

  private registerConnection(state: RelaySocketState, sourceRef: string, generation: number, peerProtocolVersion: string): RelayConnection {
    const previous = this.connections.get(sourceRef);
    if (previous) {
      this.connections.delete(sourceRef);
      this.rejectPending(previous, new BrowserControlError("BROWSER_EXECUTION_UNKNOWN", "The browser source connection was replaced.", 502));
      this.sendControlValue(previous, {
        jsonrpc: "2.0",
        method: "control.revoke",
        params: { reason: "superseded" },
      });
      try { previous.socket.close(4001, "Browser control connection was superseded."); } catch { /* The old socket is already closing. */ }
    }
    const connection: RelayConnection = {
      connectionId: ++this.nextConnection,
      sourceRef,
      generation,
      peerProtocolVersion,
      ready: false,
      synchronized: false,
      syncRequiredSent: false,
      socket: state.socket,
      pending: new Map(),
      close: (code, reason) => this.closeSocket(state, code, reason),
    };
    this.connections.set(sourceRef, connection);
    return connection;
  }

  private activateConnection(connection: RelayConnection) {
    if (connection.synchronized || this.connections.get(connection.sourceRef) !== connection) return;
    let source;
    try { source = this.service.sourceBinding(connection.sourceRef, connection.generation); } catch { return; }
    if (source.state === "syncing" || source.state === "ready") {
      if (this.service.syncSourceIfCurrent(connection.sourceRef, connection.generation, source.registryEpoch, source.registryRevision)) {
        connection.synchronized = true;
        connection.ready = true;
        this.sendNotification(connection, "control.ready", {
          protocolVersion: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
          sourceRef: connection.sourceRef,
          generation: connection.generation,
        });
        this.sendNotification(connection, "control.synced", {
          sourceRef: connection.sourceRef,
          generation: connection.generation,
          registryEpoch: source.registryEpoch,
          registryRevision: source.registryRevision,
        });
        return;
      }
    }
    if (!connection.syncRequiredSent) {
      connection.syncRequiredSent = true;
      this.sendNotification(connection, "source.syncRequired", {
        sourceRef: connection.sourceRef,
        generation: connection.generation,
      });
    }
  }

  private requireBinding(state: RelaySocketState, sourceRef: string, generation: number) {
    const connection = state.connection;
    if (!connection || connection.sourceRef !== sourceRef || connection.generation !== generation) {
      throw new BrowserControlError("BROWSER_LEASE_STALE", "Browser source generation is stale.", 409);
    }
  }

  private sendNotification(connection: RelayConnection, method: string, params: unknown) {
    return this.sendControlValue(connection, { jsonrpc: "2.0", method, params });
  }

  private sendControlValue(connection: RelayConnection, value: unknown) {
    try {
      const encoded = encodeEmbeddedBrowserControlMessage(value);
      const chunkSize = EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES - 4;
      for (let offset = 0; offset < encoded.byteLength; offset += chunkSize) {
        if (!this.sendFrameTo(connection.socket, "data", CONTROL_STREAM_ID, encoded.subarray(offset, offset + chunkSize))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private sendFrame(state: RelaySocketState, type: EmbeddedBrowserFrame["type"], streamId: number, payload: Uint8Array) {
    return this.sendFrameTo(state.socket, type, streamId, payload);
  }

  private sendFrameTo(socket: RelaySocket, type: EmbeddedBrowserFrame["type"], streamId: number, payload: Uint8Array) {
    if (socket.readyState !== socket.OPEN) return false;
    const bytes = encodeEmbeddedBrowserFrame({ type, streamId, payload });
    if ((socket.bufferedAmount || 0) + bytes.byteLength > EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES) {
      try { socket.close(1013, "Browser control consumer is too slow."); } catch { /* The socket is already unusable. */ }
      return false;
    }
    try {
      socket.send(Buffer.from(bytes), { binary: true, compress: false });
      return true;
    } catch {
      return false;
    }
  }

  private sendChannelError(state: RelaySocketState, streamId: number, code: string, message: string) {
    try {
      const payload = encodeEmbeddedBrowserChannelError(EmbeddedBrowserChannelErrorSchema.parse({ code, message }));
      this.sendFrame(state, "error", streamId, payload);
    } catch { /* The control stream is already unusable. */ }
  }

  private closeSocket(state: RelaySocketState, code: number, reason: string) {
    if (state.closed) return;
    try { state.socket.close(code, reason.slice(0, 123)); } catch { /* The socket is already closed. */ }
    this.cleanup(state);
  }

  private cleanup(state: RelaySocketState) {
    if (state.closed) return;
    state.closed = true;
    const connection = state.connection;
    if (!connection) return;
    state.connection = undefined;
    if (this.connections.get(connection.sourceRef) === connection) {
      this.connections.delete(connection.sourceRef);
      this.service.disconnectSource(connection.sourceRef, connection.generation);
    }
    this.rejectPending(connection, new BrowserControlError("BROWSER_EXECUTION_UNKNOWN", "The browser source disconnected before replying.", 502));
  }

  private rejectPending(connection: RelayConnection, error: BrowserControlError) {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
  }
}

export function webSocketMessageBytes(data: unknown) {
  return messageBytes(data);
}
