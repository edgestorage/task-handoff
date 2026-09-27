import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AgentDefinitionCreateInputSchema,
  AgentDefinitionDeleteResultSchema,
  AgentDefinitionIdSchema,
  AgentDefinitionListSchema,
  AgentDefinitionSchema,
  AgentDefinitionUpdateInputSchema,
} from "@task-handoff/protocol/agent-definitions";
import {
  AgentRunCancelInputSchema,
  AgentRunCreateInputSchema,
  AgentRunIdSchema,
  AgentRunListSchema,
  AgentRunMemberIdSchema,
  AgentRunMemberSchema,
  AgentRunSchema,
} from "@task-handoff/protocol/agent-runs";
import {
  StoryAgentEntrySetSchema,
  StoryAgentEntrySetUpdateInputSchema,
} from "@task-handoff/protocol/story-agent-authorization";
import { StoryIdSchema } from "@task-handoff/protocol/stories";
import type { AgentDefinitionService } from "./service.ts";
import type { AgentRunService } from "./run-service.ts";
import type { StoryAgentEntryService } from "./story-entry-service.ts";
import { AgentInvocationToolResolutionSchema } from "@task-handoff/protocol/agent-invocation-tools";
import { AgentInvocationRequestSchema } from "@task-handoff/protocol/agent-invocation-tools";
import type { NodeAgentState } from "../state.ts";

const AgentParamsSchema = z.object({ agentId: AgentDefinitionIdSchema }).strict();
const RunParamsSchema = z.object({ runId: AgentRunIdSchema }).strict();
const RunMemberParamsSchema = z.object({ runId: AgentRunIdSchema, memberId: AgentRunMemberIdSchema }).strict();
const RunMemberSessionParamsSchema = RunMemberParamsSchema.extend({ sessionId: z.string().trim().min(1).max(120) }).strict();
const StoryAgentEntryParamsSchema = z.object({ storyId: StoryIdSchema }).strict();

/**
 * Node Agent 的 AgentDefinition API。Node 上下文只来自路由，定义本体不含 ownerNodeId；
 * 写操作全部落到本 Node Agent 自己的 SQLite，不存在可写副本。
 */
export function registerNodeAgentDefinitionRoutes(app: FastifyInstance, agents: AgentDefinitionService) {
  app.get("/api/node-agent/agents", async () => ({ data: AgentDefinitionListSchema.parse({ agents: agents.list() }) }));

  app.post("/api/node-agent/agents", async (request, reply) => {
    const input = AgentDefinitionCreateInputSchema.parse(request.body);
    return reply.code(201).send({ data: AgentDefinitionSchema.parse(agents.create(input)) });
  });

  app.get("/api/node-agent/agents/:agentId", async (request) => {
    const { agentId } = AgentParamsSchema.parse(request.params);
    return { data: AgentDefinitionSchema.parse(agents.get(agentId)) };
  });

  app.get("/api/node-agent/agents/:agentId/invocation-tools", async (request) => {
    const { agentId } = AgentParamsSchema.parse(request.params);
    return { data: AgentInvocationToolResolutionSchema.parse(agents.resolveInvocationTools(agentId)) };
  });

  app.patch("/api/node-agent/agents/:agentId", async (request) => {
    const { agentId } = AgentParamsSchema.parse(request.params);
    const input = AgentDefinitionUpdateInputSchema.parse(request.body);
    return { data: AgentDefinitionSchema.parse(agents.update(agentId, input)) };
  });

  app.delete("/api/node-agent/agents/:agentId", async (request) => {
    const { agentId } = AgentParamsSchema.parse(request.params);
    return { data: AgentDefinitionDeleteResultSchema.parse({ id: agentId, deleted: agents.delete(agentId) }) };
  });
}

/** Node-local Run routes; node identity is transport context and never accepted in a request body. */
export function registerNodeAgentRunRoutes(app: FastifyInstance, runs: AgentRunService, state?: NodeAgentState) {
  app.get("/api/node-agent/agent-runs", async () => ({ data: AgentRunListSchema.parse({ runs: runs.list() }) }));

  app.post("/api/node-agent/agent-runs", async (request, reply) => {
    const input = AgentRunCreateInputSchema.parse(request.body);
    return reply.code(201).send({ data: AgentRunSchema.parse(runs.create(input)) });
  });

  app.get("/api/node-agent/agent-runs/:runId", async (request) => {
    const { runId } = RunParamsSchema.parse(request.params);
    return { data: AgentRunSchema.parse(runs.get(runId)) };
  });

  app.get("/api/node-agent/agent-runs/:runId/members/:memberId", async (request) => {
    const { runId, memberId } = RunMemberParamsSchema.parse(request.params);
    return { data: AgentRunMemberSchema.parse(runs.getMember(runId, memberId)) };
  });

  app.post("/api/node-agent/agent-runs/:runId/cancel", async (request) => {
    const { runId } = RunParamsSchema.parse(request.params);
    const input = AgentRunCancelInputSchema.parse(request.body ?? {});
    return { data: AgentRunSchema.parse(runs.cancel(runId, input)) };
  });

  app.post("/api/node-agent/agent-runs/:runId/members/:memberId/ai-sessions/:sessionId/agent-runs", async (request) => {
    if (!state) throw Object.assign(new Error("Agent Run member invocation is unavailable."), { code: "AGENT_RUN_MEMBER_INVOCATION_UNAVAILABLE", statusCode: 503 });
    const { runId, memberId, sessionId } = RunMemberSessionParamsSchema.parse(request.params);
    const member = runs.getMember(runId, memberId);
    if (!member.aiSessionId || member.aiSessionId !== sessionId) {
      throw Object.assign(new Error("The provider session does not own this Agent Run member."), { code: "AGENT_RUN_MEMBER_SESSION_MISMATCH", statusCode: 403 });
    }
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : undefined;
    state.authenticateInstance(member.instanceId, token);
    const invocation = AgentInvocationRequestSchema.parse(request.body);
    const callee = runs.addMember({
      runId,
      parentMemberId: memberId,
      clientRequestId: invocation.clientRequestId,
      agentId: invocation.input.agentId,
      input: { prompt: invocation.input.prompt },
    });
    return { data: await runs.waitForMemberToolResult(runId, callee.memberId, request.signal) };
  });
}

export function registerNodeStoryAgentEntryRoutes(app: FastifyInstance, entries: StoryAgentEntryService) {
  app.get("/api/node-agent/stories/:storyId/agent-entries", async (request) => {
    const { storyId } = StoryAgentEntryParamsSchema.parse(request.params);
    return { data: StoryAgentEntrySetSchema.parse(await entries.get(storyId)) };
  });

  app.put("/api/node-agent/stories/:storyId/agent-entries", async (request) => {
    const { storyId } = StoryAgentEntryParamsSchema.parse(request.params);
    const input = StoryAgentEntrySetUpdateInputSchema.parse(request.body);
    return { data: StoryAgentEntrySetSchema.parse(await entries.update(storyId, input)) };
  });
}
