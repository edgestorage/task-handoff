import type { FastifyInstance } from "fastify";
import { ApplyUpdateRequestSchema, UpdateCheckRequestSchema } from "@task-handoff/protocol/control-plane";
import { ControlPlaneEventBus } from "../events/bus.ts";
import { ControlPlaneService } from "../application/service.ts";
import {
  ControlPlaneNodeAgentTunnelTransport,
  ControlPlaneNodeEventSubscriber,
  registerNodeAgentTunnelRoutes,
} from "../nodes/tunnel.ts";
import {
  IdParamsSchema,
  NodeControlPlaneConnectionParamsSchema,
  NodeFolderTreeQuerySchema,
  NodeLocalFolderParamsSchema,
  NodeRemoteKeyParamsSchema,
  NodeRuntimeParamsSchema,
} from "./route-params.ts";
import { withRequestSignal } from "./request-signal.ts";
import { z } from "zod";
import { PUBLIC_CONTROL_PLANE_ROUTE } from "./auth-boundary.ts";
import { publicNodeDirectory } from "../public-records.ts";

const DeleteNodeQuerySchema = z.object({ force: z.enum(["true", "false"]).optional() }).strict();
const NodeListQuerySchema = z.object({ projection: z.literal("directory").optional() }).strict();

type ErrorPayload = (error: unknown) => {
  statusCode: number;
  code: string;
  message: string;
};

export type RegisterNodeRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  events: ControlPlaneEventBus;
  nodeAgentTunnel: ControlPlaneNodeAgentTunnelTransport;
  nodeEventSubscriber: ControlPlaneNodeEventSubscriber;
  errorPayload: ErrorPayload;
};

