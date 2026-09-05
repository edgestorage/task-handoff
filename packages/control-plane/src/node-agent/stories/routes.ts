import fs from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  STORY_DEFAULT_MAX_FILE_BYTES,
  StoryAutomationInputSchema,
  StoryAutomationListSchema,
  StoryAutomationManualRunInputSchema,
  StoryAutomationRunsSchema,
  StoryAutomationStatusSchema,
  StoryAutomationUpdateInputSchema,
  StoryAutomationWithActionInputSchema,
  StoryContentListSchema,
  StoryCreateInputSchema,
  StoryDocumentUpdateInputSchema,
  StoryIdSchema,
  StoryPathSchema,
  StoryUpdateInputSchema,
} from "@task-handoff/protocol/stories";
import type { NodeAgentState } from "../state.ts";
import { NodeStoryStore } from "./store.ts";
import type { StoryCommandService } from "./command-service.ts";
import type { StoryScheduler } from "./scheduler.ts";

type NodeStoryRouteOptions = {
  fetchImpl?: typeof fetch;
  resolveInstanceWeb?: (instance: ReturnType<NodeAgentState["requireInstance"]>) => Promise<string>;
  onRetentionSettingsChanged?: () => void | Promise<void>;
  commands?: StoryCommandService;
  scheduler?: StoryScheduler;
};

