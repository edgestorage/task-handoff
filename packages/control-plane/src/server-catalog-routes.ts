import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ControlPlaneEventBus } from "./events.ts";
import { ControlPlaneService } from "./service.ts";
import { IdParamsSchema } from "./server-route-params.ts";

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

  app.get("/api/models", async () => ({ data: service.listModels() }));
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
    const deleted = service.deleteImage(id);
    events.publish("image.deleted", { imageId: id, deleted });
    return { data: { deleted } };
  });
}
