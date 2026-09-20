import fs from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  STORY_DEFAULT_MAX_FILE_BYTES,
  StoryActionRunResultSchema,
  StoryAutomationInputSchema,
  StoryAutomationListSchema,
  StoryAutomationManualRunInputSchema,
  StoryAutomationRunSchema,
  StoryAutomationRunsSchema,
  StoryAutomationStatusSchema,
  StoryAutomationUpdateInputSchema,
  StoryAutomationWithActionInputSchema,
  StoryContentListSchema,
  StoryContentPageInputSchema,
  StoryContentPageResultSchema,
  StoryCreateInputSchema,
  StoryDocumentUpdateInputSchema,
  StoryIdSchema,
  StoryPathSchema,
  StoryUpdateInputSchema,
} from "@task-handoff/protocol/stories";
import {
  STORY_AGENT_ACTION_PROMPT_PREVIEW_CHARS,
  STORY_AGENT_TOOL_SCHEMAS,
  StoryAgentActionListInputSchema,
  StoryAgentActionListResultSchema,
  StoryAgentActionRunInputSchema,
  StoryAgentActionRunResultSchema,
  StoryAgentAutomationCreateInputSchema,
  StoryAgentAutomationDeleteInputSchema,
  StoryAgentAutomationListInputSchema,
  StoryAgentAutomationRunInputSchema,
  StoryAgentAutomationRunSchema,
  StoryAgentAutomationRunsInputSchema,
  StoryAgentAutomationStatusSchema,
  StoryAgentAutomationUpdateInputSchema,
  StoryAgentAiSessionGetInputSchema,
  StoryAgentAiSessionGetResultSchema,
  StoryAgentAiSessionListInputSchema,
  StoryAgentAiSessionListResultSchema,
  StoryAgentAiSessionTurnInputSchema,
  StoryAgentAiSessionTurnResultSchema,
  StoryAgentDeleteResultSchema,
  StoryAgentToolPolicyUpdateInputSchema,
  StoryAgentToolResolutionSchema,
  StoryAgentToolNameSchema,
  storyAgentPagination,
} from "@task-handoff/protocol/story-agent-tools";
import type { NodeAgentState } from "../state.ts";
import { NodeStoryStore } from "./store.ts";
import type { StoryCommandService } from "./command-service.ts";
import type { StoryScheduler } from "./scheduler.ts";
import type { StoryToolPolicyService } from "./tool-policy-service.ts";
import type { StoryAgentToolPolicyInvalidated } from "@task-handoff/protocol/story-agent-tools";
import type { StoryActionExecutionService } from "./action-execution-service.ts";
import type { StoryAiSessionReadService } from "./ai-session-read-service.ts";

type NodeStoryRouteOptions = {
  fetchImpl?: typeof fetch;
  resolveInstanceWeb?: (instance: ReturnType<NodeAgentState["requireInstance"]>) => Promise<string>;
  onRetentionSettingsChanged?: () => void | Promise<void>;
  commands?: StoryCommandService;
  scheduler?: StoryScheduler;
  toolPolicy?: StoryToolPolicyService;
  onToolPolicyInvalidated?: (event: StoryAgentToolPolicyInvalidated) => void | Promise<void>;
  actionExecution?: StoryActionExecutionService;
  aiSessionRead?: StoryAiSessionReadService;
};

