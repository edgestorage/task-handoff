import type {
  ControlPlanePermissionId,
  ControlPlaneUserNodeScope,
} from "@task-handoff/protocol/control-plane-access";

export type ControlPlaneUserAuthorizationContext = {
  type: "user";
  userId: string;
  identityId: string;
  roleIds: string[];
  permissionIds: ControlPlanePermissionId[];
  nodeScope: ControlPlaneUserNodeScope;
  authorizationRevision: number;
};

export type ControlPlaneActor =
  | ControlPlaneUserAuthorizationContext
  | { type: "cloud-account"; accountId: string; deviceSessionId: string; bindingId: string; bindingRevision: number }
  | { type: "chat-bridge"; bridgeId: string; channel: string; chatSessionId?: string; userId?: string }
  | { type: "system"; reason: string };

export type ControlPlaneAction =
  | "read" | "read-file-content" | "create" | "update" | "delete"
  | "start" | "stop" | "restart" | "proxy" | "interactive-access"
  | "send-message" | "approve" | "interrupt"
  | "manage-settings" | "manage-secrets" | "manage-members" | "manage-node-auth";

export type ControlPlaneResourceType =
  | "project" | "node" | "runtime" | "template" | "instance" | "app-session" | "ai-session"
  | "trigger-template" | "trigger-deployment" | "repository" | "attachment" | "image" | "model"
  | "user" | "role" | "identity-provider" | "user-session" | "identity-approval" | "user-audit"
  | "chat-bridge" | "control-plane-settings" | "secret" | "public-directory";

export type ControlPlaneResource = {
  type: ControlPlaneResourceType;
  id?: string;
  projectId?: string;
  nodeId?: string;
  instanceId?: string;
};

export type ResolvedControlPlaneResourceScope =
  | { kind: "global-public" }
  | { kind: "global-shared" }
  | { kind: "global-admin" }
  | { kind: "node"; nodeId: string }
  | { kind: "instance-derived"; nodeId: string; instanceId: string };

const RESOURCE_PERMISSION_PREFIX: Record<ControlPlaneResourceType, string> = {
  project: "projects", node: "nodes", runtime: "runtimes", template: "templates", instance: "instances",
  "app-session": "app-sessions", "ai-session": "ai-sessions", "trigger-template": "triggers", "trigger-deployment": "triggers",
  repository: "repositories", attachment: "attachments", image: "images", model: "models",
  user: "users", role: "roles", "identity-provider": "identity-providers", "user-session": "users",
  "identity-approval": "users", "user-audit": "users", "chat-bridge": "chat-bridges",
  "control-plane-settings": "settings", secret: "secrets", "public-directory": "public-directory",
};

const INTERACTIVE_RESOURCES = new Set<ControlPlaneResourceType>(["instance", "app-session", "ai-session"]);

export function permissionForControlPlaneOperation(action: ControlPlaneAction, resourceType: ControlPlaneResourceType): ControlPlanePermissionId | undefined {
  const prefix = RESOURCE_PERMISSION_PREFIX[resourceType];
  if (action === "manage-secrets") return "secrets:manage";
  if (action === "manage-settings") return "settings:manage";
  if (action === "manage-members") return "users:manage";
  if (action === "manage-node-auth") return "nodes:manage";
  if (action === "interactive-access" || action === "proxy") {
    return INTERACTIVE_RESOURCES.has(resourceType) ? `${prefix}:interactive` as ControlPlanePermissionId : undefined;
  }
  if (action === "read") return `${prefix}:read` as ControlPlanePermissionId;
  if (action === "read-file-content") return `${prefix}:manage` as ControlPlanePermissionId;
  return `${prefix}:manage` as ControlPlanePermissionId;
}

export function scopeAllows(nodeScope: ControlPlaneUserNodeScope, resourceScope: ResolvedControlPlaneResourceScope) {
  if (resourceScope.kind === "global-public" || resourceScope.kind === "global-shared" || resourceScope.kind === "global-admin") return true;
  return nodeScope.kind === "all" || nodeScope.nodeIds.includes(resourceScope.nodeId);
}

export function canAccessResolvedResource(actor: ControlPlaneUserAuthorizationContext, action: ControlPlaneAction, resource: ControlPlaneResource, resourceScope: ResolvedControlPlaneResourceScope) {
  return userCan(actor, action, resource) && scopeAllows(actor.nodeScope, resourceScope);
}

export function can(actor: ControlPlaneActor, action: ControlPlaneAction, resource: ControlPlaneResource) {
  if (actor.type === "system") return true;
  if (actor.type === "chat-bridge") return canChatBridge(action, resource);
  if (actor.type === "cloud-account") return canCloudAccount(action, resource);
  return userCan(actor, action, resource);
}

function userCan(actor: ControlPlaneUserAuthorizationContext, action: ControlPlaneAction, resource: ControlPlaneResource) {
  const permission = permissionForControlPlaneOperation(action, resource.type);
  return Boolean(permission && actor.permissionIds.includes(permission));
}

function canCloudAccount(action: ControlPlaneAction, resource: ControlPlaneResource) {
  if (["user", "role", "identity-provider", "user-session", "identity-approval", "user-audit", "control-plane-settings", "secret", "chat-bridge"].includes(resource.type)) return false;
  if (resource.type === "node") return action === "read";
  if (action === "read") return true;
  if (resource.type === "image" || resource.type === "public-directory") return false;
  return ["create", "update", "delete", "start", "stop", "restart", "proxy", "interactive-access", "send-message", "approve", "interrupt", "read-file-content"].includes(action);
}

export function assertCan(actor: ControlPlaneActor, action: ControlPlaneAction, resource: ControlPlaneResource) {
  if (can(actor, action, resource)) return;
  throw forbiddenError(action, resource);
}

export function assertCanAccessResolvedResource(actor: ControlPlaneUserAuthorizationContext, action: ControlPlaneAction, resource: ControlPlaneResource, resourceScope: ResolvedControlPlaneResourceScope) {
  if (!userCan(actor, action, resource)) throw forbiddenError(action, resource);
  if (scopeAllows(actor.nodeScope, resourceScope)) return;
  throw Object.assign(new Error("The requested resource is not visible."), { statusCode: 404, code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE" });
}

function forbiddenError(action: ControlPlaneAction, resource: ControlPlaneResource) {
  return Object.assign(new Error(`Actor is not allowed to ${action} ${resource.type}${resource.id ? ` ${resource.id}` : ""}.`), {
    statusCode: 403,
    code: "CONTROL_PLANE_FORBIDDEN",
  });
}

function canChatBridge(action: ControlPlaneAction, resource: ControlPlaneResource) {
  if (resource.type === "ai-session") return ["read", "send-message", "approve", "interrupt"].includes(action);
  if (resource.type === "instance") return ["read", "start", "stop", "restart"].includes(action);
  return action === "read";
}
