import { z } from 'zod';
import { COMPACT_EVENT_ENVELOPE_VERSION } from '@task-handoff/protocol/events';
import { RelayControlPlaneTransport, type EncryptedRelayChannel } from '../src/control-plane/relay-transport';
import { MOBILE_EVENT_KEEPALIVE_INTERVAL_MS, MobileControlPlaneTransportError } from '../src/control-plane/transport';
import type { MobileCloudRelayControlPlaneProfile } from '../src/control-plane/profile';

const profile: MobileCloudRelayControlPlaneProfile = { version: 1, identity: { controlPlaneId: 'control_plane_a', publicKeyFingerprint: `sha256:${'a'.repeat(43)}` }, access: { kind: 'cloud-relay', serviceOrigin: 'https://cloud.thandoff.com', bindingId: 'binding_a', bindingRevision: 2, accountSession: { id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }, transport: { request: true, stream: true, webSocket: true } }, capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true }, createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z' };

// The mobile client declares an empty resource-metric scope on every
// subscription: it renders no instance metrics, and that stream shares the
// `instances` topic with real directory changes.
function eventSubscribe(topics: string[] | undefined, extra: Record<string, unknown> = {}) {
  return { type: 'event-subscribe', body: { eventEnvelopeVersion: COMPACT_EVENT_ENVELOPE_VERSION, aiSessionHierarchy: { subagents: true }, metricInstanceIds: [], topics, ...extra } };
}

function harness() {
  let listener: (value: any) => void = () => undefined;
  const channel: EncryptedRelayChannel = { send: jest.fn((value: any) => { if (value.type === 'request') queueMicrotask(() => listener({ type: 'response', id: value.id, status: 200, body: { data: { ok: true } } })); }), close: jest.fn(), subscribe(next) { listener = next; return () => undefined; } };
  const account = { issueAccessTicket: jest.fn().mockResolvedValue({ ticketId: 'ticket_a', bindingId: 'binding_a', bindingRevision: 2, targetPublicKeyFingerprint: profile.identity.publicKeyFingerprint }), allocateRelay: jest.fn().mockResolvedValue({ relayUrl: 'wss://eu.relay.thandoff.com/connect', clientAttach: { role: 'client' } }) } as any;
  const open = jest.fn().mockResolvedValue(channel); const transport = new RelayControlPlaneTransport(profile, account, open);
  return { account, channel, open, transport, emit: (value: any) => listener(value) };
}

test('cloud Relay transport rotates ticket, validates target identity and serves the shared business client', async () => {
  const { account, channel, open, transport } = harness();
  await expect(transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }))).resolves.toEqual({ data: { ok: true } });
  expect(account.issueAccessTicket).toHaveBeenCalledWith({ controlPlaneId: 'control_plane_a', trafficClasses: ['interactive', 'stream'] });
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ targetPublicKeyFingerprint: profile.identity.publicKeyFingerprint, epoch: 1 }));
  expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'request', body: expect.objectContaining({ path: '/api/bootstrap' }) }));
});

test('cloud Relay transport multiplexes events, TTY, cancellation and reconnect epoch without duplicating reducers', async () => {
  const { channel, transport, emit, open } = harness(); const events: any[] = []; const tty: any[] = [];
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  transport.connectEvents({ onOpen() {}, onEvent: (event) => events.push(event), onError() {}, onClose() {} });
  const terminal = transport.connectAppSessionTty('instance_a', 'session_a', { onOpen: () => tty.push('open'), onSnapshot: (data, pendingEscape, cols, rows) => tty.push(`snapshot:${data}:${pendingEscape}:${cols}x${rows}`), onOutput: (data) => tty.push(data), onResize() {}, onExit() {}, onError() {}, onClose() {} });
  await Promise.resolve(); await Promise.resolve();
  const streamId = (channel.send as jest.Mock).mock.calls.map(([value]) => value).find((value) => value.type === 'tty-open').streamId;
  emit({ type: 'event', event: { v: COMPACT_EVENT_ENVELOPE_VERSION, id: 'event_a', type: 'instance.updated', createdAt: '2026-08-26T00:00:00.000Z', payload: {} } }); emit({ type: 'tty-snapshot', streamId, data: 'restored', pendingEscape: '\u001b[2', cols: 120, rows: 32 }); emit({ type: 'tty-output', streamId, data: 'hello' }); terminal.sendInput('ls\n');
  expect(events).toEqual([expect.objectContaining({ v: 1, id: 'event_a', type: 'instance.updated', topic: 'instances' })]); expect(tty).toEqual(['snapshot:restored:\u001b[2:120x32', 'hello']); expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'tty-input' }));
  await transport.revalidate(); expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 2 }));
});

