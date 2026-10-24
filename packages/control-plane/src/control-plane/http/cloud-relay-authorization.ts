import type { EventEnvelope } from "@task-handoff/protocol/events";
import type { ControlPlaneAction, ControlPlaneResource } from "../auth/authorization.ts";

const ROUTES_WITHOUT_RBAC = new Set([
  "/api/auth/session",
  "/api/auth/bootstrap-admin",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/mobile/login",
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

/**
 * Shared cloud actors keep the existing account-level resource scope but never
 * inherit local administration. These prefixes cover routes that would
 * otherwise look like an ordinary directory read to the generic route mapper.
 */
/**
 * Shared actors may follow ordinary resource events, but system/admin events
 * would expose management activity that their HTTP routes cannot reach.
 */
export function sharedCloudEventAllowed(event: Pick<EventEnvelope, "type" | "topic">) {
  const type = String(event.type);
  if (/^(operation-approval|control-plane-proxy|user|role|identity-provider|settings|secret|chat|chat-bridge|git-credential|node-join)\./.test(type)) return false;
  if (/^node\.(pairing-invite|remote-connect|control-plane-pairing|control-plane-connection)\./.test(type)) return false;
  return event.topic !== "system" || /^(attachment|repository|market|story|agent)\./.test(type);
}

export function sharedCloudRouteAllowed(url: string) {
  const path = url.split("?")[0] || "/";
  if (path.startsWith("/api/cloud-account") || path.startsWith("/api/cloud-connectivity")) return false;
  if (path.startsWith("/api/users") || path.startsWith("/api/roles") || path === "/api/permissions") return false;
  if (path.startsWith("/api/identity-providers") || path.startsWith("/api/external-identity-approvals")) return false;
  if (path.startsWith("/api/git-credentials") || path.includes("/git-credential-assignments")) return false;
  if (path.startsWith("/api/chat/")) return false;
  if (path.startsWith("/api/chat-gateway/bridges") || path === "/api/chat-gateway/status" || path === "/api/chat-gateway/poll-ai-sessions") return false;
  if (path.startsWith("/api/control-plane-proxy") || path.startsWith("/api/node-proxy")) return false;
  if (path.startsWith("/api/operation-approvals") || path.startsWith("/api/pending-routes")) return false;
  if (path.startsWith("/api/control-plane/settings") || path.startsWith("/api/control-plane/diagnostic-logs") || path.startsWith("/api/control-plane/relay-trace") || path.startsWith("/api/control-plane/node-relay-trace") || path === "/api/control-plane/status") return false;
  if (path.startsWith("/api/node-join/")) return false;
  if (/^\/api\/nodes\/[^/]+\/(cloud-relay-binding|control-plane-connections|control-plane-pairings|pairing\/invites|settings\/|updates\/)/.test(path)) return false;
  return true;
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
  // known checkpoints but only reads the directory, so it shares the list route's
  // non-sensitive directory policy and filters by visible instances in the handler.
  if (path === "/api/ai-sessions" || path === "/api/ai-sessions/sync") {
    return { action: "read", resource: { type: "public-directory" } };
  }
  if (path.startsWith("/api/control-plane-proxy")) {
    return { action: method === "GET" ? "read" : "manage-node-auth", resource: { type: "node" } };
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
