import nacl from 'tweetnacl';
import {
  RELAY_SESSION_PROTOCOL_VERSION,
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
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 15 * 60_000).toISOString();
  const authority = {
    accountId: 'account_a',
    deviceSessionId: 'device_a',
    controlPlaneId: 'control_plane_a',
    bindingId: 'binding_a',
    bindingRevision: 1,
  };
  return {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: 'task-handoff:relay-session-grant',
    sessionId: 'session_a',
    grantId: 'grant_a',
    generation: 1,
    allocationId: 'allocation_a',
    accessTicketId: 'access_ticket_a',
    relayId: 'relay_a',
    relayRegion: 'cn-north-test-1',
    relayUrl: 'wss://relay.example.test/connect',
    ...authority,
    ownerAccountId: 'account_a',
    accessMode: 'owner',
    accessRoleId: 'role_admin',
    targetPublicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
    clientProofPublicKey,
    controlPlaneProofPublicKey: 'p'.repeat(43),
    trafficClass: 'interactive',
    sessionTranscriptTicket: {
      protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
      audience: 'task-handoff:relay-session-transcript',
      transcriptTicketId: 'rtt_ticket_a',
      ...authority,
      ownerAccountId: 'account_a',
      accessMode: 'owner',
      accessRoleId: 'role_admin',
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

test('restores one installation proof key across app instances, accounts, and logs in', async () => {
  const secureStore = memorySecureStore();
  const first = new MobileRelayProofKeyProvider(secureStore);
  const publicKey = await first.publicKey();
  const restored = new MobileRelayProofKeyProvider(secureStore);
  await expect(restored.publicKey()).resolves.toBe(publicKey);

  const afterReauthentication = new MobileRelayProofKeyProvider(secureStore);
  await expect(afterReauthentication.publicKey()).resolves.toBe(publicKey);

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
  const proofKey = [...secureStore.values.entries()].find(([key]) => key.includes('device-proof'))!;
  const sessionKey = [...secureStore.values.entries()].find(([key]) => key.includes('.session.'))!;
  expect(proofKey[0]).not.toBe(sessionKey[0]);
  expect(sessionKey[1]).not.toContain(proofKey[1]);
  expect(JSON.parse(sessionKey[1])).not.toHaveProperty('privateKey');
  expect(JSON.parse(sessionKey[1])).not.toHaveProperty('secretKey');
  expect(JSON.parse(sessionKey[1])).not.toHaveProperty('seed');
});

test('replaces a corrupt proof seed instead of reusing it', async () => {
  const secureStore = memorySecureStore();
  const original = new MobileRelayProofKeyProvider(secureStore);
  const originalPublicKey = await original.publicKey();
  const proofEntry = [...secureStore.values.keys()].find((key) => key.includes('device-proof'))!;
  secureStore.values.set(proofEntry, 'corrupt');

  const recovered = new MobileRelayProofKeyProvider(secureStore);
  const recoveredPublicKey = await recovered.publicKey();
  expect(recoveredPublicKey).not.toBe(originalPublicKey);
  expect(secureStore.values.get(proofEntry)).not.toBe('corrupt');
});

test('does not replace an unreadable proof seed and retries after storage recovers', async () => {
  const secureStore = memorySecureStore();
  const storageKey = 'cloud.relay.device-proof.v1';
  const originalSeed = encodeBase64Url(new Uint8Array(32).fill(9));
  secureStore.values.set(storageKey, originalSeed);

  const read = secureStore.get.bind(secureStore);
  let storageUnavailable = true;
  secureStore.get = async (key) => {
    if (storageUnavailable) throw new Error('keychain unavailable');
    return read(key);
  };

  const provider = new MobileRelayProofKeyProvider(secureStore);
  await expect(provider.publicKey()).rejects.toMatchObject({ code: 'CLOUD_DEVICE_KEY_UNAVAILABLE' });
  expect(secureStore.values.get(storageKey)).toBe(originalSeed);

  storageUnavailable = false;
  await expect(provider.publicKey()).resolves.toBeDefined();
  expect(secureStore.values.get(storageKey)).toBe(originalSeed);
});

test('concurrent providers converge on one installation proof key', async () => {
  const secureStore = memorySecureStore();
  const read = secureStore.get.bind(secureStore);
  let reads = 0;
  let writes = 0;
  secureStore.get = async (key) => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return read(key);
  };
  secureStore.set = async (key, value) => {
    writes += 1;
    secureStore.values.set(key, value);
  };

  const [first, second] = await Promise.all([
    new MobileRelayProofKeyProvider(secureStore).publicKey(),
    new MobileRelayProofKeyProvider(secureStore).publicKey(),
  ]);

  expect(first).toBe(second);
  expect(reads).toBe(1);
  expect(writes).toBe(1);
});

test('does not migrate an old account-scoped proof key into the installation identity', async () => {
  const secureStore = memorySecureStore();
  const oldKey = 'cloud.relay.proof.device_a';
  const oldSeed = encodeBase64Url(new Uint8Array(32).fill(7));
  secureStore.values.set(oldKey, oldSeed);

  const installation = new MobileRelayProofKeyProvider(secureStore);
  const publicKey = await installation.publicKey();

  expect(publicKey).toBeDefined();
  expect(secureStore.values.get(oldKey)).toBe(oldSeed);
  expect(secureStore.values.get('cloud.relay.device-proof.v1')).toBeDefined();
  expect(secureStore.values.get('cloud.relay.device-proof.v1')).not.toBe(oldSeed);
});

function encodeBase64Url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
