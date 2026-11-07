import { EMPTY_RESOURCE_WORKSPACE, openRepositoryFileResource, openSessionResource, removeSessionResource, resourceContextKey, resourceLayoutMode, resourceOverlayWidth, resourcePanelWidth, ResourceWorkspaceStore, sessionResourceTopInset } from '../src/ai-sessions/resource-workspace-model';

test('resource selection deduplicates a view and removes only its local reference', () => {
  const files = openSessionResource(EMPTY_RESOURCE_WORKSPACE, { kind: 'repository', page: 'files' });
  const terminal = openSessionResource(files, { kind: 'app-session', sessionId: 'app_opaque' });
  const selectedAgain = openSessionResource(terminal, { kind: 'repository', page: 'files' });
  expect(selectedAgain.resources).toHaveLength(2);
  expect(selectedAgain.activeKey).toBe('repository:files');
  const removed = removeSessionResource(selectedAgain, 'repository:files');
  expect(removed.activeKey).toBe('app-session:app_opaque');
  expect(removeSessionResource(removed, removed.activeKey!).resources).toEqual([]);
});

test('file links reuse the files resource and replace its pending path request', () => {
  const first = openRepositoryFileResource(EMPTY_RESOURCE_WORKSPACE, 'src/first.ts#L4');
  const second = openRepositoryFileResource(first, 'src/second.ts', 'src');
  expect(second).toMatchObject({ activeKey: 'repository:files', expanded: true });
  expect(second.resources).toHaveLength(1);
  expect(second.resources[0]).toMatchObject({ kind: 'repository', page: 'files', fileRequest: { basePath: 'src', href: 'src/second.ts' } });
  const firstRequest = first.resources[0].kind === 'repository' ? first.resources[0].fileRequest : undefined;
  const secondRequest = second.resources[0].kind === 'repository' ? second.resources[0].fileRequest : undefined;
  expect(secondRequest!.id).toBeGreaterThan(firstRequest!.id);
});

test('contexts remain distinct across profiles, instances and sessions with opaque IDs', () => {
  const store = new ResourceWorkspaceStore();
  const key = resourceContextKey('cp:a', 'node:instance', 's/1');
  const other = resourceContextKey('cp:a', 'node', 'instance:s/1');
  const nextProfile = resourceContextKey('cp:b', 'node:instance', 's/1');
  const listener = jest.fn();
  const unsubscribe = store.subscribe(key, listener);
  store.update(key, openSessionResource(store.snapshot(key), { kind: 'browser', tabId: 'local:1' }));
  expect(store.snapshot(other)).toBe(EMPTY_RESOURCE_WORKSPACE);
  expect(store.snapshot(nextProfile)).toBe(EMPTY_RESOURCE_WORKSPACE);
  expect(listener).toHaveBeenCalledTimes(1);
  store.clearProfile('cp:a');
  expect(store.snapshot(key)).toBe(EMPTY_RESOURCE_WORKSPACE);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

test('layout respects actual container width, minimum columns and hysteresis', () => {
  expect(resourceLayoutMode(390)).toBe('overlay');
  expect(resourceLayoutMode(850)).toBe('overlay');
  expect(resourceLayoutMode(900)).toBe('inline');
  expect(resourceLayoutMode(850, 'inline')).toBe('inline');
  expect(resourceLayoutMode(830, 'inline')).toBe('overlay');
  for (const width of [860, 1024, 1366]) {
    for (const ratio of [0.1, 0.4, 0.5, 0.9]) {
      const panel = resourcePanelWidth(width, ratio);
      expect(panel).toBeGreaterThanOrEqual(360);
      expect(width - panel - 1).toBeGreaterThanOrEqual(480);
    }
  }
  for (const width of [320, 390, 500, 850]) expect(resourceOverlayWidth(width)).toBe(width);
  expect(sessionResourceTopInset('ios', 96)).toBe(96);
  expect(sessionResourceTopInset('ios', -1)).toBe(0);
  expect(sessionResourceTopInset('android', 96)).toBe(0);
});

test('window-driven remounts preserve expansion but entering another session resets its display intent', () => {
  const store = new ResourceWorkspaceStore();
  const a = resourceContextKey('cp', 'instance', 'a');
  const b = resourceContextKey('cp', 'instance', 'b');
  store.enterContext(a);
  store.update(a, { ...openSessionResource(store.snapshot(a), { kind: 'repository', page: 'files' }), expanded: true, fraction: 0.5 });
  store.enterContext(a);
  expect(store.snapshot(a).expanded).toBe(true);
  store.enterContext(b);
  store.enterContext(a);
  expect(store.snapshot(a)).toMatchObject({ expanded: false, activeKey: 'repository:files', fraction: 0.5 });
});
