import type { CloudFetch, CloudFetchResponse } from '../src/cloud-discovery/doh';
import { queryCloudDiscoveryTxt } from '../src/cloud-discovery/doh';
import { parseCloudDiscoveryRecord } from '../src/cloud-discovery/format';
import { CloudEndpointResolver } from '../src/cloud-discovery/resolver';
import type { ValueStore } from '../src/platform/secure-storage';

const config = {
  record: '_cloud.thandoff.com',
  fallbackOrigin: 'https://cloud.thandoff.com',
  allowedHostSuffixes: ['thandoff.com'],
};

function response(status: number, body?: unknown): CloudFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function memoryStore(): ValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    available: async () => true,
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
}

function txtAnswer(value: string) {
  return { Answer: [{ type: 16, data: `"${value}"` }] };
}

describe('cloud discovery', () => {
  test('parses the versioned plain-text endpoint list', () => {
    expect(parseCloudDiscoveryRecord('v1 cloud.thandoff.com cloud-backup.thandoff.com', config)).toEqual({
      version: 'v1',
      origins: ['https://cloud.thandoff.com', 'https://cloud-backup.thandoff.com'],
    });
    expect(parseCloudDiscoveryRecord('"v1 cloud.thandoff.com " "cloud-backup.thandoff.com"', config).origins).toEqual([
      'https://cloud.thandoff.com',
      'https://cloud-backup.thandoff.com',
    ]);
  });

  test('rejects unknown versions, embedded protocols, paths, ports and untrusted suffixes', () => {
    expect(() => parseCloudDiscoveryRecord('v2 cloud.thandoff.com', config)).toThrow(/Unsupported/);
    expect(() => parseCloudDiscoveryRecord('v1 https://cloud.thandoff.com', config)).toThrow(/Invalid/);
    expect(() => parseCloudDiscoveryRecord('v1 cloud.thandoff.com/api', config)).toThrow(/Invalid/);
    expect(() => parseCloudDiscoveryRecord('v1 cloud.thandoff.com:8443', config)).toThrow(/Invalid/);
    expect(() => parseCloudDiscoveryRecord('v1 192.0.2.10', { allowedHostSuffixes: ['0.2.10'] })).toThrow(/IP addresses/);
    expect(() => parseCloudDiscoveryRecord('v1 cloud.example.com', config)).toThrow(/Untrusted/);
  });

  test('falls back to the second DoH provider when the first lookup fails', async () => {
    const fetchImpl: CloudFetch = async (input) => {
      if (input.includes('dns.alidns.com')) return response(503);
      return response(200, txtAnswer('v1 cloud.thandoff.com backup.thandoff.com'));
    };

    await expect(queryCloudDiscoveryTxt(config.record, { fetchImpl, timeoutMs: 50 })).resolves.toBe('v1 cloud.thandoff.com backup.thandoff.com');
  });

  test('chooses the first healthy endpoint and fails over safe requests to the backup', async () => {
    const calls: string[] = [];
    const fetchImpl: CloudFetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${input}`);
      if (input.includes('dns.alidns.com')) return response(200, txtAnswer('v1 primary.thandoff.com backup.thandoff.com'));
      if (input.includes('/health')) return response(200);
      if (input.startsWith('https://primary.thandoff.com/api/read')) return response(503);
      if (input.startsWith('https://backup.thandoff.com/api/read')) return response(200, { ok: true });
      return response(404);
    };
    const resolver = new CloudEndpointResolver({
      config,
      fallbackOrigin: config.fallbackOrigin,
      store: memoryStore(),
      fetchImpl,
      healthCheckPath: '/health',
      queryTimeoutMs: 50,
      healthTimeoutMs: 50,
    });

    await resolver.initialize();
    expect(resolver.activeOrigin).toBe('https://primary.thandoff.com');

    const result = await resolver.request('https://primary.thandoff.com/api/read?value=1', { method: 'GET' });
    expect(result.status).toBe(200);
    expect(resolver.activeOrigin).toBe('https://backup.thandoff.com');
    expect(calls).toContain('GET https://primary.thandoff.com/api/read?value=1');
    expect(calls).toContain('GET https://backup.thandoff.com/api/read?value=1');
  });

  test('does not replay unsafe requests across endpoints', async () => {
    const calls: string[] = [];
    const fetchImpl: CloudFetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${input}`);
      if (input.includes('dns.alidns.com')) return response(200, txtAnswer('v1 primary.thandoff.com backup.thandoff.com'));
      if (input.includes('/health')) return response(200);
      if (input.startsWith('https://primary.thandoff.com/api/write')) return response(503);
      return response(200);
    };
    const resolver = new CloudEndpointResolver({
      config,
      fallbackOrigin: config.fallbackOrigin,
      fetchImpl,
      healthCheckPath: '/health',
      queryTimeoutMs: 50,
      healthTimeoutMs: 50,
    });

    await resolver.initialize();
    const result = await resolver.request('https://primary.thandoff.com/api/write', { method: 'POST', body: '{}' });
    expect(result.status).toBe(503);
    expect(calls).toContain('POST https://primary.thandoff.com/api/write');
    expect(calls).not.toContain('POST https://backup.thandoff.com/api/write');
    expect(resolver.activeOrigin).toBe('https://backup.thandoff.com');
  });

  test('uses a valid cached endpoint list when TXT lookup fails', async () => {
    const store = memoryStore();
    store.values.set('cloud.discovery.v1', JSON.stringify({
      record: config.record,
      recordText: 'v1 primary.thandoff.com backup.thandoff.com',
      origins: ['https://primary.thandoff.com', 'https://backup.thandoff.com'],
      fetchedAt: Date.now(),
      lastGoodOrigin: 'https://backup.thandoff.com',
    }));
    const fetchImpl: CloudFetch = async (input) => {
      if (input.includes('dns.alidns.com') || input.includes('dns-query')) throw new Error('offline');
      if (input.includes('/health')) return response(200);
      return response(404);
    };
    const resolver = new CloudEndpointResolver({
      config,
      fallbackOrigin: config.fallbackOrigin,
      store,
      fetchImpl,
      healthCheckPath: '/health',
      queryTimeoutMs: 50,
      healthTimeoutMs: 50,
    });

    await resolver.initialize();
    expect(resolver.currentSource).toBe('cache');
    expect(resolver.endpoints).toEqual(['https://primary.thandoff.com', 'https://backup.thandoff.com']);
    expect(resolver.activeOrigin).toBe('https://primary.thandoff.com');
  });
});
