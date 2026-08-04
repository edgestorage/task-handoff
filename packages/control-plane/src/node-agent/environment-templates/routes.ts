import type { FastifyInstance } from "fastify";
import { EnvironmentTemplateSchema } from "@task-handoff/protocol/control-plane";
import type { EnvironmentTemplateService } from "./service.ts";

export function registerEnvironmentTemplateRoutes(app: FastifyInstance, service: EnvironmentTemplateService) {
  app.get("/api/node-agent/environment-templates", async () => ({ data: service.list() }));
  app.get("/api/node-agent/environment-templates/:id", async (request) => ({
    data: EnvironmentTemplateSchema.parse(service.require((request.params as { id: string }).id)),
  }));
  app.post("/api/node-agent/instances/:id/environment-templates", async (request, reply) => {
    const template = await service.create((request.params as { id: string }).id, request.body);
    return reply.code(201).send({ data: template });
  });
  app.delete("/api/node-agent/environment-templates/:id", async (request) => ({
    data: await service.delete((request.params as { id: string }).id),
  }));
}
