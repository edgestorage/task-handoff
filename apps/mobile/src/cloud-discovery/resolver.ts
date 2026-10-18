import { MOBILE_PUBLIC_PROVIDERS_PATH } from '@task-handoff/cloud-contracts/mobile';

import type { ValueStore } from '../platform/secure-storage';
import { readCloudDiscoveryCache, writeCloudDiscoveryCache } from './cache';
import { queryCloudDiscoveryTxt, type CloudFetch, type CloudFetchResponse } from './doh';
import { hostMatchesSuffix, parseCloudDiscoveryRecord, type CloudDiscoveryConfig } from './format';
import { defaultCloudFetch } from './transport';

export type CloudRequestFunction = (input: string, init?: RequestInit) => Promise<CloudFetchResponse>;

export type CloudEndpointResolverOptions = {
  config?: CloudDiscoveryConfig;
  fallbackOrigin: string;
  store?: ValueStore;
  fetchImpl?: CloudFetch;
  now?: () => number;
  queryTimeoutMs?: number;
  healthTimeoutMs?: number;
  healthCheckPath?: string;
  cacheMaxAgeMs?: number;
  cooldownMs?: number;
};

type DiscoverySource = 'txt' | 'cache' | 'fallback';

export class CloudEndpointResolver {
  private candidates: string[];
  private active: string;
  private lastGood?: string;
  private recordText?: string;
  private fetchedAt = 0;
  private source: DiscoverySource = 'fallback';
  private initialized?: Promise<void>;
  private refreshing?: Promise<void>;
  private readonly cooldowns = new Map<string, number>();
  private readonly config?: CloudDiscoveryConfig;
  private readonly fallbackOrigin: string;
  private readonly store?: ValueStore;
  private readonly fetchImpl: CloudFetch;
  private readonly now: () => number;
  private readonly queryTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly healthCheckPath: string;
  private readonly cacheMaxAgeMs: number;
  private readonly cooldownMs: number;

  constructor(options: CloudEndpointResolverOptions) {
    this.config = options.config;
    this.fallbackOrigin = new URL(options.config?.fallbackOrigin ?? options.fallbackOrigin).origin;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? defaultCloudFetch;
    this.now = options.now ?? Date.now;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 1_200;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 1_200;
    this.healthCheckPath = options.healthCheckPath ?? MOBILE_PUBLIC_PROVIDERS_PATH;
    this.cacheMaxAgeMs = options.cacheMaxAgeMs ?? 7 * 24 * 60 * 60_000;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.candidates = [this.fallbackOrigin];
    this.active = this.fallbackOrigin;
  }

  get enabled() {
    return Boolean(this.config);
  }

  get activeOrigin() {
    return this.active;
  }

  get endpoints() {
    return [...this.candidates];
  }

  get currentSource() {
    return this.source;
  }

  initialize() {
    this.initialized ??= this.initializeInternal();
    return this.initialized;
  }

  async refresh() {
    if (!this.config) return;
    if (!this.initialized) return this.initialize();
    await this.refreshAndSelect();
  }

  isTrustedOrigin(origin: unknown) {
    if (typeof origin !== 'string' || !origin) return false;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    const normalized = parsed.origin;
    if (normalized === this.fallbackOrigin || this.candidates.includes(normalized)) return true;
    if (parsed.protocol !== 'https:') return false;
    return Boolean(this.config?.allowedHostSuffixes.some((suffix) => hostMatchesSuffix(parsed.hostname, suffix)));
  }

  readonly request: CloudRequestFunction = async (input, init) => {
    await this.initialize();
    const method = (init?.method ?? 'GET').toUpperCase();
    const retryable = method === 'GET' || method === 'HEAD';
    const target = new URL(input, this.active);
    const path = `${target.pathname}${target.search}`;
    const candidates = this.orderedCandidates();
    let lastResponse: CloudFetchResponse | undefined;
    let lastError: unknown;

    for (let index = 0; index < candidates.length; index += 1) {
      const origin = candidates[index];
      try {
        const response = await this.fetchImpl(`${origin}${path}`, init);
        if (response.status >= 500) {
          this.markFailure(origin);
          lastResponse = response;
          if (retryable && index < candidates.length - 1) continue;
          return response;
        }
        this.markSuccess(origin);
        return response;
      } catch (error) {
        this.markFailure(origin);
        lastError = error;
        if (retryable && index < candidates.length - 1) continue;
        throw error;
      }
    }

    if (lastResponse) return lastResponse;
    throw lastError ?? Object.assign(new Error('No cloud endpoint is available.'), { code: 'CLOUD_DISCOVERY_UNAVAILABLE' });
  };

