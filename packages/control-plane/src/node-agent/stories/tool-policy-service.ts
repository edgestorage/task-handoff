import crypto from "node:crypto";
import {
  agentInvocationToolRevisionSource,
  resolveAgentInvocationToolGrant,
} from "@task-handoff/protocol/agent-invocation-tools";
import { agentOrchestrationContainsAgent } from "@task-handoff/protocol/agent-orchestrations";
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
        agentToolsDecisions: parsed.decisions,
        updatedAt: new Date().toISOString(),
      });
    });
    return this.settingsFor(story!);
  }

  async resolve(storyId: string) {
    const story = await this.requireStory(storyId);
    const settings = this.settingsFor(story);
    const entries = this.repository.agents.storyEntries.get(storyId);
    const availableTargets = story.archivedAt ? [] : entries.entries.filter((entry) => {
      if (!this.repository.agents.definitions.get(entry.agentId)) return false;
      const orchestration = this.repository.agents.orchestrations.get(entry.orchestrationId);
      return Boolean(orchestration) && agentOrchestrationContainsAgent(orchestration!, entry.agentId);
    });
    const agentInvocation = resolveAgentInvocationToolGrant(availableTargets);
    const revision = crypto.createHash("sha256").update(JSON.stringify([
      storyAgentToolPolicyRevisionSource(settings.policy),
      Boolean(story.archivedAt),
      agentInvocationToolRevisionSource(entries.revision, agentInvocation),
    ])).digest("hex");
    return StoryAgentToolResolutionSchema.parse({
      storyId,
      policy: settings.policy,
      revision,
      enabledTools: resolveStoryAgentToolNames(settings.policy, { archived: Boolean(story.archivedAt) }),
      agentInvocation,
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

  /** 解析调用目标：显式 orchestrationId 必须精确匹配入口集合；缺省时该 Agent 只能有一个入口。 */
  async assertAgentInvocation(storyId: string, agentId: string, orchestrationId?: string) {
    const resolution = await this.resolve(storyId);
    if (!resolution.agentInvocation.enabledTools.includes("agent_run")) {
      throw policyError("STORY_AGENT_INVOCATION_FORBIDDEN", "The Agent is not authorized as an entry Agent for this Story.", 403);
    }
    const candidates = resolution.agentInvocation.allowedTargets.filter((target) => target.agentId === agentId);
    if (orchestrationId) {
      const target = candidates.find((candidate) => candidate.orchestrationId === orchestrationId);
      if (!target) throw policyError("STORY_AGENT_INVOCATION_FORBIDDEN", "The Agent is not authorized as an entry Agent for this Story.", 403);
      return target;
    }
    if (candidates.length === 1) return candidates[0]!;
    if (!candidates.length) {
      throw policyError("STORY_AGENT_INVOCATION_FORBIDDEN", "The Agent is not authorized as an entry Agent for this Story.", 403);
    }
    throw policyError(
      "STORY_AGENT_INVOCATION_AMBIGUOUS",
      "The Agent is bound to multiple orchestrations in this Story; the call must name one.",
      409,
    );
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
      decisions: story.agentToolsDecisions,
    });
    const revision = crypto.createHash("sha256").update(storyAgentToolPolicyRevisionSource(policy)).digest("hex");
    return StoryAgentToolPolicySettingsSchema.parse({ policy, revision });
  }
}

function policyError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}
