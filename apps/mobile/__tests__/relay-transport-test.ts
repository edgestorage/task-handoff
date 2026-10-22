import { z } from 'zod';
import { COMPACT_EVENT_ENVELOPE_VERSION } from '@task-handoff/protocol/events';
import { RELAY_BODY_CHUNK_BYTES } from '@task-handoff/protocol/relay-body';
import type { RelaySessionGrant } from '@task-handoff/cloud-contracts/mobile';
import { RelayControlPlaneTransport, type EncryptedRelayChannel } from '../src/control-plane/relay-transport';
import type { RelayProofKeyProvider } from '../src/control-plane/relay-proof-key';
import type { RelayPendingOperation, RelaySessionStore } from '../src/control-plane/relay-session-store';
import { RelayWinnerCache } from '../src/control-plane/relay-winner-cache';
import { MobileControlPlaneTransportError } from '../src/control-plane/transport';
import type { ValueStore } from '../src/platform/secure-storage';
import type { MobileCloudRelayControlPlaneProfile } from '../src/control-plane/profile';
import { diagnosticLog } from '../src/observability/diagnostic-logs';

const profile: MobileCloudRelayControlPlaneProfile = {
  version: 1,
  identity: { controlPlaneId: 'control_plane_a', publicKeyFingerprint: `sha256:${'a'.repeat(43)}` },
  access: {
    kind: 'cloud-relay',
    serviceOrigin: 'https://cloud.thandoff.com',
    bindingId: 'binding_a',
    bindingRevision: 2,
    accountSession: { id: 'device_a', secureCredentialKey: 'cloud.account.device_a' },
    transport: { request: true, stream: true, webSocket: true },
  },
  capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const clientProofPublicKey = 'c'.repeat(43);
const proofKey: RelayProofKeyProvider = {
  async publicKey() { return clientProofPublicKey; },
  async proof(grant) {
    return {
      protocolVersion: grant.protocolVersion,
      role: 'client',
      sessionId: grant.sessionId,
      grantId: grant.grantId,
      generation: grant.generation,
      allocationId: grant.allocationId,
      relayId: grant.relayId,
      nonce: 'n'.repeat(24),
      issuedAt: new Date().toISOString(),
      signature: 's'.repeat(86),
    };
  },
};

const candidates = [
  { allocationId: 'allocation_a', relayId: 'relay_a', relayRegion: 'eu-west', relayUrl: 'wss://eu.relay.thandoff.com/connect', serverScore: 0.1, clientAttach: { role: 'client' } },
  { allocationId: 'allocation_b', relayId: 'relay_b', relayRegion: 'us-east', relayUrl: 'wss://us.relay.thandoff.com/connect', serverScore: 0.4, clientAttach: { role: 'client' } },
];

function selection(overrides: Record<string, unknown> = {}) {
  return { selectionId: 'relay_selection_a', expiresAt: new Date(Date.now() + 15_000).toISOString(), preferredHonored: false, candidates, ...overrides };
}

function grantFor(candidate: (typeof candidates)[number], generation = 1, overrides: Partial<RelaySessionGrant> = {}): RelaySessionGrant {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  return {
    protocolVersion: '2026-10-20',
    audience: 'task-handoff:relay-session-grant',
    sessionId: 'session_a',
    grantId: `grant_${generation}`,
    generation,
    allocationId: candidate.allocationId,
    accessTicketId: 'access_ticket_a',
    relayId: candidate.relayId,
    relayRegion: candidate.relayRegion,
    relayUrl: candidate.relayUrl,
    accountId: 'account_a',
    deviceSessionId: 'device_a',
    controlPlaneId: 'control_plane_a',
    bindingId: 'binding_a',
    bindingRevision: 2,
    targetPublicKeyFingerprint: profile.identity.publicKeyFingerprint,
    clientProofPublicKey,
    controlPlaneProofPublicKey: 'p'.repeat(43),
    trafficClass: 'interactive',
    sessionTranscriptTicket: {
      protocolVersion: '2026-10-20',
      audience: 'task-handoff:relay-session-transcript',
      transcriptTicketId: 'rtt_ticket_a',
      accountId: 'account_a',
      deviceSessionId: 'device_a',
      controlPlaneId: 'control_plane_a',
      bindingId: 'binding_a',
      bindingRevision: 2,
      targetPublicKeyFingerprint: profile.identity.publicKeyFingerprint,
      nonce: 'n'.repeat(24),
      issuedAt,
      expiresAt,
    },
    revocationEpoch: 0,
    issuedAt,
    expiresAt,
    signature: 's'.repeat(86),
    ...overrides,
  };
}

function bootstrapResult(overrides: Record<string, unknown> = {}) {
  return {
    relayTicket: {
      protocolVersion: '2026-08-10',
      audience: 'official.control-plane-access',
      ticketId: 'ticket_a',
      accountId: 'account_a',
      deviceSessionId: 'device_a',
      controlPlaneId: 'control_plane_a',
      bindingId: 'binding_a',
      bindingRevision: 2,
      targetPublicKeyFingerprint: profile.identity.publicKeyFingerprint,
      nonce: 'n'.repeat(24),
      trafficClasses: ['interactive', 'stream'],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signature: 's'.repeat(86),
      clientProofPublicKey,
    },
    selection: selection(),
    clientProofPublicKey,
    ...overrides,
  };
}

function accountStub(probe: jest.Mock = fastestProbe()) {
  return {
    bootstrapRelaySession: jest.fn().mockResolvedValue(bootstrapResult()),
    confirmRelaySession: jest.fn(async (_selectionId: string, input: { winnerAllocationId: string }) => {
      const candidate = candidates.find((entry) => entry.allocationId === input.winnerAllocationId) ?? candidates[0];
      return { ...candidate, grant: grantFor(candidate), substituted: false };
    }),
    renewRelaySession: jest.fn(async (_sessionId: string, input: { expectedGeneration: number }) => ({ grant: grantFor(candidates[0], input.expectedGeneration + 1) })),
    probe,
  };
}

function fastestProbe(winner = 'allocation_a'): jest.Mock {
  return jest.fn(async (targets: Array<{ allocationId: string }>) => targets.map((target) => ({ allocationId: target.allocationId, sampleCount: 2, failureCount: 0, mobileRttMs: target.allocationId === winner ? 10 : 50 })));
}

function memoryStore(): ValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, async available() { return true; }, async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); }, async remove(key) { values.delete(key); } };
}

