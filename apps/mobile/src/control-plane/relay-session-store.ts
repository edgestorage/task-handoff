import { RelaySessionGrantSchema, type RelaySessionGrant } from '@task-handoff/cloud-contracts/mobile';

import type { SecureValueStore } from '../platform/secure-storage';

export type RelayPendingOperation =
  | { type: 'bootstrap'; key: string; body: Record<string, unknown>; createdAt: number }
  | { type: 'confirm'; selectionId: string; key: string; body: Record<string, unknown>; createdAt: number };

export interface RelaySessionStore {
  load(): Promise<RelaySessionGrant | undefined>;
  save(grant: RelaySessionGrant): Promise<void>;
  clear(): Promise<void>;
  loadPending?(): Promise<RelayPendingOperation | undefined>;
  savePending?(operation: RelayPendingOperation): Promise<void>;
  clearPending?(): Promise<void>;
}

/**
 * Persists only the Coordinator-signed grant. The proof private key lives in a
 * separate secure-store entry, so a copied grant remains useless without this
 * device's key.
 */
export class MobileRelaySessionStore implements RelaySessionStore {
  private readonly storageKey: string;
  private readonly pendingKey: string;

  constructor(private readonly secureStore: SecureValueStore, accountSessionId: string, controlPlaneId: string) {
    const scope = `${safeKey(accountSessionId)}.${safeKey(controlPlaneId)}`;
    this.storageKey = `cloud.relay.session.${scope}`;
    this.pendingKey = `cloud.relay.pending.${scope}`;
  }

  async load() {
    const raw = await this.secureStore.get(this.storageKey).catch(() => undefined);
    if (!raw) return undefined;
    try {
      const parsed = RelaySessionGrantSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Corrupt or stale state must never block a fresh authorization.
    }
    await this.clear();
    return undefined;
  }

  save(grant: RelaySessionGrant) {
    return this.secureStore.set(this.storageKey, JSON.stringify(grant));
  }

  clear() {
    return this.secureStore.remove(this.storageKey);
  }

  async loadPending() {
    const raw = await this.secureStore.get(this.pendingKey).catch(() => undefined);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isPendingOperation(parsed)) return parsed;
    } catch {
      // Corrupt pending state falls back to a fresh authorization.
    }
    await this.clearPending();
    return undefined;
  }

  savePending(operation: RelayPendingOperation) {
    return this.secureStore.set(this.pendingKey, JSON.stringify(operation));
  }

  clearPending() {
    return this.secureStore.remove(this.pendingKey);
  }
}

function isPendingOperation(value: unknown): value is RelayPendingOperation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if ((candidate.type !== 'bootstrap' && candidate.type !== 'confirm')
    || typeof candidate.key !== 'string' || !candidate.key
    || !Number.isFinite(candidate.createdAt)
    || !candidate.body || typeof candidate.body !== 'object' || Array.isArray(candidate.body)) return false;
  return candidate.type === 'bootstrap' || (typeof candidate.selectionId === 'string' && Boolean(candidate.selectionId));
}

function safeKey(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
