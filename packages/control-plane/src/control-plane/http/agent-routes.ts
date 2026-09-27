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
  supportsNodeAgentRuns,
  supportsNodeAgentManualRuns,
  supportsNodeAgentStoryEntryAuthorization,
} from "@task-handoff/protocol/node-agent-capabilities";
import {
  StoryAgentEntrySetSchema,
  StoryAgentEntrySetUpdateInputSchema,
  sanitizeStoryAgentEntrySet,
} from "@task-handoff/protocol/story-agent-authorization";
import { StoryIdSchema, StorySchema } from "@task-handoff/protocol/stories";
import type { ControlPlaneService } from "../application/service.ts";
import { requestCanAccessInstance, requestCanAccessNode } from "./access-projection.ts";
import { nodeJson } from "./node-agent-request.ts";
import type { ControlPlaneAgentAggregator } from "../agents/agent-aggregator.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";

const NodeQuerySchema = z.object({ nodeId: z.string().trim().min(1).max(120).optional() }).strict();
const NodeRequiredQuerySchema = z.object({ nodeId: z.string().trim().min(1).max(120) }).strict();
const AgentRouteSchema = z.object({ agentId: AgentDefinitionIdSchema }).strict();
const RunRouteSchema = z.object({ runId: AgentRunIdSchema }).strict();
const RunMemberRouteSchema = RunRouteSchema.extend({ memberId: AgentRunMemberIdSchema }).strict();
const StoryRouteSchema = z.object({ storyId: StoryIdSchema }).strict();

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
    const { nodeId } = NodeRequiredQuerySchema.parse(request.query);
    await requireVisibleAgent(service, request, nodeId, agentId);
    const result = AgentDefinitionDeleteResultSchema.parse(await nodeJson(service, nodeId, `/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }));
    aggregator?.removeDefinition(nodeId, agentId);
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
    const retainedIds = new Set(current.entries.map((entry) => entry.agentId));
    await Promise.all(body.input.agentIds
      .filter((agentId) => !retainedIds.has(agentId))
      .map((agentId) => requireVisibleAgent(service, request, body.nodeId, agentId)));

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
    await requireVisibleAgent(service, request, body.nodeId, body.input.agentId);
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
    await requireVisibleAgent(service, request, body.nodeId, body.input.agentId);
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
