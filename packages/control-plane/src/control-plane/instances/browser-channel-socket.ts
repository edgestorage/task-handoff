import { EventEmitter } from "node:events";
import {
  browserChannelError,
  RELAY_BROWSER_MAX_QUEUED_BYTES,
  type BrowserChannel,
  type BrowserChannelHandlers,
  type BrowserChannelMessage,
} from "@task-handoff/protocol/relay-browser-channel";
import type { WebSocketLike } from "@task-handoff/protocol/websocket-bridge";

type Write = { message: BrowserChannelMessage; resolve(): void; reject(error: Error): void };

/** Adapts Relay credit to a ws-like socket. Both directions remain bounded;
 * receive credit is returned only after the bridge resumes its source. */
export function createBrowserChannelSocket(handlers: BrowserChannelHandlers, options: { drainOnClose?: boolean } = {}) {
  const emitter = new EventEmitter();
  let closed = false;
  let closing = false;
  let paused = false;
  let writing = false;
  let reading = false;
  let outboundBytes = 0;
  let inboundBytes = 0;
  const outbound: Write[] = [];
  const inbound: Write[] = [];
  let delivered: Write | undefined;
  const closedError = () => browserChannelError("BROWSER_CHANNEL_CLOSED");
  const finish = (code: number, reason: string, notify: boolean, error: Error = closedError()) => {
    if (closed) return;
    closed = true;
    outboundBytes = inboundBytes = 0;
    for (const item of outbound.splice(0)) item.reject(error);
    for (const item of inbound.splice(0)) item.reject(error);
    delivered?.reject(error);
    delivered = undefined;
    // Notify upstream even when the downstream consumer failed.
    emitter.emit("close", code, reason);
    if (notify) handlers.onClose((error as Error & { code?: string }).code === "BROWSER_CHANNEL_CLOSED" ? undefined : error);
  };
  const fail = (error: unknown) => finish(1011, "Relay consumer failed.", true,
    error instanceof Error ? error : browserChannelError("BROWSER_CHANNEL_CONSUMER_FAILED"));
  let flushing: Promise<void> | undefined;
  const flushOutbound = () => {
    if (flushing) return flushing;
    const promise = (async () => {
      writing = true;
      try {
        while (!closed && outbound.length) {
          const item = outbound[0];
          await handlers.onMessage(item.message);
          if (closed) return;
          outbound.shift();
          outboundBytes -= item.message.bytes.byteLength;
          item.resolve();
        }
      } catch (error) { fail(error); }
      finally { writing = false; }
    })();
    flushing = promise;
    void promise.finally(() => { if (flushing === promise) flushing = undefined; });
    return promise;
  };
  const flushInbound = () => {
    if (reading || paused || closed) return;
    reading = true;
    try {
      while (!closed && !paused && (delivered || inbound.length)) {
        if (!delivered) {
          delivered = inbound.shift()!;
          emitter.emit("message", Buffer.from(delivered.message.bytes), delivered.message.binary);
          if (closed || paused) return;
        }
        const item = delivered;
        delivered = undefined;
        inboundBytes -= item.message.bytes.byteLength;
        item.resolve();
      }
    } catch (error) { fail(error); }
    finally { reading = false; }
  };
  const socket: WebSocketLike = {
    get readyState() { return closed ? 3 : 1; },
    get bufferedAmount() { return outboundBytes; },
    on(event, listener) { emitter.on(event, listener); },
    pause() { paused = true; },
    resume() { paused = false; flushInbound(); },
    sendAsync(data, options) {
      if (closed || closing) return Promise.reject(closedError());
      const bytes = typeof data === "string" ? Buffer.from(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array();
      if (!bytes.byteLength) return Promise.resolve();
      if (outboundBytes + bytes.byteLength > RELAY_BROWSER_MAX_QUEUED_BYTES) {
        const error = browserChannelError("BROWSER_CHANNEL_QUEUE_LIMIT");
        finish(1013, "Relay consumer is too slow.", true, error);
        return Promise.reject(error);
      }
      const message = { bytes, binary: options?.binary ?? typeof data !== "string" };
      outboundBytes += bytes.byteLength;
      const result = new Promise<void>((resolve, reject) => outbound.push({ message, resolve, reject }));
      void flushOutbound();
      return result;
    },
    send(data, options) {
      if (closed || closing) return;
      void socket.sendAsync!(data, options).catch(fail);
    },
    close(code = 1000, reason = "Relay channel closed.") {
      if (closed || closing) return;
      if (!options.drainOnClose || (!writing && !outbound.length)) { finish(code, reason, true); return; }
      // A closing signaling socket still owes the viewer its final control
      // frame. Let the bounded outbound queue drain before reporting close, or
      // Relay turns an actionable component error into a generic disconnect.
      closing = true;
      void flushOutbound().then(() => { if (!closed) finish(code, reason, true); });
    },
  };
  const channel: BrowserChannel = {
    send(message) {
      if (closed) return Promise.reject(closedError());
      if (!emitter.listenerCount("message")) return Promise.reject(browserChannelError("BROWSER_CHANNEL_UNAVAILABLE"));
      if (inboundBytes + message.bytes.byteLength > RELAY_BROWSER_MAX_QUEUED_BYTES) {
        const error = browserChannelError("BROWSER_CHANNEL_QUEUE_LIMIT");
        finish(1013, "Relay producer is too fast.", true, error);
        return Promise.reject(error);
      }
      inboundBytes += message.bytes.byteLength;
      const result = new Promise<void>((resolve, reject) => inbound.push({ message, resolve, reject }));
      flushInbound();
      return result;
    },
    close() { finish(1000, "Relay channel closed.", false); },
  };
  return { socket, channel };
}
