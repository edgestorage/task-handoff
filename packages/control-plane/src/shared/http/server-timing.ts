import { createHash } from "node:crypto";

export const TRACE_ID_HEADER = "x-task-handoff-trace-id";

export function clientRequestTraceId(clientRequestId: string) {
  return traceId(clientRequestId, createHash("sha256").update(clientRequestId).digest("hex"));
}

export type RequestTimingDiagnostics = {
  traceId?: string;
  serverTiming: string;
  nodeTransportMs: number;
};

export function serverTimingDuration(name: string, durationMs: number) {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  return `${name};dur=${duration.toFixed(1)}`;
}

export function appendServerTiming(...values: Array<string | null | undefined>) {
  return values.map((value) => String(value || "").trim()).filter(Boolean).join(", ");
}

// 归一化后的 trace id 必须满足代理关联 id 的字符集（首字符为字母或数字），
// 否则调用方传入的宽松 id 会在 node-agent 代理边界被拒。
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function traceId(value: unknown, fallback: string) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = typeof candidate === "string" ? candidate.trim() : "";
  return TRACE_ID_PATTERN.test(normalized) ? normalized : fallback;
}
