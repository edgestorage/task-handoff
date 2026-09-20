import {
  StoryAgentToolPolicyInvalidatedSchema,
  StoryAgentToolResolutionSchema,
  type StoryAgentToolResolution,
} from "@task-handoff/protocol/story-agent-tools";

/** Runtime-only cache. Story tool policy remains owned and persisted by node-agent. */
export class StoryToolPolicyCache {
  private readonly resolutions = new Map<string, StoryAgentToolResolution>();

  get(storyId: string) {
    return this.resolutions.get(storyId);
  }

  remember(input: StoryAgentToolResolution) {
    const resolution = StoryAgentToolResolutionSchema.parse(input);
    this.resolutions.set(resolution.storyId, resolution);
    return resolution;
  }

  invalidate(input: unknown) {
    const event = StoryAgentToolPolicyInvalidatedSchema.parse(input);
    const current = this.resolutions.get(event.storyId);
    if (current?.revision === event.revision) return false;
    return this.resolutions.delete(event.storyId);
  }

  clear() {
    this.resolutions.clear();
  }
}
