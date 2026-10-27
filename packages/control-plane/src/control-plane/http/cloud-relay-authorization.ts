import type { EventEnvelope } from "@task-handoff/protocol/events";
import type { ControlPlanePermissionId } from "@task-handoff/protocol/control-plane-access";
import type { ControlPlaneAction, ControlPlaneCloudAccountActor, ControlPlaneResource } from "../auth/authorization.ts";

const ROUTES_WITHOUT_RBAC = new Set([
  "/api/auth/session",
  "/api/auth/bootstrap-admin",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/mobile/login",
  "/api/auth/step-up",
  "/api/control-plane/identity",
  "/api/health",
  "/api/events",
  "/api/access/me",
  "/api/auth/external/callback",
]);

// A linked cloud account is its own principal, so a relayed request has no
// Control Plane session credential to present. These credential-free routes
// are reachable over the relay because the mobile profile bootstraps and
// re-verifies itself with them; every other route still needs an RBAC mapping.
const CLOUD_RELAY_ROUTES_WITHOUT_RBAC = new Set([
  "/api/auth/session",
  "/api/access/me",
  "/api/control-plane/identity",
  "/api/health",
]);

export function cloudRelayRouteReachable(method: string, url: string) {
  if (routeAuthorization(method, url)) return true;
  return CLOUD_RELAY_ROUTES_WITHOUT_RBAC.has(url.split("?")[0] || "/");
}

/** Binding, credential and Cloud-sharing lifecycle stays with the owner identity. */
export function cloudOwnerOnlyRoute(url: string) {
  const path = url.split("?")[0] || "/";
  return path === "/api/cloud-account"
    || path.startsWith("/api/cloud-account/")
    || path === "/api/cloud-connectivity"
    || path.startsWith("/api/cloud-connectivity/");
}

const EVENT_PERMISSION_PREFIXES: ReadonlyArray<readonly [string, ControlPlanePermissionId]> = [
  ["ai-session", "ai-sessions:read"],
  ["ai.session", "ai-sessions:read"],
  ["app-session", "app-sessions:read"],
  ["instance", "instances:read"],
  ["node", "nodes:read"],
  ["project", "projects:read"],
  ["runtime", "runtimes:read"],
  ["environment-template", "templates:read"],
  ["model", "models:read"],
  ["image", "images:read"],
  ["trigger", "triggers:read"],
  ["repository", "repositories:read"],
  ["attachment", "attachments:read"],
  ["market", "public-directory:read"],
  ["story", "public-directory:read"],
  ["document", "public-directory:read"],
  ["agent", "ai-sessions:read"],
  ["git.", "instances:read"],
  ["device-trust", "settings:manage"],
];

/** Events are a read surface. Unknown families fail closed instead of inheriting a broad allow. */
export function cloudEventPermission(event: Pick<EventEnvelope, "type">): ControlPlanePermissionId | undefined {
  const type = String(event.type);
  return EVENT_PERMISSION_PREFIXES.find(([prefix]) => type.startsWith(prefix))?.[1];
}

export function cloudEventAllowed(actor: Pick<ControlPlaneCloudAccountActor, "permissionIds">, event: Pick<EventEnvelope, "type" | "topic">) {
  const permission = cloudEventPermission(event);
  return Boolean(permission && actor.permissionIds.includes(permission));
}

