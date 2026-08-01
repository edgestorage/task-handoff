import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import type { ControlPlaneProxyService } from "../proxy/service.ts";
import type { ControlPlaneNodeProxyRuntime } from "../proxy/runtime.ts";

const IdParamsSchema = z.object({ id: z.string().trim().min(1).max(160) }).strict();
const ResumeProxyClaimInputSchema = z.object({}).strict();

export function registerControlPlaneProxyManagementRoutes(options: {
  app: FastifyInstance;
  service: ControlPlaneService;
  proxy: ControlPlaneProxyService;
  runtime: ControlPlaneNodeProxyRuntime;
  events: ControlPlaneEventBus;
  actorId: (request: FastifyRequest) => Promise<string>;
}) {
  const { app, service, proxy, runtime, events, actorId } = options;

  app.get("/api/control-plane-proxy/invites", async () => ({ data: proxy.listInvites() }));
  app.post("/api/control-plane-proxy/invites", async (request, reply) => {
    const actor = await actorId(request);
    const result = proxy.createInvite(request.body, actor);
    events.publish("control-plane-proxy.invite.created", { invite: result.invite, audit: { action: "invite.create", actor } }, {
      topic: "control-plane-proxy",
      scope: { nodeId: result.invite.targetNodeId },
    });
    return reply.code(201).send({ data: result });
  });
  app.delete("/api/control-plane-proxy/invites/:id", async (request) => {
    const actor = await actorId(request);
    const invite = proxy.revokeInvite(IdParamsSchema.parse(request.params).id);
    events.publish("control-plane-proxy.invite.updated", { invite, audit: { action: "invite.revoke", actor } }, {
      topic: "control-plane-proxy",
      scope: { nodeId: invite.targetNodeId },
    });
    return { data: invite };
  });

  app.get("/api/control-plane-proxy/bindings", async () => ({ data: proxy.listBindings() }));
  app.delete("/api/control-plane-proxy/bindings/:id", async (request) => {
    const actor = await actorId(request);
    const id = IdParamsSchema.parse(request.params).id;
    const binding = proxy.revokeBinding(id);
    const closed = runtime.closeBinding(id);
    events.publish("control-plane-proxy.binding.updated", { binding, audit: { action: "binding.revoke", actor } }, {
      topic: "control-plane-proxy",
      scope: { nodeId: binding.targetNodeId },
    });
    return { data: { binding, closed } };
  });
  app.get("/api/control-plane-proxy/diagnostics", async () => ({ data: runtime.diagnostics() }));

  app.post("/api/node-proxy/claims", async (request, reply) => {
    const result = proxy.claimInvite(request.body);
    events.publish("control-plane-proxy.binding.created", {
      binding: result.binding,
      audit: { action: "binding.claim", actor: `control-plane:${result.binding.sourceControlPlaneId}` },
    }, {
      topic: "control-plane-proxy",
      scope: { nodeId: result.binding.targetNodeId },
    });
    return reply.code(201).send({ data: result });
  });

  app.get("/api/control-plane-proxy/pending-claims", async () => ({ data: service.listPendingProxyClaims() }));
  app.post("/api/control-plane-proxy/claims", async (request, reply) => {
    const result = await service.claimProxyNode(request.body);
    events.publish("node.created", { nodeId: result.node.id });
    return reply.code(201).send({ data: result });
  });
  app.post("/api/control-plane-proxy/pending-claims/:id/resume", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    ResumeProxyClaimInputSchema.parse(request.body || {});
    const result = await service.resumeProxyClaim(id);
    events.publish("node.created", { nodeId: result.node.id });
    return { data: result };
  });
  app.delete("/api/control-plane-proxy/pending-claims/:id", async (request) => ({
    data: await service.cancelProxyClaim(IdParamsSchema.parse(request.params).id),
  }));
}
