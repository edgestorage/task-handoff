import { connectionSyncPhase } from '../src/control-plane/sync-state';

describe('connectionSyncPhase', () => {
  test('keeps cached data visible when a refresh fails', () => {
    expect(connectionSyncPhase(true, { retryable: false })).toBe('stale');
    expect(connectionSyncPhase(true)).toBe('stale');
  });

  test('keeps initial loading pending for retryable or close-only failures', () => {
    expect(connectionSyncPhase(false, { retryable: true })).toBe('loading');
    expect(connectionSyncPhase(false)).toBe('loading');
  });

  test('presents a non-retryable initial failure as an error', () => {
    expect(connectionSyncPhase(false, { retryable: false })).toBe('error');
    expect(connectionSyncPhase(false, new Error('invalid response'))).toBe('error');
  });
});
