import { activeMobileStreamingMessage, MOBILE_MESSAGE_TURN_LIMIT, MOBILE_TIMELINE_ITEMS_PER_TURN, MobileAiSessionStore, mobileControlPlaneQueryKeys } from '../src/ai-sessions/store';
import { MobileAiSessionController } from '../src/ai-sessions/controller';
import {
  applyControlPlaneAiSessionStreamEvent,
  type ControlPlaneAiSessions,
  type ControlPlaneClient,
} from '@task-handoff/control-plane-client';
import { AiSessionDetailSchema, AiSessionEventType, AiSessionStatusSchema, AiSessionTurnIndexSchema, AiSessionUnreadEventType, type AiSessionStreamEvent } from '@task-handoff/protocol/ai-sessions';
import { supportsDirectoryAiSessionTimelineCapability } from '@task-handoff/protocol/control-plane-directory';
import type { MobileControlPlaneEventHandlers, MobileControlPlaneTransport } from '../src/control-plane/transport';

function snapshot(instanceId: string, sessionId: string): ControlPlaneAiSessions {
  const updatedAt = '2026-08-05T00:00:00.000Z';
  return {
    updatedAt,
    instances: [{
      instanceId,
      streamId: `stream-${instanceId}`,
      revision: 1,
      aiSessions: {
        runningCount: 0,
        waitingCount: 0,
        staleCount: 0,
        updatedAt,
        sessions: [{
          id: sessionId,
          providerSessionId: sessionId,
          creationSource: 'ai-session',
          agent: 'codex',
          status: 'idle',
          phase: 'unknown',
          startedAt: updatedAt,
          updatedAt,
          queue: { revision: 0, pendingCount: 0, items: [] },
          toolCallsSinceLastMessage: 0,
          subAgents: [],
          unread: false,
        }],
      },
    }],
  };
}

