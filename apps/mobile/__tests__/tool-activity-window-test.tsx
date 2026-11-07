import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { AiSessionTimelineActivity, AiSessionToolActivityWindow } from '@task-handoff/protocol/ai-sessions';
import { mergeMobileToolActivityWindow, useToolActivityWindow } from '../src/ai-sessions/use-tool-activity-window';
import { mobileAiSessionStore } from '../src/ai-sessions/store';

const activity = (id: string): AiSessionTimelineActivity => ({ id, turnId: 'turn', type: 'activity', activityKind: 'commandExecution', title: id, status: 'running' });
const snapshot = (id = 'a'): AiSessionToolActivityWindow => ({ sessionId: 'session', turnId: 'turn', revision: 'r1', boundaryItemId: 'answer', items: [activity(id)], total: 1, truncated: false, generatedAt: '2026-11-07T00:00:00.000Z' });
const options = { controlPlaneId: 'cp-window-test', instanceId: 'instance', sessionId: 'session', turns: [{ id: 'turn', providerTurnId: 'provider-turn' }], enabled: true, recoveryRevision: 0 };

afterEach(() => jest.restoreAllMocks());

test('window stays bounded, updates matching activities, and clears at a new assistant boundary', () => {
  const window = { ...snapshot(), status: 'ready' as const };
  const merged = mergeMobileToolActivityWindow(window, [
    { ...activity('a'), status: 'completed' },
    ...Array.from({ length: 60 }, (_, i) => activity(`new-${i}`)),
  ]);
  expect(merged.items).toHaveLength(50);
  expect(merged.total).toBe(61);
  expect(merged.truncated).toBe(true);
  const cleared = mergeMobileToolActivityWindow(merged, [{ type: 'ai-message', id: 'next-answer', turnId: 'turn', text: 'Next' }]);
  expect(cleared.items).toEqual([]);
  expect(cleared.total).toBe(0);
  expect(cleared.boundaryItemId).toBe('next-answer');
});

test('loads only on demand, deduplicates, and reacquires requested windows after recovery', async () => {
  let resolve!: (value: AiSessionToolActivityWindow) => void;
  const toolActivity = jest.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue(snapshot('recovered'));
  const client = { aiSessions: { toolActivity } } as unknown as ControlPlaneClient;
  const hook = await renderHook((props: typeof options) => useToolActivityWindow({ ...props, client }), { initialProps: options });
  expect(toolActivity).not.toHaveBeenCalled();
  await act(() => { hook.result.current.load(options.turns[0]); hook.result.current.load(options.turns[0]); });
  expect(toolActivity).toHaveBeenCalledTimes(1);
  await act(() => resolve(snapshot()));
  await waitFor(() => expect(hook.result.current.windows.turn.status).toBe('ready'));
  await act(() => hook.result.current.load(options.turns[0]));
  expect(toolActivity).toHaveBeenCalledTimes(1);
  await hook.rerender({ ...options, recoveryRevision: 1 });
  await waitFor(() => expect(hook.result.current.windows.turn.items[0].id).toBe('recovered'));
  expect(toolActivity).toHaveBeenCalledTimes(2);
  await hook.unmount();
});

test('unsupported peers issue no requests and errors can be retried', async () => {
  const toolActivity = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot());
  const client = { aiSessions: { toolActivity } } as unknown as ControlPlaneClient;
  const hook = await renderHook((props: typeof options) => useToolActivityWindow({ ...props, client }), { initialProps: { ...options, enabled: false } });
  await act(() => hook.result.current.load(options.turns[0]));
  expect(toolActivity).not.toHaveBeenCalled();
  await hook.rerender(options);
  await act(() => hook.result.current.load(options.turns[0]));
  await waitFor(() => expect(hook.result.current.windows.turn.status).toBe('error'));
  await act(() => hook.result.current.load(options.turns[0]));
  await waitFor(() => expect(hook.result.current.windows.turn.status).toBe('ready'));
  await hook.unmount();
});

test('late responses cannot cross session scopes', async () => {
  let resolve!: (value: AiSessionToolActivityWindow) => void;
  const toolActivity = jest.fn(() => new Promise<AiSessionToolActivityWindow>((done) => { resolve = done; }));
  const client = { aiSessions: { toolActivity } } as unknown as ControlPlaneClient;
  const hook = await renderHook((props: typeof options) => useToolActivityWindow({ ...props, client }), { initialProps: options });
  await act(() => hook.result.current.load(options.turns[0]));
  await hook.rerender({ ...options, sessionId: 'other' });
  await act(() => resolve(snapshot()));
  expect(hook.result.current.windows).toEqual({});
  await hook.unmount();
});

test('HTTP wins over pre-request events; subsequent WebSocket updates merge without refetch or double counts', async () => {
  let live = [activity('older')];
  jest.spyOn(mobileAiSessionStore, 'realtimeTurnTimelineItems').mockImplementation(() => live);
  const toolActivity = jest.fn().mockResolvedValue(snapshot());
  const client = { aiSessions: { toolActivity } } as unknown as ControlPlaneClient;
  const hook = await renderHook(() => useToolActivityWindow({ ...options, client }));
  await act(() => hook.result.current.load(options.turns[0]));
  await waitFor(() => expect(hook.result.current.windows.turn.status).toBe('ready'));
  expect(hook.result.current.windows.turn.items.map((item) => item.id)).toEqual(['a']);
  live = [...live, activity('next')];
  await hook.rerender({});
  expect(hook.result.current.windows.turn.items.map((item) => item.id)).toEqual(['a', 'next']);
  await hook.rerender({});
  expect(hook.result.current.windows.turn.total).toBe(2);
  expect(toolActivity).toHaveBeenCalledTimes(1);
  await hook.unmount();
});

test('events covered by a truncated in-flight snapshot are counted once and evicted activities stay evicted', async () => {
  let live: AiSessionTimelineActivity[] = [];
  jest.spyOn(mobileAiSessionStore, 'realtimeTurnTimelineItems').mockImplementation(() => live);
  let resolve!: (value: AiSessionToolActivityWindow) => void;
  const toolActivity = jest.fn(() => new Promise<AiSessionToolActivityWindow>((done) => { resolve = done; }));
  const client = { aiSessions: { toolActivity } } as unknown as ControlPlaneClient;
  const hook = await renderHook(() => useToolActivityWindow({ ...options, client }));
  await act(() => hook.result.current.load(options.turns[0]));
  live = Array.from({ length: 60 }, (_, index) => activity(`burst-${index}`));
  await act(() => resolve({ ...snapshot(), items: live.slice(-50), total: 60, truncated: true }));
  await waitFor(() => expect(hook.result.current.windows.turn.status).toBe('ready'));
  expect(hook.result.current.windows.turn.total).toBe(60);
  expect(hook.result.current.windows.turn.items.map((item) => item.id)).toEqual(live.slice(-50).map((item) => item.id));
  live = live.map((item, index) => index === 0 ? { ...item, status: 'completed' } : item);
  await hook.rerender({});
  expect(hook.result.current.windows.turn.total).toBe(60);
  expect(hook.result.current.windows.turn.items[0].id).toBe('burst-10');
  await hook.unmount();
});
