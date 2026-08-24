import { AppSessionEventType } from '@task-handoff/protocol/app-sessions';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import { MobileAppSessionController } from '../src/app-sessions/controller';
import { MobileAppSessionStore } from '../src/app-sessions/store';
import type { MobileControlPlaneEventHandlers, MobileControlPlaneTransport } from '../src/control-plane/transport';

const at = '2026-08-07T00:00:00.000Z';

test('app session store applies authoritative snapshot and patch events per instance', () => {
  const store = new MobileAppSessionStore();
  store.replaceSnapshot('cp-1', { updatedAt: at, instances: [] });
  store.applyStreamEvent('cp-1', {
    type: AppSessionEventType.Snapshot,
    payload: {
      meta: { streamId: 'stream-1', instanceId: 'instance-1', revision: 1, traceId: 'trace-1', generatedAt: at, reason: 'startup' },
      snapshot: { runningCount: 0, problemCount: 0, sessions: [], updatedAt: at },
    },
  });
  const result = store.applyStreamEvent('cp-1', {
    type: AppSessionEventType.Patch,
    payload: {
      meta: { streamId: 'stream-1', instanceId: 'instance-1', revision: 2, previousRevision: 1, traceId: 'trace-2', generatedAt: at, reason: 'app-session-created' },
      session: { id: 'app-session-1', appId: 'terminal', status: 'running', bindings: [] },
    },
  });

  expect(result.kind).toBe('applied');
  expect(store.profile('cp-1').snapshot?.instances[0].appSessions).toEqual(expect.objectContaining({ runningCount: 1 }));
  expect(store.profile('cp-1').snapshot?.instances[0].appSessions.sessions[0]).toEqual(expect.objectContaining({ id: 'app-session-1', appId: 'terminal' }));
});

test('app session store exposes stream gaps instead of hiding them with a local patch', () => {
  const store = new MobileAppSessionStore();
  store.replaceSnapshot('cp-1', { updatedAt: at, instances: [{ instanceId: 'instance-1', streamId: 'stream-1', revision: 1, appSessions: { runningCount: 0, problemCount: 0, sessions: [], updatedAt: at } }] });
  const result = store.applyStreamEvent('cp-1', {
    type: AppSessionEventType.Removed,
    payload: { meta: { streamId: 'stream-1', instanceId: 'instance-1', revision: 3, previousRevision: 2, traceId: 'trace-3', generatedAt: at, reason: 'app-session-deleted' }, sessionId: 'missing' },
  });
  expect(result.kind).toBe('gap');
  expect(store.profile('cp-1').snapshot?.instances[0].revision).toBe(1);
});

test('app session store applies mutation records without a full list refresh', () => {
  const store = new MobileAppSessionStore();
  store.replaceSnapshot('cp-1', {
    updatedAt: at,
    instances: [{
      instanceId: 'instance-1',
      streamId: 'stream-1',
      revision: 1,
      appSessions: {
        runningCount: 1,
        problemCount: 0,
        sessions: [{ id: 'app-session-1', appId: 'terminal', status: 'running', bindings: [] }],
        updatedAt: at,
      },
    }],
  });

  expect(store.upsertSession('cp-1', 'instance-1', {
    id: 'app-session-1', appId: 'terminal', title: 'Renamed', status: 'running', bindings: [], updatedAt: '2026-08-07T00:01:00.000Z',
  })).toBe(true);
  expect(store.profile('cp-1').snapshot?.instances[0].appSessions.sessions[0]).toEqual(expect.objectContaining({ title: 'Renamed' }));

  store.upsertSession('cp-1', 'instance-1', {
    id: 'app-session-1', appId: 'terminal', status: 'stopped', bindings: [], updatedAt: '2026-08-07T00:02:00.000Z',
  });
  expect(store.profile('cp-1').snapshot?.instances[0].appSessions.sessions).toEqual([]);
});

test('an older App Session HTTP snapshot cannot overwrite a newer stream projection', () => {
  const store = new MobileAppSessionStore();
  const initial = { updatedAt: at, instances: [{ instanceId: 'instance-1', streamId: 'stream-1', revision: 1, appSessions: { runningCount: 0, problemCount: 0, sessions: [], updatedAt: at } }] };
  store.replaceSnapshot('cp-1', initial);
  store.applyStreamEvent('cp-1', {
    type: AppSessionEventType.Patch,
    payload: {
      meta: { streamId: 'stream-1', instanceId: 'instance-1', revision: 2, previousRevision: 1, traceId: 'trace-newer', generatedAt: '2026-08-07T00:01:00.000Z', reason: 'app-session-created' },
      session: { id: 'app-session-1', appId: 'terminal', status: 'running', bindings: [] },
    },
  });

  store.replaceSnapshot('cp-1', initial);

  expect(store.profile('cp-1').snapshot?.instances[0].revision).toBe(2);
  expect(store.profile('cp-1').snapshot?.instances[0].appSessions.sessions).toHaveLength(1);
});

test('app sessions reload a snapshot and reconnect after the event socket closes', async () => {
  jest.useFakeTimers();
  try {
    const store = new MobileAppSessionStore();
    const snapshot = { updatedAt: at, instances: [] };
    const list = jest.fn().mockResolvedValue(snapshot);
    const handlers: MobileControlPlaneEventHandlers[] = [];
    const client = { appSessions: { list } } as unknown as ControlPlaneClient;
    const transport = {
      revalidate: jest.fn().mockResolvedValue(undefined),
      connectEvents(next: MobileControlPlaneEventHandlers) { handlers.push(next); return { close: jest.fn() }; },
    } as unknown as MobileControlPlaneTransport;
    const controller = new MobileAppSessionController('cp-reconnect', client, transport, store);

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

test('app sessions explicitly refresh from the authoritative snapshot endpoint', async () => {
  const store = new MobileAppSessionStore();
  const initial = { updatedAt: at, instances: [] };
  const refreshed = { updatedAt: '2026-08-07T00:01:00.000Z', instances: [] };
  const refresh = jest.fn().mockResolvedValue(refreshed);
  const client = { appSessions: { list: jest.fn().mockResolvedValue(initial), refresh } } as unknown as ControlPlaneClient;
  const transport = { connectEvents: jest.fn(() => ({ close: jest.fn() })) } as unknown as MobileControlPlaneTransport;
  const controller = new MobileAppSessionController('cp-refresh', client, transport, store);

  await controller.start();
  await controller.refresh();

  expect(refresh).toHaveBeenCalledTimes(1);
  expect(store.profile('cp-refresh').snapshot?.updatedAt).toBe(refreshed.updatedAt);
  controller.stop();
});
