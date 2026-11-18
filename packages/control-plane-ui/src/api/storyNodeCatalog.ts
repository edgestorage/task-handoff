import type { Story } from "@task-handoff/protocol/stories";

export type StoryNodePayload = {
  stories: Story[];
  unavailableNodeIds: string[];
};

/**
 * Node-scoped Story snapshot. The owning node is copied from the query key at
 * the query boundary so consumers never infer ownership from array position.
 */
export type StoryNodeSnapshot = StoryNodePayload & {
  nodeId: string;
};

export class StoryNodeSnapshotMismatchError extends Error {
  readonly code = "STORY_NODE_SNAPSHOT_MISMATCH";

  constructor(nodeId: string, story: Story) {
    super(`Story ${story.ownerNodeId}:${story.id} was returned for node ${nodeId}.`);
    this.name = "StoryNodeSnapshotMismatchError";
  }
}

export function storyNodeSnapshot(nodeId: string, payload: StoryNodePayload): StoryNodeSnapshot {
  const foreignStory = payload.stories.find((story) => story.ownerNodeId !== nodeId);
  if (foreignStory) throw new StoryNodeSnapshotMismatchError(nodeId, foreignStory);
  return { nodeId, stories: payload.stories, unavailableNodeIds: payload.unavailableNodeIds };
}

type StoryNodeQuerySnapshot = {
  data?: StoryNodeSnapshot;
};

/**
 * Story identity is `(ownerNodeId, story.id)`. Join node snapshots through the
 * node id carried by each snapshot, not through the reactive query array index,
 * and keep only one entry for each Story identity.
 */
export function collectStoryNodeStories(nodeIds: readonly string[], queries: readonly (StoryNodeQuerySnapshot | undefined)[]): Story[] {
  const snapshots = new Map<string, StoryNodeSnapshot>();
  for (const query of queries) {
    const snapshot = query?.data;
    if (!snapshot || snapshots.has(snapshot.nodeId)) continue;
    snapshots.set(snapshot.nodeId, snapshot);
  }

  const seen = new Set<string>();
  const stories: Story[] = [];
  for (const nodeId of nodeIds) {
    const snapshot = snapshots.get(nodeId);
    if (!snapshot) continue;
    for (const story of snapshot.stories) {
      if (story.ownerNodeId !== nodeId) continue;
      const key = `${story.ownerNodeId}:${story.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stories.push(story);
    }
  }
  return stories;
}
