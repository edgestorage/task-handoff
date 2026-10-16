import * as Crypto from 'expo-crypto';
import { deflateSync, inflateSync } from 'fflate';
import nacl from 'tweetnacl';

import { RELAY_FRAME_FLAG_DEFLATE, decodeRelayFrame, encodeRelayFrame } from '@task-handoff/cloud-contracts/mobile';
import { createMobileRelayChannelFactory } from '../src/control-plane/relay-channel';

type NodeWebCrypto = { getRandomValues(value: Uint8Array): Uint8Array; subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };

jest.mock('expo-crypto', () => {
  const { webcrypto } = jest.requireActual('node:crypto') as { webcrypto: NodeWebCrypto };
  return {
    __esModule: true,
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    getRandomValues: (value: Uint8Array) => { value.set(webcrypto.getRandomValues(new Uint8Array(value.length))); return value; },
    digest: async (_algorithm: string, data: Uint8Array) => webcrypto.subtle.digest('SHA-256', data),
  };
});

type SocketListener = (event: { data?: unknown }) => void;
type SocketEvent = 'open' | 'message' | 'error' | 'close';

class FakeSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType?: string;
  readonly sent: (string | Uint8Array)[] = [];
  closed?: { code?: number; reason?: string };
  private readonly listeners = new Map<SocketEvent, Set<SocketListener>>();
  addEventListener(type: SocketEvent, listener: SocketListener) { const set = this.listeners.get(type) ?? new Set<SocketListener>(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: SocketEvent, listener: SocketListener) { this.listeners.get(type)?.delete(listener); }
  listenerCount(type: SocketEvent) { return this.listeners.get(type)?.size ?? 0; }
  open() { this.readyState = 1; this.emit('open', {}); }
  send(data: string | Uint8Array) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.readyState = 3; this.closed = { code, reason }; this.emit('close', {}); }
  emit(type: SocketEvent, event: { data?: unknown }) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event); }
}

const ticket = {
  protocolVersion: '2026-08-10',
  audience: 'official.control-plane-access',
  ticketId: 'ticket_a',
  accountId: 'account_a',
  deviceSessionId: 'device_a',
  controlPlaneId: 'control_plane_a',
  bindingId: 'binding_a',
  bindingRevision: 1,
  targetPublicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
  nonce: 'n'.repeat(24),
  trafficClasses: ['interactive'],
  issuedAt: '2026-08-10T00:00:00.000Z',
  expiresAt: '2026-08-10T00:05:00.000Z',
  signature: 's'.repeat(48),
};

