import type { AiSessionForest, AiSessionHierarchyRecord, AiSessionTreeNode } from "@task-handoff/protocol/ai-session-hierarchy";

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
