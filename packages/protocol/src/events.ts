import { z } from "zod";

export type EventScope = {
  nodeId?: string;
  instanceId?: string;
  [key: string]: unknown;
};

export type EventEnvelope<T = unknown> = {
  v: 1;
  id: string;
  seq: number;
  type: string;
  topic: string;
  createdAt: string;
  payload: T;
  /** True only when a transient source replays an event after a demand cursor. */
  replay?: true;
  scope?: EventScope;
};

export const COMPACT_EVENT_ENVELOPE_VERSION = "2026-08-25" as const;
export type CompactEventEnvelope<T = unknown> = {
  v: typeof COMPACT_EVENT_ENVELOPE_VERSION;
  id: string;
  type: string;
  createdAt: string;
  payload: T;
  topic?: string;
  replay?: true;
  scope?: EventScope;
};

export type EventWireEnvelope<T = unknown> = EventEnvelope<T> | CompactEventEnvelope<T>;

export const EventScopeSchema = z.object({
  nodeId: z.string().optional(),
  instanceId: z.string().optional(),
}).passthrough();

export const EventEnvelopeSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  seq: z.number().finite(),
  type: z.string().min(1),
  topic: z.string().min(1),
  createdAt: z.string().datetime(),
  payload: z.unknown(),
  replay: z.literal(true).optional(),
  scope: EventScopeSchema.optional(),
}).passthrough();

export const CompactEventEnvelopeSchema = z.object({
  v: z.literal(COMPACT_EVENT_ENVELOPE_VERSION),
  id: z.string().min(1),
  type: z.string().min(1),
  createdAt: z.string().datetime(),
  payload: z.unknown(),
  topic: z.string().min(1).optional(),
  replay: z.literal(true).optional(),
  scope: EventScopeSchema.optional(),
}).passthrough();

export const EventWireEnvelopeSchema = z.discriminatedUnion("v", [
  EventEnvelopeSchema,
  CompactEventEnvelopeSchema,
]);

export type EventSubscribeMessage = {
  v?: 1;
  type: "subscribe";
  /** Optional connection-scoped wire projection. Absence retains the v1 envelope. */
  eventEnvelopeVersion?: typeof COMPACT_EVENT_ENVELOPE_VERSION;
  topics?: string[];
  instanceIds?: string[];
  /**
   * Optional resource-metrics scope independent from the general instance
   * event scope. Compatibility for v0.0.23: absence retains the legacy full
   * metrics stream; an explicit empty list disables metrics snapshots.
   */
  metricInstanceIds?: string[];
  aiSessionTransient?: AiSessionTransientSubscription;
};

export const EventKeepalivePingSchema = z.object({
  v: z.literal(1),
  type: z.literal("ping"),
  sentAt: z.string().datetime(),
}).strict();

export const EventKeepalivePongSchema = z.object({
  v: z.literal(1),
  type: z.literal("pong"),
  sentAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
}).strict();

export type EventKeepalivePing = z.infer<typeof EventKeepalivePingSchema>;
export type EventKeepalivePong = z.infer<typeof EventKeepalivePongSchema>;

export type SessionStreamTopic = z.infer<typeof SessionStreamTopicSchema>;
export type SessionStreamDescriptor = z.infer<typeof SessionStreamDescriptorSchema>;
export type SessionStreamsHello = z.infer<typeof SessionStreamsHelloSchema>;

export function eventTopic(type: string) {
  if (type.startsWith("ai-session.") || type.startsWith("ai.session.")) {
    return "ai.sessions";
  }
  if (type.startsWith("app-session.")) {
    return "app.sessions";
  }
  if (type.startsWith("app.management")) {
    return "apps";
  }
  if (type.startsWith("trigger.")) {
    return "triggers";
  }
  if (type.startsWith("instance.")) {
    return "instances";
  }
  if (type.startsWith("node.")) {
    return "nodes";
  }
  if (type.startsWith("project.")) {
    return "projects";
  }
  if (type.startsWith("model.")) {
    return "models";
  }
  if (type.startsWith("image.")) {
    return "images";
  }
  if (type.startsWith("market.")) {
    return "market";
  }
  if (type.startsWith("story.")) {
    return "stories";
  }
  return "system";
}

