import {
  AiSessionEventType,
  applyAiSessionStreamEvent,
  emptyAiSessionsSnapshot,
} from '../src/ai-sessions/protocol';
import { applyAiSessionStreamEvent as sharedReducer } from '@task-handoff/protocol/ai-sessions';

describe('mobile AI Session protocol boundary', () => {
  test('exports the shared reducer rather than a mobile copy', () => {
    expect(applyAiSessionStreamEvent).toBe(sharedReducer);
  });

  test('applies the shared snapshot contract unchanged', () => {
    const generatedAt = '2026-08-05T00:00:00.000Z';
    const result = applyAiSessionStreamEvent(undefined, {
      type: AiSessionEventType.Snapshot,
      payload: {
        meta: {
          streamId: 'stream_1',
          instanceId: 'instance_1',
          revision: 1,
          traceId: 'trace_1',
          generatedAt,
          reason: 'startup',
        },
        snapshot: emptyAiSessionsSnapshot(generatedAt),
      },
    });

    expect(result.kind).toBe('applied');
    expect(result.projection?.streamId).toBe('stream_1');
    expect(result.projection?.revision).toBe(1);
  });
});
