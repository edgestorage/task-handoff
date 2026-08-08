import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";

const IdParamsSchema = z.object({ id: z.string().trim().min(1).max(120) }).strict();
const NodeTemplateParamsSchema = z.object({
  nodeId: z.string().trim().min(1).max(120),
  templateId: z.string().trim().min(1).max(120),
}).strict();

export function registerEnvironmentTemplateRoutes(app: FastifyInstance, service: ControlPlaneService, events: ControlPlaneEventBus) {
  app.get("/api/nodes/:id/environment-templates", async (request) => ({
    data: await service.listEnvironmentTemplates(IdParamsSchema.parse(request.params).id),
  }));
  app.get("/api/nodes/:nodeId/environment-templates/:templateId", async (request) => {
    const params = NodeTemplateParamsSchema.parse(request.params);
    return { data: await service.getEnvironmentTemplate(params.nodeId, params.templateId) };
  });
  app.post("/api/controlled-instances/:id/environment-templates", async (request, reply) => {
    const instanceId = IdParamsSchema.parse(request.params).id;
    const template = await service.createEnvironmentTemplate(instanceId, request.body);
    events.publish("environment-template.updated", { templateId: template.id, nodeId: template.nodeId, status: template.status });
    return reply.code(201).send({ data: template });
  });
  app.delete("/api/nodes/:nodeId/environment-templates/:templateId", async (request) => {
    const params = NodeTemplateParamsSchema.parse(request.params);
    const result = await service.deleteEnvironmentTemplate(params.nodeId, params.templateId);
    events.publish("environment-template.deleted", result);
    return { data: result };
  });
}
