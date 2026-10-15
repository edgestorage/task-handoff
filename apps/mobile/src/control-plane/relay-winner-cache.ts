import type { ValueStore } from '../platform/secure-storage';

/**
 * A winning Relay stays a good answer until it stops working, so the next
 * connection reuses it instead of paying a full probe round. The entry is keyed
 * by Control Plane: two Control Planes may reach different Relays fastest.
 */
export interface RelayWinnerEntry {
  relayId: string;
  relayUrl: string;
  rttMs: number;
  selectedAt: string;
  /** Cleared when the client observes a network change, so a Wi-Fi winner is not reused on cellular. */
  networkFingerprint: string;
}

export const RELAY_WINNER_TTL_MS = 30 * 60_000;

export interface RelayWinnerCacheOptions {
  store: ValueStore;
  clock?: () => number;
  ttlMs?: number;
}

export class RelayWinnerCache {
  private readonly store: ValueStore;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  constructor(options: RelayWinnerCacheOptions) {
    this.store = options.store;
    this.clock = options.clock ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? RELAY_WINNER_TTL_MS;
  }

  static key(controlPlaneId: string) {
    return `cloud.relay.winner.${controlPlaneId}`;
  }

  /** Returns the cached winner only when it is fresh and belongs to this network. */
  async read(controlPlaneId: string, networkFingerprint: string): Promise<RelayWinnerEntry | undefined> {
    const raw = await this.store.get(RelayWinnerCache.key(controlPlaneId)).catch(() => undefined);
    if (!raw) return undefined;
    let parsed: RelayWinnerEntry;
    try {
      parsed = JSON.parse(raw) as RelayWinnerEntry;
    } catch {
      await this.clear(controlPlaneId);
      return undefined;
    }
    if (typeof parsed?.relayId !== 'string' || typeof parsed?.relayUrl !== 'string' || !Number.isFinite(parsed?.rttMs) || typeof parsed?.selectedAt !== 'string' || typeof parsed?.networkFingerprint !== 'string') {
      await this.clear(controlPlaneId);
      return undefined;
    }
    const age = this.clock() - Date.parse(parsed.selectedAt);
    if (!Number.isFinite(age) || age < 0 || age > this.ttlMs || parsed.networkFingerprint !== networkFingerprint) {
      await this.clear(controlPlaneId);
      return undefined;
    }
    return parsed;
  }

  async write(controlPlaneId: string, entry: Omit<RelayWinnerEntry, 'selectedAt'> & { selectedAt?: string }) {
    const stored: RelayWinnerEntry = { ...entry, selectedAt: entry.selectedAt ?? new Date(this.clock()).toISOString() };
    await this.store.set(RelayWinnerCache.key(controlPlaneId), JSON.stringify(stored)).catch(() => undefined);
    return stored;
  }

  async clear(controlPlaneId: string) {
    await this.store.remove(RelayWinnerCache.key(controlPlaneId)).catch(() => undefined);
  }
}
