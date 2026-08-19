import type { AiSessionTimelineActivity, AiSessionTimelineItem, AiSessionTurn } from "@task-handoff/protocol/ai-sessions";
import { aiSessionElapsedSeconds } from "@task-handoff/control-plane-client";

type TurnTiming = Pick<AiSessionTurn, "status" | "completedAt">;

export function turnElapsedEnd(turn?: TurnTiming) {
  if (!turn || (turn.status !== "completed" && turn.status !== "failed")) return undefined;
  return turn.completedAt;
}

export const turnElapsedSeconds = aiSessionElapsedSeconds;

export type TimelineMessage = Extract<AiSessionTimelineItem, { type: "user-message" | "ai-message" }>;
export type TimelineTurnNode =
  | { id: string; type: "message"; message: TimelineMessage }
  | { id: string; type: "activities"; activities: AiSessionTimelineActivity[] };

export type GroupedTimelineTurn = { id: string; nodes: TimelineTurnNode[] };
export type ConversationTimelineTurn = {
  id: string;
  userMessages: TimelineMessage[];
  history: TimelineTurnNode[];
  latestResponse?: TimelineMessage;
  trailing: TimelineTurnNode[];
};

function turnIdentity(turn: Pick<AiSessionTurn, "id" | "providerTurnId"> | undefined) {
  return new Set([turn?.id, turn?.providerTurnId].filter((value): value is string => Boolean(value)));
}

function groupTurnItems(items: readonly AiSessionTimelineItem[]): TimelineTurnNode[] {
  const nodes: TimelineTurnNode[] = [];
  for (const item of items) {
    if (item.type !== "activity") {
      nodes.push({ id: item.id, type: "message", message: item });
      continue;
    }
    const previous = nodes.at(-1);
    if (previous?.type === "activities") previous.activities.push(item);
    else nodes.push({ id: `activities:${item.id}`, type: "activities", activities: [item] });
  }
  return nodes;
}

function splitTimelineTurnNodes(nodes: TimelineTurnNode[], retainFollowupUserMessages = false) {
  const latestResponseIndex = nodes.findLastIndex(
    (node) => node.type === "message" && node.message.type === "ai-message",
  );
  const primaryUserMessageIndex = nodes.findIndex(
    (node) => node.type === "message" && node.message.type === "user-message",
  );
  const userMessages = nodes.flatMap((node) => (
    node.type === "message" && node.message.type === "user-message" ? [node.message] : []
  ));
  if (latestResponseIndex < 0) {
    return {
      userMessages,
      history: [] as TimelineTurnNode[],
      latestResponse: undefined,
      trailing: nodes.filter((node, index) => (
        node.type !== "message"
        || node.message.type !== "user-message"
        || (retainFollowupUserMessages && index !== primaryUserMessageIndex)
      )),
    };
  }
  const latestResponseNode = nodes[latestResponseIndex];
  return {
    userMessages,
    history: nodes.slice(0, latestResponseIndex)
      .filter((node, index) => (
        node.type !== "message"
        || node.message.type !== "user-message"
        || (retainFollowupUserMessages && index !== primaryUserMessageIndex)
      )),
    latestResponse: latestResponseNode.type === "message" ? latestResponseNode.message : undefined,
    trailing: nodes.slice(latestResponseIndex + 1)
      .filter((node, offset) => {
        const index = latestResponseIndex + 1 + offset;
        return node.type !== "message"
          || node.message.type !== "user-message"
          || (retainFollowupUserMessages && index !== primaryUserMessageIndex);
      }),
  };
}

/** Preserve the provider event order and only collapse adjacent activities into one expandable run. */
export function groupTimelineTurns(items: readonly AiSessionTimelineItem[]): GroupedTimelineTurn[] {
  const turnItems = new Map<string, AiSessionTimelineItem[]>();
  for (const item of items) {
    const existing = turnItems.get(item.turnId);
    if (existing) existing.push(item);
    else turnItems.set(item.turnId, [item]);
  }
  return [...turnItems].map(([id, groupedItems]) => ({ id, nodes: groupTurnItems(groupedItems) }));
}

/** Collapse each turn around its final AI message while retaining live trailing activity. */
export function conversationTimelineTurns(items: readonly AiSessionTimelineItem[]): ConversationTimelineTurn[] {
  return groupTimelineTurns(items).map((turn) => {
    return { id: turn.id, ...splitTimelineTurnNodes(turn.nodes) };
  });
}

export function compactTimelineForTurn(
  items: readonly AiSessionTimelineItem[],
  turn: Pick<AiSessionTurn, "id" | "providerTurnId"> | undefined,
) {
  const identities = turnIdentity(turn);
  const split = splitTimelineTurnNodes(
    groupTurnItems(items.filter((item) => identities.has(item.turnId))),
    true,
  );
  return {
    history: split.history,
    activityNodes: split.trailing,
    activities: split.trailing.flatMap((node) => node.type === "activities" ? node.activities : []),
  };
}