function memoryRelaySessionStore(): RelaySessionStore & { grant?: RelaySessionGrant; pending?: RelayPendingOperation } {
  return {
    grant: undefined,
    pending: undefined,
    async load() { return this.grant; },
    async save(grant) { this.grant = grant; },
    async clear() { this.grant = undefined; },
    async loadPending() { return this.pending; },
    async savePending(operation) { this.pending = operation; },
    async clearPending() { this.pending = undefined; },
  };
}

function transientNetworkError() {
  return Object.assign(new Error('connection reset'), { code: 'NETWORK_RESET' });
}

function e2eHandshakeTimeout() {
  return new MobileControlPlaneTransportError('RELAY_E2E_HANDSHAKE_TIMEOUT', 'E2E handshake timed out.', true);
}

type ChannelHarness = {
  channel: EncryptedRelayChannel;
  drop(error?: unknown): void;
  control(notice: any): void;
  emit(value: any): void;
};

function channelHarness(overrides: Partial<EncryptedRelayChannel> = {}): ChannelHarness {
  let listener: (value: any) => void = () => undefined;
  let closeListener: (error?: unknown) => void = () => undefined;
  let controlListener: (value: any) => void = () => undefined;
  const channel: EncryptedRelayChannel = {
    leaseExpiresAt: undefined,
    generation: 1,
    send: jest.fn((value: any) => {
      if (value.type === 'request') void Promise.resolve().then(() => listener({ type: 'response', id: value.id, status: 200, body: { data: { ok: true } } }));
    }),
    sendBody: jest.fn(),
    renew: jest.fn(async (grant) => ({ generation: grant.generation, committed: true, leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString() })),
    close: jest.fn(),
    subscribe(next, closed) { listener = next; closeListener = closed; return () => undefined; },
    subscribeControl(next) { controlListener = next; return () => undefined; },
    ...overrides,
  };
  return { channel, drop: (error) => closeListener(error), control: (notice) => controlListener(notice), emit: (value) => listener(value) };
}

function harness(options: { probe?: jest.Mock; winnerCache?: RelayWinnerCache; sessionStore?: RelaySessionStore; e2eRekeyIntervalMs?: number; maxE2eHandshakeTimeouts?: number; networkFingerprint?: () => string } = {}) {
  const probe = options.probe ?? fastestProbe();
  const account = accountStub(probe) as any;
  const channels: ChannelHarness[] = [];
  const open = jest.fn(async () => {
    const created = channelHarness();
    channels.push(created);
    return created.channel;
  });
  const transport = new RelayControlPlaneTransport(profile, account, open, {
    probeRelayCandidates: probe as any,
    proofKey,
    ...(options.winnerCache ? { winnerCache: options.winnerCache } : {}),
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
    ...(options.e2eRekeyIntervalMs === undefined ? {} : { e2eRekeyIntervalMs: options.e2eRekeyIntervalMs }),
    ...(options.maxE2eHandshakeTimeouts === undefined ? {} : { maxE2eHandshakeTimeouts: options.maxE2eHandshakeTimeouts }),
    ...(options.networkFingerprint ? { networkFingerprint: options.networkFingerprint } : {}),
  });
  return { account, channels, open, probe, transport };
}

test('first connection performs exactly bootstrap and confirm before attaching the grant', async () => {
  const { account, channels, open, transport } = harness();
  await expect(transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }))).resolves.toEqual({ data: { ok: true } });

  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
  expect(account.confirmRelaySession).toHaveBeenCalledTimes(1);
  expect(account.bootstrapRelaySession).toHaveBeenCalledWith(expect.objectContaining({ clientProofPublicKey, maxCandidates: 3 }), expect.stringMatching(/^relay_bootstrap_/));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({
    mode: 'attach',
    relayUrl: candidates[0].relayUrl,
    attach: candidates[0].clientAttach,
    targetPublicKeyFingerprint: profile.identity.publicKeyFingerprint,
  }));
  expect(channels[0].channel.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'request' }));
});

test('binary request bodies travel as chunk frames instead of a base64 envelope', async () => {
  const { channels, transport } = harness();
  const body = new TextEncoder().encode('hello').buffer;
  await expect(transport.request('/api/upload', z.object({ data: z.object({ ok: z.literal(true) }) }), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })).resolves.toEqual({ data: { ok: true } });

  const request = (channels[0].channel.send as jest.Mock).mock.calls
    .map(([value]: [any]) => value)
    .find((value) => value.type === 'request');
  expect(request.body.body).toBeUndefined();
  expect(request.body.binaryBody).toEqual({ bodyId: 1, size: 5 });
  const frames = (channels[0].channel.sendBody as jest.Mock).mock.calls.map(([frame]: [any]) => frame);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ bodyId: 1, offset: 0, final: true });
  expect(new TextDecoder().decode(frames[0].bytes)).toBe('hello');
});

const flushMicrotasks = async (rounds = 50) => { for (let round = 0; round < rounds; round += 1) await Promise.resolve(); };

