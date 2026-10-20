import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import {
  relayRoleProofSigningInput,
  RelayRoleProofSchema,
  type RelayRoleProof,
  type RelaySessionGrant,
} from '@task-handoff/cloud-contracts/mobile';

import type { SecureValueStore } from '../platform/secure-storage';

export interface RelayProofKeyProvider {
  publicKey(): Promise<string>;
  proof(grant: RelaySessionGrant): Promise<RelayRoleProof>;
}

type KeyMaterial = { publicKey: string; secretKey: Uint8Array };

/**
 * The Relay grant proves authorization, not bearer possession. This key is the
 * mobile half of that proof-of-possession pair. It is device-bound and stored in
 * the same OS keychain-backed store as the account refresh credential so an app
 * restart can still resume a grant that the Coordinator has not expired.
 */
export class MobileRelayProofKeyProvider implements RelayProofKeyProvider {
  private material?: Promise<KeyMaterial>;
  private readonly storageKey: string;

  constructor(private readonly secureStore: SecureValueStore, accountSessionId: string) {
    this.storageKey = `cloud.relay.proof.${accountSessionId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  }

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

  private load() {
    this.material ??= this.loadOrCreate();
    return this.material;
  }

  private async loadOrCreate(): Promise<KeyMaterial> {
    const stored = await this.secureStore.get(this.storageKey).catch(() => undefined);
    const seed = stored ? decodeSeed(stored) : undefined;
    if (seed) return materialFromSeed(seed);

    const generated = Crypto.getRandomValues(new Uint8Array(nacl.sign.seedLength));
    await this.secureStore.set(this.storageKey, base64Url(generated)).catch(() => undefined);
    return materialFromSeed(generated);
  }
}

/** Used only by callers that deliberately keep a grant in memory for one app session. */
export function createEphemeralRelayProofKey(): RelayProofKeyProvider {
  const seed = Crypto.getRandomValues(new Uint8Array(nacl.sign.seedLength));
  const material = materialFromSeed(seed);
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
