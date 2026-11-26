import type { AiSessionNextInputSuggestion, AiSessionNextInputSuggestionError } from '@task-handoff/protocol/ai-sessions';
import type { ControlPlaneAiSessionSummary } from '@task-handoff/control-plane-client';

const consumedSuggestions = new Set<string>();
const MAX_CONSUMED_SUGGESTIONS = 2_000;

export function nextInputSuggestionKey(
  controlPlaneId: string,
  instanceId: string,
  sessionId: string,
  turnId: string,
) {
  return `${controlPlaneId}:${instanceId}:${sessionId}:${turnId}`;
}

export function consumeNextInputSuggestion(key: string) {
  consumedSuggestions.add(key);
  if (consumedSuggestions.size > MAX_CONSUMED_SUGGESTIONS) {
    for (const stale of consumedSuggestions) {
      consumedSuggestions.delete(stale);
      if (consumedSuggestions.size <= MAX_CONSUMED_SUGGESTIONS - 500) break;
    }
  }
}

export function resetNextInputSuggestionConsumption() {
  consumedSuggestions.clear();
}

export function nextInputSuggestionForSession(
  session: ControlPlaneAiSessionSummary | undefined,
  latestTurnId: string | undefined,
): AiSessionNextInputSuggestion | undefined {
  const suggestion = session?.nextInputSuggestion;
  if (
    !session
    || !suggestion
    || session.status !== 'idle'
    || session.queue.pendingCount > 0
    || session.lineage?.kind === 'subagent'
    || suggestion.turnId !== latestTurnId
  ) {
    return undefined;
  }
  return suggestion;
}

export function nextInputSuggestionErrorForSession(
  session: ControlPlaneAiSessionSummary | undefined,
  latestTurnId: string | undefined,
): AiSessionNextInputSuggestionError | undefined {
  const error = session?.nextInputSuggestionError;
  if (
    !session
    || !error
    || session.nextInputSuggestion
    || session.status !== 'idle'
    || session.queue.pendingCount > 0
    || session.lineage?.kind === 'subagent'
    || error.turnId !== latestTurnId
  ) {
    return undefined;
  }
  return error;
}

export function visibleNextInputSuggestion(input: {
  controlPlaneId: string;
  instanceId: string;
  sessionId: string;
  suggestion: AiSessionNextInputSuggestion | undefined;
  draft: string;
  attachmentCount: number;
  editing: boolean;
  actionsEnabled: boolean;
}) {
  if (!input.suggestion || !input.actionsEnabled || input.editing || input.draft.trim() || input.attachmentCount > 0) {
    return undefined;
  }
  const key = nextInputSuggestionKey(input.controlPlaneId, input.instanceId, input.sessionId, input.suggestion.turnId);
  return consumedSuggestions.has(key) ? undefined : input.suggestion;
}