function checksum(bytes: Uint8Array) {
  let value = 0x811c9dc5;
  for (const byte of bytes) {
    value ^= byte;
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

const waitForCondition = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
};

function uploadFrames(created: ChannelHarness) {
  return () => (created.channel.sendBody as jest.Mock).mock.calls.map(([frame]: [any]) => frame);
}

test('binary uploads stream chunks within a window and report acknowledged progress', async () => {
  const created = channelHarness({ send: jest.fn() });
  const { channels, open, transport } = harness();
  channels.push(created);
  open.mockResolvedValueOnce(created.channel);
  const chunk = RELAY_BODY_CHUNK_BYTES;
  const size = chunk * 6 + 10;
  const data = new Uint8Array(size).fill(3);
  const progress: number[] = [];
  const pending = transport.request('/api/upload', z.object({ data: z.object({ ok: z.literal(true) }) }), { method: 'POST', body: data.buffer }, (value) => progress.push(value));
  const frames = uploadFrames(created);
  await waitForCondition(() => frames().length > 0);
  const request = (created.channel.send as jest.Mock).mock.calls.map(([value]: [any]) => value).find((value) => value.type === 'request');
  expect(request.body.body).toBeUndefined();
  expect(request.body.binaryBody).toEqual({ bodyId: 1, size });
  // Four chunks (1 MiB) may be in flight before the first acknowledgement.
  expect(frames().map((frame) => frame.offset)).toEqual([0, chunk, chunk * 2, chunk * 3]);
  created.emit({ type: 'body-ack', bodyId: 1, offset: chunk });
  expect(frames().map((frame) => frame.offset)).toEqual([0, chunk, chunk * 2, chunk * 3, chunk * 4]);
  expect(progress).toEqual([chunk / size]);
  created.emit({ type: 'body-ack', bodyId: 1, offset: chunk * 5 });
  expect(frames().map((frame) => frame.offset)).toEqual([0, chunk, chunk * 2, chunk * 3, chunk * 4, chunk * 5, chunk * 6]);
  expect(frames().at(-1)!.final).toBe(true);
  expect(frames().at(-1)!.bytes.byteLength).toBe(10);
  created.emit({ type: 'body-ack', bodyId: 1, offset: size });
  expect(progress.at(-1)).toBe(1);
  created.emit({ type: 'response', id: request.id, status: 200, body: { data: { ok: true } } });
  await expect(pending).resolves.toEqual({ data: { ok: true } });
});

test('concurrent uploads share one in-flight window and release it when complete', async () => {
  const created = channelHarness({ send: jest.fn() });
  const { channels, open, transport } = harness();
  channels.push(created);
  open.mockResolvedValueOnce(created.channel);
  const chunk = RELAY_BODY_CHUNK_BYTES;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = transport.request('/api/upload/a', z.object({ data: z.object({ ok: z.literal(true) }) }), {
    method: 'POST',
    body: new Uint8Array(chunk * 4).fill(1).buffer,
    signal: firstController.signal,
  });
  const frames = uploadFrames(created);
  await waitForCondition(() => frames().length === 4);
  expect(new Set(frames().map((frame) => frame.bodyId))).toEqual(new Set([1]));

  const second = transport.request('/api/upload/b', z.object({ data: z.object({ ok: z.literal(true) }) }), {
    method: 'POST',
    body: new Uint8Array(chunk * 4).fill(2).buffer,
    signal: secondController.signal,
  });
  await waitForCondition(() => (created.channel.send as jest.Mock).mock.calls.filter(([value]: [any]) => value.type === 'request').length === 2);
  expect(frames()).toHaveLength(4);

  // The first acknowledgement frees exactly one chunk, which goes to the
  // upload with no bytes in flight instead of extending the first upload.
  created.emit({ type: 'body-ack', bodyId: 1, offset: chunk });
  expect(frames()).toHaveLength(5);
  expect(frames().at(-1)).toMatchObject({ bodyId: 2, offset: 0, final: false });

  // Completing the first upload releases the rest of the shared window at
  // once; no further acknowledgement from it will arrive to trigger a pump.
  created.emit({ type: 'body-ack', bodyId: 1, offset: chunk * 4 });
  expect(frames().filter((frame) => frame.bodyId === 2)).toHaveLength(4);
  expect(frames().at(-1)).toMatchObject({ bodyId: 2, offset: chunk * 3, final: true });

  firstController.abort();
  secondController.abort();
  await Promise.allSettled([first, second]);
});

test('an upload acknowledgement cannot cover bytes that were never sent', async () => {
  const created = channelHarness({ send: jest.fn() });
  const { channels, open, transport } = harness();
  channels.push(created);
  open.mockResolvedValueOnce(created.channel);
  const chunk = RELAY_BODY_CHUNK_BYTES;
  const pending = transport.request('/api/upload', z.object({ data: z.object({ ok: z.literal(true) }) }), {
    method: 'POST',
    body: new Uint8Array(chunk * 8).fill(1).buffer,
  });
  const frames = uploadFrames(created);
  await waitForCondition(() => frames().length === 4);

  const rejected = expect(pending).rejects.toMatchObject({ code: 'RELAY_UPLOAD_ACK_INVALID' });
  created.emit({ type: 'body-ack', bodyId: 1, offset: chunk * 5 });
  await rejected;
  expect(frames()).toHaveLength(4);
});

test('binary downloads request framed responses, acknowledge every chunk, and reassemble byte-exact', async () => {
  const created = channelHarness({ send: jest.fn() });
  const { channels, open, transport } = harness();
  channels.push(created);
  open.mockResolvedValueOnce(created.channel);
  const size = 5 * 1024 * 1024;
  const content = new Uint8Array(size);
  for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
  const pending = transport.requestBinary('/api/download');
  await waitForCondition(() => (created.channel.send as jest.Mock).mock.calls.some(([value]: [any]) => value.type === 'request'));
  const sent = (created.channel.send as jest.Mock).mock.calls.map(([value]: [any]) => value);
  const request = sent.find((value) => value.type === 'request');
  expect(request.body.responseBinary).toBe(true);
  expect(request.body.headers.accept).toBe('application/octet-stream, */*');

  const responseId = 7;
  created.emit({ type: 'response', id: request.id, status: 200, binaryResponse: { responseId, size, contentType: 'application/octet-stream', filename: 'archive.bin' } });
  for (let offset = 0; offset < size; offset += RELAY_BODY_CHUNK_BYTES) {
    const end = Math.min(offset + RELAY_BODY_CHUNK_BYTES, size);
    created.emit({ type: 'response-chunk', responseId, offset, bytes: content.subarray(offset, end), final: end === size });
  }
  const result = await pending;
  expect(result.filename).toBe('archive.bin');
  expect(result.contentType).toBe('application/octet-stream');
  expect(result.body.byteLength).toBe(size);
  expect(checksum(result.body)).toBe(checksum(content));
  const acknowledgements = (created.channel.send as jest.Mock).mock.calls.map(([value]: [any]) => value).filter((value) => value.type === 'response-ack');
  expect(acknowledgements).toHaveLength(Math.ceil(size / RELAY_BODY_CHUNK_BYTES));
  expect(acknowledgements.at(-1)).toEqual({ type: 'response-ack', responseId, offset: size });
});

test('aborting a binary download cancels the response and rejects the request', async () => {
  const created = channelHarness({ send: jest.fn() });
  const { channels, open, transport } = harness();
  channels.push(created);
  open.mockResolvedValueOnce(created.channel);
  const controller = new AbortController();
  const pending = transport.requestBinary('/api/download', { signal: controller.signal });
  await waitForCondition(() => (created.channel.send as jest.Mock).mock.calls.some(([value]: [any]) => value.type === 'request'));
  const request = (created.channel.send as jest.Mock).mock.calls.map(([value]: [any]) => value).find((value) => value.type === 'request');
  created.emit({ type: 'response', id: request.id, status: 200, binaryResponse: { responseId: 8, size: 10 } });
  created.emit({ type: 'response-chunk', responseId: 8, offset: 0, bytes: new Uint8Array([1, 2, 3]), final: false });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'RELAY_REQUEST_CANCELLED' });
  expect((created.channel.send as jest.Mock).mock.calls.map(([value]: [any]) => value).find((value) => value.type === 'cancel')).toMatchObject({ id: request.id });
});

