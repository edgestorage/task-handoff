import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AgentDefinitionAggregateSchema,
  AgentDefinitionCreateInputSchema,
  AgentDefinitionDeleteResultSchema,
  AgentDefinitionIdSchema,
  AgentDefinitionSchema,
  AgentDefinitionUpdateInputSchema,
  sanitizeAgentDefinition,
  sanitizeAgentDefinitionList,
  type AgentDefinition,
} from "@task-handoff/protocol/agent-definitions";
import {
  AgentRunAggregateSchema,
  AgentRunCancelInputSchema,
  AgentRunCreateInputSchema,
  AgentRunManualCreateInputSchema,
  AgentRunIdSchema,
  AgentRunMemberIdSchema,
  AgentRunMemberSchema,
  sanitizeAgentRun,
  sanitizeAgentRunMember,
  type AgentRun,
} from "@task-handoff/protocol/agent-runs";
import {
  nodeAgentCapabilitiesFromPublicNode,
  supportsNodeAgentDefinitions,
  supportsNodeAgentOrchestrations,
  supportsNodeAgentRuns,
  supportsNodeAgentManualRuns,
  supportsNodeAgentStoryEntryAuthorization,
} from "@task-handoff/protocol/node-agent-capabilities";
import {
  AgentOrchestrationAggregateSchema,
  AgentOrchestrationCreateInputSchema,
  AgentOrchestrationDeleteResultSchema,
  AgentOrchestrationIdSchema,
  AgentOrchestrationSchema,
  AgentOrchestrationUpdateInputSchema,
  defaultAgentOrchestrationId,
  sanitizeAgentOrchestration,
  sanitizeAgentOrchestrationList,
  type AgentOrchestration,
} from "@task-handoff/protocol/agent-orchestrations";
import {
  StoryAgentEntrySetSchema,
  StoryAgentEntrySetUpdateInputSchema,
  sanitizeStoryAgentEntrySet,
} from "@task-handoff/protocol/story-agent-authorization";
import { StoryIdSchema, StorySchema } from "@task-handoff/protocol/stories";
import type { ControlPlaneService } from "../application/service.ts";
import { requestCanAccessInstance, requestCanAccessNode, requestVisibleInstanceIds } from "./access-projection.ts";
import { nodeJson } from "./node-agent-request.ts";
import type { ControlPlaneAgentAggregator } from "../agents/agent-aggregator.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";

const NodeQuerySchema = z.object({ nodeId: z.string().trim().min(1).max(120).optional() }).strict();
const NodeRequiredQuerySchema = z.object({ nodeId: z.string().trim().min(1).max(120) }).strict();
const AgentRouteSchema = z.object({ agentId: AgentDefinitionIdSchema }).strict();
const OrchestrationRouteSchema = z.object({ orchestrationId: AgentOrchestrationIdSchema }).strict();
const RunRouteSchema = z.object({ runId: AgentRunIdSchema }).strict();
const RunMemberRouteSchema = RunRouteSchema.extend({ memberId: AgentRunMemberIdSchema }).strict();
const StoryRouteSchema = z.object({ storyId: StoryIdSchema }).strict();
const AgentDeleteQuerySchema = z.object({
  nodeId: z.string().trim().min(1).max(120),
  /** `delete` 同时删除引用该 Agent 的自定义编排；默认只保留（悬挂引用由 UI 标记）。 */
  referencingOrchestrations: z.enum(["keep", "delete"]).optional(),
}).strict();

function entryKey(agentId: string, orchestrationId: string) {
  return `${agentId}\u001f${orchestrationId}`;
}

/**
 * AgentDefinition 的写操作必须落到定义所属 Node：Control Plane 只做转发与聚合，
 * 不保存可写副本，也不把聚合信封上的 nodeId 写回定义本体。
 */
