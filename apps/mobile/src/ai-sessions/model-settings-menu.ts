import type { AiSessionModelSelection, AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import type { AiSessionModelGroup } from '@task-handoff/control-plane-client';
import { sameModelSelection } from './model-selection';

export type FormatModelGroupSummary = (modelName: string, count: number) => string;

export const reasoningEfforts: AiSessionReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function modelGroupSubtitle(
  group: AiSessionModelGroup,
  selection: AiSessionModelSelection | undefined,
  formatSummary: FormatModelGroupSummary,
) {
  // Show the entry's current label after a rename while the identity still matches.
  const selected = selection ? group.models.find((model) => sameModelSelection(model, selection)) : undefined;
  if (selected) return selected.modelName;
  if (selection?.modelEntityId === group.modelEntityId) return selection.modelName;
  const first = group.models[0]?.modelName || '';
  return group.models.length > 1 ? formatSummary(first, group.models.length) : first;
}