test('a stalled upload fails instead of retransmitting acknowledged data', async () => {
  jest.useFakeTimers();
  try {
    const created = channelHarness({ send: jest.fn() });
    const { channels, open, transport } = harness();
    channels.push(created);
    open.mockResolvedValueOnce(created.channel);
    const chunk = RELAY_BODY_CHUNK_BYTES;
    const data = new Uint8Array(chunk * 8).fill(1);
    const pending = transport.request('/api/upload', z.object({ data: z.object({ ok: z.literal(true) }) }), { method: 'POST', body: data.buffer });
    const frames = uploadFrames(created);
    await flushMicrotasks();
    expect(frames().length).toBe(4);
    created.emit({ type: 'body-ack', bodyId: 1, offset: chunk * 2 });
    expect(frames().length).toBe(6);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'RELAY_UPLOAD_STALLED', retryable: true });
    await jest.advanceTimersByTimeAsync(15_001);
    await rejected;
    expect(frames()).toHaveLength(6);
    expect((created.channel.send as jest.Mock).mock.calls.map(([value]: [any]) => value).find((value) => value.type === 'cancel')).toBeDefined();
  } finally {
    jest.useRealTimers();
  }
});

test('another upload acknowledging data does not keep a stalled upload alive', async () => {
  jest.useFakeTimers();
  try {
    const created = channelHarness({ send: jest.fn() });
    const { channels, open, transport } = harness();
    channels.push(created);
    open.mockResolvedValueOnce(created.channel);
    const chunk = RELAY_BODY_CHUNK_BYTES;
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = transport.request('/api/upload/a', z.object({ data: z.object({ ok: z.literal(true) }) }), {
      method: 'POST',
      body: new Uint8Array(chunk * 8).fill(1).buffer,
      signal: firstController.signal,
    });
    const frames = uploadFrames(created);
    await flushMicrotasks();
    expect(frames()).toHaveLength(4);

    const second = transport.request('/api/upload/b', z.object({ data: z.object({ ok: z.literal(true) }) }), {
      method: 'POST',
      body: new Uint8Array(chunk).fill(2).buffer,
      signal: secondController.signal,
    });
    await flushMicrotasks();
    created.emit({ type: 'body-ack', bodyId: 1, offset: chunk });
    expect(frames()).toHaveLength(5);
    expect(frames().at(-1)).toMatchObject({ bodyId: 2, final: true });

    // The second upload is now fully sent and waiting for its acknowledgement.
    // A later ACK for the first upload must not refresh that idle deadline.
    let secondFailure: any;
    void second.catch((error) => { secondFailure = error; });
    await jest.advanceTimersByTimeAsync(14_000);
    created.emit({ type: 'body-ack', bodyId: 1, offset: chunk * 2 });
    await jest.advanceTimersByTimeAsync(1_001);
    await flushMicrotasks();
    expect(secondFailure).toMatchObject({ code: 'RELAY_UPLOAD_STALLED', retryable: true });

    firstController.abort();
    secondController.abort();
    await Promise.allSettled([first, second]);
  } finally {
    jest.useRealTimers();
  }
});

test('aborting an upload cancels the body and stops further chunks', async () => {
  const created = channelHarness({ send: jest.fn() });
  const { channels, open, transport } = harness();
  channels.push(created);
  open.mockResolvedValueOnce(created.channel);
  const controller = new AbortController();
  const data = new Uint8Array(RELAY_BODY_CHUNK_BYTES * 8).fill(1);
  const pending = transport.request('/api/upload', z.object({ data: z.object({ ok: z.literal(true) }) }), { method: 'POST', body: data.buffer, signal: controller.signal });
  const frames = uploadFrames(created);
  await waitForCondition(() => frames().length === 4);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'RELAY_REQUEST_CANCELLED' });
  const cancel = (created.channel.send as jest.Mock).mock.calls.map(([value]: [any]) => value).find((value) => value.type === 'cancel');
  expect(cancel).toBeDefined();
  const sent = frames().length;
  // The upload state is gone, so a late acknowledgement must not restart it.
  created.emit({ type: 'body-ack', bodyId: 1, offset: RELAY_BODY_CHUNK_BYTES });
  expect(frames().length).toBe(sent);
});

