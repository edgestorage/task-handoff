import type { AiSessionForest, AiSessionHierarchyRecord, AiSessionTreeNode } from "@task-handoff/protocol/ai-session-hierarchy";
import type { AiSessionSummary } from "@task-handoff/protocol/ai-sessions";
import { isAiSessionApprovalPending } from "./ai-session-state.ts";

export type StorySessionAttention = "unread" | "running" | "failed" | "approval";

const attentionPriority = { unread: 1, running: 2, failed: 3, approval: 4 } satisfies Record<StorySessionAttention, number>;

export function storySessionAttentionByKey<T extends AiSessionSummary & AiSessionHierarchyRecord & { instanceId: string }>(
  forest: AiSessionForest<T>,
  nodeIdForInstance: (instanceId: string) => string | undefined,
): ReadonlyMap<string, StorySessionAttention> {
  const attentionByKey = new Map<string, StorySessionAttention>();
  for (const root of forest.roots) {
    const { storyId, instanceId } = root.session;
    const nodeId = nodeIdForInstance(instanceId);
    if (!nodeId || !storyId) continue;
    const key = `${nodeId}:${storyId}`;
    let highest = attentionByKey.get(key);
    const pending = [root];
    while (pending.length && highest !== "approval") {
      const { session, children } = pending.pop()!;
      const attention = isAiSessionApprovalPending(session) ? "approval"
        : session.status === "failed" || session.status === "running" ? session.status
        : session.unread ? "unread" : undefined;
      if (attention && (!highest || attentionPriority[attention] > attentionPriority[highest])) highest = attention;
      for (const child of children) pending.push(child);
    }
    if (highest) attentionByKey.set(key, highest);
  }
  return attentionByKey;
}

/**
 * New-session defaults for a Story are one derivation shared by every client:
 * the newest root session of the Story on the Story's own node, ordered by the
 * same `last-user-message` rule the Story trees use.
 *
 * Sessions the Story tree keeps visible after `close` (`actions.close === false`)
 * stay listable but never seed creation defaults, so a closed session cannot
 * resurrect its instance, folder, or worktree.
 */
export type StorySessionInheritanceRecord = AiSessionHierarchyRecord & {
  instanceId: string;
  storyId?: string;
  actions?: { close?: boolean };
};

export function storySessionRootsInForest<T extends AiSessionHierarchyRecord & { instanceId: string; storyId?: string }>(
  forest: AiSessionForest<T>,
  storyId: string,
  instanceIds: readonly string[],
): AiSessionTreeNode<T>[] {
  const owned = new Set(instanceIds);
  return forest.roots.filter((root) => root.session.storyId === storyId && owned.has(root.session.instanceId));
}

export function latestStorySessionForCreation<T extends StorySessionInheritanceRecord>(
  forest: AiSessionForest<T>,
  storyId: string,
  instanceIds: readonly string[],
): T | undefined {
  return storySessionRootsInForest(forest, storyId, instanceIds)
    .find((root) => root.session.actions?.close !== false)?.session;
}
