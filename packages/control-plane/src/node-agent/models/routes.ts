import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateNodeModelSchema,
  DeployNodeModelSchema,
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
  app: z.enum(["codex", "claude", "opencode"]),
}).strict();

export function registerNodeModelRoutes(
  app: FastifyInstance,
  registry: NodeModelRegistry,
  syncEnvironment: (instanceId: string) => Promise<unknown>,
  fetchImpl: typeof fetch,
) {
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
    return { data: registry.deploy(input) };
  });

  app.patch("/api/node-agent/models/:id", async (request) => ({
    data: registry.update((request.params as { id: string }).id, UpdateNodeModelSchema.parse(request.body)),
  }));

  app.delete("/api/node-agent/models/:id", async (request) => ({
    data: { deleted: registry.delete((request.params as { id: string }).id) },
  }));

  app.put("/api/node-agent/instances/:id/model-assignment", async (request) => {
    const id = (request.params as { id: string }).id;
    const result = registry.assign(id, UpdateNodeModelAssignmentSchema.parse(request.body));
    await syncEnvironment(id);
    return { data: result };
  });
}
