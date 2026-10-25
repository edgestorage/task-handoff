import { useSyncExternalStore } from 'react';

export type AiSessionDetailSelection = {
  controlPlaneId: string;
  instanceId: string;
  sessionId: string;
};

export type StoryDetailSelection = {
  controlPlaneId: string;
  nodeId: string;
  storyId: string;
};

export type StorySessionDetailSelection = StoryDetailSelection & {
  instanceId: string;
  sessionId: string;
};

export type AppSessionDetailSelection = {
  controlPlaneId: string;
  instanceId: string;
  sessionId: string;
};

export type BrowserTabDetailSelection = {
  controlPlaneId: string;
  browserTabId: string;
  instanceId: string;
};

export type InstanceDetailSelection = {
  controlPlaneId: string;
  instanceId: string;
};

type SelectionStore<T> = {
  clear(): void;
  get(): T | undefined;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
};

function createSelectionStore<T extends object>(): SelectionStore<T> {
  let value: T | undefined;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    clear() {
      if (value === undefined) return;
      value = undefined;
      emit();
    },
    get: () => value,
    set(next) {
      if (value && sameSelection(value, next)) return;
      value = next;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function sameSelection<T extends object>(left: T | undefined, right: T | undefined) {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right[key as keyof T] === value);
}

export const aiSessionDetailSelection = createSelectionStore<AiSessionDetailSelection>();
export const storyDetailSelection = createSelectionStore<StoryDetailSelection>();
export const storySessionDetailSelection = createSelectionStore<StorySessionDetailSelection>();
export const appSessionDetailSelection = createSelectionStore<AppSessionDetailSelection>();
export const browserTabDetailSelection = createSelectionStore<BrowserTabDetailSelection>();
export const instanceDetailSelection = createSelectionStore<InstanceDetailSelection>();

export function useDetailSelection<T extends object>(store: SelectionStore<T>) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function resetDetailSelections() {
  aiSessionDetailSelection.clear();
  storyDetailSelection.clear();
  storySessionDetailSelection.clear();
  appSessionDetailSelection.clear();
  browserTabDetailSelection.clear();
  instanceDetailSelection.clear();
}