export function routeAuthorization(method: string, url: string): { action: ControlPlaneAction; resource: ControlPlaneResource } | undefined {
  const path = url.split("?")[0] || "/";
  if (!path.startsWith("/api/")) return undefined;
  if (ROUTES_WITHOUT_RBAC.has(path)) return undefined;
  if (path.startsWith("/api/operation-approvals")) return undefined;
  const action = actionForHttpMethod(method);
  if (path === "/api/control-plane/diagnostic-logs/export") {
    return { action: "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path === "/api/device-trust" || path.startsWith("/api/device-trust/")) {
    return { action: "manage-settings", resource: { type: "device-trust" } };
  }
  if (path === "/api/session-streams/diagnostics") {
    return { action: "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path === "/api/control-plane/relay-trace" || path.startsWith("/api/control-plane/relay-trace/") || path === "/api/control-plane/node-relay-trace" || path.startsWith("/api/control-plane/node-relay-trace/")) {
    return { action: "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path.startsWith("/api/control-plane/settings")) {
    return { action: method === "GET" ? "read" : "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path === "/api/auth/mobile/logout" || path.startsWith("/api/auth/mobile/sessions")) return undefined;
  // CLI authorization and CLI session routes carry their own credential and CSRF rules.
  if (path.startsWith("/api/auth/cli/")) return undefined;
  if (path === "/api/auth/password") return undefined;
  if (path.startsWith("/api/auth/external/")) return undefined;
  if (path.startsWith("/api/users")) {
    return { action: method === "GET" ? "read" : "manage-members", resource: { type: path.includes("/sessions") ? "user-session" : "user" } };
  }
  if (path.startsWith("/api/roles") || path === "/api/permissions") {
    return { action: method === "GET" ? "read" : "update", resource: { type: "role" } };
  }
  if (path.startsWith("/api/identity-providers")) {
    return { action: method === "GET" ? "read" : "update", resource: { type: "identity-provider" } };
  }
  if (path.startsWith("/api/external-identity-approvals")) {
    return { action: method === "GET" ? "read" : "manage-members", resource: { type: "identity-approval" } };
  }
  if (path.startsWith("/api/models")) {
    return { action: method === "GET" ? "read" : "manage-secrets", resource: { type: "model" } };
  }
  if (path.startsWith("/api/git-credentials")) {
    return { action: "manage-secrets", resource: { type: "secret" } };
  }
  if (path.startsWith("/api/chat-gateway/bridges")) {
    return { action: method === "GET" ? "read" : "manage-secrets", resource: { type: "chat-bridge" } };
  }
  if (path === "/api/chat-gateway/messages" || path === "/api/chat-gateway/actions") {
    return { action: "send-message", resource: { type: "ai-session" } };
  }
  if (path === "/api/chat-gateway/poll-ai-sessions") {
    return { action: "manage-settings", resource: { type: "chat-bridge" } };
  }
  if (path === "/api/ai-session-attachments") {
    return { action: "send-message", resource: { type: "ai-session" } };
  }
  if (path === "/api/node-join/invites") {
    return { action: "manage-node-auth", resource: { type: "node" } };
  }
  // AI session aggregates are read surfaces: the reconnect sync route posts its
  // known checkpoints but only reads session metadata. Both routes share the AI
  // Session read permission and filter by visible instances in the handler.
  if (path === "/api/ai-sessions" || path === "/api/ai-sessions/sync") {
    return { action: "read", resource: { type: "ai-session" } };
  }
  if (path.startsWith("/api/control-plane-proxy")) {
    return { action: method === "GET" ? "read" : "manage-node-auth", resource: { type: "node" } };
  }
  if (path.startsWith("/api/nodes/") && /\/control-plane-trust-(?:requests|pins)(?:\/|$)/.test(path)) {
    return { action: "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path.startsWith("/api/nodes")) {
    if (/\/(runtimes|local-folders)(\/|$)/.test(path)) {
      return { action, resource: { type: "runtime" } };
    }
    return { action: method === "GET" ? "read" : "manage-node-auth", resource: { type: "node" } };
  }
  if (path.startsWith("/api/controlled-instances")) {
    if (/\/apps\/sessions\/[^/]+\/access$/.test(path)) return { action: "interactive-access", resource: { type: "app-session" } };
    // 自定义应用目录可能携带启动环境变量；读取与写入都要求实例 update 权限，不能按普通 read 放开。
    if (/\/apps\/catalog\/custom$/.test(path)) return { action: "update", resource: { type: "instance" } };
    if (path.includes("/ai-sessions")) {
      if (path.includes("/triggers")) return { action, resource: { type: "trigger-deployment" } };
      if (/\/messages\/[^/]+\/attachments\/[^/]+\/content$/.test(path)) return { action: "read-file-content", resource: { type: "attachment" } };
      // Timeline sync uses POST so the client can send its known item revisions,
      // but it only reads conversation history. Keep it behind the same AI
      // Session read permission as the GET timeline routes.
      if (method === "POST" && /\/timeline\/sync$/.test(path)) return { action: "read", resource: { type: "ai-session" } };
      if (method === "POST" && /\/ai-sessions$/.test(path)) return { action: "send-message", resource: { type: "ai-session" } };
      if (path.endsWith("/approval")) return { action: "approve", resource: { type: "ai-session" } };
      if (path.endsWith("/interrupt")) return { action: "interrupt", resource: { type: "ai-session" } };
      if (path.endsWith("/resume") || path.endsWith("/fork") || path.endsWith("/commands") || path.includes("/messages") || path.includes("/queue/")) {
        return { action: "send-message", resource: { type: "ai-session" } };
      }
      if (path.endsWith("/read") || path.endsWith("/mentions/files")) {
        return { action: "read", resource: { type: "ai-session" } };
      }
      if (path.endsWith("/open-app") || path.endsWith("/close")) return { action: "update", resource: { type: "ai-session" } };
      if (method === "GET" || method === "HEAD") return { action: "read", resource: { type: "ai-session" } };
      return { action: "manage-settings", resource: { type: "control-plane-settings" } };
    }
    if (path.includes("/start")) return { action: "start", resource: { type: "instance" } };
    if (path.includes("/stop")) return { action: "stop", resource: { type: "instance" } };
    if (path.includes("/restart")) return { action: "restart", resource: { type: "instance" } };
    if (/\/config-sync(?:\/|$)/.test(path)) return { action: "update", resource: { type: "instance" } };
    return { action, resource: { type: "instance" } };
  }
  if (path.startsWith("/api/projects")) {
    return { action, resource: { type: "project" } };
  }
  if (path.startsWith("/api/images") || path.startsWith("/api/image-options") || path.startsWith("/api/market")) {
    return { action, resource: { type: "image" } };
  }
  if (path.startsWith("/api/triggers")) {
    if (path.endsWith("/apply")) return { action: "create", resource: { type: "trigger-deployment" } };
    return { action, resource: { type: "trigger-template" } };
  }
  // Collection reads use a non-sensitive global directory policy and must be
  // filtered by their handler. Unknown mutations fail closed as settings.
  return method === "GET" || method === "HEAD"
    ? { action: "read", resource: { type: "public-directory" } }
    : { action, resource: { type: "control-plane-settings" } };
}

function actionForHttpMethod(method: string): ControlPlaneAction {
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "POST") return "create";
  if (method === "PATCH" || method === "PUT") return "update";
  if (method === "DELETE") return "delete";
  return "read";
}
