export type ControlPlaneRole = "admin" | "operator" | "viewer";

export type ControlPlaneActor =
  | { type: "user"; userId: string; role: ControlPlaneRole }
  | { type: "cloud-account"; accountId: string; deviceSessionId: string; bindingId: string; bindingRevision: number }
  | { type: "chat-bridge"; bridgeId: string; channel: string; chatSessionId?: string; userId?: string }
  | { type: "system"; reason: string };

export type ControlPlaneAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "start"
  | "stop"
  | "restart"
  | "proxy"
  | "send-message"
  | "approve"
  | "interrupt"
  | "manage-settings"
  | "manage-secrets"
  | "manage-node-auth";

export type ControlPlaneResourceType =
  | "project"
  | "node"
  | "runtime"
  | "instance"
  | "ai-session"
  | "trigger"
  | "model"
  | "chat-bridge"
  | "control-plane-settings"
  | "secret";

export type ControlPlaneResource = {
  type: ControlPlaneResourceType;
  id?: string;
  projectId?: string;
  nodeId?: string;
  instanceId?: string;
};

export function can(actor: ControlPlaneActor, action: ControlPlaneAction, resource: ControlPlaneResource) {
  if (actor.type === "system") {
    return true;
  }
  if (actor.type === "chat-bridge") {
    return canChatBridge(action, resource);
  }
  if (actor.type === "cloud-account") {
    return canCloudAccount(action, resource);
  }
  if (actor.role === "admin") {
    return true;
  }
  if (actor.role === "viewer") {
    return action === "read";
  }
  if (actor.role === "operator") {
    return canOperator(action, resource);
  }
  return false;
}

function canCloudAccount(action: ControlPlaneAction, resource: ControlPlaneResource) {
  if (["control-plane-settings", "secret", "chat-bridge"].includes(resource.type)) return false;
  if (resource.type === "node") return action === "read";
  return canOperator(action, resource);
}

export function assertCan(actor: ControlPlaneActor, action: ControlPlaneAction, resource: ControlPlaneResource) {
  if (can(actor, action, resource)) {
    return;
  }
  const error = new Error(`Actor is not allowed to ${action} ${resource.type}${resource.id ? ` ${resource.id}` : ""}.`);
  Object.assign(error, { statusCode: 403, code: "CONTROL_PLANE_FORBIDDEN" });
  throw error;
}

function canOperator(action: ControlPlaneAction, resource: ControlPlaneResource) {
  if (action === "read") {
    return true;
  }
  if (resource.type === "instance") {
    return ["create", "update", "delete", "start", "stop", "restart", "proxy"].includes(action);
  }
  if (resource.type === "ai-session") {
    return ["send-message", "approve", "interrupt"].includes(action);
  }
  if (resource.type === "trigger") {
    return ["create", "update", "delete"].includes(action);
  }
  if (resource.type === "runtime") {
    return ["create", "update", "delete"].includes(action);
  }
  return false;
}

function canChatBridge(action: ControlPlaneAction, resource: ControlPlaneResource) {
  if (resource.type === "ai-session") {
    return ["read", "send-message", "approve", "interrupt"].includes(action);
  }
  if (resource.type === "instance") {
    return ["read", "start", "stop", "restart"].includes(action);
  }
  return action === "read";
}
