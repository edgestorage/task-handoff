import type { NodeVisibilityFilter } from '@task-handoff/control-plane-client';

import { createPersistedPreferenceStore } from '../platform/persisted-preferences';

export type InstanceScopeSelection = { kind: 'all' } | { kind: 'instance'; instanceId: string };

export type ScopeSelectionPreferences = {
  instanceScopeByControlPlane: Record<string, InstanceScopeSelection>;
  storyNodeFilterByControlPlane: Record<string, NodeVisibilityFilter>;
};

export const SCOPE_SELECTION_STORAGE_KEY = 'task-handoff.mobile.scope-selection-preferences';
const STORAGE_VERSION = 1;
const MAX_CONTROL_PLANES = 100;
const MAX_NODES = 500;
const DEFAULT_PREFERENCES: ScopeSelectionPreferences = {
  instanceScopeByControlPlane: {},
  storyNodeFilterByControlPlane: {},
};

export function parseScopeSelectionPreferences(raw: string | null | undefined): ScopeSelectionPreferences | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORAGE_VERSION) return undefined;
    return {
      instanceScopeByControlPlane: parseInstanceScopes(value.instanceScopeByControlPlane),
      storyNodeFilterByControlPlane: parseStoryNodeFilters(value.storyNodeFilterByControlPlane),
    };
  } catch {
    return undefined;
  }
}

export function sameInstanceScopeSelection(left: InstanceScopeSelection, right: InstanceScopeSelection) {
  return left.kind === right.kind && (left.kind === 'all' || (right.kind === 'instance' && left.instanceId === right.instanceId));
}

export function sameNodeVisibilityFilter(left: NodeVisibilityFilter, right: NodeVisibilityFilter) {
  return left.kind === right.kind
    && (left.kind === 'all' || (right.kind === 'selected' && left.nodeIds.join('\0') === right.nodeIds.join('\0')));
}

const store = createPersistedPreferenceStore<ScopeSelectionPreferences>({
  defaults: DEFAULT_PREFERENCES,
  parse: parseScopeSelectionPreferences,
  storageKey: SCOPE_SELECTION_STORAGE_KEY,
  version: STORAGE_VERSION,
});

export function getScopeSelectionPreferences() {
  return store.get();
}

export function subscribeScopeSelectionPreferences(listener: () => void) {
  return store.subscribe(listener);
}

export function setInstanceScopeSelection(controlPlaneId: string | undefined, next: InstanceScopeSelection) {
  if (!controlPlaneId) return;
  const current = store.get();
  const previous = current.instanceScopeByControlPlane[controlPlaneId];
  if (previous && sameInstanceScopeSelection(previous, next)) return;
  store.update({
    instanceScopeByControlPlane: { ...current.instanceScopeByControlPlane, [controlPlaneId]: next },
  });
}

export function setStoryNodeFilterSelection(controlPlaneId: string | undefined, next: NodeVisibilityFilter) {
  if (!controlPlaneId) return;
  const current = store.get();
  const previous = current.storyNodeFilterByControlPlane[controlPlaneId];
  if (previous && sameNodeVisibilityFilter(previous, next)) return;
  store.update({
    storyNodeFilterByControlPlane: { ...current.storyNodeFilterByControlPlane, [controlPlaneId]: next },
  });
}

export function clearScopeSelectionPreferences(controlPlaneId: string) {
  const current = store.get();
  if (!(controlPlaneId in current.instanceScopeByControlPlane) && !(controlPlaneId in current.storyNodeFilterByControlPlane)) return;
  const { [controlPlaneId]: _instanceScope, ...instanceScopeByControlPlane } = current.instanceScopeByControlPlane;
  const { [controlPlaneId]: _storyNodeFilter, ...storyNodeFilterByControlPlane } = current.storyNodeFilterByControlPlane;
  store.update({ instanceScopeByControlPlane, storyNodeFilterByControlPlane });
}

function parseInstanceScopes(input: unknown): Record<string, InstanceScopeSelection> {
  const result: Record<string, InstanceScopeSelection> = {};
  for (const [controlPlaneId, value] of Object.entries(plainRecord(input)).slice(0, MAX_CONTROL_PLANES)) {
    if (!controlPlaneId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.kind === 'all') {
      result[controlPlaneId] = { kind: 'all' };
    } else if (record.kind === 'instance' && typeof record.instanceId === 'string' && record.instanceId.length > 0) {
      result[controlPlaneId] = { kind: 'instance', instanceId: record.instanceId };
    }
  }
  return result;
}

function parseStoryNodeFilters(input: unknown): Record<string, NodeVisibilityFilter> {
  const result: Record<string, NodeVisibilityFilter> = {};
  for (const [controlPlaneId, value] of Object.entries(plainRecord(input)).slice(0, MAX_CONTROL_PLANES)) {
    if (!controlPlaneId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.kind === 'all') {
      result[controlPlaneId] = { kind: 'all' };
      continue;
    }
    if (record.kind !== 'selected' || !Array.isArray(record.nodeIds)) continue;
    const nodeIds = [...new Set(record.nodeIds.filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0))].slice(0, MAX_NODES);
    result[controlPlaneId] = nodeIds.length ? { kind: 'selected', nodeIds } : { kind: 'all' };
  }
  return result;
}

function plainRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
