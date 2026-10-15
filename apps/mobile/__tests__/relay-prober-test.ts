import { probeRelayCandidates, relayProbeUrl, RELAY_PROBE_FAST_BUDGET_MS } from '../src/control-plane/relay-prober';
import { RelayWinnerCache, RELAY_WINNER_TTL_MS } from '../src/control-plane/relay-winner-cache';
import type { ValueStore } from '../src/platform/secure-storage';

function store(): ValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, async available() { return true; }, async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); }, async remove(key) { values.delete(key); } };
}

function respond(delayMs: number, ok = true) {
  return async () => { await new Promise((resolve) => setTimeout(resolve, delayMs)); return { ok, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response; };
}

test('a probe targets the relay probe endpoint on the same origin, never the attach path', () => {
  expect(relayProbeUrl('wss://relay.thandoff.com/connect').toString()).toBe('https://relay.thandoff.com/probe');
  expect(relayProbeUrl('ws://127.0.0.1:8080/connect').toString()).toBe('http://127.0.0.1:8080/probe');
});

test('every candidate is measured in parallel, two samples each, and a slow one does not delay the others', async () => {
  const started: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const fetchImpl = (async (url: URL | RequestInfo) => {
    started.push(String(url));
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try { return await respond(Number(String(url).includes('slow') ? 60 : 5))(); } finally { inFlight -= 1; }
  }) as unknown as typeof fetch;
  const results = await probeRelayCandidates([
    { allocationId: 'allocation_fast', relayUrl: 'wss://fast.relay.thandoff.com/connect' },
    { allocationId: 'allocation_slow', relayUrl: 'wss://slow.relay.thandoff.com/connect' },
  ], { fetchImpl });
  // Both candidates are in flight together, so a slow Relay cannot serialize the
  // probe round behind it.
  expect(peakInFlight).toBe(2);
  expect(started).toHaveLength(4);
  const [fast, slow] = results;
  expect(fast.mobileRttMs).toBeGreaterThanOrEqual(0);
  expect(slow.mobileRttMs).toBeGreaterThan(fast.mobileRttMs!);
  expect(results.every((result) => result.sampleCount === 2 && result.failureCount === 0)).toBe(true);
});

test('a failing candidate is reported as failures rather than an error', async () => {
  const fetchImpl = (async (_url: URL | RequestInfo) => { throw new Error('unreachable'); }) as unknown as typeof fetch;
  const [result] = await probeRelayCandidates([{ allocationId: 'allocation_a', relayUrl: 'wss://a.relay.thandoff.com/connect' }], { fetchImpl });
  expect(result).toEqual({ allocationId: 'allocation_a', sampleCount: 2, failureCount: 2 });
});

test('a non-2xx or untrusted candidate never becomes a candidate with a latency', async () => {
  const fetchImpl = (async () => respond(0, false)()) as unknown as typeof fetch;
  const [unhealthy] = await probeRelayCandidates([{ allocationId: 'allocation_a', relayUrl: 'wss://a.relay.thandoff.com/connect' }], { fetchImpl });
  expect(unhealthy.mobileRttMs).toBeUndefined();
  const called: string[] = [];
  const recording = (async (url: URL | RequestInfo) => { called.push(String(url)); return respond(0)(); }) as unknown as typeof fetch;
  const [untrusted] = await probeRelayCandidates([{ allocationId: 'allocation_b', relayUrl: 'wss://attacker.test/connect' }], { fetchImpl: recording, allowRelayUrl: (url) => url.hostname.endsWith('.relay.thandoff.com') });
  expect(called).toEqual([]);
  expect(untrusted).toEqual({ allocationId: 'allocation_b', sampleCount: 0, failureCount: 1 });
});

test('a silent candidate is cut off by the probe budget instead of the request timeout', async () => {
  const fetchImpl = (async () => { await new Promise((resolve) => setTimeout(resolve, 500)); return respond(0)(); }) as unknown as typeof fetch;
  const startedAt = Date.now();
  const [result] = await probeRelayCandidates([{ allocationId: 'allocation_a', relayUrl: 'wss://a.relay.thandoff.com/connect' }], { fetchImpl, budgetMs: 60, sampleTimeoutMs: 40 });
  expect(Date.now() - startedAt).toBeLessThan(400);
  expect(result.mobileRttMs).toBeUndefined();
  expect(result.failureCount).toBeGreaterThan(0);
  expect(RELAY_PROBE_FAST_BUDGET_MS).toBeLessThan(600);
});

test('the winner cache is keyed per control plane, expires, and forgets a different network', async () => {
  const values = store();
  let now = Date.parse('2026-08-10T00:00:00.000Z');
  const cache = new RelayWinnerCache({ store: values, clock: () => now });
  await cache.write('control_plane_a', { relayId: 'relay_a', relayUrl: 'wss://a.relay.thandoff.com/connect', rttMs: 12, networkFingerprint: 'wifi' });
  expect(await cache.read('control_plane_a', 'wifi')).toMatchObject({ relayId: 'relay_a', rttMs: 12 });
  expect(await cache.read('control_plane_b', 'wifi')).toBeUndefined();
  expect(await cache.read('control_plane_a', 'cellular')).toBeUndefined();
  await cache.write('control_plane_a', { relayId: 'relay_a', relayUrl: 'wss://a.relay.thandoff.com/connect', rttMs: 12, networkFingerprint: 'wifi' });
  now += RELAY_WINNER_TTL_MS + 1;
  expect(await cache.read('control_plane_a', 'wifi')).toBeUndefined();
});

test('a corrupt cache entry is discarded rather than trusted', async () => {
  const values = store();
  const cache = new RelayWinnerCache({ store: values });
  await values.set(RelayWinnerCache.key('control_plane_a'), '{not json');
  expect(await cache.read('control_plane_a', 'default')).toBeUndefined();
  expect(values.values.has(RelayWinnerCache.key('control_plane_a'))).toBe(false);
});
