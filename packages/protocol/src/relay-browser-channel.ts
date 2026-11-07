import { z } from "zod";

// CP/client subprotocol. Cloud Relay sees only the enclosing encrypted data frame.
export const RELAY_BROWSER_PROTOCOL_VERSION = "2026-11-07";
export const RELAY_BROWSER_MAX_CHANNELS = 4;
export const RELAY_BROWSER_WINDOW_BYTES = 128 * 1024;
export const RELAY_BROWSER_MAX_MESSAGE_BYTES = 64 * 1024 + 9;
export const RELAY_BROWSER_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const MAGIC = 0x57;
const HEADER_BYTES = 7;
const TunnelIdSchema = z.number().int().positive().max(0xffff_ffff);

export const RelayBrowserControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser-channel-open"), tunnelId: TunnelIdSchema, instanceId: z.string().min(1).max(160), protocolVersion: z.literal(RELAY_BROWSER_PROTOCOL_VERSION) }),
  z.object({ type: z.literal("browser-channel-opened"), tunnelId: TunnelIdSchema }),
  z.object({ type: z.literal("browser-channel-close"), tunnelId: TunnelIdSchema }),
  z.object({ type: z.literal("browser-channel-closed"), tunnelId: TunnelIdSchema }),
  z.object({ type: z.literal("browser-channel-error"), tunnelId: TunnelIdSchema, errorCode: z.string().min(1).max(160) }),
  z.object({ type: z.literal("browser-channel-window-update"), tunnelId: TunnelIdSchema, creditBytes: z.number().int().positive().max(RELAY_BROWSER_WINDOW_BYTES) }),
]);
export type RelayBrowserControl = z.infer<typeof RelayBrowserControlSchema>;
export type BrowserChannelMessage = { bytes: Uint8Array; binary: boolean };
export type RelayBrowserData = BrowserChannelMessage & { tunnelId: number };
export type BrowserChannelHandlers = {
  /** Resolves only once the downstream bounded consumer has accepted the message. */
  onMessage(message: BrowserChannelMessage): Promise<void>;
  onClose(error?: Error): void;
};
export type BrowserChannel = {
  send(message: BrowserChannelMessage): Promise<void>;
  close(): void;
};

export function isRelayBrowserData(bytes: Uint8Array) { return bytes[0] === MAGIC; }
export function encodeRelayBrowserData(frame: RelayBrowserData): Uint8Array {
  TunnelIdSchema.parse(frame.tunnelId);
  if (!frame.bytes.byteLength || frame.bytes.byteLength > RELAY_BROWSER_MAX_MESSAGE_BYTES) throw browserChannelError("BROWSER_CHANNEL_FRAME_INVALID");
  const result = new Uint8Array(HEADER_BYTES + frame.bytes.byteLength);
  result.set([MAGIC, 1, frame.binary ? 1 : 0]);
  new DataView(result.buffer).setUint32(3, frame.tunnelId, false);
  result.set(frame.bytes, HEADER_BYTES);
  return result;
}
export function decodeRelayBrowserData(bytes: Uint8Array): RelayBrowserData {
  if (bytes.byteLength <= HEADER_BYTES || bytes.byteLength > HEADER_BYTES + RELAY_BROWSER_MAX_MESSAGE_BYTES || bytes[0] !== MAGIC || bytes[1] !== 1 || bytes[2] > 1) throw browserChannelError("BROWSER_CHANNEL_FRAME_INVALID");
  const tunnelId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(3, false);
  TunnelIdSchema.parse(tunnelId);
  return { tunnelId, binary: bytes[2] === 1, bytes: bytes.subarray(HEADER_BYTES) };
}
export function browserChannelError(code: string) { return Object.assign(new Error(code), { code }); }

