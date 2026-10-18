import type { ValueStore } from '../platform/secure-storage';

export const CLOUD_DISCOVERY_CACHE_KEY = 'cloud.discovery.v1';

export type CloudDiscoveryCache = {
  record: string;
  recordText: string;
  origins: string[];
  fetchedAt: number;
  lastGoodOrigin?: string;
};

export async function readCloudDiscoveryCache(store: ValueStore): Promise<CloudDiscoveryCache | undefined> {
  try {
    const raw = await store.get(CLOUD_DISCOVERY_CACHE_KEY);
    if (!raw) return undefined;
    return parseCloudDiscoveryCache(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function writeCloudDiscoveryCache(store: ValueStore, cache: CloudDiscoveryCache) {
  await store.set(CLOUD_DISCOVERY_CACHE_KEY, JSON.stringify(cache));
}

function parseCloudDiscoveryCache(value: unknown): CloudDiscoveryCache | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const cache = value as Record<string, unknown>;
  if (typeof cache.record !== 'string' || !cache.record) return undefined;
  if (typeof cache.recordText !== 'string' || !cache.recordText) return undefined;
  if (!Array.isArray(cache.origins) || !cache.origins.every((origin) => typeof origin === 'string' && origin.length > 0)) return undefined;
  if (typeof cache.fetchedAt !== 'number' || !Number.isFinite(cache.fetchedAt)) return undefined;
  return {
    record: cache.record,
    recordText: cache.recordText,
    origins: [...cache.origins],
    fetchedAt: cache.fetchedAt,
    ...(typeof cache.lastGoodOrigin === 'string' && cache.lastGoodOrigin ? { lastGoodOrigin: cache.lastGoodOrigin } : {}),
  };
}
