import { z } from 'zod';
import { RelayControlPlaneTransport, type EncryptedRelayChannel } from '../src/control-plane/relay-transport';
import type { MobileCloudRelayControlPlaneProfile } from '../src/control-plane/profile';

const profile: MobileCloudRelayControlPlaneProfile = { version: 1, identity: { controlPlaneId: 'control_plane_a', publicKeyFingerprint: `sha256:${'a'.repeat(43)}` }, access: { kind: 'cloud-relay', serviceOrigin: 'https://cloud.thandoff.com', bindingId: 'binding_a', bindingRevision: 2, accountSession: { id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }, transport: { request: true, stream: true, webSocket: true } }, capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true }, createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z' };

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
  emit({ type: 'event', event: { type: 'instance.updated' } }); emit({ type: 'tty-snapshot', streamId, data: 'restored', pendingEscape: '\u001b[2', cols: 120, rows: 32 }); emit({ type: 'tty-output', streamId, data: 'hello' }); terminal.sendInput('ls\n');
  expect(events).toEqual([{ type: 'instance.updated' }]); expect(tty).toEqual(['snapshot:restored:\u001b[2:120x32', 'hello']); expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'tty-input' }));
  await transport.revalidate(); expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 2 }));
});

test('cloud Relay profile cannot inject authorization, cross-origin route or stale binding identity', async () => {
  const first = harness(); await expect(first.transport.request('https://attacker.test/', z.any())).rejects.toMatchObject({ code: 'RELAY_ROUTE_INVALID' });
  await expect(first.transport.request('/api/health', z.any(), { headers: { authorization: 'Bearer stolen' } })).rejects.toMatchObject({ code: 'RELAY_AUTH_HEADER_FORBIDDEN' });
  const staleAccount = { issueAccessTicket: async () => ({ bindingId: 'binding_a', bindingRevision: 1, targetPublicKeyFingerprint: profile.identity.publicKeyFingerprint }) } as any;
  await expect(new RelayControlPlaneTransport(profile, staleAccount, jest.fn()).request('/api/health', z.any())).rejects.toMatchObject({ code: 'RELAY_TARGET_IDENTITY_CHANGED' });
});