test('Relay response errors preserve the Control Plane code and message in diagnostics', async () => {
  const warn = jest.spyOn(diagnosticLog, 'warn').mockImplementation(() => undefined);
  try {
    let requestFrame: any;
    const created = channelHarness({ send: jest.fn((value: any) => { if (value.type === 'request') requestFrame = value; }) });
    const { channels, open, transport } = harness();
    channels.push(created);
    open.mockResolvedValueOnce(created.channel);
    const pending = transport.request('/api/upload?name=private#secret', z.object({ data: z.object({ ok: z.literal(true) }) }));
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'AI_SESSION_ATTACHMENTS_TOO_LARGE',
      message: 'File attachment must be smaller than 524288 bytes.',
      retryable: false,
      status: 413,
    });
    for (let attempt = 0; attempt < 20 && !requestFrame; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestFrame).toBeDefined();
    created.emit({
      type: 'response',
      id: requestFrame.id,
      status: 413,
      body: { error: { code: 'AI_SESSION_ATTACHMENTS_TOO_LARGE', message: 'File attachment must be smaller than 524288 bytes.', retryable: false } },
    });
    await rejection;
    expect(warn).toHaveBeenCalledWith('relay.request.failed', expect.objectContaining({
      path: '/api/upload',
      phase: 'response',
      status: 413,
      errorCode: 'AI_SESSION_ATTACHMENTS_TOO_LARGE',
      errorMessage: 'File attachment must be smaller than 524288 bytes.',
    }));
  } finally {
    warn.mockRestore();
  }
});

test('a lost bootstrap response reuses the persisted body and idempotency key', async () => {
  const sessionStore = memoryRelaySessionStore();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  const first = harness({ sessionStore });
  first.account.bootstrapRelaySession.mockRejectedValueOnce(transientNetworkError());
  await expect(first.transport.request('/api/bootstrap', schema)).rejects.toMatchObject({ code: 'NETWORK_RESET', retryable: true });
  expect(sessionStore.pending).toMatchObject({ type: 'bootstrap' });
  const pending = sessionStore.pending!;
  expect(pending.type).toBe('bootstrap');

  const second = harness({ sessionStore });
  await expect(second.transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(second.account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
  expect(second.account.bootstrapRelaySession).toHaveBeenCalledWith(pending.body, pending.key);
  expect(sessionStore.pending).toBeUndefined();
  expect(second.account.confirmRelaySession).toHaveBeenCalledTimes(1);
});

test('a lost confirm response retries the same confirmation without a second bootstrap', async () => {
  const sessionStore = memoryRelaySessionStore();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  const first = harness({ sessionStore });
  first.account.confirmRelaySession.mockRejectedValueOnce(transientNetworkError());
  await expect(first.transport.request('/api/bootstrap', schema)).rejects.toMatchObject({ code: 'NETWORK_RESET', retryable: true });
  expect(sessionStore.pending).toMatchObject({ type: 'confirm', selectionId: 'relay_selection_a' });
  const pending = sessionStore.pending!;

  const second = harness({ sessionStore });
  await expect(second.transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(second.account.bootstrapRelaySession).not.toHaveBeenCalled();
  expect(second.account.confirmRelaySession).toHaveBeenCalledTimes(1);
  expect(second.account.confirmRelaySession).toHaveBeenCalledWith(pending.type === 'confirm' ? pending.selectionId : '', pending.body, pending.key);
  expect(sessionStore.pending).toBeUndefined();
});

test('a socket loss resumes the same grant without another bootstrap or confirm', async () => {
  const { account, channels, open, transport } = harness();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await transport.request('/api/bootstrap', schema);
  channels[0].drop(new MobileControlPlaneTransportError('RELAY_CHANNEL_CLOSED', 'closed', true));

  await expect(transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
  expect(account.confirmRelaySession).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'resume', grant: expect.objectContaining({ sessionId: 'session_a' }) }));
  expect(open).toHaveBeenCalledTimes(2);
});

test('a single E2E handshake timeout keeps the allocation for the next resume', async () => {
  const { account, channels, open, transport } = harness();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await transport.request('/api/bootstrap', schema);
  channels[0].drop(new MobileControlPlaneTransportError('RELAY_CHANNEL_CLOSED', 'closed', true));
  open.mockRejectedValueOnce(e2eHandshakeTimeout());

  await expect(transport.request('/api/bootstrap', schema)).rejects.toMatchObject({ code: 'RELAY_E2E_HANDSHAKE_TIMEOUT' });
  await expect(transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
  expect(account.confirmRelaySession).toHaveBeenCalledTimes(1);
  expect(open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'resume', 'resume']);
});

test('consecutive E2E handshake timeouts abandon the allocation and select a fresh Relay', async () => {
  const winnerCache = new RelayWinnerCache({ store: memoryStore() });
  const { account, channels, open, transport } = harness({ winnerCache });
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await transport.request('/api/bootstrap', schema);
  channels[0].drop(new MobileControlPlaneTransportError('RELAY_CHANNEL_CLOSED', 'closed', true));
  open.mockRejectedValueOnce(e2eHandshakeTimeout()).mockRejectedValueOnce(e2eHandshakeTimeout());

  await expect(transport.request('/api/bootstrap', schema)).rejects.toMatchObject({ code: 'RELAY_E2E_HANDSHAKE_TIMEOUT' });
  await expect(transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(2);
  expect(account.confirmRelaySession).toHaveBeenCalledTimes(2);
  expect(account.bootstrapRelaySession.mock.calls[1][0]).not.toHaveProperty('preferredRelayId');
  expect(open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'resume', 'resume', 'attach']);
});

test('a terminal Relay close discards the grant instead of resuming it', async () => {
  const { account, channels, open, transport } = harness();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await transport.request('/api/bootstrap', schema);
  channels[0].drop(new MobileControlPlaneTransportError(
    'RELAY_SOCKET_CLOSED',
    'Cloud Relay closed the socket (4400: RELAY_SESSION_GENERATION_STALE).',
    true,
    undefined,
    4400,
    'RELAY_SESSION_GENERATION_STALE',
  ));

  await expect(transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(2);
  expect(account.confirmRelaySession).toHaveBeenCalledTimes(2);
  expect(open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'attach']);
});

test('an app restart resumes the persisted grant without bootstrap or confirm', async () => {
  const sessionStore = memoryRelaySessionStore();
  const first = harness({ sessionStore });
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await first.transport.request('/api/bootstrap', schema);
  expect(sessionStore.grant).toMatchObject({ sessionId: 'session_a', generation: 1 });

  const restored = harness({ sessionStore });
  await expect(restored.transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(restored.account.bootstrapRelaySession).not.toHaveBeenCalled();
  expect(restored.account.confirmRelaySession).not.toHaveBeenCalled();
  expect(restored.open).toHaveBeenCalledWith(expect.objectContaining({ mode: 'resume', grant: expect.objectContaining({ sessionId: 'session_a' }) }));
});

test('an expired persisted grant is discarded before authorization', async () => {
  const sessionStore = memoryRelaySessionStore();
  sessionStore.grant = grantFor(candidates[0], 1, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
  const { account, open, transport } = harness({ sessionStore });
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ mode: 'attach' }));
  expect(sessionStore.grant?.generation).toBe(1);
  expect(Date.parse(sessionStore.grant!.expiresAt)).toBeGreaterThan(Date.now());
});

