import { z } from "zod";
import {
  AgentDefinitionCreateInputSchema,
  AgentDefinitionDeleteResultSchema,
  AgentDefinitionUpdateInputSchema,
  AGENT_DEFINITION_CHANGED_EVENT_TYPE,
  sanitizeAgentDefinition,
  sanitizeAgentDefinitionAggregate,
  sanitizeAgentDefinitionAggregateEvent,
  type AgentDefinition,
  type AgentDefinitionCreateInput,
  type AgentDefinitionUpdateInput,
} from "@task-handoff/protocol/agent-definitions";
import type { ControlPlaneClientTransport } from "./transport.ts";
import {
  AgentRunCancelInputSchema,
  AgentRunCreateInputSchema,
  AgentRunManualCreateInputSchema,
  AGENT_RUN_CHANGED_EVENT_TYPE,
  AGENT_RUN_MEMBER_CHANGED_EVENT_TYPE,
  sanitizeAgentRun,
  sanitizeAgentRunAggregateEvent,
  sanitizeAgentRunMember,
  type AgentRunCancelInput,
  type AgentRunCreateInput,
  type AgentRunManualCreateInput,
} from "@task-handoff/protocol/agent-runs";
import {
  StoryAgentEntrySetUpdateInputSchema,
  sanitizeStoryAgentEntrySet,
  type StoryAgentEntrySetUpdateInput,
} from "@task-handoff/protocol/story-agent-authorization";
import {
  nodeAgentCapabilitiesFromPublicNode,
  nodeAgentExecutionCapabilities,
  supportsNodeAgentCallableRelations,
  supportsNodeAgentDefinitions,
  supportsNodeAgentRunMembers,
  supportsNodeAgentManualRuns,
  supportsNodeAgentRuns,
  supportsNodeAgentStoryEntryAuthorization,
  supportsNodeAgentExecutionPolicy,
} from "@task-handoff/protocol/node-agent-capabilities";
import type { AgentExecutionPolicy } from "@task-handoff/protocol/agent-definitions";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();

/**
 * AgentDefinition 客户端。读取走宽容 sanitize，兼容 N-1 Node 缺失或新增的字段；
 * 写操作都带 nodeId，由 Control Plane 路由回定义所属 Node。
 */
export function createControlPlaneAgentsApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (await transport.request(path, DataSchema(schema), init)).data;
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    async list(nodeId?: string, signal?: AbortSignal) {
      const data = await requestData(
        "/api/agents" + (nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""),
        z.unknown(),
        { signal },
      );
      return sanitizeAgentDefinitionAggregate(data);
    },
    async get(agentId: string, nodeId: string, signal?: AbortSignal): Promise<AgentDefinition> {
      const data = await requestData(`/api/agents/${encodeURIComponent(agentId)}?nodeId=${encodeURIComponent(nodeId)}`, z.unknown(), { signal });
      return sanitizeAgentDefinition(data);
    },
    async create(nodeId: string, input: AgentDefinitionCreateInput) {
      const data = await requestData("/api/agents", z.unknown(), json("POST", { nodeId, input: AgentDefinitionCreateInputSchema.parse(input) }));
      return sanitizeAgentDefinition(data);
    },
    async update(agentId: string, nodeId: string, input: AgentDefinitionUpdateInput) {
      const data = await requestData(`/api/agents/${encodeURIComponent(agentId)}`, z.unknown(), json("PATCH", { nodeId, input: AgentDefinitionUpdateInputSchema.parse(input) }));
      return sanitizeAgentDefinition(data);
    },
    remove(agentId: string, nodeId: string) {
      return requestData(
        `/api/agents/${encodeURIComponent(agentId)}?nodeId=${encodeURIComponent(nodeId)}`,
        AgentDefinitionDeleteResultSchema,
        { method: "DELETE" },
      );
    },
    async storyEntries(storyId: string, nodeId: string, signal?: AbortSignal) {
      const data = await requestData(`/api/stories/${encodeURIComponent(storyId)}/agent-entries?nodeId=${encodeURIComponent(nodeId)}`, z.unknown(), { signal });
      return sanitizeStoryAgentEntrySet(data);
    },
    async updateStoryEntries(storyId: string, nodeId: string, input: StoryAgentEntrySetUpdateInput) {
      const data = await requestData(
        `/api/stories/${encodeURIComponent(storyId)}/agent-entries`,
        z.unknown(),
        json("PUT", { nodeId, input: StoryAgentEntrySetUpdateInputSchema.parse(input) }),
      );
      return sanitizeStoryAgentEntrySet(data);
    },
    async listRuns(nodeId?: string, signal?: AbortSignal) {
      const data = await requestData(
        "/api/agent-runs" + (nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""),
        z.object({
          runs: z.array(z.object({ nodeId: z.string(), run: z.unknown() }).strip()),
          unavailableNodeIds: z.array(z.string()).default([]),
        }).strip(),
        { signal },
      );
      return {
        unavailableNodeIds: data.unavailableNodeIds,
        runs: data.runs.map(({ nodeId: sourceNodeId, run }) => ({ nodeId: sourceNodeId, run: sanitizeAgentRun(run) })),
      };
    },
    async getRun(runId: string, nodeId: string, signal?: AbortSignal) {
      const data = await requestData(`/api/agent-runs/${encodeURIComponent(runId)}?nodeId=${encodeURIComponent(nodeId)}`, z.unknown(), { signal });
      return sanitizeAgentRun(data);
    },
    async getRunMember(runId: string, memberId: string, nodeId: string, signal?: AbortSignal) {
      const data = await requestData(
        `/api/agent-runs/${encodeURIComponent(runId)}/members/${encodeURIComponent(memberId)}?nodeId=${encodeURIComponent(nodeId)}`,
        z.unknown(),
        { signal },
      );
      return sanitizeAgentRunMember(data);
    },
    async createRun(nodeId: string, input: AgentRunCreateInput) {
      const data = await requestData("/api/agent-runs", z.unknown(), json("POST", { nodeId, input: AgentRunCreateInputSchema.parse(input) }));
      return sanitizeAgentRun(data);
    },
    async createManualRun(nodeId: string, input: AgentRunManualCreateInput) {
      const data = await requestData("/api/agent-runs/manual", z.unknown(), json("POST", {
        nodeId,
        input: AgentRunManualCreateInputSchema.parse(input),
      }));
      return sanitizeAgentRun(data);
    },
    async cancelRun(runId: string, nodeId: string, input: AgentRunCancelInput = {}) {
      const data = await requestData(
        `/api/agent-runs/${encodeURIComponent(runId)}/cancel`,
        z.unknown(),
        json("POST", { nodeId, input: AgentRunCancelInputSchema.parse(input) }),
      );
      return sanitizeAgentRun(data);
    },
  };
}