const StoryParamsSchema = z.object({ storyId: StoryIdSchema }).strict();
const StoryDocumentParamsSchema = StoryParamsSchema.extend({ storyPath: z.string().min(1).max(2048) }).strict();
const StoryAutomationParamsSchema = StoryParamsSchema.extend({ automationId: z.string().trim().min(1).max(120) }).strict();
const InstanceSessionParamsSchema = z.object({
  id: z.string().trim().min(1).max(120),
  sessionId: z.string().trim().min(1).max(120),
}).strict();
const StoryPathQuerySchema = z.object({ storyPath: StoryPathSchema }).strict();
const StoryWriteQuerySchema = StoryPathQuerySchema.extend({
  title: z.string().trim().min(1).max(240).optional(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

function bearerToken(headers: Record<string, unknown>) {
  const authorization = headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
}

function storyForSession(state: NodeAgentState, store: NodeStoryStore, instanceId: string, sessionId: string, token?: string) {
  const instance = state.authenticateInstance(instanceId, token);
  const session = instance.aiSessions.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw Object.assign(new Error("AI Session was not found in the authoritative instance snapshot."), { code: "AI_SESSION_NOT_FOUND", statusCode: 404 });
  if (!session.storyId) throw Object.assign(new Error("AI Session is not assigned to a Story."), { code: "STORY_CONTEXT_REQUIRED", statusCode: 409 });
  return store.get(session.storyId) || (() => { throw Object.assign(new Error("Story was not found."), { code: "STORY_NOT_FOUND", statusCode: 404 }); })();
}

function sendStoryFile(reply: FastifyReply, filePath: string, revision: string, size: number) {
  reply.header("content-type", "application/octet-stream");
  reply.header("content-length", String(size));
  reply.header("x-story-revision", revision);
  return reply.send(fs.createReadStream(filePath));
}

export function registerNodeStoryRoutes(app: FastifyInstance, state: NodeAgentState, store: NodeStoryStore, options: NodeStoryRouteOptions = {}) {
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  }

  app.get("/api/node-agent/stories", async () => ({ data: { stories: store.list() } }));

  app.post("/api/node-agent/stories", async (request, reply) => {
    const story = store.create(StoryCreateInputSchema.parse(request.body));
    void options.onRetentionSettingsChanged?.();
    return reply.code(201).send({ data: story });
  });

  app.get("/api/node-agent/stories/:storyId", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    return { data: store.get(storyId) || (() => { throw Object.assign(new Error("Story was not found."), { code: "STORY_NOT_FOUND", statusCode: 404 }); })() };
  });

  app.patch("/api/node-agent/stories/:storyId", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    const input = StoryUpdateInputSchema.parse(request.body);
    const story = options.commands ? options.commands.update(storyId, input) : store.update(storyId, input);
    if (input.maxIdleAiSessions !== undefined) void options.onRetentionSettingsChanged?.();
    return { data: story };
  });

  app.get("/api/node-agent/stories/:storyId/settings", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    return { data: store.retentionSettings(storyId) };
  });

  app.post("/api/node-agent/stories/:storyId/archive", async (request) => ({
    data: options.commands?.archive(StoryParamsSchema.parse(request.params).storyId)
      ?? store.archive(StoryParamsSchema.parse(request.params).storyId),
  }));

  app.post("/api/node-agent/stories/:storyId/restore", async (request) => ({
    data: options.commands?.restore(StoryParamsSchema.parse(request.params).storyId)
      ?? store.restore(StoryParamsSchema.parse(request.params).storyId),
  }));

  app.delete("/api/node-agent/stories/:storyId", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    return { data: { deleted: options.commands ? options.commands.delete(storyId) : store.delete(storyId) } };
  });

  if (options.scheduler) {
    const scheduler = options.scheduler;
    const requireScopedAutomation = (storyId: string, automationId: string) => {
      const status = scheduler.status(automationId);
      if (status.automation.storyId !== storyId) {
        throw Object.assign(new Error("Story Automation belongs to another Story."), { code: "STORY_AUTOMATION_STORY_MISMATCH", statusCode: 409 });
      }
      return status;
    };

    app.get("/api/node-agent/stories/:storyId/automations", async (request) => {
      const { storyId } = StoryParamsSchema.parse(request.params);
      store.require(storyId);
      return { data: StoryAutomationListSchema.parse({ automations: scheduler.list(storyId) }) };
    });

    app.post("/api/node-agent/stories/:storyId/automations", async (request, reply) => {
      const { storyId } = StoryParamsSchema.parse(request.params);
      const input = StoryAutomationInputSchema.parse(request.body);
      if (input.storyId !== storyId) throw Object.assign(new Error("Automation storyId does not match the route."), { code: "STORY_AUTOMATION_STORY_MISMATCH", statusCode: 409 });
      return reply.code(201).send({ data: StoryAutomationStatusSchema.parse(scheduler.create(input)) });
    });

    app.post("/api/node-agent/stories/:storyId/automations/with-action", async (request, reply) => {
      const { storyId } = StoryParamsSchema.parse(request.params);
      if (!options.commands) throw Object.assign(new Error("Story command service is unavailable."), { code: "STORY_COMMAND_UNAVAILABLE", statusCode: 503 });
      const input = StoryAutomationWithActionInputSchema.parse(request.body);
      return reply.code(201).send({ data: StoryAutomationStatusSchema.parse(options.commands.createAutomationWithAction(storyId, input)) });
    });

    app.get("/api/node-agent/stories/:storyId/automations/:automationId", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      return { data: StoryAutomationStatusSchema.parse(requireScopedAutomation(storyId, automationId)) };
    });

    app.patch("/api/node-agent/stories/:storyId/automations/:automationId", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      requireScopedAutomation(storyId, automationId);
      return { data: StoryAutomationStatusSchema.parse(scheduler.update(automationId, StoryAutomationUpdateInputSchema.parse(request.body))) };
    });

    app.delete("/api/node-agent/stories/:storyId/automations/:automationId", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      requireScopedAutomation(storyId, automationId);
      return { data: { deleted: scheduler.delete(automationId) } };
    });

    for (const action of ["enable", "disable"] as const) {
      app.post(`/api/node-agent/stories/:storyId/automations/:automationId/${action}`, async (request) => {
        const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
        requireScopedAutomation(storyId, automationId);
        return { data: StoryAutomationStatusSchema.parse(scheduler.setEnabled(automationId, action === "enable")) };
      });
    }

    app.post("/api/node-agent/stories/:storyId/automations/:automationId/run", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      requireScopedAutomation(storyId, automationId);
      return { data: scheduler.manualRun(automationId, StoryAutomationManualRunInputSchema.parse(request.body)) };
    });

    app.get("/api/node-agent/stories/:storyId/automations/:automationId/runs", async (request) => {
      const { storyId, automationId } = StoryAutomationParamsSchema.parse(request.params);
      requireScopedAutomation(storyId, automationId);
      return { data: StoryAutomationRunsSchema.parse({ runs: scheduler.runs(automationId) }) };
    });
  }

  app.get("/api/node-agent/stories/:storyId/content", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    return { data: StoryContentListSchema.parse({ documents: store.listContent(storyId) }) };
  });

  app.get("/api/node-agent/stories/:storyId/content/file", async (request, reply) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    const { storyPath } = StoryPathQuerySchema.parse(request.query);
    const content = store.readContent(storyId, storyPath);
    return sendStoryFile(reply, content.filePath, content.revision, content.size);
  });

  app.put("/api/node-agent/stories/:storyId/content/file", { bodyLimit: STORY_DEFAULT_MAX_FILE_BYTES + 1024 }, async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    const input = StoryWriteQuerySchema.parse(request.query);
    return { data: await store.writeContent(storyId, { ...input, stream: request.body as NodeJS.ReadableStream }) };
  });

  app.patch("/api/node-agent/stories/:storyId/documents/:storyPath", async (request) => {
    const params = StoryDocumentParamsSchema.parse(request.params);
    const currentPath = StoryPathSchema.parse(decodeURIComponent(params.storyPath));
    return { data: store.updateDocument(params.storyId, currentPath, StoryDocumentUpdateInputSchema.parse(request.body)) };
  });

  app.delete("/api/node-agent/stories/:storyId/documents/:storyPath", async (request) => {
    const params = StoryDocumentParamsSchema.parse(request.params);
    return { data: { deleted: store.deleteDocument(params.storyId, StoryPathSchema.parse(decodeURIComponent(params.storyPath))) } };
  });

  app.post("/api/node-agent/stories/:storyId/documents/order", async (request) => {
    const { storyId } = StoryParamsSchema.parse(request.params);
    return { data: store.reorderDocuments(storyId, request.body) };
  });

  app.get("/api/node-agent/instances/:id/ai-sessions/:sessionId/story-content", async (request) => {
    const { id, sessionId } = InstanceSessionParamsSchema.parse(request.params);
    const story = storyForSession(state, store, id, sessionId, bearerToken(request.headers));
    return { data: StoryContentListSchema.parse({ documents: store.listContent(story.id) }) };
  });

  app.get("/api/node-agent/instances/:id/ai-sessions/:sessionId/story-content/file", async (request, reply) => {
    const { id, sessionId } = InstanceSessionParamsSchema.parse(request.params);
    const story = storyForSession(state, store, id, sessionId, bearerToken(request.headers));
    const { storyPath } = StoryPathQuerySchema.parse(request.query);
    const content = store.readContent(story.id, storyPath);
    return sendStoryFile(reply, content.filePath, content.revision, content.size);
  });

  app.put("/api/node-agent/instances/:id/ai-sessions/:sessionId/story-content/file", {
    bodyLimit: STORY_DEFAULT_MAX_FILE_BYTES + 1024,
  }, async (request) => {
    const { id, sessionId } = InstanceSessionParamsSchema.parse(request.params);
    const story = storyForSession(state, store, id, sessionId, bearerToken(request.headers));
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
      const story = store.get(body.storyId);
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
