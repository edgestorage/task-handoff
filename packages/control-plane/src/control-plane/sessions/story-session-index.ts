import type { AiSessionsSnapshot } from "@task-handoff/protocol/ai-sessions";

export type StorySessionReference = { instanceId: string; sessionId: string; storyId?: string };

/** Rebuildable in-memory acceleration index. It never owns or mutates Session state. */
export class StorySessionIndex {
  private readonly byStory = new Map<string, Map<string, StorySessionReference>>();
  private readonly byInstance = new Map<string, Set<string>>();

  replaceInstance(instanceId: string, snapshot: AiSessionsSnapshot) {
    this.removeInstance(instanceId);
    const ids = new Set<string>();
    for (const session of snapshot.sessions) {
      if (!session.storyId) continue;
      const key = `${instanceId}:${session.id}`;
      const group = this.byStory.get(session.storyId) || new Map<string, StorySessionReference>();
      group.set(key, { instanceId, sessionId: session.id, storyId: session.storyId });
      this.byStory.set(session.storyId, group);
      ids.add(key);
    }
    this.byInstance.set(instanceId, ids);
  }

  removeInstance(instanceId: string) {
    const keys = this.byInstance.get(instanceId);
    if (!keys) return;
    for (const [storyId, group] of this.byStory) {
      for (const key of keys) group.delete(key);
      if (!group.size) this.byStory.delete(storyId);
    }
    this.byInstance.delete(instanceId);
  }

  list(storyId: string) { return [...(this.byStory.get(storyId)?.values() || [])]; }
}
