import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ControlPlaneEventBus } from "../events/bus.ts";
import { ControlPlaneService } from "../application/service.ts";
import { IdParamsSchema } from "./route-params.ts";

export type RegisterCatalogRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  events: ControlPlaneEventBus;
};

const ModelReorderRequestSchema = z
  .object({
    ids: z.array(z.string().trim().min(1).max(120)).default([]),
  })
  .strict();

const NodeModelParamsSchema = z.object({
  nodeId: z.string().trim().min(1).max(120),
  modelId: z.string().trim().min(1).max(120).optional(),
}).strict();

export function registerCatalogRoutes({ app, service, events }: RegisterCatalogRoutesOptions) {
  app.get("/api/projects", async () => ({ data: service.listProjects() }));
  app.post("/api/projects", async (request, reply) => {
    const project = service.createProject(request.body);
    events.publish("project.created", { projectId: project.id });
    return reply.code(201).send({ data: project });
  });
  app.get("/api/projects/:id", async (request) => ({ data: service.requireProject(IdParamsSchema.parse(request.params).id) }));
  app.patch("/api/projects/:id", async (request) => {
    const project = service.updateProject(IdParamsSchema.parse(request.params).id, request.body);
    events.publish("project.updated", { projectId: project.id });
    return { data: project };
  });
  app.delete("/api/projects/:id", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const deleted = service.deleteProject(id);
    events.publish("project.deleted", { projectId: id, deleted });
    return { data: { deleted } };
  });

  app.get("/api/models", async () => ({ data: await service.listFederatedModels() }));
  app.post("/api/models", async (request, reply) => {
    const model = await service.createModel(request.body);
    events.publish("model.created", { modelId: model.id });
    return reply.code(201).send({ data: model });
  });
  app.post("/api/models/reorder", async (request) => {
    const parsed = ModelReorderRequestSchema.parse(request.body);
    const models = await service.reorderModels(parsed.ids);
    events.publish("model.reordered", { ids: parsed.ids });
    return { data: models };
  });
  app.get("/api/models/:id", async (request) => ({ data: service.requireModel(IdParamsSchema.parse(request.params).id) }));
  app.patch("/api/models/:id", async (request) => {
    const model = await service.updateModel(IdParamsSchema.parse(request.params).id, request.body);
    events.publish("model.updated", { modelId: model.id });
    return { data: model };
  });
  app.delete("/api/models/:id", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const deleted = await service.deleteModel(id);
    events.publish("model.deleted", { modelId: id, deleted });
    return { data: { deleted } };
  });

  app.post("/api/nodes/:nodeId/models", async (request, reply) => {
    const { nodeId } = NodeModelParamsSchema.parse(request.params);
    const model = await service.createNodeModel(nodeId, request.body);
    events.publish("model.created", { modelId: model.id, nodeId });
    return reply.code(201).send({ data: model });
  });
  app.patch("/api/nodes/:nodeId/models/:modelId", async (request) => {
    const { nodeId, modelId } = NodeModelParamsSchema.parse(request.params);
    const model = await service.updateNodeModel(nodeId, modelId!, request.body);
    events.publish("model.updated", { modelId, nodeId });
    return { data: model };
  });
  app.delete("/api/nodes/:nodeId/models/:modelId", async (request) => {
    const { nodeId, modelId } = NodeModelParamsSchema.parse(request.params);
    const result = await service.deleteNodeModel(nodeId, modelId!);
    events.publish("model.deleted", { modelId, nodeId, deleted: result.deleted });
    return { data: result };
  });

  app.get("/api/market/catalog", async () => ({ data: service.getMarketCatalog() }));
  app.post("/api/market/refresh", async () => {
    const result = await service.refreshMarketCatalog();
    events.publish("market.catalog.updated", { revision: result.catalog.revision, source: result.catalog.source });
    return { data: result };
  });
  app.get("/api/image-options", async () => ({ data: service.listImageOptions() }));
  app.get("/api/images", async () => ({ data: service.listImages() }));
  app.post("/api/images", async (request, reply) => {
    const image = service.createImage(request.body);
    events.publish("image.created", { imageId: image.id });
    return reply.code(201).send({ data: image });
  });
  app.get("/api/images/:id", async (request) => ({ data: service.requireImage(IdParamsSchema.parse(request.params).id) }));
  app.patch("/api/images/:id", async (request) => {
    const image = service.updateImage(IdParamsSchema.parse(request.params).id, request.body);
    events.publish("image.updated", { imageId: image.id });
    return { data: image };
  });
  app.delete("/api/images/:id", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const deleted = await service.deleteImage(id);
    events.publish("image.deleted", { imageId: id, deleted });
    return { data: { deleted } };
  });
}
