import crypto from "node:crypto";
import {
  normalizeStoryAgentToolPolicy,
  resolveStoryAgentToolNames,
  StoryAgentToolNameSchema,
  StoryAgentToolPolicySchema,
  StoryAgentToolPolicySettingsSchema,
  StoryAgentToolResolutionSchema,
  storyAgentToolPolicyRevisionSource,
  type StoryAgentToolName,
  type StoryAgentToolPolicy,
} from "@task-handoff/protocol/story-agent-tools";
import type { NodeAgentRepository, StoryRecord } from "../persistence/repository.ts";

export class StoryToolPolicyService {
  private readonly repository: NodeAgentRepository;

  constructor(repository: NodeAgentRepository) {
    this.repository = repository;
  }

  async settings(storyId: string) {
    const story = await this.requireStory(storyId);
    return this.settingsFor(story);
  }

  async update(storyId: string, policy: StoryAgentToolPolicy) {
    const parsed = StoryAgentToolPolicySchema.parse(policy);
    const story = await this.repository.transaction(async (repository) => {
      if (!await repository.stories.get(storyId)) throw policyError("STORY_NOT_FOUND", "Story was not found.", 404);
      return repository.stories.update(storyId, {
        agentToolsContent: parsed.content,
        agentToolsActions: parsed.actions,
        agentToolsAutomations: parsed.automations,
        agentToolsAiSessions: parsed.aiSessions,
        updatedAt: new Date().toISOString(),
      });
    });
    return this.settingsFor(story!);
  }

  async resolve(storyId: string) {
    const story = await this.requireStory(storyId);
    const settings = this.settingsFor(story);
    return StoryAgentToolResolutionSchema.parse({
      storyId,
      ...settings,
      enabledTools: resolveStoryAgentToolNames(settings.policy, { archived: Boolean(story.archivedAt) }),
    });
  }

  async assertEnabled(storyId: string, tool: StoryAgentToolName | string) {
    const parsedTool = StoryAgentToolNameSchema.safeParse(tool);
    const resolution = await this.resolve(storyId);
    if (!parsedTool.success || !resolution.enabledTools.includes(parsedTool.data)) {
      throw policyError("STORY_AGENT_TOOL_DISABLED", "The Story Agent tool is disabled.", 403);
    }
    return resolution;
  }

  private async requireStory(storyId: string) {
    const story = await this.repository.stories.get(storyId);
    if (!story) throw policyError("STORY_NOT_FOUND", "Story was not found.", 404);
    return story;
  }

  private settingsFor(story: StoryRecord) {
    const policy = normalizeStoryAgentToolPolicy({
      content: story.agentToolsContent,
      actions: story.agentToolsActions,
      automations: story.agentToolsAutomations,
      aiSessions: story.agentToolsAiSessions,
    });
    const revision = crypto.createHash("sha256").update(storyAgentToolPolicyRevisionSource(policy)).digest("hex");
    return StoryAgentToolPolicySettingsSchema.parse({ policy, revision });
  }
}

function policyError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}
