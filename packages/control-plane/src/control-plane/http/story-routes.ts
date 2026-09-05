import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  STORY_TEXT_PREVIEW_MAX_BYTES,
  StoryAutomationInputSchema,
  StoryAutomationListSchema,
  StoryAutomationManualRunInputSchema,
  StoryAutomationRunSchema,
  StoryAutomationRunsSchema,
  StoryAutomationStatusSchema,
  StoryAutomationUpdateInputSchema,
  StoryAutomationWithActionInputSchema,
  StoryContentPreviewSchema,
  StoryCreateInputSchema,
  StoryDocumentOrderInputSchema,
  StoryDocumentUpdateInputSchema,
  StoryIdSchema,
  StoryListSchema,
  StoryPathSchema,
  StorySchema,
  StoryUpdateInputSchema,
  StorySessionRetentionSettingsSchema,
} from "@task-handoff/protocol/stories";
import type { ControlPlaneService } from "../application/service.ts";

const NodeQuerySchema = z.object({ nodeId: z.string().trim().min(1).max(120).optional() }).strict();
const StoryRouteSchema = z.object({ storyId: StoryIdSchema }).strict();
const StoryAutomationRouteSchema = StoryRouteSchema.extend({ automationId: z.string().trim().min(1).max(120) }).strict();
const StoryRouteQuerySchema = z.object({ nodeId: z.string().trim().min(1).max(120) }).strict();

async function nodeJson(service: ControlPlaneService, nodeId: string, route: string, init: RequestInit = {}) {
  const node = service.requireNode(nodeId);
  const transport = service.resolveNodeAgentTransport(node);
  const response = await transport.request(node, route, init);
  const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { code?: string; message?: string } };
  if (!response.ok) throw Object.assign(new Error(payload.error?.message || `Node agent request failed with HTTP ${response.status}.`), {
    statusCode: response.status,
    code: payload.error?.code || "NODE_AGENT_REQUEST_FAILED",
  });
  return payload.data;
}