test('cloud Relay transport rotates off a channel that can no longer accept frames', async () => {
  const { channel, open, transport } = harness();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await transport.request('/api/bootstrap', schema);
  (channel.send as jest.Mock).mockImplementationOnce(() => { throw new MobileControlPlaneTransportError('RELAY_CHANNEL_CLOSED', 'Cloud Relay channel failed.', true); });
  await expect(transport.request('/api/bootstrap', schema)).rejects.toMatchObject({ code: 'RELAY_CHANNEL_CLOSED' });
  expect(channel.close).toHaveBeenCalledWith(4000, 'reset');
  await expect(transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(open).toHaveBeenCalledTimes(2);
});

test('cloud Relay transport resets the channel instead of delivering malformed compact events', async () => {
  const { channel, transport, emit } = harness();
  const onEvent = jest.fn();
  const onError = jest.fn();
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  transport.connectEvents({ topics: ['instances'], onOpen() {}, onEvent, onError, onClose() {} });
  await Promise.resolve();

  emit({
    type: 'event',
    event: {
      v: COMPACT_EVENT_ENVELOPE_VERSION,
      id: 'event-invalid',
      type: 'instance.updated',
      createdAt: '2026-08-26T00:00:00.000Z',
    },
  });

  expect(onEvent).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'RELAY_EVENT_INVALID' }));
  expect(channel.close).toHaveBeenCalledWith(4000, 'reset');
});

test('cloud Relay transport aggregates event topics and sends an explicit empty subscription after the last consumer closes', async () => {
  const { channel, transport } = harness();
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  const handlers = (topics?: string[], aiSessionTransient?: any) => ({ topics, aiSessionTransient, onOpen() {}, onEvent() {}, onError() {}, onClose() {} });
  const transient = { messageDeltas: { allInstances: false, instanceIds: [] }, timelineAllSessions: false, timelineSessions: [] };
  const ai = transport.connectEvents(handlers(['ai.sessions'], transient));
  await Promise.resolve(); await Promise.resolve();
  expect(channel.send).toHaveBeenLastCalledWith(eventSubscribe(['ai.sessions'], { aiSessionTransient: transient }));

  const nodes = transport.connectEvents(handlers(['nodes']));
  await Promise.resolve(); await Promise.resolve();
  expect(channel.send).toHaveBeenLastCalledWith(eventSubscribe(['ai.sessions', 'nodes'], { aiSessionTransient: transient }));

  ai.close();
  expect(channel.send).toHaveBeenLastCalledWith(eventSubscribe(['nodes']));
  nodes.close();
  expect(channel.send).toHaveBeenLastCalledWith(eventSubscribe([]));
});

