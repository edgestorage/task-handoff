import type { FastifyRequest } from "fastify";
import type { ControlPlaneService } from "../application/service.ts";
import type {
  ControlPlaneUserAuthorizationContext,
  ControlPlaneAction,
  ControlPlaneResource,
  ResolvedControlPlaneResourceScope,
} from "./authorization.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nodeScope(nodeId: string): ResolvedControlPlaneResourceScope {
  return { kind: "node", nodeId };
}

async function instanceScope(service: ControlPlaneService, instanceId: string, actor?: ControlPlaneUserAuthorizationContext): Promise<ResolvedControlPlaneResourceScope> {
  if (!actor) return { kind: "instance-derived", nodeId: "", instanceId };
  const instance = service.requireControlledInstanceForAuthorization(instanceId);
  return { kind: "instance-derived", nodeId: instance.nodeId, instanceId: instance.id };
}

/**
 * Resolves concrete request targets from authoritative Control Plane topology.
 * Undefined means a collection/global projection whose contents must be
 * filtered by its handler; it never means that a concrete client nodeId was trusted.
 */
export async function resolveRequestResourceScopes(
  service: ControlPlaneService,
  request: Pick<FastifyRequest, "params" | "body">,
  routePath: string,
  resource: ControlPlaneResource,
  actor?: ControlPlaneUserAuthorizationContext,
  action?: ControlPlaneAction,
): Promise<ResolvedControlPlaneResourceScope[] | undefined> {
  const params = record(request.params);
  const body = record(request.body);

  if (["user", "role", "identity-provider", "user-session", "identity-approval", "user-audit", "secret", "chat-bridge", "control-plane-settings"].includes(resource.type)) {
    return [{ kind: "global-admin" }];
  }
  if (resource.type === "trigger-template") return [{ kind: "global-shared" }];
  if (resource.type === "public-directory") return [{ kind: "global-public" }];
  if (resource.type === "image") return [{ kind: "global-public" }];
  if (resource.type === "model" && !routePath.startsWith("/api/nodes/")) return [{ kind: "global-public" }];

  const explicitNodeId = stringField(params.nodeId)
    || (routePath.startsWith("/api/nodes/") ? stringField(params.id) : undefined);
  if (explicitNodeId && ["node", "runtime", "template", "model"].includes(resource.type)) {
    service.requireNode(explicitNodeId);
    return [nodeScope(explicitNodeId)];
  }

  if (resource.type === "project") {
    const projectId = stringField(params.id);
    if (!projectId) return undefined;
    const project = service.requireProject(projectId);
    if (project.source.type !== "local-folder") return [{ kind: "global-public" }];
    if (!project.source.ownerNodeId) {
      throw Object.assign(new Error("The requested resource is not visible."), {
        code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE",
        statusCode: 404,
      });
    }
    service.requireNode(project.source.ownerNodeId);
    return [nodeScope(project.source.ownerNodeId)];
  }

  if (resource.type === "instance" && routePath === "/api/controlled-instances" && action === "create") {
    const targetNodeId = service.resolveControlledInstanceTargetNodeId(body);
    service.requireNode(targetNodeId);
    return [nodeScope(targetNodeId)];
  }

  if (resource.type === "trigger-deployment" && routePath.endsWith("/apply")) {
    const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds.map(stringField).filter((id): id is string => Boolean(id)) : [];
    if (!instanceIds.length) return undefined;
    return Promise.all([...new Set(instanceIds)].map((instanceId) => instanceScope(service, instanceId, actor)));
  }

  const instanceId = routePath.startsWith("/api/controlled-instances/")
    ? stringField(params.id)
    : stringField(body.instanceId);
  if (instanceId && ["instance", "app-session", "ai-session", "trigger-deployment", "repository", "attachment", "template"].includes(resource.type)) {
    return [await instanceScope(service, instanceId, actor)];
  }

  if (["node", "runtime", "template"].includes(resource.type) && explicitNodeId) return [nodeScope(explicitNodeId)];
  return undefined;
}
