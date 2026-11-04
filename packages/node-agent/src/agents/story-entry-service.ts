import {
  STORY_AGENT_AUTHORIZATION_ERROR_CODES,
  StoryAgentEntrySetUpdateInputSchema,
  type StoryAgentAuthorizationErrorCode,
  type StoryAgentEntrySet,
  type StoryAgentEntrySetUpdateInput,
} from "@task-handoff/protocol/story-agent-authorization";
import { defaultAgentOrchestrationId } from "@task-handoff/protocol/agent-orchestrations";
import type { AgentDefinitionService } from "./service.ts";
import type { AgentOrchestrationService } from "./orchestration-service.ts";
import type { StoryAgentEntryRecord, StoryAgentEntryReference, StoryAgentEntryRepository } from "../persistence/story-agent-entry-repository.ts";
import type { NodeStoryStore } from "../stories/store.ts";

/**
 * Story 入口集合：每项是 (Agent, 编排) 对，缺省编排是该 Agent 的默认编排。
 * 同一 Agent 可以绑定多张编排；调用方在调用工具里用 orchestrationId 消歧。
 */
export class StoryAgentEntryService {
  private readonly stories: NodeStoryStore;
  private readonly definitions: AgentDefinitionService;
  private readonly orchestrations: AgentOrchestrationService;
  private readonly entries: StoryAgentEntryRepository;
  private readonly onUpdated?: (entries: StoryAgentEntrySet) => void | Promise<void>;

  constructor(
    stories: NodeStoryStore,
    definitions: AgentDefinitionService,
    orchestrations: AgentOrchestrationService,
    entries: StoryAgentEntryRepository,
    onUpdated?: (entries: StoryAgentEntrySet) => void | Promise<void>,
  ) {
    this.stories = stories;
    this.definitions = definitions;
    this.orchestrations = orchestrations;
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
    const currentPairs = new Set(current.entries.map(referenceKey));
    const references = parsed.entries.map((entry): StoryAgentEntryReference => ({
      agentId: entry.agentId,
      orchestrationId: entry.orchestrationId ?? defaultAgentOrchestrationId(entry.agentId),
    }));
    for (const reference of references) {
      // 既有悬挂/失效引用允许保留，直到用户显式移除或替换；新增引用必须当场可解析。
      if (currentPairs.has(referenceKey(reference))) continue;
      if (!this.definitions.has(reference.agentId)) {
        throw storyAgentAuthorizationError(
          "STORY_AGENT_ENTRY_AGENT_NOT_FOUND",
          `Agent definition ${reference.agentId} was not found on this Node Agent.`,
          409,
          { storyId, agentId: reference.agentId },
        );
      }
      if (!this.orchestrations.has(reference.orchestrationId)) {
        throw storyAgentAuthorizationError(
          "STORY_AGENT_ENTRY_ORCHESTRATION_NOT_FOUND",
          `Agent orchestration ${reference.orchestrationId} was not found on this Node Agent.`,
          409,
          { storyId, orchestrationId: reference.orchestrationId },
        );
      }
      if (!this.orchestrations.containsAgent(reference.orchestrationId, reference.agentId)) {
        throw storyAgentAuthorizationError(
          "STORY_AGENT_ENTRY_ORCHESTRATION_MISMATCH",
          `Agent ${reference.agentId} is not part of orchestration ${reference.orchestrationId}.`,
          409,
          { storyId, agentId: reference.agentId, orchestrationId: reference.orchestrationId },
        );
      }
    }
    const updated = this.project(this.entries.replace(storyId, references));
    await this.onUpdated?.(updated);
    return updated;
  }

  private project(record: StoryAgentEntryRecord): StoryAgentEntrySet {
    return {
      storyId: record.storyId,
      revision: record.revision,
      entries: record.entries.map((entry) => ({
        agentId: entry.agentId,
        orchestrationId: entry.orchestrationId,
        status: this.referenceAvailable(entry) ? "available" : "missing-reference",
      })),
    };
  }

  private referenceAvailable(entry: StoryAgentEntryReference) {
    return this.definitions.has(entry.agentId) && this.orchestrations.containsAgent(entry.orchestrationId, entry.agentId);
  }
}

function referenceKey(entry: StoryAgentEntryReference) {
  return `${entry.agentId}\u001f${entry.orchestrationId}`;
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
