import { parseRemoteDesktopRelayPath, remoteDesktopRelaySubprotocol } from '@task-handoff/protocol/remote-desktop';
import type { BrowserChannel } from '@task-handoff/protocol/relay-browser-channel';

import {
  MobileControlPlaneTransportError,
  type MobileAuthenticatedWebSocket,
  type MobileAuthenticatedWebSocketHandlers,
  type MobileAuthenticatedWebSocketOptions,
} from './transport';

type OpenRelayChannel = (
  input: { path: string; protocols: string[] },
  signal: AbortSignal,
  events: {
    onMessage(message: { bytes: Uint8Array; binary: boolean }): void;
    onClose(error?: unknown): void;
  },
) => Promise<BrowserChannel>;

const MAX_PENDING_BYTES = 512 * 1024;

/** Expose the existing relay byte-channel as the small WebSocket-shaped API the
 * remote desktop controller already consumes. The socket stays CONNECTING while
 * the encrypted channel is opened and queues the tiny signaling prelude. */
export function openRelayRemoteDesktopWebSocket(
  options: MobileAuthenticatedWebSocketOptions,
  handlers: MobileAuthenticatedWebSocketHandlers,
  open: OpenRelayChannel,
): MobileAuthenticatedWebSocket {
  const target = parseRemoteDesktopRelayPath(options.path);
  if (!target) throw new MobileControlPlaneTransportError('REMOTE_DESKTOP_RELAY_PATH_INVALID', 'The remote desktop Relay path is invalid.');
  const protocols = typeof options.protocols === 'string' ? [options.protocols] : options.protocols ?? [];
  if (protocols.length !== 1 || protocols[0] !== remoteDesktopRelaySubprotocol(target)) {
    throw new MobileControlPlaneTransportError('REMOTE_DESKTOP_RELAY_PROTOCOL_INVALID', 'The remote desktop Relay subprotocol is invalid.');
  }
  if (Object.keys(options.headers ?? {}).length) {
    throw new MobileControlPlaneTransportError('REMOTE_DESKTOP_RELAY_HEADERS_UNSUPPORTED', 'Remote desktop Relay sockets do not accept custom headers.');
  }

  let readyState = 0;
  let closed = false;
  let notified = false;
  let channel: BrowserChannel | undefined;
  let pendingBytes = 0;
  const pending: Array<{ bytes: Uint8Array; binary: boolean }> = [];
  const abort = new AbortController();

  const notifyClose = (event: { code?: number; reason?: string }, error?: unknown) => {
    if (notified) return;
    notified = true;
    if (error !== undefined) handlers.onError?.(asTransportError(error));
    handlers.onClose?.(event);
  };
  const fail = (error: unknown) => {
    if (closed) return;
    closed = true;
    readyState = 3;
    abort.abort();
    try { channel?.close(); } catch { /* The Relay channel already owns the failure. */ }
    notifyClose({ code: 1006, reason: errorMessage(error) }, error);
  };
  const sendMessage = (message: { bytes: Uint8Array; binary: boolean }) => {
    void channel!.send(message).catch(fail);
  };
  const relayEvents = {
    onMessage(message: { bytes: Uint8Array; binary: boolean }) {
      if (closed) return;
      if (message.binary) {
        handlers.onMessage(message.bytes.buffer.slice(message.bytes.byteOffset, message.bytes.byteOffset + message.bytes.byteLength) as ArrayBuffer);
      } else {
        handlers.onMessage(new TextDecoder().decode(message.bytes));
      }
    },
    onClose(error?: unknown) {
      if (closed) return;
      closed = true;
      readyState = 3;
      notifyClose({ code: 1006, reason: errorMessage(error) }, error);
    },
  };

  const socket: MobileAuthenticatedWebSocket = {
    get readyState() { return readyState; },
    send(data) {
      if (closed) return;
      const message = socketMessage(data);
      if (!message) return;
      if (readyState === 1 && channel) { sendMessage(message); return; }
      if (readyState !== 0) return;
      if (pendingBytes + message.bytes.byteLength > MAX_PENDING_BYTES) {
        fail(new MobileControlPlaneTransportError('REMOTE_DESKTOP_RELAY_QUEUE_LIMIT', 'The remote desktop Relay socket queue is full.'));
        return;
      }
      pending.push(message);
      pendingBytes += message.bytes.byteLength;
    },
    close(code = 1000, reason = 'Client closed') {
      if (closed) return;
      closed = true;
      readyState = 3;
      abort.abort();
      try { channel?.close(); } catch { /* Best effort. */ }
      notifyClose({ code, reason });
    },
  };

  void open({ path: options.path, protocols }, abort.signal, relayEvents).then((opened) => {
    if (closed) { opened.close(); return; }
    channel = opened;
    readyState = 1;
    for (const message of pending.splice(0)) sendMessage(message);
    pendingBytes = 0;
    handlers.onOpen?.();
  }).catch(fail);

  return socket;
}

function socketMessage(data: string | ArrayBuffer | Uint8Array) {
  if (typeof data === 'string') {
    if (!data) return undefined;
    return { bytes: new TextEncoder().encode(data), binary: false };
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength ? { bytes: new Uint8Array(data), binary: true } : undefined;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength
      ? { bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), binary: true }
      : undefined;
  }
  return undefined;
}

function asTransportError(error: unknown) {
  if (error instanceof MobileControlPlaneTransportError) return error;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'REMOTE_DESKTOP_RELAY_CHANNEL_FAILED';
  return new MobileControlPlaneTransportError(code, errorMessage(error), true);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? 'Remote desktop Relay channel failed.');
}