export function registerStoryRoutes(app: FastifyInstance, service: ControlPlaneService) {
  app.get("/api/stories", async (request) => {
    const { nodeId } = NodeQuerySchema.parse(request.query);
    const nodes = nodeId ? [service.requireNode(nodeId)] : service.listNodes();
    const stories = [] as Array<z.infer<typeof StorySchema>>;
    const unavailableNodeIds: string[] = [];
    await Promise.all(nodes.map(async (node) => {
      try {
        const payload = await nodeJson(service, node.id, "/stories");
        const parsed = StoryListSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Invalid Story list response.");
        stories.push(...parsed.data.stories);
      } catch {
        unavailableNodeIds.push(node.id);
      }
    }));
    return { data: { stories, unavailableNodeIds } };
  });

  app.get<{ Params: { storyId: string }; Querystring: { nodeId: string } }>("/api/stories/:storyId", async (request) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const { nodeId } = StoryRouteQuerySchema.parse(request.query);
    return { data: StorySchema.parse(await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}`)) };
  });

  app.post("/api/stories", async (request, reply) => {
    const body = z.object({ nodeId: z.string().trim().min(1).max(120), input: StoryCreateInputSchema }).strict().parse(request.body);
    const story = StorySchema.parse(await nodeJson(service, body.nodeId, "/stories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.input) }));
    return reply.code(201).send({ data: story });
  });

  app.patch<{ Params: { storyId: string } }>("/api/stories/:storyId", async (request) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const body = z.object({ nodeId: z.string().trim().min(1).max(120), input: StoryUpdateInputSchema }).strict().parse(request.body);
    return { data: StorySchema.parse(await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(storyId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body.input) })) };
  });

  app.get<{ Params: { storyId: string } }>("/api/stories/:storyId/settings", async (request) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const { nodeId } = StoryRouteQuerySchema.parse(request.query);
    return { data: StorySessionRetentionSettingsSchema.parse(await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}/settings`)) };
  });

  for (const action of ["archive", "restore"] as const) {
    app.post<{ Params: { storyId: string } }>(`/api/stories/:storyId/${action}`, async (request) => {
      const { storyId } = StoryRouteSchema.parse(request.params);
      const body = z.object({ nodeId: z.string().trim().min(1).max(120) }).strict().parse(request.body);
      return { data: StorySchema.parse(await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(storyId)}/${action}`, { method: "POST" })) };
    });
  }

  app.delete<{ Params: { storyId: string } }>("/api/stories/:storyId", async (request) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const { nodeId } = z.object({ nodeId: z.string().trim().min(1).max(120) }).strict().parse(request.query);
    return { data: await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}`, { method: "DELETE" }) };
  });

  app.get("/api/stories/:storyId/automations", async (request) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const { nodeId } = StoryRouteQuerySchema.parse(request.query);
    return { data: StoryAutomationListSchema.parse(await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}/automations`)) };
  });

  app.post("/api/stories/:storyId/automations", async (request, reply) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const body = z.object({ nodeId: z.string().trim().min(1).max(120), input: StoryAutomationInputSchema }).strict().parse(request.body);
    if (body.input.storyId !== storyId) throw Object.assign(new Error("Automation storyId does not match the route."), { code: "STORY_AUTOMATION_STORY_MISMATCH", statusCode: 409 });
    const data = await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(storyId)}/automations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.input),
    });
    return reply.code(201).send({ data: StoryAutomationStatusSchema.parse(data) });
  });

  app.post("/api/stories/:storyId/automations/with-action", async (request, reply) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const body = z.object({ nodeId: z.string().trim().min(1).max(120), input: StoryAutomationWithActionInputSchema }).strict().parse(request.body);
    const data = await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(storyId)}/automations/with-action`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.input),
    });
    return reply.code(201).send({ data: StoryAutomationStatusSchema.parse(data) });
  });

  app.get("/api/stories/:storyId/automations/:automationId", async (request) => {
    const { storyId, automationId } = StoryAutomationRouteSchema.parse(request.params);
    const { nodeId } = StoryRouteQuerySchema.parse(request.query);
    return { data: StoryAutomationStatusSchema.parse(await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}`)) };
  });

  app.patch("/api/stories/:storyId/automations/:automationId", async (request) => {
    const { storyId, automationId } = StoryAutomationRouteSchema.parse(request.params);
    const body = z.object({ nodeId: z.string().trim().min(1).max(120), input: StoryAutomationUpdateInputSchema }).strict().parse(request.body);
    return { data: StoryAutomationStatusSchema.parse(await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body.input),
    })) };
  });

  app.delete("/api/stories/:storyId/automations/:automationId", async (request) => {
    const { storyId, automationId } = StoryAutomationRouteSchema.parse(request.params);
    const { nodeId } = StoryRouteQuerySchema.parse(request.query);
    return { data: z.object({ deleted: z.boolean() }).strict().parse(await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}`, { method: "DELETE" })) };
  });

  for (const action of ["enable", "disable"] as const) {
    app.post(`/api/stories/:storyId/automations/:automationId/${action}`, async (request) => {
      const { storyId, automationId } = StoryAutomationRouteSchema.parse(request.params);
      const { nodeId } = z.object({ nodeId: z.string().trim().min(1).max(120) }).strict().parse(request.body);
      return { data: StoryAutomationStatusSchema.parse(await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}/${action}`, { method: "POST" })) };
    });
  }

  app.post("/api/stories/:storyId/automations/:automationId/run", async (request) => {
    const { storyId, automationId } = StoryAutomationRouteSchema.parse(request.params);
    const body = z.object({ nodeId: z.string().trim().min(1).max(120), input: StoryAutomationManualRunInputSchema }).strict().parse(request.body);
    return { data: StoryAutomationRunSchema.parse(await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.input),
    })) };
  });

  app.get("/api/stories/:storyId/automations/:automationId/runs", async (request) => {
    const { storyId, automationId } = StoryAutomationRouteSchema.parse(request.params);
    const { nodeId } = StoryRouteQuerySchema.parse(request.query);
    return { data: StoryAutomationRunsSchema.parse(await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}/runs`)) };
  });

  app.patch<{ Params: { storyId: string; storyPath: string } }>("/api/stories/:storyId/documents/*", async (request) => {
    const params = request.params as unknown as { storyId: string; "*": string };
    const body = z.object({ nodeId: z.string().trim().min(1).max(120), input: StoryDocumentUpdateInputSchema }).strict().parse(request.body);
    const storyPath = StoryPathSchema.parse(decodeURIComponent(params["*"]));
    return { data: StorySchema.parse(await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(StoryRouteSchema.parse({ storyId: params.storyId }).storyId)}/documents/${encodeURIComponent(storyPath)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body.input) })) };
  });

  app.post<{ Params: { storyId: string } }>("/api/stories/:storyId/documents/order", async (request) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const body = z.object({ nodeId: z.string().trim().min(1).max(120), input: StoryDocumentOrderInputSchema }).strict().parse(request.body);
    return { data: StorySchema.parse(await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(storyId)}/documents/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.input) })) };
  });

  app.delete<{ Params: { storyId: string } }>("/api/stories/:storyId/documents/*", async (request) => {
    const params = request.params as unknown as { storyId: string; "*": string };
    const body = z.object({ nodeId: z.string().trim().min(1).max(120) }).strict().parse(request.body || {});
    const storyPath = StoryPathSchema.parse(decodeURIComponent(params["*"]));
    return { data: await nodeJson(service, body.nodeId, `/stories/${encodeURIComponent(params.storyId)}/documents/${encodeURIComponent(storyPath)}`, { method: "DELETE" }) };
  });

  app.get<{ Params: { storyId: string } }>("/api/stories/:storyId/content", async (request) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const { nodeId } = StoryRouteQuerySchema.parse(request.query);
    return { data: await nodeJson(service, nodeId, `/stories/${encodeURIComponent(storyId)}/content`) };
  });

  app.put<{ Params: { instanceId: string; sessionId: string } }>("/api/controlled-instances/:instanceId/ai-sessions/:sessionId/story", async (request) => {
    const params = z.object({ instanceId: z.string().trim().min(1).max(120), sessionId: z.string().trim().min(1).max(120) }).strict().parse(request.params);
    const body = z.object({ storyId: StoryIdSchema.nullable() }).strict().parse(request.body || {});
    const instance = await service.requireControlledInstance(params.instanceId, true) as { id: string; nodeId: string };
    const payload = await nodeJson(service, instance.nodeId, `/instances/${encodeURIComponent(instance.id)}/ai-sessions/${encodeURIComponent(params.sessionId)}/story`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    return { data: record.data || payload };
  });

  app.get<{ Params: { storyId: string } }>("/api/stories/:storyId/content/file", async (request, reply) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const query = z.object({ nodeId: z.string().trim().min(1).max(120), storyPath: StoryPathSchema }).strict().parse(request.query);
    const node = service.requireNode(query.nodeId);
    const response = await service.resolveNodeAgentTransport(node).requestStream(node, `/stories/${encodeURIComponent(storyId)}/content/file?storyPath=${encodeURIComponent(query.storyPath)}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: { code: "STORY_CONTENT_READ_FAILED", message: `Story content request failed with HTTP ${response.status}.` } }));
      return reply.code(response.status).send(payload);
    }
    reply.code(response.status);
    for (const [key, value] of response.headers) if (["content-type", "content-length", "x-story-revision"].includes(key.toLowerCase())) reply.header(key, value);
    return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  });

  app.get<{ Params: { storyId: string } }>("/api/stories/:storyId/content/preview", async (request, reply) => {
    const { storyId } = StoryRouteSchema.parse(request.params);
    const query = z.object({ nodeId: z.string().trim().min(1).max(120), storyPath: StoryPathSchema }).strict().parse(request.query);
    const node = service.requireNode(query.nodeId);
    const response = await service.resolveNodeAgentTransport(node).requestStream(node, `/stories/${encodeURIComponent(storyId)}/content/file?storyPath=${encodeURIComponent(query.storyPath)}`);
    if (!response.ok) return reply.code(response.status).send(await response.json().catch(() => ({ error: { code: "STORY_CONTENT_READ_FAILED", message: "Story content could not be read." } })));
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > STORY_TEXT_PREVIEW_MAX_BYTES) return reply.code(413).send({ error: { code: "STORY_PREVIEW_TOO_LARGE", message: "Story document exceeds the text preview limit." } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > STORY_TEXT_PREVIEW_MAX_BYTES) return reply.code(413).send({ error: { code: "STORY_PREVIEW_TOO_LARGE", message: "Story document exceeds the text preview limit." } });
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return reply.code(415).send({ error: { code: "STORY_PREVIEW_NOT_TEXT", message: "Story document is not valid UTF-8 text." } });
    }
    return { data: StoryContentPreviewSchema.parse({ storyPath: query.storyPath, revision: response.headers.get("x-story-revision"), content, size: bytes.byteLength }) };
  });
}
