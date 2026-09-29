import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateNodeModelSchema,
  DeployNodeModelSchema,
  NodeModelMergeSchema,
  UpdateNodeModelAssignmentSchema,
  UpdateNodeModelSchema,
} from "@task-handoff/protocol/control-plane";
import type { NodeModelRegistry } from "./registry.ts";
import { discoverModels, testModelEndpoint } from "../../shared/models/model-endpoint.ts";

const NodeModelDiscoveryInputSchema = z.object({
  endpoint: z.string().trim().url().max(2048),
  key: z.string().trim().min(1).max(4096).optional(),
  existingModelId: z.string().trim().min(1).max(120).optional(),
}).strict();

const NodeModelTestInputSchema = NodeModelDiscoveryInputSchema.extend({
  model: z.string().trim().min(1).max(240),
  app: z.enum(["codex", "claude", "opencode"]).optional(),
  protocol: z.enum(["openai-responses", "openai-chat-completions", "anthropic-messages"]).optional(),
}).strict().refine((input) => Boolean(input.protocol || input.app), { message: "A model protocol is required.", path: ["protocol"] });

export function registerNodeModelRoutes(
  app: FastifyInstance,
  registry: NodeModelRegistry,
  syncEnvironment: (instanceId: string) => Promise<unknown>,
  fetchImpl: typeof fetch,
) {
  // Model content changes must reach every instance that resolves it. The sync
  // helper is best-effort by design: unreachable instances are warned and heal
  // on their next lifecycle operation instead of failing the model write.
  const resyncReferencingInstances = async (modelId: string) => {
    for (const instanceId of registry.referencingInstanceIds(modelId)) {
      await syncEnvironment(instanceId);
    }
  };

  app.get("/api/node-agent/models", async () => ({ data: registry.list() }));

  app.post("/api/node-agent/models", async (request, reply) => reply.code(201).send({
    data: registry.create(CreateNodeModelSchema.parse(request.body)),
  }));

  app.post("/api/node-agent/models/discover", async (request) => {
    const input = NodeModelDiscoveryInputSchema.parse(request.body);
    return { data: await discoverModels(fetchImpl, { ...input, key: registry.resolveProbeKey(input.existingModelId, input.key) }) };
  });

  app.post("/api/node-agent/models/test", async (request) => {
    const input = NodeModelTestInputSchema.parse(request.body);
    return { data: await testModelEndpoint(fetchImpl, { ...input, key: registry.resolveProbeKey(input.existingModelId, input.key) }) };
  });

  app.put("/api/node-agent/models/:id/deploy", async (request) => {
    const id = (request.params as { id: string }).id;
    const input = DeployNodeModelSchema.parse(request.body);
    if (input.id !== id) {
      throw Object.assign(
        new Error(`Model payload id ${input.id} does not match route id ${id}.`),
        { statusCode: 400, code: "NODE_MODEL_ID_MISMATCH" },
      );
    }
    const model = registry.deploy(input);
    await resyncReferencingInstances(model.id);
    return { data: model };
  });

  app.patch("/api/node-agent/models/:id", async (request) => {
    const model = registry.update((request.params as { id: string }).id, UpdateNodeModelSchema.parse(request.body));
    await resyncReferencingInstances(model.id);
    return { data: model };
  });

  app.post("/api/node-agent/models/:id/merge", async (request) => {
    const id = (request.params as { id: string }).id;
    const { targetModelId } = NodeModelMergeSchema.parse(request.body);
    const result = registry.merge(id, targetModelId);
    for (const instanceId of result.reassignedInstances) await syncEnvironment(instanceId);
    return { data: result };
  });

  app.delete("/api/node-agent/models/:id", async (request) => ({
    data: { deleted: registry.delete((request.params as { id: string }).id) },
  }));

  app.put("/api/node-agent/instances/:id/model-assignment", async (request) => {
    const id = (request.params as { id: string }).id;
    const currentWireModel = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      && Object.prototype.hasOwnProperty.call(request.body, "modelEntityIds");
    const result = registry.assign(id, UpdateNodeModelAssignmentSchema.parse(request.body));
    await syncEnvironment(id);
    if (currentWireModel) return { data: result };
    // Compatibility for v0.0.23: its strict response parser does not accept
    // modelEntityIds. Persist the migrated array, but project the legacy reply.
    const { modelEntityIds: _modelEntityIds, ...assignment } = result.assignment;
    return { data: { ...result, assignment } };
  });

  // On-demand convergence trigger. The control plane calls this when an
  // instance rejected a model the node-agent assignment already contains, so a
  // stale in-memory catalog heals without restarting the instance.
  app.post("/api/node-agent/instances/:id/sync-models", async (request) => {
    const id = (request.params as { id: string }).id;
    const synced = await syncEnvironment(id);
    return { data: { synced: synced === true } };
  });
}