describe('MobileAiSessionStore identity isolation', () => {
  test('selected session detail restores compact snapshot turns, queue, and sub-agents', () => {
    const store = new MobileAiSessionStore();
    const compact = snapshot('instance-detail', 'session-detail');
    const summary = compact.instances[0].aiSessions.sessions[0];
    compact.instances[0].aiSessions.sessions[0] = {
      ...summary,
      detailRevision: 'detail-1',
      turnCount: 1,
      subAgentCount: 1,
      queue: { revision: 2, pendingCount: 1, items: [] },
    };
    store.replaceSnapshot('cp-detail', compact);
    const { unread: _unread, ...detailBase } = summary;
    const detail = AiSessionStatusSchema.parse({
      ...detailBase,
      turns: [{
        id: 'turn-1',
        status: 'completed',
        phase: 'responding',
        userPrompt: 'question',
        lastMessage: 'answer',
        startedAt: summary.startedAt,
        updatedAt: summary.updatedAt,
      }],
      subAgents: [{ threadId: 'sub-1', status: 'running', message: 'working', updatedAt: summary.updatedAt }],
      queue: {
        revision: 2,
        pendingCount: 1,
        items: [{ id: 'queue-1', message: 'next', status: 'queued', createdAt: summary.startedAt, updatedAt: summary.startedAt }],
      },
      counters: { toolCalls: 0, edits: 0, approvals: 0 },
    });

    const compactSummary = compact.instances[0].aiSessions.sessions[0];
    store.setSessionDetail('cp-detail', 'instance-detail', compactSummary, AiSessionDetailSchema.parse({
      id: detail.id,
      appBindingKeys: detail.appBindingKeys,
      cwd: detail.cwd,
      error: detail.error,
      providerMeta: detail.providerMeta,
      queue: detail.queue,
      subAgents: detail.subAgents,
    }));
    store.setSessionTurnIndex('cp-detail', 'instance-detail', compactSummary, AiSessionTurnIndexSchema.parse({
      sessionId: detail.id,
      revision: compactSummary.turnsRevision || 'turns-1',
      turns: detail.turns?.map((turn) => ({
        id: turn.id,
        providerTurnId: turn.providerTurnId,
        status: turn.status,
        phase: turn.phase,
        revision: turn.revision,
        startedAt: turn.startedAt,
        updatedAt: turn.updatedAt,
        completedAt: turn.completedAt,
        bodyRevision: `body-${turn.id}`,
      })),
    }));
    store.setSessionTurn('cp-detail', 'instance-detail', detail.id, 'body-turn-1', detail.turns![0]);

    const selected = store.sessionView('cp-detail', 'instance-detail', 'session-detail').session;
    expect(selected?.turns?.[0]?.lastMessage).toBe('answer');
    expect(selected?.queue.items[0]?.message).toBe('next');
    expect(selected?.subAgents[0]?.threadId).toBe('sub-1');

    compact.instances[0].aiSessions.sessions[0] = {
      ...compact.instances[0].aiSessions.sessions[0],
      detailRevision: 'detail-2',
      queue: { revision: 3, pendingCount: 0, items: [] },
    };
    store.replaceSnapshot('cp-detail', compact);
    const refreshed = store.session('cp-detail', 'instance-detail', 'session-detail');
    expect(refreshed?.queue).toEqual({ revision: 3, pendingCount: 0, items: [] });
    expect(refreshed?.turns?.[0]?.lastMessage).toBe('answer');
    expect(refreshed?.subAgents).toEqual([]);
  });

  test('directory timeline capabilities default old responses to unsupported and remain provider-scoped', () => {
    expect(supportsDirectoryAiSessionTimelineCapability(undefined, 'codex', 'turn-read')).toBe(false);
    expect(supportsDirectoryAiSessionTimelineCapability({ aiSessionTimeline: { turnReadAgents: ['codex'] } }, 'codex', 'turn-read')).toBe(true);
    expect(supportsDirectoryAiSessionTimelineCapability({ aiSessionTimeline: { turnReadAgents: ['codex'] } }, 'claude', 'turn-read')).toBe(false);
  });

  test('query keys include Control Plane, instance, and session identity', () => {
    expect(mobileControlPlaneQueryKeys.aiSession('cp-a', 'instance-1', 'session-1')).toEqual([
      'control-plane',
      'cp-a',
      'ai-sessions',
      'instance-1',
      'session-1',
    ]);
  });

  test('same instance and session ids remain isolated across Control Planes', () => {
    const store = new MobileAiSessionStore();
    const listenerA = jest.fn();
    const listenerB = jest.fn();
    store.subscribe('cp-a', listenerA);
    store.subscribe('cp-b', listenerB);

    store.replaceSnapshot('cp-a', snapshot('instance-1', 'session-1'));
    expect(store.session('cp-a', 'instance-1', 'session-1')?.id).toBe('session-1');
    expect(store.session('cp-b', 'instance-1', 'session-1')).toBeUndefined();
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();

    store.replaceSnapshot('cp-b', snapshot('instance-1', 'session-1'));
    store.clearProfile('cp-a');
    expect(store.session('cp-a', 'instance-1', 'session-1')).toBeUndefined();
    expect(store.session('cp-b', 'instance-1', 'session-1')?.id).toBe('session-1');
  });

  test('an older HTTP snapshot cannot overwrite a newer stream projection', () => {
    const store = new MobileAiSessionStore();
    const initial = snapshot('instance-1', 'session-1');
    store.replaceSnapshot('cp-monotonic', initial);
    const current = initial.instances[0].aiSessions.sessions[0];
    const { unread: _unread, ...protocolSession } = current;
    store.applyStreamEvent('cp-monotonic', {
      type: AiSessionEventType.Patch,
      payload: {
        meta: {
          streamId: initial.instances[0].streamId,
          instanceId: 'instance-1',
          revision: 2,
          previousRevision: 1,
          traceId: 'trace-newer',
          generatedAt: '2026-08-05T00:01:00.000Z',
          reason: 'provider-event',
        },
        upserted: [{ ...protocolSession, status: 'running', updatedAt: '2026-08-05T00:01:00.000Z' }],
        removed: [],
      },
    });

    store.replaceSnapshot('cp-monotonic', initial);

    expect(store.profile('cp-monotonic').snapshot?.instances[0].revision).toBe(2);
    expect(store.session('cp-monotonic', 'instance-1', 'session-1')?.status).toBe('running');
  });

  test('message deltas notify only their session and preserve unrelated session view snapshots', () => {
    const store = new MobileAiSessionStore();
    const initial = snapshot('instance-1', 'session-1');
    initial.instances[0].aiSessions.sessions.push({
      ...initial.instances[0].aiSessions.sessions[0],
      id: 'session-2',
      providerSessionId: 'session-2',
    });
    store.replaceSnapshot('cp-scoped', initial);
    const firstListener = jest.fn();
    const secondListener = jest.fn();
    const snapshotListener = jest.fn();
    store.subscribeSession('cp-scoped', 'instance-1', 'session-1', firstListener);
    store.subscribeSession('cp-scoped', 'instance-1', 'session-2', secondListener);
    store.subscribeSnapshot('cp-scoped', snapshotListener);
    const stableSecondView = store.sessionView('cp-scoped', 'instance-1', 'session-2');

    store.appendMessageDelta('cp-scoped', {
      instanceId: 'instance-1', sessionId: 'session-1', providerSessionId: 'session-1',
      turnId: 'turn-1', itemId: 'item-1', delta: 'hello', generatedAt: initial.updatedAt,
    });

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).not.toHaveBeenCalled();
    expect(snapshotListener).not.toHaveBeenCalled();
    expect(store.sessionView('cp-scoped', 'instance-1', 'session-2')).toBe(stableSecondView);
    expect(store.sessionView('cp-scoped', 'instance-1', 'session-1').messages[0]?.receivedText).toBe('hello');

    store.replaceSnapshot('cp-scoped', initial);
    expect(snapshotListener).toHaveBeenCalledTimes(1);
  });

  test('message retention notifies a different session when its final message is evicted', () => {
    const store = new MobileAiSessionStore();
    store.replaceSnapshot('cp-retention', snapshot('instance-1', 'session-0'));
    for (let index = 0; index < MOBILE_MESSAGE_TURN_LIMIT; index += 1) {
      store.appendMessageDelta('cp-retention', {
        instanceId: 'instance-1', sessionId: `session-${index}`, providerSessionId: `session-${index}`,
        turnId: `turn-${index}`, itemId: `item-${index}`, delta: 'x',
        generatedAt: new Date(Date.parse('2026-08-05T00:10:00.000Z') + index).toISOString(),
      });
    }
    const evictedListener = jest.fn();
    store.subscribeSession('cp-retention', 'instance-1', 'session-0', evictedListener);
    expect(store.sessionView('cp-retention', 'instance-1', 'session-0').messages).toHaveLength(1);

    store.appendMessageDelta('cp-retention', {
      instanceId: 'instance-1', sessionId: 'session-new', providerSessionId: 'session-new',
      turnId: 'turn-new', itemId: 'item-new', delta: 'new', generatedAt: '2026-08-05T00:11:00.000Z',
    });

    expect(evictedListener).toHaveBeenCalledTimes(1);
    expect(store.sessionView('cp-retention', 'instance-1', 'session-0').messages).toHaveLength(0);
  });

  test('controller initializes snapshot then consumes stream, unread, and message events', async () => {
    const store = new MobileAiSessionStore();
    const initial = snapshot('instance-1', 'session-1');
    const delta = jest.fn();
    const client = {
      auth: { session: jest.fn().mockResolvedValue({ mode: 'password', enabled: true, requiresBootstrap: false, authenticated: true }) },
      aiSessions: { list: jest.fn().mockResolvedValue(initial), delta },
    } as unknown as ControlPlaneClient;
    let handlers: MobileControlPlaneEventHandlers | undefined;
    const transport = {
      connectEvents(next: MobileControlPlaneEventHandlers) {
        handlers = next;
        return { close: jest.fn() };
      },
    } as unknown as MobileControlPlaneTransport;
    const controller = new MobileAiSessionController('cp-a', client, transport, store);
    await controller.start();
    expect(store.profile('cp-a').snapshot).toBe(initial);
    expect(handlers).toBeDefined();
    const staleHandlers = handlers;
    await controller.start();

    const current = initial.instances[0].aiSessions.sessions[0];
    const { unread: _unread, ...protocolSession } = current;
    const updatedAt = '2026-08-05T00:01:00.000Z';
    staleHandlers?.onEvent({
      type: AiSessionEventType.Patch,
      topic: 'ai.sessions',
      scope: { instanceId: 'instance-1' },
      payload: {
        meta: {
          streamId: 'stream-instance-1',
          instanceId: 'instance-1',
          revision: 2,
          previousRevision: 1,
          traceId: 'stale-epoch',
          generatedAt: updatedAt,
          reason: 'provider-event',
        },
        upserted: [{ ...protocolSession, status: 'failed', updatedAt }],
        removed: [],
      },
    });
    expect(store.session('cp-a', 'instance-1', 'session-1')?.status).toBe('idle');
    expect(controller.applyEvent({
      type: AiSessionEventType.Patch,
      topic: 'ai.sessions',
      scope: { instanceId: 'instance-1' },
      payload: {
        meta: {
          streamId: 'stream-instance-1',
          instanceId: 'instance-1',
          revision: 2,
          previousRevision: 1,
          traceId: 'trace-2',
          generatedAt: updatedAt,
          reason: 'provider-event',
        },
        upserted: [{ ...protocolSession, status: 'running', updatedAt }],
        removed: [],
      },
    })).toBe(true);
    expect(store.session('cp-a', 'instance-1', 'session-1')?.status).toBe('running');

    const patchEvent = (revision: number, previousRevision: number, status: 'running' | 'waiting' | 'idle') => ({
      type: AiSessionEventType.Patch,
      payload: {
        meta: {
          streamId: 'stream-instance-1',
          instanceId: 'instance-1',
          revision,
          previousRevision,
          traceId: `trace-${revision}`,
          generatedAt: `2026-08-05T00:0${revision}:00.000Z`,
          reason: 'provider-event' as const,
        },
        upserted: [{ ...protocolSession, status, updatedAt: `2026-08-05T00:0${revision}:00.000Z` }],
        removed: [],
      },
    });
    expect(store.applyStreamEvent('cp-a', patchEvent(2, 1, 'running')).kind).toBe('duplicate');
    expect(store.applyStreamEvent('cp-a', patchEvent(1, 0, 'idle')).kind).toBe('stale');
    expect(store.applyStreamEvent('cp-a', {
      ...patchEvent(3, 2, 'waiting'),
      payload: {
        ...patchEvent(3, 2, 'waiting').payload,
        meta: { ...patchEvent(3, 2, 'waiting').payload.meta, streamId: 'another-stream' },
      },
    }).kind).toBe('snapshot-required');

    delta.mockResolvedValue({
      streamId: 'stream-instance-1',
      instanceId: 'instance-1',
      sinceRevision: 2,
      latestRevision: 4,
      earliestRetainedRevision: 1,
      syncRequired: false,
      events: [patchEvent(3, 2, 'running'), patchEvent(4, 3, 'waiting')],
    });
    const gap = patchEvent(4, 3, 'waiting');
    expect(controller.applyEvent({ ...gap, scope: { instanceId: 'instance-1' } })).toBe(false);
    await controller.recoverInstance('instance-1');
    expect(store.profile('cp-a').snapshot?.instances[0].revision).toBe(4);
    expect(store.session('cp-a', 'instance-1', 'session-1')?.status).toBe('waiting');

    expect(controller.applyEvent({
      type: AiSessionUnreadEventType.Updated,
      topic: 'ai.sessions',
      scope: { instanceId: 'instance-1' },
      payload: {
        instanceId: 'instance-1',
        sessionId: 'session-1',
        sessionUpdatedAt: '2026-08-05T00:04:00.000Z',
        unread: true,
        updatedAt,
      },
    })).toBe(true);
    expect(store.session('cp-a', 'instance-1', 'session-1')?.unread).toBe(true);

    expect(controller.applyEvent({
      type: AiSessionEventType.MessageDelta,
      topic: 'ai.sessions',
      scope: { instanceId: 'instance-1' },
      payload: {
        instanceId: 'instance-1',
        sessionId: 'session-1',
        providerSessionId: 'session-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'hello',
        generatedAt: updatedAt,
      },
    })).toBe(true);
    expect(Object.values(store.profile('cp-a').messages)[0]?.receivedText).toBe('hello');

    expect(controller.applyEvent({
      type: AiSessionEventType.TimelineItem,
      topic: 'ai.sessions',
      scope: { instanceId: 'instance-1' },
      payload: {
        instanceId: 'instance-1',
        sessionId: 'session-1',
        providerSessionId: 'session-1',
        item: { id: 'command-1', turnId: 'provider-turn-1', type: 'activity', activityKind: 'commandExecution', title: 'Command', status: 'running', input: 'pnpm test' },
        generatedAt: updatedAt,
      },
    })).toBe(true);
    expect(store.timelineTurnState('cp-a', 'instance-1', 'session-1', { id: 'turn-1', providerTurnId: 'provider-turn-1' }).items).toEqual([
      expect.objectContaining({ id: 'command-1', status: 'running' }),
    ]);
  });

  test('turn timeline snapshots merge live lifecycle updates and become stale on reconnect', () => {
    const store = new MobileAiSessionStore();
    const turn = { id: 'turn-local', providerTurnId: 'turn-provider' };
    store.beginTurnTimeline('cp-timeline', 'instance-1', 'session-1', turn);
    store.applyTimelineItem('cp-timeline', {
      instanceId: 'instance-1', sessionId: 'session-1', providerSessionId: 'provider-session', generatedAt: '2026-08-05T00:01:00.000Z',
      item: { id: 'command-1', turnId: 'turn-provider', type: 'activity', activityKind: 'commandExecution', title: 'Command', status: 'completed', output: 'passed' },
    });
    store.resolveTurnTimeline('cp-timeline', 'instance-1', 'session-1', turn, [
      { id: 'prompt-1', turnId: 'turn-provider', type: 'user-message', text: 'Test this' },
      { id: 'command-1', turnId: 'turn-provider', type: 'activity', activityKind: 'commandExecution', title: 'Command', status: 'running' },
    ]);

    expect(store.timelineTurnState('cp-timeline', 'instance-1', 'session-1', turn)).toEqual({
      status: 'ready',
      items: [
        expect.objectContaining({ id: 'prompt-1' }),
        expect.objectContaining({ id: 'command-1', status: 'completed', output: 'passed' }),
      ],
    });
    store.recoverTimelines('cp-timeline');
    expect(store.timelineTurnState('cp-timeline', 'instance-1', 'session-1', turn).status).toBe('stale');
    expect(store.timelineRecoveryRevision('cp-timeline')).toBe(1);
  });

  test('reconnect preserves live-only timeline items until an authoritative reader can replace them', () => {
    const store = new MobileAiSessionStore();
    const turn = { id: 'turn-local', providerTurnId: 'turn-provider' };
    store.applyTimelineItem('cp-live-only', {
      instanceId: 'instance-1', sessionId: 'session-1', providerSessionId: 'provider-session', generatedAt: '2026-08-05T00:01:00.000Z',
      item: { id: 'command-1', turnId: 'turn-provider', type: 'activity', activityKind: 'commandExecution', title: 'Command', status: 'running' },
    });

    store.recoverTimelines('cp-live-only');

    expect(store.timelineTurnState('cp-live-only', 'instance-1', 'session-1', turn).items).toEqual([
      expect.objectContaining({ id: 'command-1', status: 'running' }),
    ]);
  });

  test('evicted live timeline items cannot return out of order', () => {
    const store = new MobileAiSessionStore();
    const base = {
      instanceId: 'instance-1', sessionId: 'session-1', providerSessionId: 'provider-session', generatedAt: '2026-08-05T00:01:00.000Z',
    };
    for (let index = 0; index <= MOBILE_TIMELINE_ITEMS_PER_TURN; index += 1) {
      store.applyTimelineItem('cp-eviction', {
        ...base,
        item: { id: `activity-${index}`, turnId: 'turn-1', type: 'activity', activityKind: 'commandExecution', title: 'Command' },
      });
    }
    store.applyTimelineItem('cp-eviction', {
      ...base,
      item: { id: 'activity-0', turnId: 'turn-1', type: 'activity', activityKind: 'commandExecution', title: 'Late duplicate' },
    });

    const items = store.timelineTurnState('cp-eviction', 'instance-1', 'session-1', { id: 'turn-1' }).items;
    expect(items).toHaveLength(MOBILE_TIMELINE_ITEMS_PER_TURN);
    expect(items.some((item) => item.id === 'activity-0')).toBe(false);
    expect(items.at(0)?.id).toBe('activity-1');
  });

  test('Web projection and React Native store converge for the same reducer sequence', () => {
    const initial = snapshot('instance-contract', 'session-contract');
    const base = initial.instances[0].aiSessions.sessions[0];
    const { unread: _unread, ...protocolSession } = base;
    const patch: AiSessionStreamEvent = {
      type: AiSessionEventType.Patch,
      payload: {
        meta: {
          streamId: initial.instances[0].streamId,
          instanceId: 'instance-contract',
          revision: 2,
          previousRevision: 1,
          traceId: 'contract-patch',
          generatedAt: '2026-08-05T00:02:00.000Z',
          reason: 'provider-event' as const,
        },
        upserted: [{ ...protocolSession, status: 'running' as const, updatedAt: '2026-08-05T00:02:00.000Z' }],
        removed: [],
      },
    };
    const removed: AiSessionStreamEvent = {
      type: AiSessionEventType.Removed,
      payload: {
        meta: {
          streamId: initial.instances[0].streamId,
          instanceId: 'instance-contract',
          revision: 3,
          previousRevision: 2,
          traceId: 'contract-removed',
          generatedAt: '2026-08-05T00:03:00.000Z',
          reason: 'provider-event' as const,
        },
        sessionIds: ['session-contract'],
        expiresAt: '2026-08-05T01:03:00.000Z',
      },
    };

    let webEntry = initial.instances[0];
    for (const event of [patch, removed]) {
      webEntry = applyControlPlaneAiSessionStreamEvent(webEntry, event).entry!;
    }
    const nativeStore = new MobileAiSessionStore();
    nativeStore.replaceSnapshot('cp-contract', initial);
    for (const event of [patch, removed]) nativeStore.applyStreamEvent('cp-contract', event);

    expect(nativeStore.profile('cp-contract').snapshot?.instances[0]).toEqual(webEntry);
  });

  test('bounds streaming messages to the newest 50 turns per Control Plane profile', () => {
    const store = new MobileAiSessionStore();
    store.replaceSnapshot('cp-bounded', snapshot('instance-1', 'session-1'));
    for (let index = 0; index < 205; index += 1) {
      store.appendMessageDelta('cp-bounded', {
        instanceId: 'instance-1', sessionId: 'session-1', providerSessionId: 'provider-1',
        turnId: `turn-${index}`, itemId: `item-${index}`, delta: 'x',
        generatedAt: new Date(Date.parse('2026-08-05T00:10:00.000Z') + index).toISOString(),
      });
    }
    const messages = Object.values(store.profile('cp-bounded').messages);
    expect(new Set(messages.map((message) => message.turnId)).size).toBe(MOBILE_MESSAGE_TURN_LIMIT);
    expect(messages.at(-1)?.turnId).toBe('turn-204');
  });

  test('snapshot recovery restores only active streaming turns', () => {
    const initial = snapshot('instance-many', 'session-many');
    const template = initial.instances[0].aiSessions.sessions[0];
    initial.instances[0].aiSessions.sessions = Array.from({ length: 80 }, (_, index) => {
      const active = index === 79;
      const turnId = active ? 'turn-active' : `turn-${index}`;
      return {
        ...template,
        id: `session-${index}`,
        providerSessionId: `provider-${index}`,
        status: active ? 'running' as const : 'idle' as const,
        phase: active ? 'responding' as const : 'unknown' as const,
        activeTurnId: turnId,
        turns: [{
          id: turnId,
          userPrompt: `Prompt ${index}`,
          lastMessage: `Response ${index}`,
          lastMessageItemId: `item-${index}`,
          status: active ? 'running' as const : 'completed' as const,
          phase: 'responding' as const,
          revision: 1,
          startedAt: new Date(Date.parse(initial.updatedAt) + index).toISOString(),
          updatedAt: new Date(Date.parse(initial.updatedAt) + index).toISOString(),
        }],
      };
    });
    const store = new MobileAiSessionStore();

    store.replaceSnapshot('cp-many', initial);

    expect(Object.values(store.profile('cp-many').messages)).toEqual([
      expect.objectContaining({ turnId: 'turn-active', status: 'streaming', receivedText: 'Response 79' }),
    ]);
  });

  test('restores an active streaming message from an authoritative snapshot before later deltas arrive', () => {
    const initial = snapshot('instance-snapshot', 'session-snapshot');
    const current = initial.instances[0].aiSessions.sessions[0];
    current.status = 'running';
    current.phase = 'responding';
    current.activeTurnId = 'turn-snapshot';
    current.turns = [{
      id: 'turn-snapshot',
      userPrompt: 'Explain the result',
      lastMessage: 'Partial response',
      lastMessageItemId: 'item-snapshot',
      status: 'running',
      phase: 'responding',
      revision: 1,
      startedAt: initial.updatedAt,
      updatedAt: initial.updatedAt,
    }];
    const store = new MobileAiSessionStore();

    store.replaceSnapshot('cp-snapshot', initial);
    const restored = Object.values(store.profile('cp-snapshot').messages);

    expect(restored).toEqual([expect.objectContaining({
      instanceId: 'instance-snapshot',
      sessionId: 'session-snapshot',
      turnId: 'turn-snapshot',
      itemId: 'item-snapshot',
      receivedText: 'Partial response',
      status: 'streaming',
    })]);
  });

  test('keeps the newly created assistant item active when an older item receives a late delta', () => {
    const store = new MobileAiSessionStore();
    store.replaceSnapshot('cp-active', snapshot('instance-1', 'session-1'));
    const append = (itemId: string, delta: string, generatedAt: string) => store.appendMessageDelta('cp-active', {
      instanceId: 'instance-1', sessionId: 'session-1', providerSessionId: 'provider-1',
      turnId: 'turn-1', itemId, delta, generatedAt,
    });
    append('item-old', 'old', '2026-08-05T00:10:00.000Z');
    append('item-new', 'new', '2026-08-05T00:10:01.000Z');
    append('item-old', ' late', '2026-08-05T00:10:02.000Z');

    const active = activeMobileStreamingMessage(Object.values(store.profile('cp-active').messages), 'turn-1');
    expect(active).toEqual(expect.objectContaining({ itemId: 'item-new', receivedText: 'new' }));
  });

  test('reconnects snapshot-first after an event socket closes while the app remains active', async () => {
    jest.useFakeTimers();
    try {
      const store = new MobileAiSessionStore();
      const list = jest.fn().mockResolvedValue(snapshot('instance-reconnect', 'session-reconnect'));
      const client = { auth: { session: jest.fn().mockResolvedValue({ mode: 'password', enabled: true, requiresBootstrap: false, authenticated: true }) }, aiSessions: { list } } as unknown as ControlPlaneClient;
      const handlers: MobileControlPlaneEventHandlers[] = [];
      const transport = {
        revalidate: jest.fn().mockResolvedValue(undefined),
        connectEvents(next: MobileControlPlaneEventHandlers) { handlers.push(next); return { close: jest.fn() }; },
      } as unknown as MobileControlPlaneTransport;
      const controller = new MobileAiSessionController('cp-reconnect', client, transport, store);
      await controller.start();
      handlers[0].onClose();
      expect(store.profile('cp-reconnect').sync.phase).toBe('stale');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(list).toHaveBeenCalledTimes(2);
      expect(handlers).toHaveLength(2);
      expect(transport.revalidate).toHaveBeenCalledTimes(2);
      controller.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('explicitly refreshes AI Sessions from the authoritative list snapshot', async () => {
    const store = new MobileAiSessionStore();
    const initial = snapshot('instance-refresh', 'session-before');
    const refreshed = snapshot('instance-refresh', 'session-after');
    const list = jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    const client = { auth: { session: jest.fn().mockResolvedValue({ authenticated: true }) }, aiSessions: { list } } as unknown as ControlPlaneClient;
    const transport = { connectEvents: jest.fn(() => ({ close: jest.fn() })) } as unknown as MobileControlPlaneTransport;
    const controller = new MobileAiSessionController('cp-refresh', client, transport, store);

    await controller.start();
    await controller.refresh();

    expect(list).toHaveBeenCalledTimes(2);
    expect(store.session('cp-refresh', 'instance-refresh', 'session-after')).toBeDefined();
    controller.stop();
  });
});
