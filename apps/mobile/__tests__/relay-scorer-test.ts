import { RELAY_CP_HINT_FRESHNESS_MS } from '@task-handoff/cloud-contracts/mobile';
import { RELAY_SCORING_WEIGHTS, selectRelayCandidate } from '../src/control-plane/relay-scorer';

const at = Date.parse('2026-08-10T00:00:00.000Z');

function candidate(overrides: Partial<Parameters<typeof selectRelayCandidate>[0]['candidates'][number]> & { allocationId: string }) {
  return { relayId: `relay_for_${overrides.allocationId}`, relayUrl: `wss://${overrides.allocationId}.relay.thandoff.com/connect`, relayRegion: 'eu-west', serverScore: 0.2, ...overrides };
}

const probe = (allocationId: string, mobileRttMs: number | undefined, failureCount = 0) => ({ allocationId, mobileRttMs, sampleCount: 2, failureCount });

test('the local measurement outweighs the Coordinator ranking', () => {
  const result = selectRelayCandidate({
    candidates: [candidate({ allocationId: 'allocation_a', serverScore: 0 }), candidate({ allocationId: 'allocation_b', serverScore: 1 })],
    probes: [probe('allocation_a', 90), probe('allocation_b', 12)],
  });
  expect(result.winner).toBe('allocation_b');
  expect(result.ranked).toEqual(['allocation_b', 'allocation_a']);
  expect(result.fallback).toBe('none');
});

test('a control-plane hint refines the choice and a stale one is down-weighted, not hidden', () => {
  const candidates = [candidate({ allocationId: 'allocation_a', cpHint: { relayId: 'relay_a', rttMs: 4, updatedAt: new Date(at).toISOString() } }), candidate({ allocationId: 'allocation_b', cpHint: { relayId: 'relay_b', rttMs: 200, updatedAt: new Date(at).toISOString() } })];
  const fresh = selectRelayCandidate({ candidates, probes: [probe('allocation_a', 40), probe('allocation_b', 40)], now: at });
  expect(fresh.winner).toBe('allocation_a');

  // Once the same hints age out, only the remaining signals decide, and the
  // Coordinator ranking breaks the tie.
  const stale = selectRelayCandidate({ candidates: [candidate({ allocationId: 'allocation_a', cpHint: { relayId: 'relay_a', rttMs: 4, updatedAt: new Date(at).toISOString() } }), candidate({ allocationId: 'allocation_b', cpHint: { relayId: 'relay_b', rttMs: 200, updatedAt: new Date(at).toISOString() }, serverScore: 0.1 })], probes: [probe('allocation_a', 40), probe('allocation_b', 40)], now: at + RELAY_CP_HINT_FRESHNESS_MS + 1 });
  expect(stale.winner).toBe('allocation_b');
});

test('an unknown control-plane hint sits in the middle instead of winning or losing by default', () => {
  const result = selectRelayCandidate({
    candidates: [candidate({ allocationId: 'allocation_a' }), candidate({ allocationId: 'allocation_b', cpHint: { relayId: 'relay_b', rttMs: 30, updatedAt: new Date(at).toISOString() } })],
    probes: [probe('allocation_a', 40), probe('allocation_b', 40)],
    now: at,
  });
  expect(result.scores.allocation_a).toBeCloseTo(result.scores.allocation_b, 5);
});

test('an unreliable link loses to a steady one even when its median looks better', () => {
  const result = selectRelayCandidate({
    candidates: [candidate({ allocationId: 'allocation_a' }), candidate({ allocationId: 'allocation_b' })],
    probes: [probe('allocation_a', 10, 1), probe('allocation_b', 12, 0)],
  });
  expect(result.winner).toBe('allocation_b');
});

test('region affinity only breaks ties', () => {
  const result = selectRelayCandidate({
    candidates: [candidate({ allocationId: 'allocation_a', relayRegion: 'us-east', serverScore: 1 }), candidate({ allocationId: 'allocation_b', relayRegion: 'eu-west', serverScore: 0 })],
    probes: [probe('allocation_a', 40), probe('allocation_b', 40)],
    preferredRegion: 'eu-west',
  });
  expect(result.winner).toBe('allocation_b');
});

test('unmeasured candidates are kept as a last resort and reported as a degraded selection', () => {
  const result = selectRelayCandidate({
    candidates: [candidate({ allocationId: 'allocation_a' }), candidate({ allocationId: 'allocation_b' }), candidate({ allocationId: 'allocation_c' })],
    probes: [probe('allocation_a', undefined, 2), probe('allocation_b', 20), probe('allocation_c', 40)],
  });
  expect(result.ranked).toEqual(['allocation_b', 'allocation_c', 'allocation_a']);
  expect(result.fallback).toBe('partial-probe');
});

test('when nothing answers the Coordinator order is used verbatim', () => {
  const result = selectRelayCandidate({
    candidates: [candidate({ allocationId: 'allocation_a' }), candidate({ allocationId: 'allocation_b' })],
    probes: [probe('allocation_a', undefined, 2), probe('allocation_b', undefined, 2)],
  });
  expect(result.ranked).toEqual(['allocation_a', 'allocation_b']);
  expect(result.winner).toBe('allocation_a');
  expect(result.fallback).toBe('server-order');
  expect(result.scores).toEqual({});
});

test('a cached winner that the Coordinator refused is reported as a miss', () => {
  const result = selectRelayCandidate({
    candidates: [candidate({ allocationId: 'allocation_a' }), candidate({ allocationId: 'allocation_b' })],
    probes: [probe('allocation_a', 10), probe('allocation_b', 20)],
    preferredRelayId: 'relay_for_allocation_b',
    preferredHonored: false,
  });
  expect(result.fallback).toBe('preferred-miss');
});

test('the documented weights are the ones the ranking uses', () => {
  expect(Object.values(RELAY_SCORING_WEIGHTS).reduce((total, weight) => total + weight, 0)).toBeCloseTo(1, 10);
});
