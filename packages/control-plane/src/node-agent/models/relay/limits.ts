/**
 * Operational limits for the relay data plane. These are node-agent runtime
 * configuration (environment), never part of the wire protocol or a model
 * entity record.
 */
export type ModelRelayLimits = {
  /** Time to receive upstream response headers after the request was sent. */
  responseHeadersTimeoutMs: number;
  /** Time from response headers to the first body byte. */
  firstByteTimeoutMs: number;
  /** Maximum quiet period between response body chunks. */
  idleTimeoutMs: number;
  /** Maximum bytes buffered while locating the top-level model field. */
  maxRequestPrologueBytes: number;
  /** Maximum combined size of inbound relay header names and values. */
  maxRequestHeaderBytes: number;
  /** Maximum buffered bytes for one SSE event or rewritten JSON token. */
  maxResponseEventBytes: number;
  /** Maximum concurrent relay requests on this node. */
  maxConcurrentRequests: number;
  /** Maximum concurrent relay requests per instance. */
  maxConcurrentRequestsPerInstance: number;
  /** Grace period for active streams when node-agent shuts down. */
  shutdownDrainMs: number;
};

export const MODEL_RELAY_DEFAULT_LIMITS: ModelRelayLimits = {
  responseHeadersTimeoutMs: 300_000,
  firstByteTimeoutMs: 120_000,
  idleTimeoutMs: 300_000,
  maxRequestPrologueBytes: 256 * 1024,
  maxRequestHeaderBytes: 16 * 1024,
  maxResponseEventBytes: 1024 * 1024,
  maxConcurrentRequests: 64,
  maxConcurrentRequestsPerInstance: 8,
  shutdownDrainMs: 5_000,
};

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveModelRelayLimits(env: NodeJS.ProcessEnv = process.env): ModelRelayLimits {
  return {
    responseHeadersTimeoutMs: positiveInt(env.TASK_HANDOFF_MODEL_RELAY_HEADER_TIMEOUT_MS, MODEL_RELAY_DEFAULT_LIMITS.responseHeadersTimeoutMs),
    firstByteTimeoutMs: positiveInt(env.TASK_HANDOFF_MODEL_RELAY_FIRST_BYTE_TIMEOUT_MS, MODEL_RELAY_DEFAULT_LIMITS.firstByteTimeoutMs),
    idleTimeoutMs: positiveInt(env.TASK_HANDOFF_MODEL_RELAY_IDLE_TIMEOUT_MS, MODEL_RELAY_DEFAULT_LIMITS.idleTimeoutMs),
    maxRequestPrologueBytes: positiveInt(env.TASK_HANDOFF_MODEL_RELAY_MAX_PROLOGUE_BYTES, MODEL_RELAY_DEFAULT_LIMITS.maxRequestPrologueBytes),
    maxRequestHeaderBytes: positiveInt(env.TASK_HANDOFF_MODEL_RELAY_MAX_HEADER_BYTES, MODEL_RELAY_DEFAULT_LIMITS.maxRequestHeaderBytes),
    maxResponseEventBytes: positiveInt(env.TASK_HANDOFF_MODEL_RELAY_MAX_EVENT_BYTES, MODEL_RELAY_DEFAULT_LIMITS.maxResponseEventBytes),
    maxConcurrentRequests: positiveInt(env.TASK_HANDOFF_MODEL_RELAY_MAX_CONCURRENT, MODEL_RELAY_DEFAULT_LIMITS.maxConcurrentRequests),
    maxConcurrentRequestsPerInstance: positiveInt(env.TASK_HANDOFF_MODEL_RELAY_MAX_CONCURRENT_PER_INSTANCE, MODEL_RELAY_DEFAULT_LIMITS.maxConcurrentRequestsPerInstance),
    shutdownDrainMs: positiveInt(env.TASK_HANDOFF_MODEL_RELAY_SHUTDOWN_DRAIN_MS, MODEL_RELAY_DEFAULT_LIMITS.shutdownDrainMs),
  };
}