export function registerNodeRoutes({
  app,
  service,
  events,
  nodeAgentTunnel,
  nodeEventSubscriber,
  errorPayload,
}: RegisterNodeRoutesOptions) {
  const rejectRetiredInstanceUpdate = (body: unknown) => {
    if (!body || typeof body !== "object" || Array.isArray(body) || !("target" in body)) return;
    const target = (body as { target?: unknown }).target;
    if (!target || typeof target !== "object" || Array.isArray(target) || (target as { component?: unknown }).component !== "controlled-instance") return;
    const error = new Error("Independent controlled-instance updates were retired; update the Node rollout instead.");
    Object.assign(error, { statusCode: 404, code: "LEGACY_INSTANCE_UPDATE_RETIRED" });
    throw error;
  };
  app.get("/api/nodes", async (request) => {
    const query = NodeListQuerySchema.parse(request.query);
    return { data: query.projection === "directory" ? service.listNodes().map((node) => publicNodeDirectory(service.projectNodeConnection(node))) : service.listPublicNodes() };
  });
  app.post("/api/nodes/local/sync", async () => {
    const node = await service.syncLocalNodeConnection();
    nodeEventSubscriber.syncNow();
    events.publish("node.local-synced", { nodeId: node.id });
    return { data: service.requirePublicNode(node.id) };
  });
  app.post("/api/nodes", async (request, reply) => {
    const node = await service.createNode(request.body);
    nodeEventSubscriber.syncNow();
    events.publish("node.created", { nodeId: node.id });
    return reply.code(201).send({ data: service.requirePublicNode(node.id) });
  });
  app.post("/api/nodes/:id/check", async (request) => {
    const node = await service.checkNode(IdParamsSchema.parse(request.params).id);
    events.publish("node.checked", { nodeId: node.id }, { topic: "node.state", scope: { nodeId: node.id } });
    return { data: node };
  });
  app.get("/api/nodes/:id/updates/jobs", async (request) => ({
    data: await service.listNodeUpdateJobs(IdParamsSchema.parse(request.params).id),
  }));
  app.get("/api/nodes/:id/settings/external-listener", async (request) => ({
    data: await service.getLocalNodeExternalListener(IdParamsSchema.parse(request.params).id),
  }));
  app.patch("/api/nodes/:id/settings/external-listener", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const listener = await service.updateLocalNodeExternalListener(id, request.body);
    events.publish("node.external-listener.updated", { nodeId: id, bindScope: listener.bindScope, port: listener.port });
    return { data: listener };
  });
  app.post("/api/nodes/:id/updates/check", async (request) => {
    rejectRetiredInstanceUpdate(request.body);
    const id = IdParamsSchema.parse(request.params).id;
    const result = await service.checkNodeUpdate(id, UpdateCheckRequestSchema.parse(request.body));
    events.publish("node.update.checked", { nodeId: id, availableVersion: result.availableVersion, impact: result.impact });
    return { data: result };
  });
  app.post("/api/nodes/:id/updates/apply", async (request, reply) => {
    rejectRetiredInstanceUpdate(request.body);
    const id = IdParamsSchema.parse(request.params).id;
    const job = await service.applyNodeUpdate(id, ApplyUpdateRequestSchema.parse(request.body));
    events.publish("node.update.queued", { nodeId: id, updateJobId: job.id, desiredVersion: job.toVersion, impact: job.impact });
    return reply.code(202).send({ data: job });
  });
  app.post("/api/nodes/:id/pairing/invites", async (request, reply) => {
    const params = IdParamsSchema.parse(request.params);
    const invite = await service.createNodePairingInvite(params.id, request.body);
    events.publish("node.pairing-invite.created", { nodeId: params.id });
    return reply.code(201).send({ data: invite });
  });
  app.post("/api/nodes/:id/control-plane-connections", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    const result = await service.connectNodeToControlPlane(params.id, request.body);
    events.publish("node.remote-connect.requested", { nodeId: params.id });
    return { data: result };
  });
  app.get("/api/nodes/:id/control-plane-pairings", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    return { data: await service.listNodeControlPlanePairings(params.id) };
  });
  app.delete("/api/nodes/:id/control-plane-pairings/:keyId", async (request) => {
    const params = NodeRemoteKeyParamsSchema.parse(request.params);
    const result = await service.deleteNodeControlPlanePairing(params.id, params.keyId);
    events.publish("node.control-plane-pairing.deleted", { nodeId: params.id, keyId: params.keyId });
    return { data: result };
  });
  app.get("/api/nodes/:id/control-plane-connections", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    return { data: await service.listNodeControlPlaneConnections(params.id) };
  });
  app.delete("/api/nodes/:id/control-plane-connections/:connectionId", async (request) => {
    const params = NodeControlPlaneConnectionParamsSchema.parse(request.params);
    const result = await service.deleteNodeControlPlaneConnection(params.id, params.connectionId);
    events.publish("node.control-plane-connection.deleted", { nodeId: params.id, connectionId: params.connectionId });
    return { data: result };
  });
  app.post("/api/node-join/invites", async (request, reply) => {
    const invite = service.createNodeJoinInvite(request.body);
    events.publish("node-join.invite.created", { inviteId: invite.id });
    return reply.code(201).send({ data: invite });
  });
  app.post("/api/node-join/complete", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    const node = service.completeNodeJoin(request.body);
    nodeEventSubscriber.syncNow();
    events.publish("node.joined", { nodeId: node.id });
    return reply.code(201).send({ data: service.requirePublicNode(node.id) });
  });
  app.get("/api/nodes/:id/runtimes", async (request) => ({ data: await service.listNodeRuntimes(IdParamsSchema.parse(request.params).id) }));
  app.post("/api/nodes/:id/runtimes", async (request, reply) => {
    const params = IdParamsSchema.parse(request.params);
    const runtime = await service.createNodeRuntime(params.id, request.body);
    events.publish("node.runtime.created", { nodeId: params.id, runtimeId: runtime.id });
    return reply.code(201).send({ data: runtime });
  });
  app.patch("/api/nodes/:id/runtimes/:runtimeId", async (request) => {
    const params = NodeRuntimeParamsSchema.parse(request.params);
    const runtime = await service.updateNodeRuntime(params.id, params.runtimeId, request.body);
    events.publish("node.runtime.updated", { nodeId: params.id, runtimeId: runtime.id });
    return { data: runtime };
  });
  app.delete("/api/nodes/:id/runtimes/:runtimeId", async (request) => {
    const params = NodeRuntimeParamsSchema.parse(request.params);
    const result = await service.deleteNodeRuntime(params.id, params.runtimeId);
    events.publish("node.runtime.deleted", { nodeId: params.id, runtimeId: params.runtimeId });
    return { data: result };
  });
  app.post("/api/nodes/:id/runtimes/:runtimeId/check", async (request) => {
    const params = NodeRuntimeParamsSchema.parse(request.params);
    const runtime = await service.checkNodeRuntime(params.id, params.runtimeId);
    events.publish("node.runtime.checked", { nodeId: params.id, runtimeId: runtime.id });
    return { data: runtime };
  });
  app.get("/api/nodes/:id/docker/images", async (request) => ({ data: await service.listNodeDockerImages(IdParamsSchema.parse(request.params).id) }));
  app.get("/api/nodes/:id/image-options", async (request) => ({ data: await service.listNodeImageAvailability(IdParamsSchema.parse(request.params).id) }));
  app.get("/api/nodes/:id/local-folders", async (request, reply) => withRequestSignal(request, reply, async (signal) => ({
    data: await service.listNodeLocalFolders(IdParamsSchema.parse(request.params).id, signal),
  })));
  app.get("/api/nodes/:id/folders/places", async (request) => ({
    data: await service.listNodeFolderPlaces(IdParamsSchema.parse(request.params).id),
  }));
  app.get("/api/nodes/:id/folders/tree", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    const query = NodeFolderTreeQuerySchema.parse(request.query);
    return {
      data: await service.listNodeFolderTree(params.id, {
        path: query.path,
        depth: query.depth,
      }),
    };
  });
  app.post("/api/nodes/:id/local-folders", async (request, reply) => {
    const params = IdParamsSchema.parse(request.params);
    const folder = await service.createNodeLocalFolder(params.id, request.body);
    events.publish("node.local-folder.created", { nodeId: params.id, folderId: folder.id });
    return reply.code(201).send({ data: folder });
  });
  app.delete("/api/nodes/:id/local-folders/:folderId", async (request) => {
    const params = NodeLocalFolderParamsSchema.parse(request.params);
    const result = await service.deleteNodeLocalFolder(params.id, params.folderId);
    events.publish("node.local-folder.deleted", { nodeId: params.id, folderId: params.folderId });
    return { data: result };
  });
  app.get("/api/nodes/:id", async (request) => ({ data: service.requirePublicNode(IdParamsSchema.parse(request.params).id) }));
  app.patch("/api/nodes/:id", async (request) => {
    const node = service.updateNode(IdParamsSchema.parse(request.params).id, request.body);
    if (!node.connectionEnabled) nodeAgentTunnel.disconnect(node.id);
    nodeEventSubscriber.syncNow();
    events.publish("node.updated", { nodeId: node.id });
    return { data: service.requirePublicNode(node.id) };
  });
  app.delete("/api/nodes/:id", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const query = DeleteNodeQuerySchema.parse(request.query);
    const result = await service.deleteNodeWithProxyLifecycle(id, query.force === "true");
    nodeEventSubscriber.syncNow();
    events.publish("node.deleted", { nodeId: id, deleted: result.deleted, revoke: result.revoke });
    return { data: result };
  });

  app.get("/api/node-runtimes", async (request, reply) => withRequestSignal(request, reply, async (signal) => {
    const result = await service.listNodeRuntimesWithDiagnostics(signal);
    return { data: result.items, meta: { nodeErrors: result.nodeErrors } };
  }));

  registerNodeAgentTunnelRoutes({ app, service, nodeAgentTunnel, errorPayload });
}
