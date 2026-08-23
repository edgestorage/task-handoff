import type { FastifyRequest } from "fastify";
import type { FederatedModelRegistry } from "@task-handoff/protocol/control-plane";
import type { ControlPlaneService } from "../application/service.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";

export function requestCanAccessNode(request: FastifyRequest, nodeId: string) {
  const actor = controlPlaneRequestActor(request);
  return actor?.type !== "user" || actor.nodeScope.kind === "all" || actor.nodeScope.nodeIds.includes(nodeId);
}

export function filterRequestNodes<T>(request: FastifyRequest, items: T[], nodeId: (item: T) => string) {
  return items.filter((item) => requestCanAccessNode(request, nodeId(item)));
}

export function projectFederatedModelRegistry(request: FastifyRequest, registry: FederatedModelRegistry): FederatedModelRegistry {
  return {
    ...registry,
    models: registry.models.flatMap((model) => {
      const locations = model.locations.filter((location) => location.type === "control-plane"
        || requestCanAccessNode(request, location.nodeId));
      if (!locations.length) return [];
      return [{
        ...model,
        locations,
        referenceCount: locations.reduce((total, location) => total + (location.type === "node" ? location.referenceCount : 0), 0),
      }];
    }),
    nodeDiagnostics: filterRequestNodes(request, registry.nodeDiagnostics, (diagnostic) => diagnostic.nodeId),
  };
}

export async function requestVisibleInstanceIds(service: ControlPlaneService, request: FastifyRequest) {
  const instances = await service.listControlledInstances();
  return new Set(instances.filter((instance) => requestCanAccessNode(request, instance.nodeId)).map((instance) => instance.id));
}

export async function assertRequestInstanceVisible(service: ControlPlaneService, request: FastifyRequest, instanceId: string) {
  const instance = await service.requireControlledInstance(instanceId);
  if (requestCanAccessNode(request, instance.nodeId)) return instance;
  throw Object.assign(new Error("The requested resource is not visible."), {
    statusCode: 404,
    code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE",
  });
}
