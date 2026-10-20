import nacl from 'tweetnacl';
import {
  relayRoleProofSigningInput,
  type RelaySessionGrant,
} from '@task-handoff/cloud-contracts/mobile';

import { MobileRelayProofKeyProvider } from '../src/control-plane/relay-proof-key';
import { MobileRelaySessionStore } from '../src/control-plane/relay-session-store';
import type { SecureValueStore } from '../src/platform/secure-storage';

type NodeWebCrypto = { getRandomValues(value: Uint8Array): Uint8Array };

jest.mock('expo-crypto', () => {
  const { webcrypto } = jest.requireActual('node:crypto') as { webcrypto: NodeWebCrypto };
  return {
    __esModule: true,
    getRandomValues: (value: Uint8Array) => {
      value.set(webcrypto.getRandomValues(new Uint8Array(value.length)));
      return value;
    },
  };
});

function memorySecureStore(): SecureValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async available() { return true; },
    async get(key) { return values.get(key); },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
}

function grantFor(clientProofPublicKey: string): RelaySessionGrant {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const authority = {
    accountId: 'account_a',
    deviceSessionId: 'device_a',
    controlPlaneId: 'control_plane_a',
    bindingId: 'binding_a',
    bindingRevision: 1,
  };
  return {
    protocolVersion: '2026-10-20',
    audience: 'task-handoff:relay-session-grant',
    sessionId: 'session_a',
    grantId: 'grant_a',
    generation: 1,
    allocationId: 'allocation_a',
    relayId: 'relay_a',
    relayRegion: 'cn-north-test-1',
    relayUrl: 'wss://sz1-staging.relay.aaasu.com/connect',
    ...authority,
    targetPublicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
    clientProofPublicKey,
    controlPlaneProofPublicKey: 'p'.repeat(43),
    trafficClass: 'interactive',
    sessionTranscriptTicket: {
      protocolVersion: '2026-10-20',
      audience: 'task-handoff:relay-session-transcript',
      transcriptTicketId: 'rtt_ticket_a',
      ...authority,
      targetPublicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
      nonce: 'n'.repeat(24),
      issuedAt,
      expiresAt,
    },
    revocationEpoch: 0,
    issuedAt,
    expiresAt,
    signature: 's'.repeat(86),
  };
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

test('persists a grant only within its account and Control Plane scope and removes corrupt state', async () => {
  const secureStore = memorySecureStore();
  const store = new MobileRelaySessionStore(secureStore, 'device_a', 'control_plane_a');
  const grant = grantFor('c'.repeat(43));

  await store.save(grant);
  await expect(new MobileRelaySessionStore(secureStore, 'device_a', 'control_plane_a').load()).resolves.toEqual(grant);
  await expect(new MobileRelaySessionStore(secureStore, 'device_b', 'control_plane_a').load()).resolves.toBeUndefined();
  await expect(new MobileRelaySessionStore(secureStore, 'device_a', 'control_plane_b').load()).resolves.toBeUndefined();

  const grantKey = [...secureStore.values.keys()].find((key) => key.includes('.session.'));
  expect(grantKey).toBeDefined();
  secureStore.values.set(grantKey!, '{"protocolVersion":"old"}');
  await expect(store.load()).resolves.toBeUndefined();
  expect(secureStore.values.has(grantKey!)).toBe(false);

  const pending = { type: 'bootstrap' as const, key: 'relay_bootstrap_pending', body: { controlPlaneId: 'control_plane_a' }, createdAt: Date.now() };
  await store.savePending(pending);
  await expect(new MobileRelaySessionStore(secureStore, 'device_a', 'control_plane_a').loadPending()).resolves.toEqual(pending);
  await expect(new MobileRelaySessionStore(secureStore, 'device_a', 'control_plane_b').loadPending()).resolves.toBeUndefined();

  const pendingKey = [...secureStore.values.keys()].find((key) => key.includes('.pending.'));
  expect(pendingKey).toBeDefined();
  secureStore.values.set(pendingKey!, 'not-json');
  await expect(store.loadPending()).resolves.toBeUndefined();
  expect(secureStore.values.has(pendingKey!)).toBe(false);
});

test('restores the same proof key across app instances and verifies a fresh client proof', async () => {
  const secureStore = memorySecureStore();
  const first = new MobileRelayProofKeyProvider(secureStore, 'device_a');
  const publicKey = await first.publicKey();
  const restored = new MobileRelayProofKeyProvider(secureStore, 'device_a');
  await expect(restored.publicKey()).resolves.toBe(publicKey);

  const otherAccount = new MobileRelayProofKeyProvider(secureStore, 'device_b');
  await expect(otherAccount.publicKey()).resolves.not.toBe(publicKey);

  const grant = grantFor(publicKey);
  const proof = await restored.proof(grant);
  const signature = fromBase64Url(proof.signature);
  expect(nacl.sign.detached.verify(
    new TextEncoder().encode(relayRoleProofSigningInput(proof)),
    signature,
    fromBase64Url(publicKey),
  )).toBe(true);
  expect(proof).toMatchObject({ role: 'client', sessionId: grant.sessionId, grantId: grant.grantId, generation: grant.generation });

  await new MobileRelaySessionStore(secureStore, 'device_a', 'control_plane_a').save(grant);
  const proofKey = [...secureStore.values.entries()].find(([key]) => key.includes('.proof.'))!;
  const sessionKey = [...secureStore.values.entries()].find(([key]) => key.includes('.session.'))!;
  expect(proofKey[0]).not.toBe(sessionKey[0]);
  expect(sessionKey[1]).not.toContain(proofKey[1]);
  expect(JSON.parse(sessionKey[1])).not.toHaveProperty('privateKey');
  expect(JSON.parse(sessionKey[1])).not.toHaveProperty('secretKey');
  expect(JSON.parse(sessionKey[1])).not.toHaveProperty('seed');
});

test('replaces a corrupt proof seed instead of reusing it', async () => {
  const secureStore = memorySecureStore();
  const original = new MobileRelayProofKeyProvider(secureStore, 'device_a');
  const originalPublicKey = await original.publicKey();
  const proofEntry = [...secureStore.values.keys()].find((key) => key.includes('.proof.'))!;
  secureStore.values.set(proofEntry, 'corrupt');

  const recovered = new MobileRelayProofKeyProvider(secureStore, 'device_a');
  const recoveredPublicKey = await recovered.publicKey();
  expect(recoveredPublicKey).not.toBe(originalPublicKey);
  expect(secureStore.values.get(proofEntry)).not.toBe('corrupt');
});
