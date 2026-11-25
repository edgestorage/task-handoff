import type { AiSessionNextInputSuggestion } from "@task-handoff/protocol/ai-sessions";

type NextInputSuggestionSession = {
  nextInputSuggestion?: AiSessionNextInputSuggestion;
  status: string;
  queue?: { pendingCount: number };
  lineage?: { kind?: string };
};

/**
 * The summary carries one suggestion for the latest settled turn. Panels still
 * validate it against the conversation's latest visible turn so a stale patch
 * can never show a suggestion for an older turn.
 */
export function selectNextInputSuggestion(
  session: NextInputSuggestionSession | undefined,
  latestTurnId: string | undefined,
): AiSessionNextInputSuggestion | undefined {
  const suggestion = session?.nextInputSuggestion;
  if (
    !session
    || !suggestion
    || session.status !== "idle"
    || (session.queue?.pendingCount ?? 0) > 0
    || session.lineage?.kind === "subagent"
    || suggestion.turnId !== latestTurnId
  ) {
    return undefined;
  }
  return suggestion;
}
