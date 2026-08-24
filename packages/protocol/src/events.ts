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

export type EventSubscribeMessage = {
  v?: 1;
  type: "subscribe";
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
  return "system";
}
import { z } from "zod";

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
