import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import { IdParamsSchema } from "./route-params.ts";
import { AppManagementOperationRequestSchema } from "@task-handoff/protocol/control-plane";

export type RegisterInstanceRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  events: ControlPlaneEventBus;
};

const ConfigSyncFolderQuerySchema = z.object({
  path: z.string().trim().max(1000).optional(),
  depth: z.coerce.number().int().min(0).max(2).optional(),
}).strict();
const InstanceAppParamsSchema = z.object({ id: z.string().trim().min(1), appId: z.string().trim().min(1) }).strict();
const InstanceAppJobParamsSchema = z.object({ id: z.string().trim().min(1), jobId: z.string().trim().min(1) }).strict();

export function registerInstanceRoutes({ app, service, events }: RegisterInstanceRoutesOptions) {
  app.get("/api/controlled-instances", async () => ({ data: await service.listControlledInstances() }));
  app.post("/api/controlled-instances", async (request, reply) => {
    const instance = await service.createControlledInstance(request.body);
    events.publish("instance.created", { instanceId: instance.id });
    return reply.code(201).send({ data: instance });
  });
  app.get("/api/controlled-instances/:id", async (request) => ({ data: await service.requireControlledInstance(IdParamsSchema.parse(request.params).id) }));
  app.get("/api/controlled-instances/:id/metrics", async (request) => ({ data: await service.instanceResourceMetrics(IdParamsSchema.parse(request.params).id) }));
  app.get("/api/controlled-instances/:id/apps/management", async (request) => ({ data: await service.instanceAppManagement(IdParamsSchema.parse(request.params).id) }));
  app.post("/api/controlled-instances/:id/apps/:appId/install", async (request) => {
    const params = InstanceAppParamsSchema.parse(request.params);
    const input = AppManagementOperationRequestSchema.parse(request.body || {});
    return { data: await service.requestInstanceAppOperation(params.id, params.appId, "install", input) };
  });
  app.post("/api/controlled-instances/:id/apps/:appId/uninstall", async (request) => {
    const params = InstanceAppParamsSchema.parse(request.params);
    const input = AppManagementOperationRequestSchema.parse(request.body || {});
    return { data: await service.requestInstanceAppOperation(params.id, params.appId, "uninstall", input) };
  });
  app.get("/api/controlled-instances/:id/apps/jobs/:jobId", async (request) => {
    const params = InstanceAppJobParamsSchema.parse(request.params);
    return { data: await service.instanceAppManagementJob(params.id, params.jobId) };
  });
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
  app.post("/api/controlled-instances/:id/image-provisioning/retry", async (request) => {
    const instance = await service.retryControlledInstanceImageProvisioning(IdParamsSchema.parse(request.params).id);
    events.publish("instance.image-provisioning-retried", { instanceId: instance.id });
    return { data: instance };
  });
  app.get("/api/controlled-instances/:id/config-sync", async (request) => ({
    data: await service.instanceConfigSyncState(IdParamsSchema.parse(request.params).id),
  }));
  app.get("/api/controlled-instances/:id/config-sync/folders", async (request) => ({
    data: await service.listInstanceConfigSyncFolders(
      IdParamsSchema.parse(request.params).id,
      ConfigSyncFolderQuerySchema.parse(request.query),
    ),
  }));
  app.post("/api/controlled-instances/:id/config-sync", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const result = await service.syncInstanceConfigs(id, request.body);
    events.publish("instance.config-synced", { instanceId: id });
    return { data: result };
  });
  app.get("/api/instance-board", async () => {
    const result = await service.boardWithDiagnostics();
    return { data: result.items, meta: { nodeErrors: result.nodeErrors } };
  });
}
