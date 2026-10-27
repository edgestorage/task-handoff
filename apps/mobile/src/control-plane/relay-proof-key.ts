import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import {
  CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
  CloudDeviceAuthSchema,
  cloudDeviceAuthSigningInput,
  relayRoleProofSigningInput,
  RelayRoleProofSchema,
  type CloudDeviceDescriptor,
  type CloudDeviceAuth,
  type CloudDeviceCredential,
  type RelayRoleProof,
  type RelaySessionGrant,
} from '@task-handoff/cloud-contracts/mobile';

import type { SecureValueStore } from '../platform/secure-storage';
import { mobileDeviceIdentity } from './mobile-device';

export interface RelayProofKeyProvider {
  publicKey(): Promise<string>;
  proof(grant: RelaySessionGrant): Promise<RelayRoleProof>;
  deviceAuth(input: DeviceAuthInput): Promise<CloudDeviceAuth>;
  deviceDescriptor(): Promise<CloudDeviceDescriptor>;
}

export type DeviceAuthInput = Readonly<{
  ticket: CloudDeviceCredential;
  grant: RelaySessionGrant;
  clientEphemeralPublicKey: string;
  trustRetry?: true;
}>;

type KeyMaterial = { publicKey: string; secretKey: Uint8Array };

const keyInitializations = new WeakMap<SecureValueStore, Map<string, Promise<KeyMaterial>>>();

/**
 * The Relay grant proves authorization, not bearer possession. This key is the
 * mobile half of that proof-of-possession pair. It is device-bound and stored in
 * the same OS keychain-backed store as the account refresh credential so an app
 * restart can still resume a grant that the Coordinator has not expired.
 */
export class MobileRelayProofKeyProvider implements RelayProofKeyProvider {
  private material?: Promise<KeyMaterial>;
  private readonly storageKey = 'cloud.relay.device-proof.v1';

  constructor(private readonly secureStore: SecureValueStore) {}

  publicKey() {
    return this.load().then((key) => key.publicKey);
  }

  async proof(grant: RelaySessionGrant): Promise<RelayRoleProof> {
    const key = await this.load();
    const payload = {
      protocolVersion: grant.protocolVersion,
      role: 'client' as const,
      sessionId: grant.sessionId,
      grantId: grant.grantId,
      generation: grant.generation,
      allocationId: grant.allocationId,
      relayId: grant.relayId,
      nonce: base64Url(Crypto.getRandomValues(new Uint8Array(24))),
      issuedAt: new Date().toISOString(),
    };
    const signature = nacl.sign.detached(
      new TextEncoder().encode(relayRoleProofSigningInput(payload)),
      key.secretKey,
    );
    return RelayRoleProofSchema.parse({ ...payload, signature: base64Url(signature) });
  }

  async deviceDescriptor() {
    return (await mobileDeviceIdentity(this.secureStore)).descriptor;
  }

  async deviceAuth(input: DeviceAuthInput): Promise<CloudDeviceAuth> {
    const key = await this.load();
    const device = await this.deviceDescriptor();
    const signature = nacl.sign.detached(
      new TextEncoder().encode(cloudDeviceAuthSigningInput({ ...input, device })),
      key.secretKey,
    );
    return CloudDeviceAuthSchema.parse({
      protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
      device,
      signature: base64Url(signature),
    });
  }

  private load() {
    if (!this.material) {
      const loading = loadOrCreateKeyMaterial(this.secureStore, this.storageKey);
      this.material = loading;
      loading.catch(() => {
        if (this.material === loading) this.material = undefined;
      });
    }
    return this.material;
  }
}

function loadOrCreateKeyMaterial(secureStore: SecureValueStore, storageKey: string): Promise<KeyMaterial> {
  let byKey = keyInitializations.get(secureStore);
  if (!byKey) {
    byKey = new Map();
    keyInitializations.set(secureStore, byKey);
  }
  const existing = byKey.get(storageKey);
  if (existing) return existing;

  const loading = readOrCreateKeyMaterial(secureStore, storageKey);
  byKey.set(storageKey, loading);
  const settle = () => {
    if (byKey?.get(storageKey) === loading) byKey.delete(storageKey);
  };
  loading.then(settle, settle);
  return loading;
}

async function readOrCreateKeyMaterial(secureStore: SecureValueStore, storageKey: string): Promise<KeyMaterial> {
  let stored: string | undefined;
  try {
    stored = await secureStore.get(storageKey);
  } catch {
    throw deviceKeyUnavailable('The installation device key could not be read.');
  }

  const seed = stored ? decodeSeed(stored) : undefined;
  if (seed) return materialFromSeed(seed);

  const generated = Crypto.getRandomValues(new Uint8Array(nacl.sign.seedLength));
  try {
    await secureStore.set(storageKey, base64Url(generated));
  } catch {
    throw deviceKeyUnavailable('The installation device key could not be persisted.');
  }
  return materialFromSeed(generated);
}

function deviceKeyUnavailable(message: string) {
  return Object.assign(new Error(message), { code: 'CLOUD_DEVICE_KEY_UNAVAILABLE' });
}

/** Used only by callers that deliberately keep a grant in memory for one app session. */
export function createEphemeralRelayProofKey(descriptor?: CloudDeviceDescriptor): RelayProofKeyProvider {
  const seed = Crypto.getRandomValues(new Uint8Array(nacl.sign.seedLength));
  const material = materialFromSeed(seed);
  const device = descriptor ?? { name: 'TaskHandoff test client', kind: 'mobile', platform: 'test' };
  return {
    async publicKey() { return material.publicKey; },
    async proof(grant) {
      const payload = {
        protocolVersion: grant.protocolVersion,
        role: 'client' as const,
        sessionId: grant.sessionId,
        grantId: grant.grantId,
        generation: grant.generation,
        allocationId: grant.allocationId,
        relayId: grant.relayId,
        nonce: base64Url(Crypto.getRandomValues(new Uint8Array(24))),
        issuedAt: new Date().toISOString(),
      };
      return RelayRoleProofSchema.parse({
        ...payload,
        signature: base64Url(nacl.sign.detached(
          new TextEncoder().encode(relayRoleProofSigningInput(payload)),
          material.secretKey,
        )),
      });
    },
    async deviceDescriptor() { return device; },
    async deviceAuth(input) {
      const signature = nacl.sign.detached(
        new TextEncoder().encode(cloudDeviceAuthSigningInput({ ...input, device })),
        material.secretKey,
      );
      return CloudDeviceAuthSchema.parse({
        protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
        device,
        signature: base64Url(signature),
      });
    },
  };
}

function materialFromSeed(seed: Uint8Array): KeyMaterial {
  const pair = nacl.sign.keyPair.fromSeed(seed);
  return { publicKey: base64Url(pair.publicKey), secretKey: pair.secretKey };
}

function decodeSeed(value: string) {
  try {
    const seed = fromBase64Url(value);
    return seed.byteLength === nacl.sign.seedLength ? seed : undefined;
  } catch {
    return undefined;
  }
}

function base64Url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
