import type {
  ControlPlaneAiSessions,
  ControlPlaneAiSessionSummary,
  ControlPlaneInstanceResourceEntry,
} from '@task-handoff/control-plane-client';
import type { Story, StoryDocument } from '@task-handoff/protocol/stories';

export const STORY_TREE_DOCUMENT_LIMIT = 5;

export type StoryTreeSession = {
  instanceId: string;
  instanceName: string;
  session: ControlPlaneAiSessionSummary;
};

export function storyTreeKey(story: Pick<Story, 'id' | 'ownerNodeId'>) {
  return `${story.ownerNodeId}:${story.id}`;
}

export function sortStoryTree(stories: readonly Story[], locale: string) {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  return [...stories].sort((left, right) => (
    collator.compare(left.title, right.title) || storyTreeKey(left).localeCompare(storyTreeKey(right))
  ));
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
