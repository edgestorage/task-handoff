import { requireOptionalNativeModule } from 'expo';

type NativeSubscription = { remove(): void };

type RelaySocketNativeModule = {
  createRelaySocket(url: string): Promise<string>;
  startRelaySocket(id: string): Promise<void>;
  sendRelaySocketText(id: string, value: string): Promise<void>;
  sendRelaySocketBinary(id: string, value: ArrayBuffer): Promise<void>;
  closeRelaySocket(id: string, code?: number, reason?: string): Promise<void>;
  addListener(eventName: string, listener: (payload: RelaySocketEventPayload) => void): NativeSubscription;
};

type RelaySocketEventPayload = {
  id: string;
  protocol?: string;
  type?: 'text' | 'binary';
  data?: string | ArrayBuffer | Uint8Array;
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
    // Expo Modules converts ArrayBuffer arguments without a base64 hop. Slice
    // only when the frame is a view into a larger buffer.
    const value = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer as ArrayBuffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    void this.module.sendRelaySocketBinary(this.id, value).catch((error) => this.onError({ id: this.id, message: String(error) }));
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
    this.dispatch('message', { data: event.data });
  }

  private onError(event: RelaySocketEventPayload) {
    if (event.id !== this.id || this.readyState === 3) return;
    this.readyState = 3;
    void this.module.closeRelaySocket(this.id, 1011, 'relay-socket-error').catch(() => undefined);
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
