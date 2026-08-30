import type { AiSessionModelSelection, AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import type { AiSessionModelGroup } from '@task-handoff/control-plane-client';

export type FormatModelGroupSummary = (modelName: string, count: number) => string;

export const reasoningEfforts: AiSessionReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function modelGroupSubtitle(
  group: AiSessionModelGroup,
  selection: AiSessionModelSelection | undefined,
  formatSummary: FormatModelGroupSummary,
) {
  if (selection?.modelEntityId === group.modelEntityId) return selection.modelName;
  const first = group.models[0]?.modelName || '';
  return group.models.length > 1 ? formatSummary(first, group.models.length) : first;
}
