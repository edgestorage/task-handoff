import type { FastifyInstance } from "fastify";
import {
  CreateNodeModelSchema,
  DeployNodeModelSchema,
  UpdateNodeModelAssignmentSchema,
  UpdateNodeModelSchema,
} from "@task-handoff/protocol/control-plane";
import type { NodeModelRegistry } from "./registry.ts";

export function registerNodeModelRoutes(
  app: FastifyInstance,
  registry: NodeModelRegistry,
  syncEnvironment: (instanceId: string) => Promise<unknown>,
) {
  app.get("/api/node-agent/models", async () => ({ data: registry.list() }));

  app.post("/api/node-agent/models", async (request, reply) => reply.code(201).send({
    data: registry.create(CreateNodeModelSchema.parse(request.body)),
  }));

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
