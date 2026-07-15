import { CONTROL_PLANE_PROTOCOL_VERSION } from "@task-handoff/protocol/control-plane";

export function now() {
  return new Date().toISOString();
}

export function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function controlPlaneDiagnosticLogsEnabled() {
  return envFlag(process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS);
}

export function protocolMismatchError(peer: string, actual: unknown) {
  const version = typeof actual === "string" && actual.trim() ? actual : "missing";
  const error = new Error(`${peer} protocol version ${version} is not compatible with ${CONTROL_PLANE_PROTOCOL_VERSION}.`);
  Object.assign(error, { statusCode: 409, code: "PROTOCOL_VERSION_MISMATCH" });
  return error;
}

export function plainHeaders(headers: HeadersInit | undefined) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

export function parsePendingRouteId(value: string | undefined) {
  const parts = String(value || "").split(":");
  if (parts.length === 3 && parts[1] === "ai" && parts[0] && parts[2]) {
    return { instanceId: parts[0], aiSessionId: parts[2] };
  }
  return undefined;
}

export function normalizeChatCommand(value: string) {
  return value.replace(/@[\w_]+$/, "");
}

export function isMissingAiSessionError(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return record.code === "AI_SESSION_NOT_FOUND";
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function throwNotFound(code: string, message: string): never {
  const error = new Error(message);
  Object.assign(error, { statusCode: 404, code });
  throw error;
}
