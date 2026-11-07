import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { Story } from '@task-handoff/protocol/stories';
import type { MobileControlPlaneDomain } from '../src/control-plane/use-mobile-control-plane-runtime';
import { MobileStoryListController, mobileStoryListFor } from '../src/stories/list-controller';

const story: Story = {
  id: 'story_a', ownerNodeId: 'node_a', title: 'Alpha', documents: [], actions: [],
  createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z',
};
const snapshot = { stories: [story], unavailableNodeIds: [] as string[] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(list = jest.fn().mockResolvedValue(snapshot)) {
  const api = { stories: { list } } as unknown as ControlPlaneClient;
  const controller = mobileStoryListFor(api);
  let domain!: MobileControlPlaneDomain;
  const unregister = jest.fn();
  const coordinator = { register: jest.fn((value: MobileControlPlaneDomain) => { domain = value; return unregister; }) };
  return { api, list, controller, coordinator, unregister, domain: () => domain };
}

test('multiple consumers share one domain and request; a cancelled reader cannot abort other consumers', async () => {
  const pending = deferred<typeof snapshot>();
  const h = harness(jest.fn(() => pending.promise));
  const releaseList = h.controller.acquire(h.coordinator);
  const releaseApprovals = h.controller.acquire(h.coordinator);
  const started = h.domain().start(new AbortController().signal);
  const readerAbort = new AbortController();
  const cancelled = h.controller.read(readerAbort.signal);
  const rejected = expect(cancelled).rejects.toThrow();
  const approvalRead = h.controller.read();
  releaseList();
  readerAbort.abort();
  expect(h.list).toHaveBeenCalledTimes(1);
  expect(h.coordinator.register).toHaveBeenCalledTimes(1);
  expect(h.list.mock.calls[0][1].aborted).toBe(false);
  pending.resolve(snapshot);
  await Promise.all([started, approvalRead, rejected]);
  expect(h.controller.snapshot().stories).toEqual([story]);
  expect(h.unregister).not.toHaveBeenCalled();
  releaseApprovals();
  expect(h.unregister).toHaveBeenCalledTimes(1);
});

test('domain startup adopts a reader request rather than duplicating the first snapshot', async () => {
  const pending = deferred<typeof snapshot>();
  const h = harness(jest.fn(() => pending.promise));
  const read = h.controller.read();
  const started = h.controller.start(new AbortController().signal);
  expect(h.list).toHaveBeenCalledTimes(1);
  pending.resolve(snapshot);
  await Promise.all([read, started]);
  h.controller.stop();
});

test('reconnect loads a fresh snapshot and ignores late results from the previous connection', async () => {
  const old = deferred<typeof snapshot>();
  const current = { stories: [{ ...story, title: 'Current' }], unavailableNodeIds: [] };
  const list = jest.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(current);
  const h = harness(list);
  const release = h.controller.acquire(h.coordinator);
  const first = h.domain().start(new AbortController().signal);
  h.domain().stop();
  expect(list.mock.calls[0][1].aborted).toBe(true);
  await h.domain().start(new AbortController().signal);
  old.resolve(snapshot);
  await first;
  expect(h.list).toHaveBeenCalledTimes(2);
  expect(await h.controller.read()).toEqual(current);
  expect(h.controller.snapshot().stories[0].title).toBe('Current');
  release();
});

test('events arriving during a request queue one follow-up snapshot; decision events do not reload the list', async () => {
  jest.useFakeTimers();
  const initial = deferred<typeof snapshot>();
  const h = harness(jest.fn().mockImplementationOnce(() => initial.promise).mockResolvedValue(snapshot));
  const release = h.controller.acquire(h.coordinator);
  try {
    const start = h.domain().start(new AbortController().signal);
    h.domain().onEvent({ type: 'story.changed', topic: 'stories' });
    h.domain().onEvent({ type: 'story.changed', topic: 'stories' });
    initial.resolve(snapshot);
    await start;
    await jest.advanceTimersByTimeAsync(100);
    expect(h.list).toHaveBeenCalledTimes(2);
    h.domain().onEvent({ type: 'story.decision.changed', topic: 'stories' });
    await jest.advanceTimersByTimeAsync(100);
    expect(h.list).toHaveBeenCalledTimes(2);
    release();
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.list).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});

test('partial snapshots retain unavailable nodes for display and authoritative recovery removes deleted Stories', async () => {
  const h = harness(jest.fn().mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ stories: [], unavailableNodeIds: ['node_a'] })
    .mockResolvedValueOnce({ stories: [], unavailableNodeIds: [] }));
  await h.controller.refresh();
  await h.controller.refresh();
  expect(h.controller.snapshot().stories).toEqual([story]);
  expect((await h.controller.read()).stories).toEqual([]);
  await h.controller.refresh();
  expect(h.controller.snapshot().stories).toEqual([]);
  h.controller.stop();
});

test('a failed shared snapshot is not silently retried by each consumer; explicit refresh recovers', async () => {
  const failure = new Error('Unavailable');
  const h = harness(jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(snapshot));
  await expect(h.controller.refresh()).rejects.toBe(failure);
  await expect(h.controller.read()).rejects.toBe(failure);
  expect(h.list).toHaveBeenCalledTimes(1);
  await h.controller.refresh();
  expect(h.controller.snapshot().phase).toBe('ready');
  expect(h.list).toHaveBeenCalledTimes(2);
  h.controller.stop();
});

test('client lifetimes have isolated snapshot ownership', () => {
  const h = harness();
  expect(mobileStoryListFor(h.api)).toBe(h.controller);
  expect(mobileStoryListFor({} as ControlPlaneClient)).not.toBe(h.controller);
  expect(new MobileStoryListController(h.api).snapshot().stories).toEqual([]);
});
