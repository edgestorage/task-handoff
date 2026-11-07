import { BrowserStartPageStore, browserPageSuggestions, parseBrowserStartPages } from '../src/browser/start-page-store';
import type { ValueStore } from '../src/platform/secure-storage';

function memory() {
  const values = new Map<string, string>();
  const storage: ValueStore = { get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); }, remove: async (key) => { values.delete(key); }, available: async () => true };
  return { storage, values };
}

test('visits survive restart, deduplicate URLs, and remain isolated by control plane and instance', async () => {
  const { storage } = memory();
  const store = new BrowserStartPageStore(storage, () => 100);
  await store.visit('cp1', 'instance', 'http://localhost:3000', 'App');
  await store.visit('cp1', 'instance', 'http://localhost:3000', 'App title');
  await store.visit('cp2', 'instance', 'https://example.test', 'Other CP');
  await store.visit('cp1', 'other', 'https://other.test', 'Other instance');
  expect(store.page('cp1', 'instance').recent).toEqual([{ url: 'http://localhost:3000/', title: 'App title', visitedAt: 100 }]);
  const restored = new BrowserStartPageStore(storage);
  await restored.visit('cp1', 'instance', 'https://new.test', 'New');
  expect(restored.page('cp1', 'instance').recent).toHaveLength(2);
  await restored.clearProfile('cp1');
  expect(restored.page('cp1', 'instance').recent).toEqual([]);
  expect(restored.page('cp1', 'other').recent).toEqual([]);
  expect(restored.page('cp2', 'instance').recent).toHaveLength(1);
});

test('clearing recent visits keeps pins, enforces bounds, and does not resurrect history on reload', async () => {
  const { storage, values } = memory();
  const store = new BrowserStartPageStore(storage);
  for (let i = 0; i < 16; i++) {
    await store.visit('cp', 'i', `https://page${i}.test`, `Page ${i}`);
    await store.togglePinned('cp', 'i', `https://page${i}.test`, `Page ${i}`);
  }
  expect(store.page('cp', 'i').recent).toHaveLength(12);
  expect(store.page('cp', 'i').pinned).toHaveLength(6);
  await store.clearRecent('cp', 'i');
  expect(store.page('cp', 'i').pinned).toHaveLength(6);
  expect(Object.values(parseBrowserStartPages(values.get('browser.start-pages')))[0].recent).toEqual([]);
});

test('persisted history ignores unknown fields, rejects unsafe URLs and invalid scopes', () => {
  const key = JSON.stringify(['cp', 'i']);
  const snapshot = parseBrowserStartPages(JSON.stringify({ version: 1, future: true, scopes: {
    [key]: { future: true, pinned: [], recent: [
      { url: 'file:///etc/passwd' }, { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.test' }, { url: 'about:blank' },
      { url: 'https://example.test', title: 'Valid', future: 1 }, { url: 'https://example.test/', title: 'Duplicate' },
    ] }, invalid: { pinned: [], recent: [] },
  } }));
  expect(snapshot[key].recent).toEqual([{ url: 'https://example.test/', title: 'Valid', visitedAt: 0 }]);
  expect(Object.keys(snapshot)).toEqual([key]);
  expect(parseBrowserStartPages('{')).toEqual({});
  expect(parseBrowserStartPages('{"version":2}')).toEqual({});
});

test('address suggestions match titles and URL paths, deduplicate pins and history, and rank prefixes first', () => {
  const page = { pinned: [{ url: 'https://docs.test/guide', title: 'Guide', visitedAt: 0 }], recent: [
    { url: 'https://app.test/docs', title: 'My docs', visitedAt: 10 },
    { url: 'https://docs.test/guide', title: 'Docs', visitedAt: 9 },
  ] };
  expect(browserPageSuggestions(page, '')).toHaveLength(2);
  expect(browserPageSuggestions(page, 'docs')[0].url).toBe('https://docs.test/guide');
  expect(browserPageSuggestions(page, 'guide')[0].title).toBe('Guide');
  expect(browserPageSuggestions(page, 'not-found')).toEqual([]);
});

test('a slow hydration completes before concurrent visits and history clear are applied', async () => {
  let hydrate!: (value: string) => void;
  const { storage } = memory();
  storage.get = () => new Promise((resolve) => { hydrate = resolve; });
  const store = new BrowserStartPageStore(storage);
  const saved = { url: 'https://saved.test/', title: 'Saved', visitedAt: 1 };
  const visiting = store.visit('cp', 'i', 'https://new.test', 'New');
  const clearing = store.clearRecent('cp', 'i');
  hydrate(JSON.stringify({ version: 1, scopes: { [JSON.stringify(['cp', 'i'])]: { pinned: [saved], recent: [saved] } } }));
  await Promise.all([visiting, clearing]);
  expect(store.page('cp', 'i')).toEqual({ pinned: [saved], recent: [] });
});
