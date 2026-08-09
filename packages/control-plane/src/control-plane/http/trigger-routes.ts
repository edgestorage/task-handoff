import type { FastifyInstance } from "fastify";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import {
  IdParamsSchema,
  InstanceSessionParamsSchema,
  InstanceSessionTriggerConfigParamsSchema,
  InstanceTriggerConfigParamsSchema,
  TriggerConfigParamsSchema,
} from "./route-params.ts";

export type RegisterTriggerRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  events: ControlPlaneEventBus;
};

export function registerTriggerRoutes({ app, service, events }: RegisterTriggerRoutesOptions) {
  app.get("/api/triggers", async () => ({ data: await service.listTriggers() }));
  app.post("/api/triggers", async (request, reply) => {
    const trigger = service.createTrigger(request.body);
    events.publish("trigger.created", { configHash: trigger.configHash });
    return reply.code(201).send({ data: trigger });
  });
  app.put("/api/triggers/:configHash", async (request) => {
    const params = TriggerConfigParamsSchema.parse(request.params);
    const result = await service.updateTrigger(params.configHash, request.body);
    events.publish("trigger.updated", { previousConfigHash: params.configHash, configHash: result.trigger.configHash });
    return { data: result };
  });
  app.delete("/api/triggers/:configHash", async (request) => {
    const params = TriggerConfigParamsSchema.parse(request.params);
    const result = await service.deleteTrigger(params.configHash);
    events.publish("trigger.deleted", { configHash: params.configHash });
    return { data: result };
  });
  app.post("/api/triggers/:configHash/apply", async (request) => {
    const params = TriggerConfigParamsSchema.parse(request.params);
    const result = await service.applyTrigger(params.configHash, request.body || {});
    events.publish("trigger.applied", { configHash: params.configHash });
    return { data: result };
  });
  app.get("/api/controlled-instances/:id/triggers", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    return { data: await service.listInstanceTriggers(params.id) };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/triggers", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const result = await service.bindAiSessionTrigger(params.id, params.sessionId, request.body || {});
    events.publish("trigger.deployment.bound", { instanceId: params.id, sessionId: params.sessionId }, { topic: "triggers", scope: { instanceId: params.id } });
    return { data: result };
  });
  app.delete("/api/controlled-instances/:id/ai-sessions/:sessionId/triggers/:configHash", async (request) => {
    const params = InstanceSessionTriggerConfigParamsSchema.parse(request.params);
    const result = await service.unbindAiSessionTrigger(params.id, params.sessionId, params.configHash);
    events.publish("trigger.deployment.unbound", { instanceId: params.id, sessionId: params.sessionId, configHash: params.configHash }, { topic: "triggers", scope: { instanceId: params.id } });
    return { data: result };
  });
  app.post("/api/controlled-instances/:id/triggers/:configHash/run", async (request) => {
    const params = InstanceTriggerConfigParamsSchema.parse(request.params);
    const result = await service.runInstanceTrigger(params.id, params.configHash, request.body || {});
    events.publish("trigger.run.requested", { instanceId: params.id, configHash: params.configHash }, { topic: "triggers", scope: { instanceId: params.id } });
    return { data: result };
  });
}