test('a transient resume failure keeps the grant and retries the same resume', async () => {
  const { account, channels, open, transport } = harness();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await transport.request('/api/bootstrap', schema);
  open.mockRejectedValueOnce(new MobileControlPlaneTransportError('RELAY_CONNECTION_FAILED', 'temporary', true));
  channels[0].drop(new MobileControlPlaneTransportError('RELAY_CHANNEL_CLOSED', 'closed', true));

  await expect(transport.request('/api/bootstrap', schema)).rejects.toMatchObject({ code: 'RELAY_CONNECTION_FAILED' });
  await expect(transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
  expect(account.confirmRelaySession).toHaveBeenCalledTimes(1);
  expect(open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'resume', 'resume']);
});

test('an authoritative revoked resume falls back to a fresh bootstrap and confirm', async () => {
  const { account, channels, open, transport } = harness();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await transport.request('/api/bootstrap', schema);
  open.mockRejectedValueOnce(new MobileControlPlaneTransportError('RELAY_SESSION_REVOKED', 'gone', false));
  channels[0].drop(new MobileControlPlaneTransportError('RELAY_CHANNEL_CLOSED', 'closed', true));

  await expect(transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(2);
  expect(account.confirmRelaySession).toHaveBeenCalledTimes(2);
  expect(open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'resume', 'attach']);
});

test('a terminal Relay close during the first attach discards the grant and reselects once', async () => {
  const { account, open, transport } = harness();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  open.mockRejectedValueOnce(new MobileControlPlaneTransportError(
    'RELAY_SOCKET_CLOSED',
    'Cloud Relay closed the socket (4400: RELAY_SESSION_GENERATION_STALE).',
    true,
    undefined,
    4400,
    'RELAY_SESSION_GENERATION_STALE',
  ));

  await expect(transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(2);
  expect(account.confirmRelaySession).toHaveBeenCalledTimes(2);
  expect(open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'attach']);
});

test('a grant with an unsupported protocol version is rejected before attaching', async () => {
  const { account, open, transport } = harness();
  const bad = grantFor(candidates[0], 1, { protocolVersion: '2025-01-01' as any });
  account.confirmRelaySession.mockResolvedValueOnce({ ...candidates[0], grant: bad, substituted: false });
  await expect(transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }))).rejects.toMatchObject({ code: 'RELAY_GRANT_AUTHORITY_INVALID' });
  expect(open).not.toHaveBeenCalled();
});

test('revalidate resumes the existing session rather than selecting another Relay', async () => {
  const { account, channels, open, transport } = harness();
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  channels[0].drop();
  await transport.revalidate();
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
  expect(open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'resume']);
});