const StoryParamsSchema = z.object({ storyId: StoryIdSchema }).strict();
const StoryDocumentParamsSchema = StoryParamsSchema.extend({ storyPath: z.string().min(1).max(2048) }).strict();
const StoryAutomationParamsSchema = StoryParamsSchema.extend({ automationId: z.string().trim().min(1).max(120) }).strict();
const InstanceSessionParamsSchema = z.object({
  id: z.string().trim().min(1).max(120),
  sessionId: z.string().trim().min(1).max(120),
}).strict();
const InstanceSessionToolParamsSchema = InstanceSessionParamsSchema.extend({ tool: StoryAgentToolNameSchema }).strict();
const StoryActionParamsSchema = StoryParamsSchema.extend({ actionId: z.string().trim().min(1).max(120) }).strict();
const StoryPathQuerySchema = z.object({ storyPath: StoryPathSchema }).strict();
const StoryWriteQuerySchema = StoryPathQuerySchema.extend({
  title: z.string().trim().min(1).max(240).optional(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const StoryToolResolutionQuerySchema = z.object({ storyId: StoryIdSchema }).strict();

function bearerToken(headers: Record<string, unknown>) {
  const authorization = headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
}

function projectAgentAutomationRun(run: z.infer<typeof StoryAutomationRunSchema>) {
  return StoryAgentAutomationRunSchema.parse({
    id: run.id,
    eventType: run.eventType,
    status: run.status,
    scheduledFor: run.scheduledFor,
    session: run.aiSessionId ? { instanceId: run.targetInstanceId, sessionId: run.aiSessionId } : undefined,
    error: run.error,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  });
}

function projectAgentAutomationStatus(status: z.infer<typeof StoryAutomationStatusSchema>) {
  return StoryAgentAutomationStatusSchema.parse({
    id: status.automation.id,
    actionId: status.automation.actionId,
    schedule: status.automation.schedule,
    enabled: status.automation.enabled,
    policy: status.automation.policy,
    updatedAt: status.automation.updatedAt,
    effectiveStatus: status.effectiveStatus,
    blockedReason: status.blockedReason,
    nextRunAt: status.nextRunAt,
    activeRunCount: status.currentRuns.length,
    lastRun: status.lastRun ? projectAgentAutomationRun(status.lastRun) : undefined,
  });
}

async function storyForSession(state: NodeAgentState, store: NodeStoryStore, instanceId: string, sessionId: string, token?: string) {
  const instance = state.authenticateInstance(instanceId, token);
  const session = instance.aiSessions.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw Object.assign(new Error("AI Session was not found in the authoritative instance snapshot."), { code: "AI_SESSION_NOT_FOUND", statusCode: 404 });
  if (!session.storyId) throw Object.assign(new Error("AI Session is not assigned to a Story."), { code: "STORY_CONTEXT_REQUIRED", statusCode: 409 });
  return await store.get(session.storyId) || (() => { throw Object.assign(new Error("Story was not found."), { code: "STORY_NOT_FOUND", statusCode: 404 }); })();
}

function sendStoryFile(reply: FastifyReply, stream: NodeJS.ReadableStream, revision: string, size: number) {
  reply.header("content-type", "application/octet-stream");
  reply.header("content-length", String(size));
  reply.header("x-story-revision", revision);
  return reply.send(stream);
}

export function registerNodeStoryRoutes(app: FastifyInstance, state: NodeAgentState, store: NodeStoryStore, options: NodeStoryRouteOptions = {}) {
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  }

  app.get("/api/node-agent/stories", async () => ({ data: { stories: await store.list() } }));

  app.post("/api/node-agent/stories", async (request, reply) => {
    const input = StoryCreateInputSchema.parse(request.body);
    const story = options.commands ? await options.commands.create(input) : await store.create(input);
    void options.onRetentionSettingsChanged?.();
    return reply.code(201).send({ data: story });
  });

  app.get("/api/node-agent/stories/:storyId", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    return { data: await store.get(storyId) || (() => { throw Object.assign(new Error("Story was not found."), { code: "STORY_NOT_FOUND", statusCode: 404 }); })() };
  });

  app.patch("/api/node-agent/stories/:storyId", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    const input = StoryUpdateInputSchema.parse(request.body);
    const story = options.commands ? await options.commands.update(storyId, input) : await store.update(storyId, input);
    if (input.maxIdleAiSessions !== undefined) void options.onRetentionSettingsChanged?.();
    return { data: story };
  });

  app.get("/api/node-agent/stories/:storyId/settings", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    return { data: await store.retentionSettings(storyId) };
  });

  app.get("/api/node-agent/stories/:storyId/settings/agent-tools", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    if (!options.toolPolicy) throw Object.assign(new Error("Story Agent Tool policy is unavailable."), { code: "STORY_AGENT_TOOL_POLICY_UNAVAILABLE", statusCode: 503 });
    return { data: await options.toolPolicy.settings(storyId) };
  });

  app.post("/api/node-agent/stories/:storyId/actions/:actionId/run", async (request) => {
    const { storyId, actionId } = StoryActionParamsSchema.parse(request.params);
    if (!options.actionExecution) throw Object.assign(new Error("Story Action execution is unavailable."), { code: "STORY_ACTION_EXECUTION_UNAVAILABLE", statusCode: 503 });
    const input = StoryAgentActionRunInputSchema.omit({ actionId: true }).parse(request.body || {});
    return { data: StoryActionRunResultSchema.parse(await options.actionExecution.run(storyId, actionId, input.clientRequestId)) };
  });

  app.put("/api/node-agent/stories/:storyId/settings/agent-tools", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    if (!options.toolPolicy) throw Object.assign(new Error("Story Agent Tool policy is unavailable."), { code: "STORY_AGENT_TOOL_POLICY_UNAVAILABLE", statusCode: 503 });
    const { policy } = StoryAgentToolPolicyUpdateInputSchema.parse(request.body);
    const settings = await options.toolPolicy.update(storyId, policy);
    const story = await store.get(storyId);
    if (story) store.notifyUpdated(story);
    await options.onToolPolicyInvalidated?.({ storyId, revision: settings.revision });
    return { data: settings };
  });

  app.post("/api/node-agent/stories/:storyId/archive", async (request) => ({
    data: options.commands
      ? await options.commands.archive(StoryParamsSchema.parse(request.params).storyId)
      : await store.archive(StoryParamsSchema.parse(request.params).storyId),
  }));

  app.post("/api/node-agent/stories/:storyId/restore", async (request) => ({
    data: options.commands
      ? await options.commands.restore(StoryParamsSchema.parse(request.params).storyId)
      : await store.restore(StoryParamsSchema.parse(request.params).storyId),
  }));

  app.delete("/api/node-agent/stories/:storyId", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    if (!options.commands) throw Object.assign(new Error("Story command service is unavailable."), { code: "STORY_COMMAND_UNAVAILABLE", statusCode: 503 });
    return { data: { deleted: await options.commands.delete(storyId) } };
  });

  if (options.scheduler) {
    const scheduler = options.scheduler;
    const requireScopedAutomation = async (storyId: string, automationId: string) => {
      const status = await scheduler.status(automationId);
      if (status.automation.storyId !== storyId) {
        throw Object.assign(new Error("Story Automation belongs to another Story."), { code: "STORY_AUTOMATION_STORY_MISMATCH", statusCode: 409 });
      }
      return status;
    };

    app.get("/api/node-agent/stories/:storyId/automations", async (request) => {
      const { storyId } = StoryParamsSchema.parse(request.params);
      await store.require(storyId);
      return { data: StoryAutomationListSchema.parse({ automations: await scheduler.list(storyId) }) };
    });

    app.post("/api/node-agent/stories/:storyId/automations", async (request, reply) => {
      const { storyId } = StoryParamsSchema.parse(request.params);
      const input = StoryAutomationInputSchema.parse(request.body);
      if (input.storyId !== storyId) throw Object.assign(new Error("Automation storyId does not match the route."), { code: "STORY_AUTOMATION_STORY_MISMATCH", statusCode: 409 });
      return reply.code(201).send({ data: StoryAutomationStatusSchema.parse(await scheduler.create(input)) });
    });

    app.post("/api/node-agent/stories/:storyId/automations/with-action", async (request, reply) => {
      const { storyId } = StoryParamsSchema.parse(request.params);
      if (!options.commands) throw Object.assign(new Error("Story command service is unavailable."), { code: "STORY_COMMAND_UNAVAILABLE", statusCode: 503 });
      const input = StoryAutomationWithActionInputSchema.parse(request.body);
      return reply.code(201).send({ data: StoryAutomationStatusSchema.parse(await options.commands.createAutomationWithAction(storyId, input)) });
    });

    app.get("/api/node-agent/stories/:storyId/automations/:automationId", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      return { data: StoryAutomationStatusSchema.parse(await requireScopedAutomation(storyId, automationId)) };
    });

    app.patch("/api/node-agent/stories/:storyId/automations/:automationId", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      await requireScopedAutomation(storyId, automationId);
      return { data: StoryAutomationStatusSchema.parse(await scheduler.update(automationId, StoryAutomationUpdateInputSchema.parse(request.body))) };
    });

    app.delete("/api/node-agent/stories/:storyId/automations/:automationId", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      await requireScopedAutomation(storyId, automationId);
      return { data: { deleted: await scheduler.delete(automationId) } };
    });

    for (const action of ["enable", "disable"] as const) {
      app.post(`/api/node-agent/stories/:storyId/automations/:automationId/${action}`, async (request) => {
        const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
        await requireScopedAutomation(storyId, automationId);
        return { data: StoryAutomationStatusSchema.parse(await scheduler.setEnabled(automationId, action === "enable")) };
      });
    }

    app.post("/api/node-agent/stories/:storyId/automations/:automationId/run", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      await requireScopedAutomation(storyId, automationId);
      return { data: await scheduler.manualRun(automationId, StoryAutomationManualRunInputSchema.parse(request.body)) };
    });

    app.get("/api/node-agent/stories/:storyId/automations/:automationId/runs", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      await requireScopedAutomation(storyId, automationId);
      return { data: StoryAutomationRunsSchema.parse({ runs: await scheduler.runs(automationId) }) };
    });
  }

  app.get("/api/node-agent/stories/:storyId/content", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    return { data: StoryContentListSchema.parse({ documents: await store.listContent(storyId) }) };
  });

  app.get("/api/node-agent/stories/:storyId/content/file", async (request, reply) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    const { storyPath } = StoryPathQuerySchema.parse(request.query);
    const content = await store.readContent(storyId, storyPath);
    return sendStoryFile(reply, content.stream, content.revision, content.size);
  });

  app.put("/api/node-agent/stories/:storyId/content/file", { bodyLimit: STORY_DEFAULT_MAX_FILE_BYTES + 1024 }, async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    const input = StoryWriteQuerySchema.parse(request.query);
    const { storyPath, revision, size } = await store.writeContent(storyId, { ...input, stream: request.body as NodeJS.ReadableStream });
    // Compatibility for v0.0.32: the management upload response remains unchanged;
    // only the controlled-instance Agent boundary receives the authoritative title.
    return { data: { storyPath, revision, size } };
  });

  app.patch("/api/node-agent/stories/:storyId/documents/:storyPath", async (request) => {
    const params = StoryDocumentParamsSchema.parse(request.params);
    const currentPath = StoryPathSchema.parse(decodeURIComponent(params.storyPath));
    return { data: await store.updateDocument(params.storyId, currentPath, StoryDocumentUpdateInputSchema.parse(request.body)) };
  });

  app.delete("/api/node-agent/stories/:storyId/documents/:storyPath", async (request) => {
    const params = StoryDocumentParamsSchema.parse(request.params);
    return { data: { deleted: await store.deleteDocument(params.storyId, StoryPathSchema.parse(decodeURIComponent(params.storyPath))) } };
  });

  app.post("/api/node-agent/stories/:storyId/documents/order", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    return { data: await store.reorderDocuments(storyId, request.body) };
  });

  app.get("/api/node-agent/instances/:id/ai-sessions/:sessionId/story-content", async (request) => {
    const { id, sessionId } = InstanceSessionParamsSchema.parse(request.params);
    const story = await storyForSession(state, store, id, sessionId, bearerToken(request.headers));
    await options.toolPolicy?.assertEnabled(story.id, "story_list_content");
    const { page, pageSize } = StoryContentPageInputSchema.parse(request.query || {});
    return { data: StoryContentPageResultSchema.parse(await store.pageContent(story.id, page, pageSize)) };
  });

  app.get("/api/node-agent/instances/:id/story-agent-tools", async (request) => {
    const { id } = z.object({ id: z.string().trim().min(1).max(120) }).strict().parse(request.params);
    const { storyId } = StoryToolResolutionQuerySchema.parse(request.query);
    state.authenticateInstance(id, bearerToken(request.headers));
    if (!options.toolPolicy) throw Object.assign(new Error("Story Agent Tool policy is unavailable."), { code: "STORY_AGENT_TOOL_POLICY_UNAVAILABLE", statusCode: 503 });
    return { data: StoryAgentToolResolutionSchema.parse(await options.toolPolicy.resolve(storyId)) };
  });

  app.get("/api/node-agent/instances/:id/ai-sessions/:sessionId/story-agent-tools", async (request) => {
    const { id, sessionId } = InstanceSessionParamsSchema.parse(request.params);
    const story = await storyForSession(state, store, id, sessionId, bearerToken(request.headers));
    if (!options.toolPolicy) throw Object.assign(new Error("Story Agent Tool policy is unavailable."), { code: "STORY_AGENT_TOOL_POLICY_UNAVAILABLE", statusCode: 503 });
    return { data: StoryAgentToolResolutionSchema.parse(await options.toolPolicy.resolve(story.id)) };
  });

  app.post("/api/node-agent/instances/:id/ai-sessions/:sessionId/story-agent-tools/:tool", async (request) => {
    const { id, sessionId, tool } = InstanceSessionToolParamsSchema.parse(request.params);
    const story = await storyForSession(state, store, id, sessionId, bearerToken(request.headers));
    await options.toolPolicy?.assertEnabled(story.id, tool);
    const body = z.object({ input: z.unknown() }).strict().parse(request.body || {});
    const input = STORY_AGENT_TOOL_SCHEMAS[tool].input.parse(body.input ?? {});
    if (tool === "story_list_actions") {
      const { page, pageSize } = StoryAgentActionListInputSchema.parse(input);
      const offset = (page - 1) * pageSize;
      const availableInstanceIds = new Set(state.listInstances()
        .filter((instance) => instance.nodeId === state.node.id)
        .map((instance) => instance.id));
      const actions = story.actions.slice(offset, offset + pageSize).map((action) => {
        const unavailableReason = story.archivedAt
          ? "STORY_ARCHIVED" as const
          : !action.targetInstanceId
            ? "STORY_ACTION_TARGET_REQUIRED" as const
            : !availableInstanceIds.has(action.targetInstanceId)
              ? "STORY_ACTION_TARGET_UNAVAILABLE" as const
              : undefined;
        return {
          id: action.id,
          title: action.title,
          promptPreview: action.promptTemplate.slice(0, STORY_AGENT_ACTION_PROMPT_PREVIEW_CHARS),
          promptTruncated: action.promptTemplate.length > STORY_AGENT_ACTION_PROMPT_PREVIEW_CHARS,
          executable: !unavailableReason,
          unavailableReason,
        };
      });
      const totalItems = story.actions.length;
      const data = StoryAgentActionListResultSchema.parse({
        actions,
        pagination: storyAgentPagination(totalItems, page, pageSize),
      });
      return { data };
    }
    if (tool === "story_run_action") {
      if (!options.actionExecution) throw Object.assign(new Error("Story Action execution is unavailable."), { code: "STORY_ACTION_EXECUTION_UNAVAILABLE", statusCode: 503 });
      const action = StoryAgentActionRunInputSchema.parse(input);
      const result = await options.actionExecution.run(story.id, action.actionId, action.clientRequestId);
      return { data: StoryAgentActionRunResultSchema.parse({ session: { instanceId: result.targetInstanceId, sessionId: result.aiSessionId } }) };
    }
    if (tool === "story_list_automations") {
      const { page, pageSize } = StoryAgentAutomationListInputSchema.parse(input);
      if (!options.scheduler) throw Object.assign(new Error("Story Automation scheduler is unavailable."), { code: "STORY_AUTOMATION_UNAVAILABLE", statusCode: 503 });
      const statuses = await options.scheduler.list(story.id);
      const offset = (page - 1) * pageSize;
      return { data: STORY_AGENT_TOOL_SCHEMAS[tool].output.parse({
        automations: statuses.slice(offset, offset + pageSize).map(projectAgentAutomationStatus),
        pagination: storyAgentPagination(statuses.length, page, pageSize),
      }) };
    }
    if (tool === "story_create_automation") {
      if (!options.scheduler) throw Object.assign(new Error("Story Automation scheduler is unavailable."), { code: "STORY_AUTOMATION_UNAVAILABLE", statusCode: 503 });
      const automation = StoryAgentAutomationCreateInputSchema.parse(input);
      return { data: STORY_AGENT_TOOL_SCHEMAS[tool].output.parse(projectAgentAutomationStatus(await options.scheduler.create({ storyId: story.id, ...automation }))) };
    }
    if (tool === "story_update_automation") {
      if (!options.scheduler) throw Object.assign(new Error("Story Automation scheduler is unavailable."), { code: "STORY_AUTOMATION_UNAVAILABLE", statusCode: 503 });
      const { automationId, expectedUpdatedAt, ...patch } = StoryAgentAutomationUpdateInputSchema.parse(input);
      const current = await options.scheduler.status(automationId);
      if (current.automation.storyId !== story.id) throw automationScopeError();
      return { data: STORY_AGENT_TOOL_SCHEMAS[tool].output.parse(projectAgentAutomationStatus(await options.scheduler.update(automationId, patch, expectedUpdatedAt))) };
    }
    if (tool === "story_delete_automation") {
      if (!options.scheduler) throw Object.assign(new Error("Story Automation scheduler is unavailable."), { code: "STORY_AUTOMATION_UNAVAILABLE", statusCode: 503 });
      const { automationId, expectedUpdatedAt } = StoryAgentAutomationDeleteInputSchema.parse(input);
      const current = await options.scheduler.status(automationId);
      if (current.automation.storyId !== story.id) throw automationScopeError();
      return { data: StoryAgentDeleteResultSchema.parse({ deleted: await options.scheduler.delete(automationId, expectedUpdatedAt) }) };
    }
    if (tool === "story_run_automation") {
      if (!options.scheduler) throw Object.assign(new Error("Story Automation scheduler is unavailable."), { code: "STORY_AUTOMATION_UNAVAILABLE", statusCode: 503 });
      const { automationId, clientRequestId } = StoryAgentAutomationRunInputSchema.parse(input);
      const current = await options.scheduler.status(automationId);
      if (current.automation.storyId !== story.id) throw automationScopeError();
      return { data: STORY_AGENT_TOOL_SCHEMAS[tool].output.parse(projectAgentAutomationRun(await options.scheduler.manualRun(automationId, { clientRequestId }))) };
    }
    if (tool === "story_list_automation_runs") {
      if (!options.scheduler) throw Object.assign(new Error("Story Automation scheduler is unavailable."), { code: "STORY_AUTOMATION_UNAVAILABLE", statusCode: 503 });
      const { automationId, page, pageSize } = StoryAgentAutomationRunsInputSchema.parse(input);
      const current = await options.scheduler.status(automationId);
      if (current.automation.storyId !== story.id) throw automationScopeError();
      const runs = await options.scheduler.runs(automationId);
      const offset = (page - 1) * pageSize;
      return { data: STORY_AGENT_TOOL_SCHEMAS[tool].output.parse({
        runs: runs.slice(offset, offset + pageSize).map(projectAgentAutomationRun),
        pagination: storyAgentPagination(runs.length, page, pageSize),
      }) };
    }
    const caller = { instanceId: id, sessionId, storyId: story.id };
    if (tool === "story_list_ai_sessions") {
      if (!options.aiSessionRead) throw Object.assign(new Error("Story AI Session read is unavailable."), { code: "STORY_AI_SESSION_READ_UNAVAILABLE", statusCode: 503 });
      const { page, pageSize } = StoryAgentAiSessionListInputSchema.parse(input);
      return { data: StoryAgentAiSessionListResultSchema.parse(options.aiSessionRead.list(caller, page, pageSize)) };
    }
    if (tool === "story_get_ai_session") {
      if (!options.aiSessionRead) throw Object.assign(new Error("Story AI Session read is unavailable."), { code: "STORY_AI_SESSION_READ_UNAVAILABLE", statusCode: 503 });
      const target = StoryAgentAiSessionGetInputSchema.parse(input);
      return { data: StoryAgentAiSessionGetResultSchema.parse(await options.aiSessionRead.get(caller, target.instanceId, target.sessionId, target.page, target.pageSize)) };
    }
    if (tool === "story_get_ai_session_turn") {
      if (!options.aiSessionRead) throw Object.assign(new Error("Story AI Session read is unavailable."), { code: "STORY_AI_SESSION_READ_UNAVAILABLE", statusCode: 503 });
      const target = StoryAgentAiSessionTurnInputSchema.parse(input);
      return { data: StoryAgentAiSessionTurnResultSchema.parse(await options.aiSessionRead.turn(
        caller,
        target.instanceId,
        target.sessionId,
        target.turnId,
        target.page,
        target.pageSize,
        target.maxTextChars,
      )) };
    }
    throw Object.assign(new Error("Story Agent Tool is not implemented."), { code: "STORY_AGENT_TOOL_NOT_IMPLEMENTED", statusCode: 501 });
  });

  app.get("/api/node-agent/instances/:id/ai-sessions/:sessionId/story-content/file", async (request, reply) => {
    const { id, sessionId } = InstanceSessionParamsSchema.parse(request.params);
    const story = await storyForSession(state, store, id, sessionId, bearerToken(request.headers));
    await options.toolPolicy?.assertEnabled(story.id, "story_get_content");
    const { storyPath } = StoryPathQuerySchema.parse(request.query);
    const content = await store.readContent(story.id, storyPath);
    return sendStoryFile(reply, content.stream, content.revision, content.size);
  });

  app.put("/api/node-agent/instances/:id/ai-sessions/:sessionId/story-content/file", {
    bodyLimit: STORY_DEFAULT_MAX_FILE_BYTES + 1024,
  }, async (request) => {
    const { id, sessionId } = InstanceSessionParamsSchema.parse(request.params);
    const story = await storyForSession(state, store, id, sessionId, bearerToken(request.headers));
    await options.toolPolicy?.assertEnabled(story.id, "story_set_content");
    const input = StoryWriteQuerySchema.parse(request.query);
    return { data: await store.writeContent(story.id, {
      ...input,
      stream: request.body as NodeJS.ReadableStream,
    }) };
  });

  app.put("/api/node-agent/instances/:id/ai-sessions/:sessionId/story", async (request) => {
    const { id, sessionId } = InstanceSessionParamsSchema.parse(request.params);
    const instance = state.requireInstance(id);
    const body = z.object({ storyId: StoryIdSchema.nullable() }).strict().parse(request.body || {});
    if (body.storyId) {
      const story = await store.get(body.storyId);
      if (!story) throw Object.assign(new Error("Story belongs to another node or was not found."), { code: "STORY_NODE_MISMATCH", statusCode: 409 });
      if (story.archivedAt) throw Object.assign(new Error("Archived Story cannot receive new Session associations."), { code: "STORY_ARCHIVED", statusCode: 409 });
    }
    if (!options.fetchImpl || !options.resolveInstanceWeb || !instance.registrationToken) {
      throw Object.assign(new Error("Managed instance Session association is unavailable."), { code: "STORY_SESSION_ASSOCIATION_UNAVAILABLE", statusCode: 503 });
    }
    const base = await options.resolveInstanceWeb(instance);
    const response = await options.fetchImpl(`${base}/api/ai-sessions/${encodeURIComponent(sessionId)}/story`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.registrationToken}` },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error?.message || "Controlled instance rejected Story association."), { code: payload.error?.code || "STORY_SESSION_ASSOCIATION_FAILED", statusCode: response.status });
    return payload;
  });
}

function automationScopeError() {
  return Object.assign(new Error("Story Automation belongs to another Story."), { code: "STORY_AUTOMATION_STORY_MISMATCH", statusCode: 409 });
}
