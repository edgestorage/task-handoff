import {
  STORY_AGENT_AUTHORIZATION_ERROR_CODES,
  StoryAgentEntrySetUpdateInputSchema,
  type StoryAgentAuthorizationErrorCode,
  type StoryAgentEntrySet,
  type StoryAgentEntrySetUpdateInput,
} from "@task-handoff/protocol/story-agent-authorization";
import type { AgentDefinitionService } from "./service.ts";
import type { StoryAgentEntryRepository } from "../persistence/story-agent-entry-repository.ts";
import type { NodeStoryStore } from "../stories/store.ts";

export class StoryAgentEntryService {
  private readonly stories: NodeStoryStore;
  private readonly definitions: AgentDefinitionService;
  private readonly entries: StoryAgentEntryRepository;
  private readonly onUpdated?: (entries: StoryAgentEntrySet) => void | Promise<void>;

  constructor(
    stories: NodeStoryStore,
    definitions: AgentDefinitionService,
    entries: StoryAgentEntryRepository,
    onUpdated?: (entries: StoryAgentEntrySet) => void | Promise<void>,
  ) {
    this.stories = stories;
    this.definitions = definitions;
    this.entries = entries;
    this.onUpdated = onUpdated;
  }

  async get(storyId: string): Promise<StoryAgentEntrySet> {
    if (!await this.stories.exists(storyId)) {
      throw storyAgentAuthorizationError("STORY_AGENT_ENTRY_STORY_NOT_FOUND", `Story ${storyId} was not found.`, 404, { storyId });
    }
    return this.project(this.entries.get(storyId));
  }

  async update(storyId: string, input: StoryAgentEntrySetUpdateInput): Promise<StoryAgentEntrySet> {
    const parsed = StoryAgentEntrySetUpdateInputSchema.parse(input);
    if (!await this.stories.exists(storyId)) {
      throw storyAgentAuthorizationError("STORY_AGENT_ENTRY_STORY_NOT_FOUND", `Story ${storyId} was not found.`, 404, { storyId });
    }
    const current = this.entries.get(storyId);
    if (current.revision !== parsed.expectedRevision) {
      throw storyAgentAuthorizationError("STORY_AGENT_ENTRY_REVISION_CONFLICT", "Story Agent entries changed since they were read.", 409, {
        storyId,
        expectedRevision: parsed.expectedRevision,
        actualRevision: current.revision,
      });
    }
    const currentIds = new Set(current.agentIds);
    for (const agentId of new Set(parsed.agentIds)) {
      try {
        this.definitions.get(agentId);
      } catch (error) {
        // Existing dangling references may be retained until the user explicitly removes or replaces them.
        if (currentIds.has(agentId) && (error as { code?: string }).code === "AGENT_DEFINITION_NOT_FOUND") continue;
        if ((error as { code?: string }).code !== "AGENT_DEFINITION_NOT_FOUND") throw error;
        throw storyAgentAuthorizationError(
          "STORY_AGENT_ENTRY_AGENT_NOT_FOUND",
          `Agent definition ${agentId} was not found on this Node Agent.`,
          409,
          { storyId, agentId },
        );
      }
    }
    const updated = this.project(this.entries.replace(storyId, parsed.agentIds));
    await this.onUpdated?.(updated);
    return updated;
  }

  private project(record: { storyId: string; revision: string; agentIds: string[] }): StoryAgentEntrySet {
    return {
      storyId: record.storyId,
      revision: record.revision,
      entries: record.agentIds.map((agentId) => ({
        agentId,
        status: this.definitionExists(agentId) ? "available" : "missing-reference",
      })),
    };
  }

  private definitionExists(agentId: string) {
    try {
      this.definitions.get(agentId);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "AGENT_DEFINITION_NOT_FOUND") return false;
      throw error;
    }
  }
}

function storyAgentAuthorizationError(
  code: StoryAgentAuthorizationErrorCode,
  message: string,
  statusCode: number,
  details?: Record<string, unknown>,
) {
  if (!STORY_AGENT_AUTHORIZATION_ERROR_CODES.includes(code)) throw new Error(`Unknown Story Agent authorization error code ${code}.`);
  return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
}
