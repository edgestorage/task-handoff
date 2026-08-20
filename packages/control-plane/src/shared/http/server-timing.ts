export const TRACE_ID_HEADER = "x-task-handoff-trace-id";

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

export function traceId(value: unknown, fallback: string) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = typeof candidate === "string" ? candidate.trim() : "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : fallback;
}
