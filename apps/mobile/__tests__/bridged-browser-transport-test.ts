import { requireOptionalNativeModule } from 'expo';
import type { BrowserChannelHandlers } from '@task-handoff/protocol/relay-browser-channel';
import { createBridgedBrowserTransport } from '../modules/task-handoff-browser/src/bridged-browser-transport';

jest.mock('expo', () => {
  const module = {
    createBrowserTransport: jest.fn(async () => 'bridge_1'),
    receiveBrowserTransportMessage: jest.fn(async () => {}),
    acknowledgeBrowserTransportSend: jest.fn(async () => {}),
    closeBrowserTransport: jest.fn(async () => {}),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  };
  return { requireOptionalNativeModule: () => module };
});


const native = requireOptionalNativeModule('TaskHandoffBrowser') as any;
beforeEach(() => jest.clearAllMocks());
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function event(name: string, payload: unknown) {
  const call = native.addListener.mock.calls.find(([event]: [string]) => event === name);
  call[1](payload);
}

test('native outgoing byte sends are acknowledged only when the relay accepts them', async () => {
  let accept!: () => void;
  const send = jest.fn(() => new Promise<void>((resolve) => { accept = resolve; }));
  const close = jest.fn();
  const bridge = await createBridgedBrowserTransport(async () => ({ send, close }));
  const bytes = new Uint8Array([0, 255, 1]);
  event('onBrowserTransportMessage', { id: 'bridge_1', sequence: 1, binary: true, data: bytes });
  expect(send).toHaveBeenCalledWith({ bytes, binary: true });
  expect(native.acknowledgeBrowserTransportSend).not.toHaveBeenCalled();
  accept(); await tick();
  expect(native.acknowledgeBrowserTransportSend).toHaveBeenCalledWith('bridge_1', 1);
  bridge.close();
  expect(close).toHaveBeenCalledTimes(1);
});

test('inbound credit waits for native consumption and remote closure releases the native transport once', async () => {
  let handlers!: BrowserChannelHandlers;
  let consumed!: () => void;
  native.receiveBrowserTransportMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { consumed = resolve; }));
  const closed = jest.fn();
  const bridge = await createBridgedBrowserTransport(async (h) => { handlers = h; return { send: async () => {}, close() {} }; }, closed);
  let acknowledged = false;
  const bytes = new Uint8Array([1, 2]);
  const receive = handlers.onMessage({ bytes, binary: false }).then(() => { acknowledged = true; });
  await tick(); expect(acknowledged).toBe(false);
  expect(native.receiveBrowserTransportMessage).toHaveBeenCalledWith('bridge_1', bytes, false);
  consumed(); await receive;
  handlers.onClose(new Error('relay reset'));
  bridge.close();
  expect(native.closeBrowserTransport).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
});

test('native closure during relay open aborts the opening and closes its late result', async () => {
  let finish!: (value: { send(): Promise<void>; close(): void }) => void;
  let signal!: AbortSignal;
  const opening = createBridgedBrowserTransport(async (_handlers, abort) => {
    signal = abort;
    return new Promise((resolve) => { finish = resolve; });
  });
  await tick();
  event('onBrowserTransportClose', { id: 'bridge_1' });
  expect(signal.aborted).toBe(true);
  const close = jest.fn();
  finish({ send: async () => {}, close });
  await expect(opening).rejects.toThrow('BROWSER_TRANSPORT_CLOSED');
  expect(close).toHaveBeenCalledTimes(1);
});

test('bridge diagnostics record only first-message metadata and distinguish receipt from consumption', async () => {
  let handlers!: BrowserChannelHandlers;
  let consumed!: () => void;
  native.receiveBrowserTransportMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { consumed = resolve; }));
  const diagnostic = jest.fn();
  const bridge = await createBridgedBrowserTransport(async (h) => {
    handlers = h;
    return { send: async () => {}, close() {} };
  }, undefined, diagnostic);
  const bytes = new TextEncoder().encode('private-page-content');
  const receiving = handlers.onMessage({ bytes, binary: false });
  expect(diagnostic).toHaveBeenCalledWith('receive.first.start', { transportId: 'bridge_1', binary: false, byteLength: bytes.byteLength });
  expect(diagnostic.mock.calls.some(([stage]) => stage === 'receive.first.consumed')).toBe(false);
  consumed(); await receiving;
  await handlers.onMessage({ bytes, binary: true });
  expect(diagnostic.mock.calls.filter(([stage]) => stage === 'receive.first.start')).toHaveLength(1);
  event('onBrowserTransportMessage', { id: 'bridge_1', sequence: 1, binary: false, data: bytes });
  await tick();
  event('onBrowserTransportMessage', { id: 'bridge_1', sequence: 2, binary: true, data: bytes });
  await tick();
  expect(diagnostic.mock.calls.filter(([stage]) => stage === 'send.first.start')).toHaveLength(1);
  expect(diagnostic).toHaveBeenCalledWith('send.first.accepted', { transportId: 'bridge_1', sequence: 1 });
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-page-content');
  bridge.close();
});

test.each(['local', 'remote', 'native'] as const)('closure records %s as its first source exactly once', async (source) => {
  let handlers!: BrowserChannelHandlers;
  const diagnostic = jest.fn();
  const onClose = jest.fn();
  const bridge = await createBridgedBrowserTransport(async (h) => { handlers = h; return { send: async () => {}, close() {} }; }, onClose, diagnostic);
  if (source === 'local') bridge.close();
  if (source === 'remote') handlers.onClose();
  if (source === 'native') event('onBrowserTransportClose', { id: 'bridge_1' });
  bridge.close(); handlers.onClose();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ closeSource: source }));
  expect(diagnostic.mock.calls.filter(([stage]) => stage === 'closed')).toEqual([
    ['closed', expect.objectContaining({ source, transportId: 'bridge_1' })],
  ]);
});

test('native receive failure is distinguished from remote closure and never logs its message', async () => {
  let handlers!: BrowserChannelHandlers;
  const failure = Object.assign(new Error('private browsing data'), { code: 'NATIVE_RECEIVE_FAILED' });
  native.receiveBrowserTransportMessage.mockRejectedValueOnce(failure);
  const onClose = jest.fn();
  const diagnostic = jest.fn();
  const bridge = await createBridgedBrowserTransport(async (h) => { handlers = h; return { send: async () => {}, close() {} }; }, onClose, diagnostic);
  await expect(handlers.onMessage({ bytes: new Uint8Array([1]), binary: true })).rejects.toBe(failure);
  expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 'NATIVE_RECEIVE_FAILED', closeSource: 'receive' }));
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private browsing data');
  bridge.close();
  expect(onClose).toHaveBeenCalledTimes(1);
});
