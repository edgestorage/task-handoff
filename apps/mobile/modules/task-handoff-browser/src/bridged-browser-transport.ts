import { requireOptionalNativeModule } from 'expo';
import { browserChannelError, type BrowserChannel, type BrowserChannelHandlers } from '@task-handoff/protocol/relay-browser-channel';

type Subscription = { remove(): void };
type MessageEvent = { id: string; sequence: number; binary: boolean; data: unknown };
type BridgeModule = {
  createBrowserTransport(): Promise<string>;
  receiveBrowserTransportMessage(id: string, bytes: Uint8Array, binary: boolean): Promise<void>;
  acknowledgeBrowserTransportSend(id: string, sequence: number, error?: string): Promise<void>;
  closeBrowserTransport(id: string): Promise<void>;
  addListener(name: 'onBrowserTransportMessage', listener: (event: MessageEvent) => void): Subscription;
  addListener(name: 'onBrowserTransportClose', listener: (event: { id: string }) => void): Subscription;
};
const native = requireOptionalNativeModule<BridgeModule>('TaskHandoffBrowser');
export function isBridgedBrowserTransportAvailable() { return typeof native?.createBrowserTransport === 'function'; }

export async function createBridgedBrowserTransport(
  open: (handlers: BrowserChannelHandlers, signal: AbortSignal) => Promise<BrowserChannel>,
  onClose?: (error?: Error) => void,
  onDiagnostic?: (stage: string, data: Record<string, string | number | boolean>) => void,
) {
  if (!native?.createBrowserTransport) throw browserChannelError('NATIVE_BROWSER_TRANSPORT_UNAVAILABLE');
  const module = native;
  onDiagnostic?.('native.create.start', {});
  const id = await module.createBrowserTransport();
  const diagnostic = (stage: string, data: Record<string, string | number | boolean> = {}) => onDiagnostic?.(stage, { transportId: id, ...data });
  diagnostic('native.create.end');
  const abort = new AbortController();
  const subscriptions: Subscription[] = [];
  let channel: BrowserChannel | undefined;
  let closed = false;
  let sentFirst = false;
  let receivedFirst = false;
  const close = (error?: Error, source = 'local') => {
    if (closed) return;
    closed = true;
    const errorCode = (error as Error & { code?: unknown } | undefined)?.code;
    diagnostic('closed', { source, failed: !!error, ...(typeof errorCode === 'string' ? { errorCode } : {}) });
    abort.abort();
    channel?.close();
    for (const subscription of subscriptions) subscription.remove();
    void module.closeBrowserTransport(id).catch(() => undefined);
    onClose?.(Object.assign(error ?? browserChannelError('BROWSER_CHANNEL_CLOSED'), { closeSource: source }));
  };
  subscriptions.push(
    module.addListener('onBrowserTransportMessage', (event) => {
      if (event.id !== id || closed) return;
      const bytes = nativeBytes(event.data);
      const first = !sentFirst;
      sentFirst = true;
      if (first) diagnostic('send.first.start', { sequence: event.sequence, binary: event.binary, byteLength: bytes?.byteLength ?? 0 });
      const send = bytes && channel ? channel.send({ bytes, binary: event.binary }) : Promise.reject(browserChannelError('BROWSER_TRANSPORT_MESSAGE_INVALID'));
      void send.then(
        () => {
          if (first) diagnostic('send.first.accepted', { sequence: event.sequence });
          return module.acknowledgeBrowserTransportSend(id, event.sequence);
        },
        (error: unknown) => module.acknowledgeBrowserTransportSend(id, event.sequence, String(error)).finally(() => close(error instanceof Error ? error : browserChannelError('BROWSER_TRANSPORT_SEND_FAILED'), 'send')),
      ).catch((error) => close(error instanceof Error ? error : browserChannelError('BROWSER_TRANSPORT_SEND_FAILED'), 'send'));
    }),
    module.addListener('onBrowserTransportClose', (event) => { if (event.id === id) close(browserChannelError('BROWSER_NATIVE_TRANSPORT_CLOSED'), 'native'); }),
  );
  try {
    diagnostic('channel.open.start');
    channel = await open({
      onMessage: async (message) => {
        if (closed) throw browserChannelError('BROWSER_TRANSPORT_CLOSED');
        const first = !receivedFirst;
        receivedFirst = true;
        if (first) diagnostic('receive.first.start', { binary: message.binary, byteLength: message.bytes.byteLength });
        // Both Expo ArrayBuffer (iOS) and ByteArray (Android) accept Uint8Array.
        // Resolution means native decoded/consumed the message, not event delivery.
        try { await module.receiveBrowserTransportMessage(id, message.bytes, message.binary); }
        catch (error) { close(error instanceof Error ? error : browserChannelError('BROWSER_TRANSPORT_RECEIVE_FAILED'), 'receive'); throw error; }
        if (first) diagnostic('receive.first.consumed');
      },
      onClose: (error) => close(error, 'remote'),
    }, abort.signal);
    if (closed) { channel.close(); throw browserChannelError('BROWSER_TRANSPORT_CLOSED'); }
    diagnostic('channel.open.end');
    return { transportId: id, close, isClosed: () => closed };
  } catch (error) { close(error instanceof Error ? error : browserChannelError('BROWSER_CHANNEL_OPEN_FAILED'), 'open'); throw error; }
}

function nativeBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}