type ChannelState = {
  id: number;
  handlers?: BrowserChannelHandlers;
  peer?: BrowserChannel;
  opened: boolean;
  sendCredit: number;
  receiveCredit: number;
  queuedBytes: number;
  queue: Array<{ message: BrowserChannelMessage; resolve(): void; reject(error: Error): void }>;
  incoming: Promise<void>;
  resolve?(channel: BrowserChannel): void;
  reject?(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Portable CP/client subprotocol state machine; no sockets, credentials or persistence. */
export class RelayBrowserMultiplexer {
  private readonly channels = new Map<number, ChannelState>();
  private nextId = 0;
  private closed = false;
  private pumping = false;
  private readonly wire: {
    control(value: RelayBrowserControl): void;
    data(value: RelayBrowserData): void;
    accept?(instanceId: string, handlers: BrowserChannelHandlers): Promise<BrowserChannel>;
  };
  constructor(wire: RelayBrowserMultiplexer["wire"]) { this.wire = wire; }

  open(instanceId: string, handlers: BrowserChannelHandlers, signal?: AbortSignal): Promise<BrowserChannel> {
    if (this.closed || signal?.aborted) return Promise.reject(browserChannelError("BROWSER_CHANNEL_CLOSED"));
    let state: ChannelState;
    try { state = this.create(++this.nextId); } catch (error) { return Promise.reject(error); }
    state.handlers = handlers;
    return new Promise((resolve, reject) => {
      const abort = () => this.end(state, browserChannelError("BROWSER_CHANNEL_CANCELLED"), true);
      state.resolve = (channel) => { signal?.removeEventListener("abort", abort); resolve(channel); };
      state.reject = (error) => { signal?.removeEventListener("abort", abort); reject(error); };
      signal?.addEventListener("abort", abort, { once: true });
      state.timer = setTimeout(() => this.end(state, browserChannelError("BROWSER_CHANNEL_OPEN_TIMEOUT"), true), 15_000);
      try { this.wire.control({ type: "browser-channel-open", tunnelId: state.id, instanceId, protocolVersion: RELAY_BROWSER_PROTOCOL_VERSION }); }
      catch { this.end(state, browserChannelError("BROWSER_CHANNEL_CLOSED")); }
    });
  }

  control(raw: unknown) {
    const value = RelayBrowserControlSchema.parse(raw);
    if (this.closed) return;
    if (value.type === "browser-channel-open") {
      if (!this.wire.accept) throw browserChannelError("BROWSER_CHANNEL_OPEN_UNSUPPORTED");
      if (this.channels.has(value.tunnelId)) throw browserChannelError("BROWSER_CHANNEL_ID_REUSED");
      let state: ChannelState;
      try { state = this.create(value.tunnelId); }
      catch { this.wire.control({ type: "browser-channel-error", tunnelId: value.tunnelId, errorCode: "BROWSER_CHANNEL_LIMIT" }); return; }
      const connection = this.connection(state);
      void this.wire.accept(value.instanceId, {
        onMessage: (message) => connection.send(message),
        onClose: (error) => this.end(state, error, true),
      }).then((peer) => {
        if (!this.live(state)) { peer.close(); return; }
        state.peer = peer;
        state.handlers = { onMessage: (message) => peer.send(message), onClose: () => peer.close() };
        state.opened = true;
        this.wire.control({ type: "browser-channel-opened", tunnelId: state.id });
        this.pump();
      }).catch((error: unknown) => {
        if (!this.live(state)) return;
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.slice(0, 160) : "BROWSER_CHANNEL_OPEN_FAILED";
        this.end(state, browserChannelError(code), true);
      });
      return;
    }
    const state = this.channels.get(value.tunnelId);
    if (!state) return; // Late close/credit after local cancellation is harmless.
    if (value.type === "browser-channel-opened") {
      if (state.opened || !state.resolve) throw browserChannelError("BROWSER_CHANNEL_STATE_INVALID");
      state.opened = true;
      clearTimeout(state.timer);
      state.resolve(this.connection(state));
      state.resolve = undefined;
      state.reject = undefined;
      this.pump();
    } else if (value.type === "browser-channel-window-update") {
      if (state.sendCredit + value.creditBytes > RELAY_BROWSER_WINDOW_BYTES) throw browserChannelError("BROWSER_CHANNEL_WINDOW_INVALID");
      state.sendCredit += value.creditBytes;
      this.pump();
    } else {
      this.end(state, value.type === "browser-channel-error" ? browserChannelError(value.errorCode) : undefined);
      if (value.type === "browser-channel-close") this.wire.control({ type: "browser-channel-closed", tunnelId: state.id });
    }
  }

  data(frame: RelayBrowserData) {
    const state = this.channels.get(frame.tunnelId);
    if (!state) return;
    if (!state.opened || !frame.bytes.byteLength || frame.bytes.byteLength > RELAY_BROWSER_MAX_MESSAGE_BYTES || frame.bytes.byteLength > state.receiveCredit) {
      this.end(state, browserChannelError("BROWSER_CHANNEL_WINDOW_INVALID"), true);
      return;
    }
    state.receiveCredit -= frame.bytes.byteLength;
    state.incoming = state.incoming.then(async () => {
      if (!this.live(state)) return;
      await state.handlers!.onMessage(frame);
      if (!this.live(state)) return;
      state.receiveCredit += frame.bytes.byteLength;
      this.wire.control({ type: "browser-channel-window-update", tunnelId: state.id, creditBytes: frame.bytes.byteLength });
    }).catch(() => this.end(state, browserChannelError("BROWSER_CHANNEL_CONSUMER_FAILED"), true));
  }

  close(error = browserChannelError("BROWSER_CHANNEL_CLOSED")) {
    this.closed = true;
    for (const state of [...this.channels.values()]) this.end(state, error);
  }

  private create(id: number): ChannelState {
    if (this.closed || this.channels.size >= RELAY_BROWSER_MAX_CHANNELS) throw browserChannelError("BROWSER_CHANNEL_LIMIT");
    const state: ChannelState = { id, opened: false, sendCredit: RELAY_BROWSER_WINDOW_BYTES, receiveCredit: RELAY_BROWSER_WINDOW_BYTES, queuedBytes: 0, queue: [], incoming: Promise.resolve() };
    this.channels.set(id, state);
    return state;
  }
  private live(state: ChannelState) { return this.channels.get(state.id) === state; }
  private connection(state: ChannelState): BrowserChannel {
    return {
      send: (message) => {
        if (!this.live(state)) return Promise.reject(browserChannelError("BROWSER_CHANNEL_CLOSED"));
        if (!message.bytes.byteLength || message.bytes.byteLength > RELAY_BROWSER_MAX_MESSAGE_BYTES || state.queuedBytes + message.bytes.byteLength > RELAY_BROWSER_MAX_QUEUED_BYTES) {
          const error = browserChannelError("BROWSER_CHANNEL_QUEUE_LIMIT");
          this.end(state, error, true);
          return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
          state.queue.push({ message, resolve, reject });
          state.queuedBytes += message.bytes.byteLength;
          this.pump();
        });
      },
      close: () => this.end(state, undefined, true),
    };
  }
  private pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    // One frame per tunnel per task keeps browser bursts from starving control/events.
    setTimeout(() => {
      this.pumping = false;
      let more = false;
      for (const state of this.channels.values()) {
        const next = state.queue[0];
        if (!state.opened || !next || next.message.bytes.byteLength > state.sendCredit) continue;
        state.queue.shift();
        state.queuedBytes -= next.message.bytes.byteLength;
        state.sendCredit -= next.message.bytes.byteLength;
        try { this.wire.data({ ...next.message, tunnelId: state.id }); next.resolve(); }
        catch { next.reject(browserChannelError("BROWSER_CHANNEL_CLOSED")); this.end(state, browserChannelError("BROWSER_CHANNEL_CLOSED"), true); }
        more ||= state.queue.length > 0;
      }
      if (more) this.pump();
    }, 0);
  }
  private end(state: ChannelState, error?: Error, notify = false) {
    if (!this.live(state)) return;
    this.channels.delete(state.id);
    clearTimeout(state.timer);
    state.reject?.(error ?? browserChannelError("BROWSER_CHANNEL_CLOSED"));
    for (const item of state.queue.splice(0)) item.reject(error ?? browserChannelError("BROWSER_CHANNEL_CLOSED"));
    state.queuedBytes = 0;
    try { state.handlers?.onClose(error); } catch { /* Closed independently of consumer cleanup. */ }
    if (!state.handlers) state.peer?.close();
    if (notify && !this.closed) {
      try { this.wire.control(error ? { type: "browser-channel-error", tunnelId: state.id, errorCode: "code" in error ? String(error.code).slice(0, 160) : "BROWSER_CHANNEL_CLOSED" } : { type: "browser-channel-close", tunnelId: state.id }); } catch { /* Wire already closed. */ }
    }
  }
}
