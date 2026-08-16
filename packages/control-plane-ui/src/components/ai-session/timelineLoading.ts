import type { AiSessionTurn } from "@task-handoff/protocol/ai-sessions";

const LIVE_TURN_STATUSES = new Set<AiSessionTurn["status"]>(["queued", "running", "waiting"]);

function sameTurn(left: Pick<AiSessionTurn, "id" | "providerTurnId">, right: Pick<AiSessionTurn, "id" | "providerTurnId">) {
  const leftIds = new Set([left.id, left.providerTurnId].filter((value): value is string => Boolean(value)));
  return [right.id, right.providerTurnId].some((value) => Boolean(value && leftIds.has(value)));
}

/** Live item events are authoritative for the active tail; its HTTP Timeline is loaded after completion. */
export function shouldDeferTurnTimelineLoad(
  turns: readonly AiSessionTurn[],
  turn: Pick<AiSessionTurn, "id" | "providerTurnId" | "status">,
  supportsLiveTimelineItems: boolean,
) {
  if (!supportsLiveTimelineItems) return false;
  const latestTurn = turns.at(-1);
  return Boolean(latestTurn && sameTurn(latestTurn, turn) && LIVE_TURN_STATUSES.has(turn.status));
}
