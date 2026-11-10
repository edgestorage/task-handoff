import * as SecureStore from 'expo-secure-store';

export type PersistedPreferenceStore<T> = {
  get(): T;
  subscribe(listener: () => void): () => void;
  update(patch: Partial<T>): void;
  /** Starts (or joins) the one-time storage read used by subscribe/get. */
  ready(): Promise<void>;
};

/**
 * Module-level preference store that survives an app restart, mirroring the
 * `expo-secure-store` persistence used by the theme and task-status settings.
 * The in-memory value stays synchronous so `useSyncExternalStore` consumers
 * react immediately; storage is read once on the first subscription and
 * written in the background on every change.
 */
export function createPersistedPreferenceStore<T>(options: {
  storageKey: string;
  version: number;
  defaults: T;
  parse(raw: string | null | undefined): T | undefined;
}): PersistedPreferenceStore<T> {
  const { defaults, parse, storageKey, version } = options;
  const listeners = new Set<() => void>();
  let preferences = defaults;
  let hydration: Promise<void> | undefined;
  let mutated = false;
  let writeChain: Promise<void> = Promise.resolve();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const beginHydration = () => {
    hydration ??= (async () => {
      try {
        const stored = parse(await SecureStore.getItemAsync(storageKey));
        // A user change that landed while storage was being read wins over the persisted snapshot.
        if (mutated || !stored) return;
        preferences = stored;
        notify();
      } catch {
        // Keep the in-memory defaults active even when device storage is unavailable.
      }
    })();
    return hydration;
  };

  return {
    get: () => preferences,
    subscribe(listener: () => void) {
      listeners.add(listener);
      void beginHydration();
      return () => { listeners.delete(listener); };
    },
    ready: beginHydration,
    update(patch: Partial<T>) {
      mutated = true;
      preferences = { ...preferences, ...patch };
      notify();
      const raw = JSON.stringify({ version, ...preferences });
      writeChain = writeChain.then(() => SecureStore.setItemAsync(storageKey, raw)).catch(() => undefined);
    },
  };
}
