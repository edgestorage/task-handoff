import { sameAiSessionModelSelection, type AiSessionModelSelection } from '@task-handoff/protocol/ai-sessions';
import type { AiSessionModelGroup, AiSessionModelOption } from '@task-handoff/control-plane-client';

/**
 * `modelName` may be renamed by an operator at any time; the upstream name is the
 * stable identity. Options and stored selections are compared by identity, with
 * the display label kept as a fallback for records written before the split.
 */
export function sameModelSelection(left: AiSessionModelSelection, right: AiSessionModelSelection) {
  return sameAiSessionModelSelection(left, right);
}

export function modelSelectionFromOption(option: AiSessionModelOption): AiSessionModelSelection {
  return {
    modelEntityId: option.modelEntityId,
    modelName: option.modelName,
    ...(option.modelUpstreamName ? { modelUpstreamName: option.modelUpstreamName } : {}),
  };
}

export function findModelOption(groups: readonly AiSessionModelGroup[], selection?: AiSessionModelSelection) {
  if (!selection) return undefined;
  for (const group of groups) {
    const option = group.models.find((candidate) => sameAiSessionModelSelection(candidate, selection));
    if (option) return option;
  }
  return undefined;
}

/**
 * Relabel a stored selection with the catalog entry's current display label while
 * keeping its stable identity. Returns undefined when the catalog no longer holds
 * the model, so callers can fall back to a default.
 */
export function resolveModelSelection(groups: readonly AiSessionModelGroup[], selection?: AiSessionModelSelection) {
  const option = findModelOption(groups, selection);
  return option && selection
    ? {
        ...selection,
        modelName: option.modelName,
        modelUpstreamName: option.modelUpstreamName ?? selection.modelUpstreamName,
      }
    : undefined;
}

/** Display label for a selection: the entry's current label, else the stored one. */
export function modelSelectionLabel(groups: readonly AiSessionModelGroup[], selection?: AiSessionModelSelection) {
  return resolveModelSelection(groups, selection)?.modelName ?? selection?.modelName;
}
