import { z } from 'zod';
import { COMPACT_EVENT_ENVELOPE_VERSION } from '@task-handoff/protocol/events';
import type { RelaySessionGrant } from '@task-handoff/cloud-contracts/mobile';
import { RelayControlPlaneTransport, type EncryptedRelayChannel } from '../src/control-plane/relay-transport';
import type { RelayProofKeyProvider } from '../src/control-plane/relay-proof-key';
import type { RelayPendingOperation, RelaySessionStore } from '../src/control-plane/relay-session-store';
import { RelayWinnerCache } from '../src/control-plane/relay-winner-cache';
import { MobileControlPlaneTransportError } from '../src/control-plane/transport';
import type { ValueStore } from '../src/platform/secure-storage';
import type { MobileCloudRelayControlPlaneProfile } from '../src/control-plane/profile';

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
    renew: jest.fn(async (grant) => ({ generation: grant.generation, committed: true, leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString() })),
    close: jest.fn(),
    subscribe(next, closed) { listener = next; closeListener = closed; return () => undefined; },
    subscribeControl(next) { controlListener = next; return () => undefined; },
    ...overrides,
  };
  return { channel, drop: (error) => closeListener(error), control: (notice) => controlListener(notice), emit: (value) => listener(value) };
}

function harness(options: { probe?: jest.Mock; winnerCache?: RelayWinnerCache; sessionStore?: RelaySessionStore; e2eRekeyIntervalMs?: number; networkFingerprint?: () => string } = {}) {
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