function requireAgentCapableNode(service: ControlPlaneService, request: FastifyRequest, nodeId: string) {
  if (!requestCanAccessNode(request, nodeId)) throw resourceNotVisible();
  const node = service.requireNode(nodeId);
  if (!supportsNodeAgentDefinitions(nodeAgentCapabilitiesFromPublicNode(node.capabilities))) {
    // Compatibility for v0.0.32: absence of the agentExecution capability only closes
    // the Agent feature domain, it must not affect registration, heartbeat or other features.
    throw Object.assign(new Error("This node does not support Agent definitions."), {
      statusCode: 409,
      code: "AGENT_DEFINITIONS_UNSUPPORTED",
    });
  }
  return node;
}

function requireRunCapableNode(service: ControlPlaneService, request: FastifyRequest, nodeId: string) {
  if (!requestCanAccessNode(request, nodeId)) throw resourceNotVisible();
  const node = service.requireNode(nodeId);
  if (!supportsNodeAgentRuns(nodeAgentCapabilitiesFromPublicNode(node.capabilities))) {
    throw Object.assign(new Error("This node does not support Agent Runs."), {
      statusCode: 409,
      code: "AGENT_RUNS_UNSUPPORTED",
    });
  }
  return node;
}

function requireOrchestrationCapableNode(service: ControlPlaneService, request: FastifyRequest, nodeId: string) {
  if (!requestCanAccessNode(request, nodeId)) throw resourceNotVisible();
  const node = service.requireNode(nodeId);
  if (!supportsNodeAgentOrchestrations(nodeAgentCapabilitiesFromPublicNode(node.capabilities))) {
    throw Object.assign(new Error("This node does not support Agent orchestration management."), {
      statusCode: 409,
      code: "AGENT_ORCHESTRATIONS_UNSUPPORTED",
    });
  }
  return node;
}

function requireManualRunCapableNode(service: ControlPlaneService, request: FastifyRequest, nodeId: string) {
  const node = requireRunCapableNode(service, request, nodeId);
  if (!supportsNodeAgentManualRuns(nodeAgentCapabilitiesFromPublicNode(node.capabilities))) {
    throw Object.assign(new Error("This node does not support manually launched Agent Runs."), {
      statusCode: 409,
      code: "AGENT_MANUAL_RUNS_UNSUPPORTED",
    });
  }
  return node;
}

function requireStoryEntryCapableNode(service: ControlPlaneService, request: FastifyRequest, nodeId: string) {
  if (!requestCanAccessNode(request, nodeId)) throw resourceNotVisible();
  const node = service.requireNode(nodeId);
  if (!supportsNodeAgentStoryEntryAuthorization(nodeAgentCapabilitiesFromPublicNode(node.capabilities))) {
    throw Object.assign(new Error("This node does not support Story Agent entry authorization."), {
      statusCode: 409,
      code: "STORY_AGENT_ENTRY_AUTHORIZATION_UNSUPPORTED",
    });
  }
  return node;
}

function resourceNotVisible() {
  return Object.assign(new Error("The requested resource is not visible."), {
    statusCode: 404,
    code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE",
  });
}

async function requireVisibleAgent(service: ControlPlaneService, request: FastifyRequest, nodeId: string, agentId: string) {
  requireAgentCapableNode(service, request, nodeId);
  const agent = sanitizeAgentDefinition(await nodeJson(service, nodeId, `/agents/${encodeURIComponent(agentId)}`));
  await requireVisibleInstanceOnNode(service, request, nodeId, agent.targetInstanceId);
  return agent;
}

async function requireVisibleInstanceOnNode(
  service: ControlPlaneService,
  request: FastifyRequest,
  nodeId: string,
  instanceId: string,
) {
  try {
    const instance = await service.requireControlledInstance(instanceId);
    if (instance.nodeId !== nodeId || !requestCanAccessInstance(request, instance)) throw resourceNotVisible();
    return instance;
  } catch {
    throw resourceNotVisible();
  }
}