test('cloud Relay transport keeps an idle event stream warm so the Relay cannot reap it', async () => {
  jest.useFakeTimers();
  try {
    const { channel, transport } = harness();
    const connection = transport.connectEvents({ topics: ['instances'], onOpen() {}, onEvent() {}, onError() {}, onClose() {} });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    (channel.send as jest.Mock).mockClear();

    await jest.advanceTimersByTimeAsync(MOBILE_EVENT_KEEPALIVE_INTERVAL_MS);
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ping' }));

    // The Relay closes an idle channel, so the keepalive must stop the moment
    // the last consumer releases the stream instead of holding it open.
    connection.close();
    (channel.send as jest.Mock).mockClear();
    await jest.advanceTimersByTimeAsync(MOBILE_EVENT_KEEPALIVE_INTERVAL_MS * 3);
    expect((channel.send as jest.Mock).mock.calls.filter(([value]) => value.type === 'ping')).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test('cloud Relay transport preserves wildcard semantics while any consumer omits topics', async () => {
  const { channel, transport } = harness();
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  const wildcard = transport.connectEvents({ onOpen() {}, onEvent() {}, onError() {}, onClose() {} });
  const nodes = transport.connectEvents({ topics: ['nodes'], onOpen() {}, onEvent() {}, onError() {}, onClose() {} });
  await Promise.resolve(); await Promise.resolve();
  expect(channel.send).toHaveBeenLastCalledWith(eventSubscribe(undefined));
  wildcard.close();
  expect(channel.send).toHaveBeenLastCalledWith(eventSubscribe(['nodes']));
  nodes.close();
});

test('cloud Relay profile cannot inject authorization, cross-origin route or stale binding identity', async () => {
  const first = harness(); await expect(first.transport.request('https://attacker.test/', z.any())).rejects.toMatchObject({ code: 'RELAY_ROUTE_INVALID' });
  await expect(first.transport.request('/api/health', z.any(), { headers: { authorization: 'Bearer stolen' } })).rejects.toMatchObject({ code: 'RELAY_AUTH_HEADER_FORBIDDEN' });
  const staleAccount = { issueAccessTicket: async () => ({ bindingId: 'binding_a', bindingRevision: 1, targetPublicKeyFingerprint: profile.identity.publicKeyFingerprint }) } as any;
  await expect(new RelayControlPlaneTransport(profile, staleAccount, jest.fn()).request('/api/health', z.any())).rejects.toMatchObject({ code: 'RELAY_TARGET_IDENTITY_CHANGED' });
});

function leaseHarness(leaseMs = 30_000) {
  const channels: Array<{ channel: EncryptedRelayChannel; emit: (value: any) => void; close: () => void }> = [];
  const account = { issueAccessTicket: jest.fn().mockResolvedValue({ ticketId: 'ticket_a', bindingId: 'binding_a', bindingRevision: 2, targetPublicKeyFingerprint: profile.identity.publicKeyFingerprint }), allocateRelay: jest.fn().mockResolvedValue({ relayUrl: 'wss://eu.relay.thandoff.com/connect', clientAttach: { role: 'client' } }) } as any;
  const open = jest.fn(async () => {
    let listener: (value: any) => void = () => undefined;
    let onClose: (error?: unknown) => void = () => undefined;
    // Promise callbacks are not part of the fake clock, so responses still settle
    // while the lease timer is under test control.
    const channel: EncryptedRelayChannel = { leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(), send: jest.fn((value: any) => { if (value.type === 'request') void Promise.resolve().then(() => listener({ type: 'response', id: value.id, status: 200, body: { data: { ok: true } } })); }), close: jest.fn(), subscribe(next, closed) { listener = next; onClose = closed; return () => undefined; } };
    channels.push({ channel, emit: (value) => listener(value), close: () => onClose() });
    return channel;
  });
  return { account, channels, open, transport: new RelayControlPlaneTransport(profile, account, open as any) };
}

test('cloud Relay transport rotates onto a fresh allocation before the channel lease expires', async () => {
  jest.useFakeTimers();
  try {
    const { channels, open, transport } = leaseHarness();
    await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
    const events = { topics: ['ai.sessions'], onOpen() {}, onEvent() {}, onError() {}, onClose() {} };
    transport.connectEvents(events);
    const terminal = transport.connectAppSessionTty('instance_a', 'session_a', { onOpen() {}, onSnapshot() {}, onOutput() {}, onResize() {}, onExit() {}, onError() {}, onClose() {} });
    await Promise.resolve(); await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(25_000);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 2 }));
    const rotated = channels[1];
    const streamId = (channels[0].channel.send as jest.Mock).mock.calls.map(([value]) => value).find((value) => value.type === 'tty-open').streamId;
    expect(rotated.channel.send).toHaveBeenCalledWith({ type: 'event-subscribe', body: expect.objectContaining({ topics: ['ai.sessions'] }) });
    expect(rotated.channel.send).toHaveBeenCalledWith({ type: 'tty-open', streamId, body: { instanceId: 'instance_a', sessionId: 'session_a' } });

    await expect(transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }))).resolves.toEqual({ data: { ok: true } });
    expect((rotated.channel.send as jest.Mock).mock.calls.some(([value]) => value.type === 'request')).toBe(true);

    const onError = jest.fn();
    transport.connectEvents({ onOpen() {}, onEvent() {}, onError, onClose() {} });
    channels[0].close();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    terminal.close();
  } finally {
    jest.useRealTimers();
  }
});

test('cloud Relay transport keeps the current channel when the renewed allocation fails', async () => {
  jest.useFakeTimers();
  try {
    const { account, channels, open, transport } = leaseHarness(10_000);
    await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
    account.allocateRelay.mockRejectedValueOnce(Object.assign(new Error('Coordinator unavailable.'), { code: 'NO_RELAY_CAPACITY' }));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(open).toHaveBeenCalledTimes(1);
    await expect(transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }))).resolves.toEqual({ data: { ok: true } });
    expect((channels[0].channel.send as jest.Mock).mock.calls.some(([value]) => value.type === 'request')).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
