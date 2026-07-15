import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import { IdParamsSchema } from "./route-params.ts";

export type RegisterInstanceRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  events: ControlPlaneEventBus;
};

const ConfigSyncParamsSchema = z.object({
  id: z.string().trim().min(1),
  direction: z.enum(["import", "export"]),
  preset: z.string().trim().min(1).max(120),
});

export function registerInstanceRoutes({ app, service, events }: RegisterInstanceRoutesOptions) {
  app.get("/api/controlled-instances", async () => ({ data: await service.listControlledInstances() }));
  app.post("/api/controlled-instances", async (request, reply) => {
    const instance = await service.createControlledInstance(request.body);
    events.publish("instance.created", { instanceId: instance.id });
    return reply.code(201).send({ data: instance });
  });
  app.get("/api/controlled-instances/:id", async (request) => ({ data: await service.requireControlledInstance(IdParamsSchema.parse(request.params).id) }));
  app.patch("/api/controlled-instances/:id", async (request) => {
    const instance = await service.updateControlledInstance(IdParamsSchema.parse(request.params).id, request.body);
    events.publish("instance.updated", { instanceId: instance.id });
    return { data: instance };
  });
  app.delete("/api/controlled-instances/:id", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const deleted = await service.deleteControlledInstance(id);
    events.publish("instance.deleted", { instanceId: id, deleted });
    return { data: { deleted } };
  });
  app.post("/api/controlled-instances/:id/start", async (request) => {
    const instance = await service.startControlledInstance(IdParamsSchema.parse(request.params).id);
    events.publish("instance.started", { instanceId: instance.id });
    return { data: instance };
  });
  app.post("/api/controlled-instances/:id/stop", async (request) => {
    const instance = await service.stopControlledInstance(IdParamsSchema.parse(request.params).id);
    events.publish("instance.stopped", { instanceId: instance.id });
    return { data: instance };
  });
  app.post("/api/controlled-instances/:id/restart", async (request) => {
    const instance = await service.restartControlledInstance(IdParamsSchema.parse(request.params).id);
    events.publish("instance.restarted", { instanceId: instance.id });
    return { data: instance };
  });
  app.get("/api/config-sync/presets", async () => ({ data: service.listConfigSyncPresets() }));
  app.post("/api/controlled-instances/:id/config-sync/:direction/:preset", async (request) => {
    const params = ConfigSyncParamsSchema.parse(request.params);
    const result = await service.syncInstanceConfig(params.id, params.direction, params.preset);
    events.publish("instance.config-synced", { instanceId: params.id, direction: params.direction, preset: params.preset });
    return { data: result };
  });
  app.get("/api/instance-board", async () => {
    const result = await service.boardWithDiagnostics();
    return { data: result.items, meta: { nodeErrors: result.nodeErrors } };
  });
}