  private async initializeInternal() {
    await this.loadCache();
    if (!this.config) return;
    await this.refreshAndSelect();
  }

  private async loadCache() {
    if (!this.config || !this.store) return;
    const cache = await readCloudDiscoveryCache(this.store);
    if (!cache || cache.record !== this.config.record || this.now() - cache.fetchedAt > this.cacheMaxAgeMs) return;
    try {
      const parsed = parseCloudDiscoveryRecord(cache.recordText, this.config);
      this.candidates = [...parsed.origins];
      this.recordText = cache.recordText;
      this.fetchedAt = cache.fetchedAt;
      this.source = 'cache';
      this.lastGood = cache.lastGoodOrigin && this.candidates.includes(cache.lastGoodOrigin) ? cache.lastGoodOrigin : undefined;
      this.active = this.lastGood ?? this.candidates[0] ?? this.fallbackOrigin;
    } catch {
      // A stale or hand-edited cache is never allowed to replace the fallback.
    }
  }

  private refreshAndSelect() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.refreshRecord();
      await this.selectHealthy();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refreshRecord() {
    if (!this.config) return;
    try {
      const recordText = await queryCloudDiscoveryTxt(this.config.record, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.queryTimeoutMs,
      });
      const parsed = parseCloudDiscoveryRecord(recordText, this.config);
      this.recordText = recordText;
      this.fetchedAt = this.now();
      this.candidates = [...parsed.origins];
      this.lastGood = this.lastGood && this.candidates.includes(this.lastGood) ? this.lastGood : undefined;
      this.active = this.candidates.includes(this.active) ? this.active : this.lastGood ?? this.candidates[0] ?? this.fallbackOrigin;
      this.source = 'txt';
      await this.persistCache();
    } catch {
      // Cached values (or the fallback) stay active when DNS or validation fails.
    }
  }

  private async selectHealthy() {
    if (this.candidates.length < 2) {
      this.active = this.candidates[0] ?? this.fallbackOrigin;
      return;
    }
    const results = await Promise.all(this.candidates.map(async (origin) => ({ origin, healthy: await this.healthCheck(origin) })));
    const healthy = results.find((result) => result.healthy);
    this.active = healthy?.origin
      ?? (this.lastGood && this.candidates.includes(this.lastGood) ? this.lastGood : this.candidates[0] ?? this.fallbackOrigin);
  }

  private async healthCheck(origin: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    try {
      const response = await this.fetchImpl(`${origin}${this.healthCheckPath}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      return response.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private orderedCandidates() {
    const now = this.now();
    const available = this.candidates.filter((origin) => (this.cooldowns.get(origin) ?? 0) <= now);
    const pool = available.length ? available : this.candidates;
    const first = pool.includes(this.active) ? this.active : pool[0];
    return first ? [first, ...pool.filter((origin) => origin !== first)] : [this.fallbackOrigin];
  }

  private markSuccess(origin: string) {
    this.cooldowns.delete(origin);
    const changed = this.active !== origin || this.lastGood !== origin;
    this.active = origin;
    this.lastGood = origin;
    if (changed) void this.persistCache();
  }

  private markFailure(origin: string) {
    this.cooldowns.set(origin, this.now() + this.cooldownMs);
    if (this.active !== origin) return;
    const next = this.candidates.find((candidate) => candidate !== origin && (this.cooldowns.get(candidate) ?? 0) <= this.now());
    if (next) this.active = next;
  }

  private async persistCache() {
    if (!this.config || !this.store || !this.recordText || !this.fetchedAt) return;
    try {
      await writeCloudDiscoveryCache(this.store, {
        record: this.config.record,
        recordText: this.recordText,
        origins: [...this.candidates],
        fetchedAt: this.fetchedAt,
        ...(this.lastGood ? { lastGoodOrigin: this.lastGood } : {}),
      });
    } catch {
      // Discovery still works in memory when file storage is unavailable.
    }
  }
}