function base64Url(value: Uint8Array) { let binary = ''; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function fromBase64Url(value: string) { const normalized = value.replace(/-/g, '+').replace(/_/g, '/'); const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
function concat(...values: Uint8Array[]) { const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0)); let offset = 0; for (const value of values) { result.set(value, offset); offset += value.length; } return result; }
async function sha256(...values: Uint8Array[]) { return new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, concat(...values))); }
async function fingerprintOf(publicKey: string) { return `sha256:${base64Url(await sha256(fromBase64Url(publicKey)))}`; }
function canonicalJson(value: any): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`; return JSON.stringify(value); }
function nonce(direction: number, counter: number) { const value = new Uint8Array(24); value[0] = direction; for (let index = 0; index < 6; index += 1) value[23 - index] = (counter / (2 ** (8 * index))) & 255; return value; }
function frame(sequence: number, payload: Uint8Array, kind: 'handshake' | 'data' | 'cancel' = 'data', flags = 0) { return encodeRelayFrame({ kind, sequence, payload, flags }); }
function sentFrame(socket: FakeSocket, index: number) { const value = socket.sent[index]; if (!value || typeof value === 'string') throw new Error(`sent message ${index} is not a binary frame`); return decodeRelayFrame(value); }

// Mirrors packages/cloud-contracts/src/e2e.ts so the fake Control Plane derives the same session key.
async function acceptHandshake(input: { hello: any; identity: nacl.SignKeyPair }) {
  const serverKeys = nacl.box.keyPair();
  const controlPlanePublicKey = base64Url(input.identity.publicKey);
  const serverEphemeralPublicKey = base64Url(serverKeys.publicKey);
  const transcript = base64Url(await sha256(new TextEncoder().encode(canonicalJson({ audience: ticket.audience, ticketId: ticket.ticketId, accountId: ticket.accountId, deviceSessionId: ticket.deviceSessionId, controlPlaneId: ticket.controlPlaneId, bindingId: ticket.bindingId, bindingRevision: ticket.bindingRevision, nonce: ticket.nonce, clientEphemeralPublicKey: input.hello.clientEphemeralPublicKey, serverEphemeralPublicKey }))));
  const shared = nacl.scalarMult(serverKeys.secretKey, fromBase64Url(input.hello.clientEphemeralPublicKey));
  const sessionKey = await sha256(shared, new TextEncoder().encode(transcript), new TextEncoder().encode('task-handoff:control-plane-access:e2e:v1'));
  return { controlPlanePublicKey, serverEphemeralPublicKey, transcript, signature: base64Url(nacl.sign.detached(new TextEncoder().encode(transcript), input.identity.secretKey)), sessionKey };
}
function handshakeResponse(controlPlane: Awaited<ReturnType<typeof acceptHandshake>>) { return frame(0, new TextEncoder().encode(JSON.stringify({ controlPlanePublicKey: controlPlane.controlPlanePublicKey, serverEphemeralPublicKey: controlPlane.serverEphemeralPublicKey, transcript: controlPlane.transcript, signature: controlPlane.signature })), 'handshake'); }

function flush() { return new Promise<void>((resolve) => setTimeout(resolve, 0)); }

async function connected() {
  const identity = nacl.sign.keyPair();
  const controlPlanePublicKey = base64Url(identity.publicKey);
  const socket = new FakeSocket();
  const factory = createMobileRelayChannelFactory({ webSocketFactory: () => socket, allowRelayUrl: () => true });
  const creating = factory({ relayUrl: 'wss://eu.relay.thandoff.com/connect', clientAttach: { role: 'client' }, ticket, targetPublicKeyFingerprint: await fingerprintOf(controlPlanePublicKey), epoch: 1 });
  socket.open();
  await flush();
  socket.emit('message', { data: JSON.stringify({ type: 'attached', channelId: 'channel_a', leaseExpiresAt: '2026-08-10T00:01:00.000Z' }) });
  await flush();
  const hello = JSON.parse(new TextDecoder().decode(sentFrame(socket, 1).payload));
  const controlPlane = await acceptHandshake({ hello, identity });
  socket.emit('message', { data: handshakeResponse(controlPlane) });
  return { controlPlane, channel: await creating, hello, socket };
}

describe('createMobileRelayChannelFactory', () => {
  test('completes the end-to-end handshake, detaches one-shot listeners and exchanges frames', async () => {
    const identity = nacl.sign.keyPair();
    const socket = new FakeSocket();
    const factory = createMobileRelayChannelFactory({ webSocketFactory: () => socket, allowRelayUrl: () => true });
    const creating = factory({ relayUrl: 'wss://eu.relay.thandoff.com/connect', clientAttach: { role: 'client' }, ticket, targetPublicKeyFingerprint: await fingerprintOf(base64Url(identity.publicKey)), epoch: 1 });

    expect(socket.listenerCount('open')).toBe(1);
    socket.open();
    await flush();
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'attach', capability: { role: 'client' } });

    socket.emit('message', { data: JSON.stringify({ type: 'attached', channelId: 'channel_a', leaseExpiresAt: '2026-08-10T00:01:00.000Z' }) });
    await flush();
    const helloFrame = sentFrame(socket, 1);
    expect(helloFrame).toMatchObject({ sequence: 0, kind: 'handshake' });
    const hello = JSON.parse(new TextDecoder().decode(helloFrame.payload));
    expect(hello).toEqual({ ticketId: 'ticket_a', deviceSessionId: 'device_a', clientEphemeralPublicKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });

    const controlPlane = await acceptHandshake({ hello, identity });
    socket.emit('message', { data: handshakeResponse(controlPlane) });
    const channel = await creating;

    expect(channel.leaseExpiresAt).toBe('2026-08-10T00:01:00.000Z');
    // Only the channel itself may keep listening; the one-shot handshake waits must be gone.
    expect(socket.listenerCount('message')).toBe(1);
    expect(socket.listenerCount('open')).toBe(0);
    expect(socket.listenerCount('error')).toBe(1);
    expect(socket.listenerCount('close')).toBe(1);

    const received: any[] = []; const closed: unknown[] = [];
    channel.subscribe((value) => received.push(value), (error) => closed.push(error));
    channel.send({ type: 'request', id: 'request_1', body: { path: '/api/bootstrap' } });
    const requestFrame = sentFrame(socket, 2);
    expect(requestFrame).toMatchObject({ sequence: 1, kind: 'data' });
    const opened = nacl.secretbox.open(requestFrame.payload, nonce(1, 0), controlPlane.sessionKey);
    expect(JSON.parse(new TextDecoder().decode(opened!))).toEqual({ type: 'request', id: 'request_1', body: { path: '/api/bootstrap' } });

    socket.emit('message', { data: frame(1, nacl.secretbox(new TextEncoder().encode(JSON.stringify({ type: 'response', id: 'request_1', status: 200, body: { data: { ok: true } } })), nonce(2, 0), controlPlane.sessionKey)) });
    expect(received).toEqual([{ type: 'response', id: 'request_1', status: 200, body: { data: { ok: true } } }]);
    expect(closed).toEqual([]);

    channel.send({ type: 'cancel', id: 'request_1' });
    expect(sentFrame(socket, 3)).toMatchObject({ sequence: 2, kind: 'cancel' });

    channel.close();
    expect(closed).toEqual([undefined]);
    expect(socket.listenerCount('message')).toBe(0);
    expect(() => channel.send({ type: 'request', id: 'request_2' })).toThrow(expect.objectContaining({ code: 'RELAY_CHANNEL_CLOSED' }));
  });

  test('rejects a protocol violation during the handshake, closes the socket and drops every listener', async () => {
    const socket = new FakeSocket();
    const factory = createMobileRelayChannelFactory({ webSocketFactory: () => socket, allowRelayUrl: () => true });
    const creating = factory({ relayUrl: 'wss://eu.relay.thandoff.com/connect', clientAttach: { role: 'client' }, ticket, targetPublicKeyFingerprint: `sha256:${'a'.repeat(43)}`, epoch: 1 });
    socket.open();
    await flush();
    socket.emit('message', { data: 'not-json' });

    await expect(creating).rejects.toMatchObject({ code: 'RELAY_PROTOCOL_INVALID' });
    expect(socket.closed).toEqual({ code: 4400, reason: 'handshake-failed' });
    expect(socket.listenerCount('message')).toBe(0);
    expect(socket.listenerCount('open')).toBe(0);
    expect(socket.listenerCount('error')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
  });

  test('rejects a Control Plane identity that does not match the pinned fingerprint', async () => {
    const identity = nacl.sign.keyPair();
    const socket = new FakeSocket();
    const factory = createMobileRelayChannelFactory({ webSocketFactory: () => socket, allowRelayUrl: () => true });
    const creating = factory({ relayUrl: 'wss://eu.relay.thandoff.com/connect', clientAttach: { role: 'client' }, ticket, targetPublicKeyFingerprint: `sha256:${'b'.repeat(43)}`, epoch: 1 });
    socket.open();
    await flush();
    socket.emit('message', { data: JSON.stringify({ type: 'attached', channelId: 'channel_a' }) });
    await flush();
    const hello = JSON.parse(new TextDecoder().decode(sentFrame(socket, 1).payload));
    socket.emit('message', { data: handshakeResponse(await acceptHandshake({ hello, identity })) });

    await expect(creating).rejects.toMatchObject({ code: 'RELAY_E2E_IDENTITY_INVALID' });
    expect(socket.closed).toEqual({ code: 4400, reason: 'handshake-failed' });
    expect(socket.listenerCount('message')).toBe(0);
  });

  test('closes the channel on a stale frame sequence and notifies subscribers once', async () => {
    const { controlPlane, channel, socket } = await connected();

    const closed: unknown[] = [];
    channel.subscribe(() => undefined, (error) => closed.push(error));
    socket.emit('message', { data: frame(9, nacl.secretbox(new TextEncoder().encode('{}'), nonce(2, 0), controlPlane.sessionKey)) });

    expect(closed).toEqual([expect.objectContaining({ code: 'RELAY_FRAME_SEQUENCE_INVALID' })]);
    expect(socket.closed).toEqual({ code: 4400, reason: 'protocol-error' });
    expect(socket.listenerCount('message')).toBe(0);
  });

  test('deflate-packs large outgoing frames and inflates compressed incoming frames', async () => {
    const { controlPlane, channel, socket } = await connected();
    const requested = { type: 'request', id: 'request-big', body: { items: Array.from({ length: 300 }, (_, index) => ({ id: `item-${index}`, text: 'task-handoff-request-payload' })) } };
    channel.send(requested);
    const requestFrame = sentFrame(socket, 2);
    expect(requestFrame.flags).toBe(RELAY_FRAME_FLAG_DEFLATE);
    const opened = nacl.secretbox.open(requestFrame.payload, nonce(1, 0), controlPlane.sessionKey);
    expect(JSON.parse(new TextDecoder().decode(inflateSync(opened!)))).toEqual(requested);

    const received: any[] = [];
    channel.subscribe((value) => received.push(value), () => undefined);
    const response = { type: 'response', id: 'request-big', status: 200, body: { data: 'task-handoff-response-payload '.repeat(200) } };
    const plaintext = new TextEncoder().encode(JSON.stringify(response));
    const compressed = deflateSync(plaintext);
    expect(compressed.byteLength).toBeLessThan(plaintext.byteLength);
    const sealed = nacl.secretbox(compressed, nonce(2, 0), controlPlane.sessionKey);
    socket.emit('message', { data: encodeRelayFrame({ kind: 'data', sequence: 1, payload: sealed, flags: RELAY_FRAME_FLAG_DEFLATE }) });
    await flush();
    expect(received).toEqual([response]);
    channel.close();
  });
});
