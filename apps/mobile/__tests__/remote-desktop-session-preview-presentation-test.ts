import * as SecureStore from 'expo-secure-store';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { store.delete(key); }),
  };
});

const secureStore = SecureStore as unknown as { __store: Map<string, string> };

type PresentationModule = typeof import('../src/remote-desktop/session-preview-presentation');

function loadPresentation(): PresentationModule {
  let loaded: PresentationModule | undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { loaded = require('../src/remote-desktop/session-preview-presentation') as PresentationModule; });
  return loaded!;
}

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

beforeEach(() => { secureStore.__store.clear(); });

test('defaults to floating and sanitizes unknown persisted values', () => {
  const { parseSessionPreviewPresentationPreferences, sanitizeSessionPreviewPresentation } = loadPresentation();
  expect(sanitizeSessionPreviewPresentation('expanded')).toBe('expanded');
  expect(sanitizeSessionPreviewPresentation('inline')).toBe('floating');
  expect(sanitizeSessionPreviewPresentation(undefined)).toBe('floating');
  expect(parseSessionPreviewPresentationPreferences(JSON.stringify({ version: 1, presentation: 'expanded' }))).toEqual({ presentation: 'expanded' });
  expect(parseSessionPreviewPresentationPreferences(JSON.stringify({ version: 1, presentation: 'unknown', future: true }))).toEqual({ presentation: 'floating' });
  expect(parseSessionPreviewPresentationPreferences(JSON.stringify({ version: 2, presentation: 'expanded' }))).toBeUndefined();
  expect(parseSessionPreviewPresentationPreferences('not json')).toBeUndefined();
});

test('persists the selected presentation across reloads', async () => {
  const first = loadPresentation();
  const unsubscribe = first.sessionPreviewPresentationStore.subscribe(() => undefined);
  expect(first.sessionPreviewPresentationStore.get().presentation).toBe('floating');
  first.setSessionPreviewPresentation('expanded');
  expect(first.sessionPreviewPresentationStore.get().presentation).toBe('expanded');
  await flush();
  unsubscribe();

  const reloaded = loadPresentation();
  const unsubscribeReloaded = reloaded.sessionPreviewPresentationStore.subscribe(() => undefined);
  await flush();
  expect(reloaded.sessionPreviewPresentationStore.get().presentation).toBe('expanded');
  unsubscribeReloaded();
});