async function requireStoryOnNode(service: ControlPlaneService, request: FastifyRequest, nodeId: string, storyId: string) {
  if (!requestCanAccessNode(request, nodeId)) throw resourceNotVisible();
  const story = StorySchema.parse(await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}`));
  if (story.ownerNodeId !== nodeId) throw resourceNotVisible();
  return story;
}

async function requireVisibleRun(service: ControlPlaneService, request: FastifyRequest, nodeId: string, runId: string) {
  requireRunCapableNode(service, request, nodeId);
  const run = sanitizeAgentRun(await nodeJson(service, nodeId, `/agent-runs/${encodeURIComponent(runId)}`));
  await assertRunVisible(service, request, nodeId, run);
  return run;
}

/**
 * 编排可见性由成员 Agent 的目标实例决定：任何成员位于不可见实例时整张编排都不可见。
 * 已在 Node 上不存在的悬挂成员没有可暴露的实例，保留展示以便用户清理。
 */
async function assertOrchestrationVisible(service: ControlPlaneService, request: FastifyRequest, nodeId: string, orchestration: AgentOrchestration) {
  const definitions = sanitizeAgentDefinitionList(await nodeJson(service, nodeId, "/agents"));
  const visibleInstanceIds = await requestVisibleInstanceIds(service, request);
  const instanceByAgentId = new Map(definitions.agents.map((definition) => [definition.id, definition.targetInstanceId]));
  for (const agentId of orchestration.agentIds) {
    const instanceId = instanceByAgentId.get(agentId);
    if (instanceId && !visibleInstanceIds.has(instanceId)) throw resourceNotVisible();
  }
}

async function requireVisibleOrchestration(service: ControlPlaneService, request: FastifyRequest, nodeId: string, orchestrationId: string) {
  requireOrchestrationCapableNode(service, request, nodeId);
  const orchestration = sanitizeAgentOrchestration(await nodeJson(service, nodeId, `/agent-orchestrations/${encodeURIComponent(orchestrationId)}`));
  await assertOrchestrationVisible(service, request, nodeId, orchestration);
  return orchestration;
}

async function assertRunVisible(service: ControlPlaneService, request: FastifyRequest, nodeId: string, run: AgentRun) {
  const instanceIds = new Set([
    ...(run.provenance.source === "control-plane" ? [] : [run.provenance.initiatingInstanceId]),
    ...(run.members ?? []).map((member) => member.instanceId),
  ]);
  await Promise.all([...instanceIds].map((instanceId) => requireVisibleInstanceOnNode(service, request, nodeId, instanceId)));
}

export function registerAgentRoutes(app: FastifyInstance, service: ControlPlaneService, aggregator?: ControlPlaneAgentAggregator) {
  app.get("/api/agents", async (request) => {
    const { nodeId } = NodeQuerySchema.parse(request.query);
    const nodes = nodeId
      ? [requireAgentCapableNode(service, request, nodeId)]
      : service.listNodes().filter((node) => requestCanAccessNode(request, node.id)
        && supportsNodeAgentDefinitions(nodeAgentCapabilitiesFromPublicNode(node.capabilities)));
    const visibleInstances = new Map((await service.listControlledInstances())
      .filter((instance) => requestCanAccessInstance(request, instance))
      .map((instance) => [instance.id, instance.nodeId]));
    const agents: Array<{ nodeId: string; agent: AgentDefinition }> = [];
    const unavailableNodeIds: string[] = [];
    await Promise.all(nodes.map(async (node) => {
      try {
        const list = sanitizeAgentDefinitionList(await nodeJson(service, node.id, "/agents"));
        aggregator?.replaceDefinitions(node.id, list.agents);
        agents.push(...list.agents
          .filter((agent) => visibleInstances.get(agent.targetInstanceId) === node.id)
          .map((agent) => ({ nodeId: node.id, agent })));
      } catch {
        unavailableNodeIds.push(node.id);
        agents.push(...(aggregator?.definitionsForNode(node.id) ?? [])
          .filter((agent) => visibleInstances.get(agent.targetInstanceId) === node.id)
          .map((agent) => ({ nodeId: node.id, agent })));
      }
    }));
    return { data: AgentDefinitionAggregateSchema.parse({ agents, unavailableNodeIds }) };
  });

  app.get<{ Params: { agentId: string } }>("/api/agents/:agentId", async (request) => {
    const { agentId } = AgentRouteSchema.parse(request.params);
    const { nodeId } = NodeRequiredQuerySchema.parse(request.query);
    return { data: await requireVisibleAgent(service, request, nodeId, agentId) };
  });

  app.post("/api/agents", async (request, reply) => {
    const body = z.object({
      nodeId: z.string().trim().min(1).max(120),
      input: AgentDefinitionCreateInputSchema,
    }).strict().parse(request.body);
    requireAgentCapableNode(service, request, body.nodeId);
    await requireVisibleInstanceOnNode(service, request, body.nodeId, body.input.targetInstanceId);
    const agent = AgentDefinitionSchema.parse(await nodeJson(service, body.nodeId, "/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.input),
    }));
    aggregator?.storeDefinition(body.nodeId, agent);
    return reply.code(201).send({ data: agent });
  });

  app.patch<{ Params: { agentId: string } }>("/api/agents/:agentId", async (request) => {
    const { agentId } = AgentRouteSchema.parse(request.params);
    const body = z.object({
      nodeId: z.string().trim().min(1).max(120),
      input: AgentDefinitionUpdateInputSchema,
    }).strict().parse(request.body);
    await requireVisibleAgent(service, request, body.nodeId, agentId);
    if (body.input.targetInstanceId) {
      await requireVisibleInstanceOnNode(service, request, body.nodeId, body.input.targetInstanceId);
    }
    const agent = sanitizeAgentDefinition(await nodeJson(service, body.nodeId, `/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.input),
    }));
    aggregator?.storeDefinition(body.nodeId, agent);
    return { data: agent };
  });

  app.delete<{ Params: { agentId: string } }>("/api/agents/:agentId", async (request) => {
    const { agentId } = AgentRouteSchema.parse(request.params);
    const { nodeId, referencingOrchestrations } = AgentDeleteQuerySchema.parse(request.query);
    await requireVisibleAgent(service, request, nodeId, agentId);
    const query = referencingOrchestrations ? `?referencingOrchestrations=${referencingOrchestrations}` : "";
    const result = AgentDefinitionDeleteResultSchema.parse(await nodeJson(
      service,
      nodeId,
      `/agents/${encodeURIComponent(agentId)}${query}`,
      { method: "DELETE" },
    ));
    aggregator?.removeDefinition(nodeId, agentId);
    for (const orchestrationId of result.deletedOrchestrationIds) aggregator?.removeOrchestration(nodeId, orchestrationId);
    return { data: result };
  });

  app.get<{ Params: { storyId: string } }>("/api/stories/:storyId/agent-entries", async (request) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const { nodeId } = NodeRequiredQuerySchema.parse(request.query);
    requireStoryEntryCapableNode(service, request, nodeId);
    await requireStoryOnNode(service, request, nodeId, storyId);
    return { data: sanitizeStoryAgentEntrySet(await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}/agent-entries`)) };
  });

  app.put<{ Params: { storyId: string } }>("/api/stories/:storyId/agent-entries", async (request) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const body = z.object({
      nodeId: z.string().trim().min(1).max(120),
      input: StoryAgentEntrySetUpdateInputSchema,
    }).strict().parse(request.body);
    requireStoryEntryCapableNode(service, request, body.nodeId);
    await requireStoryOnNode(service, request, body.nodeId, storyId);

    const current = sanitizeStoryAgentEntrySet(await nodeJson(
      service,
      body.nodeId,
      `/stories/${encodeURIComponent(storyId)}/agent-entries`,
    ));
    const retained = new Set(current.entries.map((entry) => entryKey(entry.agentId, entry.orchestrationId)));
    await Promise.all(body.input.entries
      .filter((entry) => !retained.has(entryKey(entry.agentId, entry.orchestrationId ?? defaultAgentOrchestrationId(entry.agentId))))
      .map((entry) => requireVisibleAgent(service, request, body.nodeId, entry.agentId)));

    const data = await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(storyId)}/agent-entries`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.input),
    });
    return { data: StoryAgentEntrySetSchema.parse(sanitizeStoryAgentEntrySet(data)) };
  });

  app.get("/api/agent-runs", async (request) => {
    const { nodeId } = NodeQuerySchema.parse(request.query);
    const nodes = nodeId
      ? [requireRunCapableNode(service, request, nodeId)]
      : service.listNodes().filter((node) => requestCanAccessNode(request, node.id)
        && supportsNodeAgentRuns(nodeAgentCapabilitiesFromPublicNode(node.capabilities)));
    const runs: Array<{ nodeId: string; run: AgentRun }> = [];
    const unavailableNodeIds: string[] = [];
    await Promise.all(nodes.map(async (node) => {
      try {
        const payload = z.object({ runs: z.array(z.unknown()) }).strip().parse(await nodeJson(service, node.id, "/agent-runs"));
        const nodeRuns = payload.runs.map(sanitizeAgentRun);
        aggregator?.replaceRuns(node.id, nodeRuns);
        const visibility = await Promise.all(nodeRuns.map(async (run) => {
          try {
            await assertRunVisible(service, request, node.id, run);
            return run;
          } catch {
            return undefined;
          }
        }));
        runs.push(...visibility.flatMap((run) => run ? [{ nodeId: node.id, run }] : []));
      } catch {
        unavailableNodeIds.push(node.id);
        const visibility = await Promise.all((aggregator?.runsForNode(node.id) ?? []).map(async (run) => {
          try {
            await assertRunVisible(service, request, node.id, run);
            return run;
          } catch {
            return undefined;
          }
        }));
        runs.push(...visibility.flatMap((run) => run ? [{ nodeId: node.id, run }] : []));
      }
    }));
    return { data: AgentRunAggregateSchema.parse({ runs, unavailableNodeIds }) };
  });

  app.post("/api/agent-runs", async (request, reply) => {
    const body = z.object({
      nodeId: z.string().trim().min(1).max(120),
      input: AgentRunCreateInputSchema,
    }).strict().parse(request.body);
    if (body.input.provenance.source === "control-plane") {
      throw Object.assign(new Error("Control Plane provenance is derived from the authenticated manual-run endpoint."), {
        statusCode: 400,
        code: "AGENT_RUN_MANUAL_PROVENANCE_FORBIDDEN",
      });
    }
    requireRunCapableNode(service, request, body.nodeId);
    await requireVisibleOrchestration(service, request, body.nodeId, body.input.orchestrationId);
    await requireVisibleInstanceOnNode(service, request, body.nodeId, body.input.provenance.initiatingInstanceId);
    await requireStoryOnNode(service, request, body.nodeId, body.input.provenance.storyId);
    const run = sanitizeAgentRun(await nodeJson(service, body.nodeId, "/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.input),
    }));
    await assertRunVisible(service, request, body.nodeId, run);
    aggregator?.storeRun(body.nodeId, run);
    return reply.code(201).send({ data: run });
  });

  app.post("/api/agent-runs/manual", async (request, reply) => {
    const body = z.object({
      nodeId: z.string().trim().min(1).max(120),
      input: AgentRunManualCreateInputSchema,
    }).strict().parse(request.body);
    requireManualRunCapableNode(service, request, body.nodeId);
    await requireVisibleOrchestration(service, request, body.nodeId, body.input.orchestrationId);
    const actor = controlPlaneRequestActor(request);
    const run = sanitizeAgentRun(await nodeJson(service, body.nodeId, "/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body.input,
        provenance: {
          source: "control-plane",
          ...(actor?.type === "user" ? {
            authorizationSubject: {
              kind: "control-plane-user",
              subjectId: actor.userId,
              authorizationRevision: actor.authorizationRevision,
            },
          } : {}),
        },
      }),
    }));
    await assertRunVisible(service, request, body.nodeId, run);
    aggregator?.storeRun(body.nodeId, run);
    return reply.code(201).send({ data: run });
  });

  app.get<{ Params: { runId: string } }>("/api/agent-runs/:runId", async (request) => {
    const { runId } = RunRouteSchema.parse(request.params);
    const { nodeId } = NodeRequiredQuerySchema.parse(request.query);
    return { data: await requireVisibleRun(service, request, nodeId, runId) };
  });

  app.get<{ Params: { runId: string; memberId: string } }>("/api/agent-runs/:runId/members/:memberId", async (request) => {
    const { runId, memberId } = RunMemberRouteSchema.parse(request.params);
    const { nodeId } = NodeRequiredQuerySchema.parse(request.query);
    await requireVisibleRun(service, request, nodeId, runId);
    const member = sanitizeAgentRunMember(await nodeJson(
      service,
      nodeId,
      `/agent-runs/${encodeURIComponent(runId)}/members/${encodeURIComponent(memberId)}`,
    ));
    await requireVisibleInstanceOnNode(service, request, nodeId, member.instanceId);
    return { data: AgentRunMemberSchema.parse(member) };
  });

  app.post<{ Params: { runId: string } }>("/api/agent-runs/:runId/cancel", async (request) => {
    const { runId } = RunRouteSchema.parse(request.params);
    const body = z.object({
      nodeId: z.string().trim().min(1).max(120),
      input: AgentRunCancelInputSchema,
    }).strict().parse(request.body);
    await requireVisibleRun(service, request, body.nodeId, runId);
    const run = sanitizeAgentRun(await nodeJson(service, body.nodeId, `/agent-runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.input),
    }));
    await assertRunVisible(service, request, body.nodeId, run);
    aggregator?.storeRun(body.nodeId, run);
    return { data: run };
  });
}

/**
 * AgentOrchestration 的转发层：编排是 Node 本地对象，Control Plane 只做聚合、可见性投影与事件缓存，
 * 不保存可写副本。Node 不支持编排管理时整个编排域按 capability 关闭，不影响定义与 Run。
 */
export function registerAgentOrchestrationRoutes(app: FastifyInstance, service: ControlPlaneService, aggregator?: ControlPlaneAgentAggregator) {
  app.get("/api/agent-orchestrations", async (request) => {
    const { nodeId } = NodeQuerySchema.parse(request.query);
    const nodes = nodeId
      ? [requireOrchestrationCapableNode(service, request, nodeId)]
      : service.listNodes().filter((node) => requestCanAccessNode(request, node.id)
        && supportsNodeAgentOrchestrations(nodeAgentCapabilitiesFromPublicNode(node.capabilities)));
    const visibleInstanceIds = await requestVisibleInstanceIds(service, request);
    const orchestrations: Array<{ nodeId: string; orchestration: AgentOrchestration }> = [];
    const unavailableNodeIds: string[] = [];
    await Promise.all(nodes.map(async (node) => {
      try {
        const list = sanitizeAgentOrchestrationList(await nodeJson(service, node.id, "/agent-orchestrations"));
        aggregator?.replaceOrchestrations(node.id, list.orchestrations);
        const definitions = sanitizeAgentDefinitionList(await nodeJson(service, node.id, "/agents")).agents;
        orchestrations.push(...projectVisibleOrchestrations(list.orchestrations, definitions, visibleInstanceIds).map((orchestration) => ({ nodeId: node.id, orchestration })));
      } catch {
        unavailableNodeIds.push(node.id);
        const cached = aggregator?.orchestrationsForNode(node.id) ?? [];
        const definitions = aggregator?.definitionsForNode(node.id) ?? [];
        orchestrations.push(...projectVisibleOrchestrations(cached, definitions, visibleInstanceIds).map((orchestration) => ({ nodeId: node.id, orchestration })));
      }
    }));
    return { data: AgentOrchestrationAggregateSchema.parse({ orchestrations, unavailableNodeIds }) };
  });

  app.get<{ Params: { orchestrationId: string } }>("/api/agent-orchestrations/:orchestrationId", async (request) => {
    const { orchestrationId } = OrchestrationRouteSchema.parse(request.params);
    const { nodeId } = NodeRequiredQuerySchema.parse(request.query);
    return { data: await requireVisibleOrchestration(service, request, nodeId, orchestrationId) };
  });

  app.post("/api/agent-orchestrations", async (request, reply) => {
    const body = z.object({
      nodeId: z.string().trim().min(1).max(120),
      input: AgentOrchestrationCreateInputSchema,
    }).strict().parse(request.body);
    requireOrchestrationCapableNode(service, request, body.nodeId);
    await Promise.all(body.input.agentIds.map((agentId) => requireVisibleAgent(service, request, body.nodeId, agentId)));
    const orchestration = sanitizeAgentOrchestration(await nodeJson(service, body.nodeId, "/agent-orchestrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.input),
    }));
    aggregator?.storeOrchestration(body.nodeId, orchestration);
    return reply.code(201).send({ data: orchestration });
  });

  app.patch<{ Params: { orchestrationId: string } }>("/api/agent-orchestrations/:orchestrationId", async (request) => {
    const { orchestrationId } = OrchestrationRouteSchema.parse(request.params);
    const body = z.object({
      nodeId: z.string().trim().min(1).max(120),
      input: AgentOrchestrationUpdateInputSchema,
    }).strict().parse(request.body);
    requireOrchestrationCapableNode(service, request, body.nodeId);
    const current = await requireVisibleOrchestration(service, request, body.nodeId, orchestrationId);
    await Promise.all((body.input.agentIds ?? current.agentIds).map((agentId) => requireVisibleAgent(service, request, body.nodeId, agentId)));
    const orchestration = sanitizeAgentOrchestration(await nodeJson(service, body.nodeId, `/agent-orchestrations/${encodeURIComponent(orchestrationId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.input),
    }));
    aggregator?.storeOrchestration(body.nodeId, orchestration);
    return { data: orchestration };
  });

  app.delete<{ Params: { orchestrationId: string } }>("/api/agent-orchestrations/:orchestrationId", async (request) => {
    const { orchestrationId } = OrchestrationRouteSchema.parse(request.params);
    const { nodeId } = NodeRequiredQuerySchema.parse(request.query);
    await requireVisibleOrchestration(service, request, nodeId, orchestrationId);
    const result = AgentOrchestrationDeleteResultSchema.parse(await nodeJson(
      service,
      nodeId,
      `/agent-orchestrations/${encodeURIComponent(orchestrationId)}`,
      { method: "DELETE" },
    ));
    aggregator?.removeOrchestration(nodeId, orchestrationId);
    return { data: result };
  });
}

/** 只投影成员实例全部可见的编排；已在 Node 上消失的悬挂成员没有实例语义，保留以便清理。 */
function projectVisibleOrchestrations(
  orchestrations: AgentOrchestration[],
  definitions: AgentDefinition[],
  visibleInstanceIds: Set<string>,
) {
  const instanceByAgentId = new Map(definitions.map((definition) => [definition.id, definition.targetInstanceId]));
  return orchestrations.filter((orchestration) => orchestration.agentIds.every((agentId) => {
    const instanceId = instanceByAgentId.get(agentId);
    return !instanceId || visibleInstanceIds.has(instanceId);
  }));
}