export function projectEventEnvelope<T>(
  event: EventEnvelope<T>,
  version: 1 | typeof COMPACT_EVENT_ENVELOPE_VERSION,
  options: { payload?: unknown; publicScope?: boolean } = {},
): EventWireEnvelope<T | unknown> {
  if (version === 1) return event;
  const scope = event.scope
    ? options.publicScope && event.scope.instanceId
      ? { instanceId: event.scope.instanceId }
      : event.scope
    : undefined;
  return {
    v: COMPACT_EVENT_ENVELOPE_VERSION,
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    payload: options.payload === undefined ? event.payload : options.payload,
    ...(event.topic !== eventTopic(event.type) ? { topic: event.topic } : {}),
    ...(event.replay ? { replay: true } : {}),
    ...(scope && Object.keys(scope).length ? { scope } : {}),
  };
}

export function normalizeEventEnvelope(input: unknown, fallbackScope: EventScope = {}): EventEnvelope | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (!type) return undefined;
  const scope = record.scope && typeof record.scope === "object" && !Array.isArray(record.scope)
    ? record.scope as EventScope
    : {};
  return {
    v: 1,
    id: typeof record.id === "string" ? record.id : `event_${Date.now().toString(36)}`,
    seq: typeof record.seq === "number" && Number.isFinite(record.seq) ? record.seq : 0,
    type,
    topic: typeof record.topic === "string" ? record.topic : eventTopic(type),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    payload: "payload" in record ? record.payload : {},
    ...(record.replay === true ? { replay: true } : {}),
    scope: { ...fallbackScope, ...scope },
  };
}
export const AiSessionTransientSubscriptionSchema = z.object({
  // Connection-scoped replay cursor. This is intentionally transient wire state:
  // it is owned by the consumer and must never be persisted on an AI Session.
  replaySince: z.string().datetime().optional(),
  messageDeltas: z.object({
    allInstances: z.boolean().default(false),
    instanceIds: z.array(z.string().trim().min(1).max(160)).max(1_000).default([]),
  }).default({ allInstances: false, instanceIds: [] }),
  timelineAllSessions: z.boolean().default(false),
  timelineSessions: z.array(z.object({
    instanceId: z.string().trim().min(1).max(160),
    sessionId: z.string().trim().min(1).max(120),
  })).max(1_000).default([]),
});

export type AiSessionTransientSubscription = z.infer<typeof AiSessionTransientSubscriptionSchema>;

export function aiSessionTransientSubscriptionAccepts(
  subscription: AiSessionTransientSubscription | undefined,
  event: { type: string; payload?: unknown; scope?: { instanceId?: string } },
) {
  // Compatibility for v0.0.21: absence of the additive subscription model
  // retains the full transient stream selected by legacy topics.
  if (!subscription) return true;
  if (event.type !== "ai-session.message-delta" && event.type !== "ai-session.timeline-item") return true;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  const instanceId = String(payload.instanceId || event.scope?.instanceId || "");
  if (event.type === "ai-session.message-delta") {
    return subscription.messageDeltas.allInstances || subscription.messageDeltas.instanceIds.includes(instanceId);
  }
  return subscription.timelineAllSessions || subscription.timelineSessions.some((entry) => (
    entry.instanceId === instanceId && entry.sessionId === payload.sessionId
  ));
}

export const SESSION_STREAM_PROTOCOL_VERSION = 1;

export const SessionStreamTopicSchema = z.enum(["ai.sessions", "app.sessions"]);

export const SessionStreamDescriptorSchema = z.object({
  topic: SessionStreamTopicSchema,
  instanceId: z.string().trim().min(1).max(160),
  streamId: z.string().trim().min(1).max(240),
  latestRevision: z.number().int().min(0),
  earliestRetainedRevision: z.number().int().min(0),
}).strict();

export const SessionStreamsHelloSchema = z.object({
  protocolVersion: z.literal(SESSION_STREAM_PROTOCOL_VERSION),
  streams: z.array(SessionStreamDescriptorSchema),
}).strict();

export const SessionStreamsHelloEventType = "streams.hello";
