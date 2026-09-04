import type {
  ControlPlaneAiSessions,
  ControlPlaneAiSessionSummary,
  ControlPlaneInstanceResourceEntry,
} from '@task-handoff/control-plane-client';
import type { Story, StoryDocument } from '@task-handoff/protocol/stories';
import type { StorySortMode } from './story-view-preferences';

export const STORY_TREE_DOCUMENT_LIMIT = 5;

export type StoryTreeSession = {
  instanceId: string;
  instanceName: string;
  session: ControlPlaneAiSessionSummary;
};

export function storyTreeKey(story: Pick<Story, 'id' | 'ownerNodeId'>) {
  return `${story.ownerNodeId}:${story.id}`;
}

export function sortStoryTree(stories: readonly Story[], locale: string, mode: StorySortMode = 'name', sessionsByStory?: ReadonlyMap<string, StoryTreeSession[]>, manualKeys: readonly string[] = []) {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const byName = (left: Story, right: Story) => (
    collator.compare(left.title, right.title) || storyTreeKey(left).localeCompare(storyTreeKey(right))
  );
  if (mode === 'last-user-message') return [...stories].sort((left, right) => {
    const leftTime = Math.max(...(sessionsByStory?.get(storyTreeKey(left)) ?? []).map((entry) => Date.parse(entry.session.lastUserMessageAt || entry.session.updatedAt)), 0);
    const rightTime = Math.max(...(sessionsByStory?.get(storyTreeKey(right)) ?? []).map((entry) => Date.parse(entry.session.lastUserMessageAt || entry.session.updatedAt)), 0);
    return rightTime - leftTime || byName(left, right);
  });
  if (mode === 'manual') {
    const order = new Map(manualKeys.map((key, index) => [key, index]));
    return [...stories].sort((left, right) => (order.get(storyTreeKey(left)) ?? Number.MAX_SAFE_INTEGER) - (order.get(storyTreeKey(right)) ?? Number.MAX_SAFE_INTEGER) || byName(left, right));
  }
  return [...stories].sort(byName);
}

export function groupStoryTreeSessions(
  stories: readonly Story[],
  instances: readonly ControlPlaneInstanceResourceEntry[],
  snapshot: ControlPlaneAiSessions | undefined,
) {
  const availableStoryKeys = new Set(stories.map(storyTreeKey));
  const instanceDirectory = new Map(instances.map((instance) => [instance.id, instance]));
  const grouped = new Map<string, StoryTreeSession[]>();

  for (const instanceSnapshot of snapshot?.instances ?? []) {
    const instance = instanceDirectory.get(instanceSnapshot.instanceId);
    if (!instance) continue;
    for (const session of instanceSnapshot.aiSessions.sessions) {
      if (!session.storyId) continue;
      const key = `${instance.nodeId}:${session.storyId}`;
      if (!availableStoryKeys.has(key)) continue;
      const entries = grouped.get(key) ?? [];
      entries.push({ instanceId: instance.id, instanceName: instance.name, session });
      grouped.set(key, entries);
    }
  }

  for (const entries of grouped.values()) {
    entries.sort((left, right) => Date.parse(right.session.updatedAt) - Date.parse(left.session.updatedAt));
  }
  return grouped;
}

export function visibleStoryTreeDocuments(documents: readonly StoryDocument[], expanded: boolean) {
  return expanded || documents.length <= STORY_TREE_DOCUMENT_LIMIT
    ? documents
    : documents.slice(-STORY_TREE_DOCUMENT_LIMIT);
}

export function mergeStoryTreeSnapshot(current: readonly Story[], incoming: readonly Story[], unavailableNodeIds: readonly string[]) {
  if (!unavailableNodeIds.length) return [...incoming];
  const unavailable = new Set(unavailableNodeIds);
  const incomingKeys = new Set(incoming.map(storyTreeKey));
  return [
    ...incoming,
    ...current.filter((story) => unavailable.has(story.ownerNodeId) && !incomingKeys.has(storyTreeKey(story))),
  ];
}