test('lease renewal runs on the same Relay socket without replacing the channel', async () => {
  jest.useFakeTimers();
  try {
    const { account, channels, open, transport } = harness();
    channels.length = 0;
    const created = channelHarness({ leaseExpiresAt: new Date(Date.now() + 6_000).toISOString() });
    channels.push(created);
    open.mockResolvedValueOnce(created.channel);
    await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
    (created.channel.renew as jest.Mock).mockResolvedValueOnce({ generation: 2, committed: true, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() });

    await jest.advanceTimersByTimeAsync(1_000);
    expect(account.renewRelaySession).toHaveBeenCalledWith('session_a', { expectedGeneration: 1 }, expect.stringMatching(/^relay_renew_/));
    expect(created.channel.renew).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }), expect.objectContaining({ generation: 2 }));
    expect(open).toHaveBeenCalledTimes(1);

    await expect(transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }))).resolves.toEqual({ data: { ok: true } });
    expect(created.channel.close).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('the configured E2E rekey boundary re-attaches without bootstrap or confirm', async () => {
  jest.useFakeTimers();
  try {
    const { account, channels, open, transport } = harness({ e2eRekeyIntervalMs: 1_000 });
    await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));

    await jest.advanceTimersByTimeAsync(1_000);

    expect(open).toHaveBeenCalledTimes(2);
    expect((open.mock.calls as any[])[1][0]).toEqual(expect.objectContaining({
      mode: 'resume',
      relayUrl: candidates[0].relayUrl,
      grant: expect.objectContaining({ sessionId: 'session_a', generation: 1 }),
    }));
    expect(channels[0].channel.close).toHaveBeenCalledWith(1000, 'e2e-rekey');
    expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
    expect(account.confirmRelaySession).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('a healthy grant renews in the background after ten minutes', async () => {
  jest.useFakeTimers();
  try {
    const { account, channels, open, transport } = harness();
    const created = channelHarness({ leaseExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
    channels.push(created);
    open.mockResolvedValueOnce(created.channel);
    await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));

    await jest.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(account.renewRelaySession).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(account.renewRelaySession).toHaveBeenCalledWith('session_a', { expectedGeneration: 1 }, expect.stringMatching(/^relay_renew_/));
    await jest.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(created.channel.close).not.toHaveBeenCalled();
    created.drop();
  } finally {
    jest.useRealTimers();
  }
});

test('the renewed grant is persisted before it is pushed to the Relay', async () => {
  jest.useFakeTimers();
  try {
    const sessionStore = memoryRelaySessionStore();
    const { channels, open, transport } = harness({ sessionStore });
    const created = channelHarness({ leaseExpiresAt: new Date(Date.now() + 6_000).toISOString() });
    channels.push(created);
    open.mockResolvedValueOnce(created.channel);
    await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
    expect(sessionStore.grant?.generation).toBe(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(sessionStore.grant?.generation).toBe(2);
    expect(created.channel.renew).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }), expect.objectContaining({ generation: 2 }));
  } finally {
    jest.useRealTimers();
  }
});

test('a failed renewal leaves the current channel usable and reuses one idempotency key', async () => {
  jest.useFakeTimers();
  try {
    const { account, channels, open, transport } = harness();
    const created = channelHarness({ leaseExpiresAt: new Date(Date.now() + 6_000).toISOString() });
    channels.push(created);
    open.mockResolvedValueOnce(created.channel);
    await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
    account.renewRelaySession.mockRejectedValueOnce(new MobileControlPlaneTransportError('RELAY_RENEW_FAILED', 'temporary', true));

    await jest.advanceTimersByTimeAsync(1_000);
    await expect(transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }))).resolves.toEqual({ data: { ok: true } });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(account.renewRelaySession).toHaveBeenCalledTimes(2);
    expect(account.renewRelaySession.mock.calls[0][2]).toBe(account.renewRelaySession.mock.calls[1][2]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(created.channel.close).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('in-place renewal preserves pending requests, event subscriptions and TTY streams', async () => {
  jest.useFakeTimers();
  try {
    const { account, channels, open, transport } = harness();
    const created = channelHarness({ leaseExpiresAt: new Date(Date.now() + 6_000).toISOString() });
    channels.push(created);
    open.mockResolvedValueOnce(created.channel);
    await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));

    const onEventError = jest.fn();
    transport.connectEvents({ onOpen: jest.fn(), onEvent: jest.fn(), onError: onEventError, onClose: jest.fn() });
    const tty = { onOpen: jest.fn(), onSnapshot: jest.fn(), onOutput: jest.fn(), onResize: jest.fn(), onExit: jest.fn(), onError: jest.fn(), onClose: jest.fn() };
    transport.connectAppSessionTty('instance_a', 'session_a', tty);
    await jest.advanceTimersByTimeAsync(0);

    const send = created.channel.send as jest.Mock;
    send.mockImplementation(() => undefined);
    const pending = transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
    await jest.advanceTimersByTimeAsync(0);
    const requestFrame = send.mock.calls.map(([value]: [any]) => value).filter((value) => value.type === 'request').at(-1);
    expect(requestFrame).toBeDefined();
    const sendCountBeforeRenewal = send.mock.calls.length;

    await jest.advanceTimersByTimeAsync(1_000);
    expect(account.renewRelaySession).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(created.channel.close).not.toHaveBeenCalled();
    expect(send.mock.calls.length).toBe(sendCountBeforeRenewal);

    created.emit({ type: 'response', id: requestFrame.id, status: 200, body: { data: { ok: true } } });
    await expect(pending).resolves.toEqual({ data: { ok: true } });
    expect(onEventError).not.toHaveBeenCalled();
    expect(tty.onError).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('peer-detached drops the socket but keeps the grant for the next resume', async () => {
  const { account, channels, open, transport } = harness();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await transport.request('/api/bootstrap', schema);
  channels[0].control({ type: 'peer-detached', sessionId: 'session_a', retryable: true });
  await expect(transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
  expect(open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'resume']);
});

test('session-closed keeps a retryable grant and discards a terminal one', async () => {
  const retryable = harness();
  const schema = z.object({ data: z.object({ ok: z.literal(true) }) });
  await retryable.transport.request('/api/bootstrap', schema);
  retryable.channels[0].control({ type: 'session-closed', sessionId: 'session_a', code: 'idle-timeout', retryable: true });
  await expect(retryable.transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(retryable.account.bootstrapRelaySession).toHaveBeenCalledTimes(1);
  expect(retryable.open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'resume']);

  const terminal = harness();
  await terminal.transport.request('/api/bootstrap', schema);
  terminal.channels[0].control({ type: 'session-closed', sessionId: 'session_a', code: 'expired', retryable: false });
  await expect(terminal.transport.request('/api/bootstrap', schema)).resolves.toEqual({ data: { ok: true } });
  expect(terminal.account.bootstrapRelaySession).toHaveBeenCalledTimes(2);
  expect(terminal.open.mock.calls.map(([input]: any[]) => input.mode)).toEqual(['attach', 'attach']);
});

test('probes candidates in parallel and confirms the fastest one with measurements', async () => {
  const { account, probe, transport } = harness();
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  expect(probe.mock.calls[0][0]).toEqual(candidates.map(({ allocationId, relayUrl }) => ({ allocationId, relayUrl })));
  expect(account.confirmRelaySession).toHaveBeenCalledWith('relay_selection_a', expect.objectContaining({
    winnerAllocationId: 'allocation_a',
    rankedAllocationIds: ['allocation_a', 'allocation_b'],
    fallback: 'none',
    measurements: [
      { allocationId: 'allocation_a', relayId: 'relay_a', mobileRttMs: 10, sampleCount: 2, failureCount: 0 },
      { allocationId: 'allocation_b', relayId: 'relay_b', mobileRttMs: 50, sampleCount: 2, failureCount: 0 },
    ],
  }), expect.stringMatching(/^relay_confirm_/));
});

test('remembered winner is validated with one sample on the next selection', async () => {
  const store = memoryStore();
  const winnerCache = new RelayWinnerCache({ store });
  const first = harness({ winnerCache });
  await first.transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  expect(store.values.get(RelayWinnerCache.key('control_plane_a'))).toEqual(expect.stringContaining('"relayId":"relay_a"'));

  const probe = fastestProbe();
  const second = harness({ winnerCache, probe });
  second.account.bootstrapRelaySession.mockResolvedValue(bootstrapResult({ selection: selection({ preferredHonored: true }) }));
  await second.transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  expect(second.account.bootstrapRelaySession).toHaveBeenCalledWith(expect.objectContaining({ preferredRelayId: 'relay_a' }), expect.any(String));
  expect(probe).toHaveBeenCalledTimes(1);
  expect(probe.mock.calls[0][0]).toEqual([{ allocationId: 'allocation_a', relayUrl: 'wss://eu.relay.thandoff.com/connect' }]);
  expect(probe.mock.calls[0][1]).toEqual(expect.objectContaining({ samples: 1, budgetMs: 400 }));
});

test('a changed network fingerprint does not reuse the remembered Relay', async () => {
  const store = memoryStore();
  const winnerCache = new RelayWinnerCache({ store });
  await harness({ winnerCache, networkFingerprint: () => 'wifi' }).transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));

  const probe = fastestProbe();
  const moved = harness({ winnerCache, probe, networkFingerprint: () => 'cellular' });
  await moved.transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  expect(moved.account.bootstrapRelaySession).toHaveBeenCalledWith(expect.not.objectContaining({ preferredRelayId: expect.anything() }), expect.any(String));
  expect(probe.mock.calls[0][0]).toEqual(candidates.map(({ allocationId, relayUrl }) => ({ allocationId, relayUrl })));
});

