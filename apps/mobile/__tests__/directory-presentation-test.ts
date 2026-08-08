import {
  aiSessionSummary,
  connectionModeLabel,
  instanceStateLabel,
  nodeDisplayName,
  nodeStateLabel,
  nodeSummary,
  relativeObservedAt,
} from '../src/directories/presentation';

describe('directory presentation', () => {
  test('shortens only generated node names', () => {
    expect(nodeDisplayName({ id: 'node_3024be99ab9047c9b2da', name: 'node_3024be99ab9047c9b2da' })).toBe('Node 3024BE99');
    expect(nodeDisplayName({ id: 'node_local', name: 'Studio Mac' })).toBe('Studio Mac');
  });

  test('does not expose duplicate unknown node state', () => {
    expect(nodeStateLabel({ status: 'unknown', health: 'unknown' })).toBeUndefined();
    expect(nodeSummary(1, { status: 'unknown', health: 'unknown' })).toBe('1 Instance');
    expect(nodeSummary(2, { status: 'online', health: 'ok' })).toBe('2 Instances · Online');
    expect(nodeSummary(1, { status: 'online', health: 'failed' })).toBe('1 Instance · Failed');
  });

  test('normalizes lifecycle, health, and connectivity into one state', () => {
    expect(instanceStateLabel({ status: 'running', health: 'ok', connectionStatus: 'online' })).toBe('Running');
    expect(instanceStateLabel({ status: 'running', health: 'ok', connectionStatus: 'offline' })).toBe('Offline');
    expect(instanceStateLabel({ status: 'running', health: 'degraded', connectionStatus: 'online' })).toBe('Needs attention');
    expect(instanceStateLabel({ status: 'failed', health: 'unknown', connectionStatus: 'unknown' })).toBe('Failed');
  });

  test('shows meaningful AI counts and omits empty zero-active noise', () => {
    const base = { idleCount: 0, staleCount: 0, updatedAt: '2026-08-06T00:00:00.000Z' };
    expect(aiSessionSummary({ ...base, runningCount: 0, waitingCount: 0, problemCount: 0 })).toBe('');
    expect(aiSessionSummary({ ...base, runningCount: 2, waitingCount: 1, problemCount: 1 })).toBe('2 active · 1 waiting · 1 issue');
  });

  test('formats connection mode and relative last seen compactly', () => {
    expect(connectionModeLabel('reverse-wss')).toBe('Remote');
    const now = Date.parse('2026-08-06T00:00:00.000Z');
    expect(relativeObservedAt('2026-08-05T23:59:35.000Z', now)).toBe('Seen just now');
    expect(relativeObservedAt('2026-08-05T22:00:00.000Z', now)).toBe('Seen 2h ago');
    expect(relativeObservedAt('2026-08-05T00:00:00.000Z', now)).toBe('Seen yesterday');
  });
});
