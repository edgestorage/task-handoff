import { requireOptionalNativeModule } from 'expo';

type NativeSubscription = { remove(): void };

type RelaySocketNativeModule = {
  createRelaySocket(url: string): Promise<string>;
  startRelaySocket(id: string): Promise<void>;
  sendRelaySocketText(id: string, value: string): Promise<void>;
  sendRelaySocketBinary(id: string, value: string): Promise<void>;
  closeRelaySocket(id: string, code?: number, reason?: string): Promise<void>;
  addListener(eventName: string, listener: (payload: RelaySocketEventPayload) => void): NativeSubscription;
};

type RelaySocketEventPayload = {
  id: string;
  protocol?: string;
  type?: 'text' | 'binary';
  data?: string;
  domain?: string;
  code?: number;
  message?: string;
  reason?: string;
  clean?: boolean;
};

type SocketEvent = 'open' | 'message' | 'error' | 'close';
type SocketEventValue = { data?: unknown; message?: string; code?: number; reason?: string; wasClean?: boolean };
type SocketListener = (event: SocketEventValue) => void;

const native = requireOptionalNativeModule<RelaySocketNativeModule>('TaskHandoffBrowser');

export function isNativeRelaySocketAvailable() {
  return typeof native?.createRelaySocket === 'function';
}

export async function createNativeRelaySocket(url: string): Promise<NativeRelaySocket> {
  if (!native?.createRelaySocket) throw new Error('NATIVE_RELAY_SOCKET_UNAVAILABLE');
  const id = await native.createRelaySocket(url);
  const socket = new NativeRelaySocket(id, native);
  socket.attach();
  try {
    await native.startRelaySocket(id);
  } catch (error) {
    socket.dispose();
    throw error;
  }
  return socket;
}

export class NativeRelaySocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';

  private readonly listeners = new Map<SocketEvent, Set<SocketListener>>();
  private readonly subscriptions: NativeSubscription[] = [];
  private disposed = false;

  constructor(private readonly id: string, private readonly module: RelaySocketNativeModule) {}

  attach() {
    this.subscriptions.push(
      this.module.addListener('onRelaySocketOpen', (event) => this.onOpen(event)),
      this.module.addListener('onRelaySocketMessage', (event) => this.onMessage(event)),
      this.module.addListener('onRelaySocketError', (event) => this.onError(event)),
      this.module.addListener('onRelaySocketClose', (event) => this.onClose(event)),
    );
  }

  addEventListener(type: SocketEvent, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEvent, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array) {
    if (this.readyState !== 1) throw new Error('RELAY_SOCKET_NOT_OPEN');
    if (typeof data === 'string') {
      void this.module.sendRelaySocketText(this.id, data).catch((error) => this.onError({ id: this.id, message: String(error) }));
      return;
    }
    void this.module.sendRelaySocketBinary(this.id, bytesToBase64(data)).catch((error) => this.onError({ id: this.id, message: String(error) }));
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    void this.module.closeRelaySocket(this.id, code, reason).catch(() => undefined);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.remove();
    this.listeners.clear();
  }

  private onOpen(event: RelaySocketEventPayload) {
    if (event.id !== this.id || this.readyState >= 2) return;
    this.readyState = 1;
    this.dispatch('open', {});
  }

  private onMessage(event: RelaySocketEventPayload) {
    if (event.id !== this.id || this.readyState !== 1) return;
    const data = event.type === 'binary' && typeof event.data === 'string' ? base64ToArrayBuffer(event.data) : event.data;
    this.dispatch('message', { data });
  }

  private onError(event: RelaySocketEventPayload) {
    if (event.id !== this.id || this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch('error', { message: event.message ?? 'Relay WebSocket failed.' });
    this.dispatch('close', { code: 1006, reason: event.message ?? '', wasClean: false });
    this.dispose();
  }

  private onClose(event: RelaySocketEventPayload) {
    if (event.id !== this.id || this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch('close', { code: event.code ?? 1000, reason: event.reason ?? '', wasClean: event.clean ?? true });
    this.dispose();
  }

  private dispatch(type: SocketEvent, value: SocketEventValue) {
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }
}

function bytesToBase64(value: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