test('all failed probes defer to the Coordinator ranking', async () => {
  const probe = jest.fn(async (targets: Array<{ allocationId: string }>) => targets.map((target) => ({ allocationId: target.allocationId, sampleCount: 2, failureCount: 2 })));
  const { account, transport } = harness({ probe });
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  expect(account.confirmRelaySession).toHaveBeenCalledWith('relay_selection_a', expect.objectContaining({ winnerAllocationId: 'allocation_a', fallback: 'server-order' }), expect.stringMatching(/^relay_confirm_/));
});

test('a failed cached-winner attach clears the cache and retries a full selection once', async () => {
  const store = memoryStore();
  const winnerCache = new RelayWinnerCache({ store });
  await winnerCache.write('control_plane_a', { relayId: 'relay_a', relayUrl: 'wss://eu.relay.thandoff.com/connect', rttMs: 11, networkFingerprint: 'default' });
  const probe = fastestProbe();
  const { account, channels, open, transport } = harness({ winnerCache, probe });
  account.bootstrapRelaySession.mockResolvedValueOnce(bootstrapResult({ selection: selection({ preferredHonored: true }) }));
  open.mockRejectedValueOnce(new MobileControlPlaneTransportError('RELAY_SOCKET_FAILED', 'failed', true));
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  expect(open).toHaveBeenCalledTimes(2);
  expect(account.bootstrapRelaySession).toHaveBeenCalledTimes(2);
  expect(account.bootstrapRelaySession).toHaveBeenLastCalledWith(expect.not.objectContaining({ preferredRelayId: 'relay_a' }), expect.any(String));
  expect(channels).toHaveLength(1);
});

test('profile cannot inject authorization, cross-origin routes or stale binding identity', async () => {
  const first = harness();
  await expect(first.transport.request('https://attacker.test/', z.any())).rejects.toMatchObject({ code: 'RELAY_ROUTE_INVALID' });
  await expect(first.transport.request('/api/health', z.any(), { headers: { authorization: 'Bearer stolen' } })).rejects.toMatchObject({ code: 'RELAY_AUTH_HEADER_FORBIDDEN' });

  const stale = bootstrapResult();
  stale.relayTicket.bindingRevision = 1;
  const account = accountStub() as any;
  account.bootstrapRelaySession.mockResolvedValue(stale);
  const transport = new RelayControlPlaneTransport(profile, account, jest.fn(), { probeRelayCandidates: fastestProbe() as any, proofKey });
  await expect(transport.request('/api/health', z.any())).rejects.toMatchObject({ code: 'RELAY_TARGET_IDENTITY_CHANGED' });
});

test('event topic updates are sent in place without reconnecting the channel', async () => {
  const { channels, open, transport } = harness();
  await transport.request('/api/bootstrap', z.object({ data: z.object({ ok: z.literal(true) }) }));
  const connection = transport.connectEvents({ topics: ['ai.sessions'], onOpen() {}, onEvent() {}, onError() {}, onClose() {} });
  await Promise.resolve();
  connection.updateTopics!(['nodes']);
  expect(channels[0].channel.send).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'event-subscribe',
    body: expect.objectContaining({ eventEnvelopeVersion: COMPACT_EVENT_ENVELOPE_VERSION, topics: ['nodes'], metricInstanceIds: [] }),
  }));
  expect(open).toHaveBeenCalledTimes(1);
  connection.close();
});
