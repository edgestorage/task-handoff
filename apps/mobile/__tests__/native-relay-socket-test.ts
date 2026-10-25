type NativeListener = (payload: Record<string, unknown>) => void;

const mockListeners = new Map<string, Set<NativeListener>>();
const mockNative = {
  createRelaySocket: jest.fn(async () => 'socket_1'),
  startRelaySocket: jest.fn(async () => undefined),
  sendRelaySocketText: jest.fn(async () => undefined),
  sendRelaySocketBinary: jest.fn(async () => undefined),
  closeRelaySocket: jest.fn(async () => undefined),
  addListener: jest.fn((name: string, listener: NativeListener) => {
    const listeners = mockListeners.get(name) ?? new Set<NativeListener>();
    listeners.add(listener);
    mockListeners.set(name, listeners);
    return { remove: () => listeners.delete(listener) };
  }),
};

import { NativeRelaySocket } from '../modules/task-handoff-browser/src/native-relay-socket';

function emit(name: string, payload: Record<string, unknown>) {
  for (const listener of mockListeners.get(name) ?? []) listener(payload);
}

describe('native Relay WebSocket bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListeners.clear();
  });

  test('bridges open, binary messages, sends and close through the native module', async () => {
    const socket = new NativeRelaySocket('socket_1', mockNative as any);
    socket.attach();
    const events: string[] = [];
    let received: unknown;
    socket.addEventListener('open', () => events.push('open'));
    socket.addEventListener('message', (event) => { received = event.data; });
    socket.addEventListener('close', (event) => events.push(`close:${event.code}`));

    emit('onRelaySocketOpen', { id: 'socket_1' });
    expect(socket.readyState).toBe(1);
    expect(events).toEqual(['open']);

    emit('onRelaySocketMessage', { id: 'socket_1', type: 'binary', data: new Uint8Array([1, 2, 3]) });
    expect(Array.from(received as Uint8Array)).toEqual([1, 2, 3]);

    socket.send(new Uint8Array([4, 5]));
    const sent = (mockNative.sendRelaySocketBinary as jest.Mock).mock.calls[0][1] as ArrayBuffer;
    expect(Array.from(new Uint8Array(sent))).toEqual([4, 5]);

    socket.close(4400, 'done');
    expect(mockNative.closeRelaySocket).toHaveBeenCalledWith('socket_1', 4400, 'done');
    emit('onRelaySocketClose', { id: 'socket_1', code: 1000, reason: '', clean: true });
    expect(events).toEqual(['open', 'close:1000']);
    expect(mockListeners.get('onRelaySocketOpen')?.size).toBe(0);
  });

  test('surfaces native failures as error and abnormal close events', async () => {
    const socket = new NativeRelaySocket('socket_1', mockNative as any);
    socket.attach();
    const events: string[] = [];
    let failure: { message?: string; domain?: string; code?: number } | undefined;
    socket.addEventListener('error', (event) => {
      failure = event;
      events.push(`error:${event.message}`);
    });
    socket.addEventListener('close', (event) => events.push(`close:${event.code}`));

    emit('onRelaySocketError', { id: 'socket_1', domain: 'NSURLErrorDomain', code: -1200, message: 'TLS failed' });
    expect(socket.readyState).toBe(3);
    expect(failure).toEqual(expect.objectContaining({ message: 'TLS failed', domain: 'NSURLErrorDomain', code: -1200 }));
    expect(events).toEqual(['error:TLS failed', 'close:1006']);
    expect(mockNative.closeRelaySocket).toHaveBeenCalledWith('socket_1', 1011, 'relay-socket-error');
    expect(mockListeners.get('onRelaySocketError')?.size).toBe(0);
  });
});