export type ControlPlaneAgentsApi = ReturnType<typeof createControlPlaneAgentsApi>;

export function controlPlaneAgentCapabilities(publicNodeCapabilities: unknown) {
  const capabilities = nodeAgentCapabilitiesFromPublicNode(publicNodeCapabilities);
  return {
    definitions: supportsNodeAgentDefinitions(capabilities),
    runs: supportsNodeAgentRuns(capabilities),
    storyEntryAuthorization: supportsNodeAgentStoryEntryAuthorization(capabilities),
    callableRelations: supportsNodeAgentCallableRelations(capabilities),
    runMembers: supportsNodeAgentRunMembers(capabilities),
    manualRuns: supportsNodeAgentManualRuns(capabilities),
    execution: nodeAgentExecutionCapabilities(capabilities),
  };
}

export function controlPlaneSupportsAgentExecutionPolicy(
  agentExecutionCapabilities: unknown,
  policy: AgentExecutionPolicy,
  target: { runtime: string; providerId: string },
) {
  return supportsNodeAgentExecutionPolicy({ agentExecution: agentExecutionCapabilities }, policy, target);
}

export type ControlPlaneAgentEvent =
  | { type: typeof AGENT_DEFINITION_CHANGED_EVENT_TYPE; payload: ReturnType<typeof sanitizeAgentDefinitionAggregateEvent> }
  | { type: typeof AGENT_RUN_CHANGED_EVENT_TYPE | typeof AGENT_RUN_MEMBER_CHANGED_EVENT_TYPE; payload: ReturnType<typeof sanitizeAgentRunAggregateEvent> };

/** Parses only Control Plane-owned aggregate events; malformed or unrelated frames are ignored. */
export function consumeControlPlaneAgentEvent(input: unknown): ControlPlaneAgentEvent | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const frame = input as { type?: unknown; payload?: unknown };
  if (frame.type === AGENT_DEFINITION_CHANGED_EVENT_TYPE) {
    const payload = safeConsume(() => sanitizeAgentDefinitionAggregateEvent(frame.payload));
    return payload ? { type: frame.type, payload } : undefined;
  }
  if (frame.type === AGENT_RUN_CHANGED_EVENT_TYPE || frame.type === AGENT_RUN_MEMBER_CHANGED_EVENT_TYPE) {
    const payload = safeConsume(() => sanitizeAgentRunAggregateEvent(frame.payload));
    return payload ? { type: frame.type, payload } : undefined;
  }
  return undefined;
}

function safeConsume<T>(consume: () => T): T | undefined {
  try {
    return consume();
  } catch {
    return undefined;
  }
}
