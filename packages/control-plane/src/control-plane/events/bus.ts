import { COMPACT_EVENT_ENVELOPE_VERSION, AiSessionTransientSubscriptionSchema, EventKeepalivePingSchema, aiSessionTransientSubscriptionAccepts, eventTopic, projectEventEnvelope, type AiSessionTransientSubscription, type EventEnvelope, type EventScope } from "@task-handoff/protocol/events";
import { AiSessionEventTopic, AiSessionEventType, AiSessionMessageDeltaEventSchema, compactAiSessionMessageDeltaEvent } from "@task-handoff/protocol/ai-sessions";
import type { ControlPlanePermissionId } from "@task-handoff/protocol/control-plane-access";

export type ControlPlaneEvent<T = unknown> = {
  v: 1;
  id: string;
  seq: number;
  type: string;
  topic: string;
  createdAt: string;
  payload: T;
  replay?: true;
  scope?: EventScope;
};

type EventSocket = {
  readyState: number;
  OPEN: number;
  bufferedAmount?: number;
  send: (value: string) => void;
  ping?: () => void;
  close?: (code?: number, reason?: string) => void;
  on: (event: "close" | "message", listener: (value?: unknown) => void) => void;
  topics?: Set<string>;
  instanceIds?: Set<string>;
  metricInstanceIds?: Set<string>;
  aiSessionTransient?: AiSessionTransientSubscription;
  subscriptionReceived?: boolean;
  authorization?: EventAuthorizationBinding;
  eventEnvelopeVersion?: 1 | typeof COMPACT_EVENT_ENVELOPE_VERSION;
};

export type EventAuthorizationBinding = {
  userId: string;
  authorizationRevision: number;
  permissionIds: ControlPlanePermissionId[];
  allowedNodeIds?: Set<string>;
  allowedInstanceIds?: Set<string>;
};

const MAX_EVENT_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const EVENT_TRANSPORT_KEEPALIVE_INTERVAL_MS = 20_000;

export type ControlPlaneAiSessionTransientDemand = AiSessionTransientSubscription & { legacyAll: boolean };

function eventId() {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

export class ControlPlaneEventBus {
  private readonly clients = new Set<EventSocket>();
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private readonly transientDemandListeners = new Set<(demand: ControlPlaneAiSessionTransientDemand) => void>();
  private readonly externalTransientDemands = new Map<symbol, AiSessionTransientSubscription | undefined>();
  private seq = 0;
  private droppedUnscopedNodeEvents = 0;
  private lastUnscopedNodeEvent?: { type: string; topic: string; createdAt: string };

  connect(socket: EventSocket, options: { instanceIds?: string[]; expectsTransientSubscription?: boolean; expectsMetricSubscription?: boolean; authorization?: EventAuthorizationBinding } = {}) {
    socket.topics = new Set(["*"]);
    socket.instanceIds = options.instanceIds?.length ? new Set(options.instanceIds) : undefined;
    socket.metricInstanceIds = options.expectsMetricSubscription ? new Set() : undefined;
    socket.authorization = options.authorization;
    // Compatibility for v0.0.21: clients without the URL capability hint never
    // send a subscribe frame and therefore retain the prior full stream. A new
    // client declares that it will subscribe so opening its socket cannot cause
    // a temporary full-stream demand spike before the first frame arrives.
    socket.subscriptionReceived = options.authorization ? false : options.expectsTransientSubscription !== true;
    this.clients.add(socket);
    this.publishTransientDemand();
    const keepaliveTimer = socket.ping ? setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.ping?.();
      } catch {
        // The socket close/error path owns reconnect and client cleanup.
      }
    }, EVENT_TRANSPORT_KEEPALIVE_INTERVAL_MS) : undefined;
    keepaliveTimer?.unref?.();
    socket.on("close", () => {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      this.clients.delete(socket);
      this.publishTransientDemand();
    });
    socket.on("message", (value) => {
      const message = parseClientMessage(value);
      if (message?.type === "ping") {
        socket.send(JSON.stringify({
          v: 1,
          type: "pong",
          sentAt: message.sentAt,
          receivedAt: new Date().toISOString(),
        }));
        return;
      }
      if (message?.type === "subscribe") {
        socket.topics = new Set(message.topics === undefined ? ["*"] : message.topics);
        socket.instanceIds = authorizedInstanceSubscription(socket, message.instanceIds);
        socket.metricInstanceIds = authorizedMetricInstanceSubscription(socket, message.metricInstanceIds);
        socket.aiSessionTransient = authorizedTransientSubscription(socket, message.aiSessionTransient);
        socket.eventEnvelopeVersion = message.eventEnvelopeVersion ?? 1;
        socket.subscriptionReceived = true;
        this.publishTransientDemand();
      }
    });
  }

  publish<T>(type: string, payload: T, options: { scope?: EventScope; topic?: string; sourceEvent?: Pick<EventEnvelope, "id" | "createdAt" | "replay"> } = {}): ControlPlaneEvent<T> {
    const event = this.createEvent(type, payload, options);
    if (NODE_DERIVED_EVENT_TOPICS.has(event.topic) && !event.scope?.nodeId && !event.scope?.instanceId) {
      this.droppedUnscopedNodeEvents += 1;
      this.lastUnscopedNodeEvent = { type: event.type, topic: event.topic, createdAt: event.createdAt };
    }
    const topic = event.topic;
    const encoded = JSON.stringify(event);
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    let compactFrame: { encoded: string; bytes: number } | undefined;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
    for (const client of this.clients) {
      if (client.readyState === client.OPEN && authorizedEvent(client, event) && subscribed(client.topics, topic, type) && subscribedInstance(client.instanceIds, event.scope) && subscribedResourceMetrics(client, event) && subscribedAiSessionTransient(client, event)) {
        const frame = client.eventEnvelopeVersion === COMPACT_EVENT_ENVELOPE_VERSION
          ? compactFrame ??= encodedCompactPublicEvent(event)
          : { encoded, bytes: encodedBytes };
        if ((client.bufferedAmount ?? 0) + frame.bytes > MAX_EVENT_CLIENT_BUFFERED_BYTES) {
          this.clients.delete(client);
          try { client.close?.(1013, "Event consumer is too slow."); } catch { /* Consumer cleanup is already complete. */ }
          this.publishTransientDemand();
          continue;
        }
        try {
          client.send(frame.encoded);
        } catch {
          this.clients.delete(client);
          this.publishTransientDemand();
        }
      }
    }
    return event;
  }

  authorizationDiagnostics() {
    return {
      droppedUnscopedNodeEvents: this.droppedUnscopedNodeEvents,
      ...(this.lastUnscopedNodeEvent ? { lastUnscopedNodeEvent: this.lastUnscopedNodeEvent } : {}),
    };
  }

  invalidateUserAuthorization(userId: string, authorizationRevision: number) {
    for (const client of this.clients) {
      const binding = client.authorization;
      if (!binding || binding.userId !== userId || binding.authorizationRevision === authorizationRevision) continue;
      this.clients.delete(client);
      try { client.close?.(4001, "Authorization changed. Reconnect for a current snapshot."); } catch { /* Connection is already invalidated. */ }
    }
    this.publishTransientDemand();
  }

  on(listener: (event: EventEnvelope) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onAiSessionTransientDemand(listener: (demand: ControlPlaneAiSessionTransientDemand) => void) {
    this.transientDemandListeners.add(listener);
    listener(this.aiSessionTransientDemand());
    return () => this.transientDemandListeners.delete(listener);
  }

  registerAiSessionTransientDemand(subscription?: AiSessionTransientSubscription) {
    const token = Symbol("ai-session-transient-demand");
    this.externalTransientDemands.set(token, subscription);
    this.publishTransientDemand();
    return () => {
      this.externalTransientDemands.delete(token);
      this.publishTransientDemand();
    };
  }

  registerLegacyAiSessionTransientDemand(topics: Iterable<string>) {
    const selected = new Set(topics);
    const subscribesAllAiEvents = selected.has("*") || selected.has(AiSessionEventTopic);
    if (subscribesAllAiEvents) return this.registerAiSessionTransientDemand();
    const subscribesMessageDeltas = selected.has(AiSessionEventType.MessageDelta);
    const subscribesTimelineItems = selected.has(AiSessionEventType.TimelineItem);
    if (!subscribesMessageDeltas && !subscribesTimelineItems) return () => undefined;
    return this.registerAiSessionTransientDemand({
      messageDeltas: { allInstances: subscribesMessageDeltas, instanceIds: [] },
      timelineAllSessions: subscribesTimelineItems,
      timelineSessions: [],
    });
  }

  aiSessionTransientDemand(): ControlPlaneAiSessionTransientDemand {
    let legacyAll = false;
    let allInstances = false;
    let timelineAllSessions = false;
    const instanceIds = new Set<string>();
    const timelineSessions = new Map<string, { instanceId: string; sessionId: string }>();
    let replaySince: string | undefined;
    for (const client of this.clients) {
      if (!client.subscriptionReceived) continue;
      if (!subscribedToAiSessionTransient(client.topics)) continue;
      if (!client.aiSessionTransient) {
        legacyAll = true;
        continue;
      }
      allInstances ||= client.aiSessionTransient.messageDeltas.allInstances;
      timelineAllSessions ||= client.aiSessionTransient.timelineAllSessions;
      replaySince = earlierReplaySince(replaySince, client.aiSessionTransient.replaySince);
      for (const instanceId of client.aiSessionTransient.messageDeltas.instanceIds) instanceIds.add(instanceId);
      for (const entry of client.aiSessionTransient.timelineSessions) timelineSessions.set(JSON.stringify([entry.instanceId, entry.sessionId]), entry);
    }
    for (const subscription of this.externalTransientDemands.values()) {
      if (!subscription) {
        legacyAll = true;
        continue;
      }
      allInstances ||= subscription.messageDeltas.allInstances;
      timelineAllSessions ||= subscription.timelineAllSessions;
      replaySince = earlierReplaySince(replaySince, subscription.replaySince);
      for (const instanceId of subscription.messageDeltas.instanceIds) instanceIds.add(instanceId);
      for (const entry of subscription.timelineSessions) timelineSessions.set(JSON.stringify([entry.instanceId, entry.sessionId]), entry);
    }
    return {
      legacyAll,
      ...(replaySince ? { replaySince } : {}),
      messageDeltas: { allInstances: legacyAll || allInstances, instanceIds: [...instanceIds] },
      timelineAllSessions: legacyAll || timelineAllSessions,
      timelineSessions: [...timelineSessions.values()],
    };
  }

  send<T>(socket: { send: (value: string) => void }, type: string, payload: T, options: { scope?: EventScope; topic?: string } = {}) {
    const event = this.createEvent(type, payload, options);
    socket.send(JSON.stringify(event));
    return event;
  }

  private createEvent<T>(type: string, payload: T, options: { scope?: EventScope; topic?: string; sourceEvent?: Pick<EventEnvelope, "id" | "createdAt" | "replay"> } = {}): EventEnvelope<T> {
    return {
      v: 1,
      id: options.sourceEvent?.id || eventId(),
      seq: ++this.seq,
      type,
      topic: options.topic || eventTopic(type),
      createdAt: options.sourceEvent?.createdAt || new Date().toISOString(),
      payload,
      ...(options.sourceEvent?.replay ? { replay: true } : {}),
      scope: normalizedEventScope(options.scope, payload),
    };
  }

  private publishTransientDemand() {
    const demand = this.aiSessionTransientDemand();
    for (const listener of this.transientDemandListeners) {
      try {
        listener(demand);
      } catch {
        // One transport failure must not prevent other nodes from receiving the aggregate demand.
      }
    }
  }
}

function earlierReplaySince(current: string | undefined, candidate: string | undefined) {
  if (!candidate) return current;
  return !current || candidate < current ? candidate : current;
}

function subscribed(topics: Set<string> | undefined, topic: string, type: string) {
  return !topics || topics.has("*") || topics.has(topic) || topics.has(type);
}

function subscribedToAiSessionTransient(topics: Set<string> | undefined) {
  return subscribed(topics, AiSessionEventTopic, AiSessionEventType.MessageDelta)
    || subscribed(topics, AiSessionEventTopic, AiSessionEventType.TimelineItem);
}

function subscribedInstance(instanceIds: Set<string> | undefined, scope: EventScope | undefined) {
  return !instanceIds || !scope?.instanceId || instanceIds.has(scope.instanceId);
}

function subscribedResourceMetrics(client: EventSocket, event: EventEnvelope) {
  if (event.type !== "instance.metrics.snapshot") return true;
  // Compatibility for v0.0.23: legacy subscribers did not send this field and
  // continue to receive the full metrics stream.
  if (!client.metricInstanceIds) return true;
  return Boolean(event.scope?.instanceId && client.metricInstanceIds.has(event.scope.instanceId));
}

function subscribedAiSessionTransient(client: EventSocket, event: EventEnvelope) {
  if (event.type !== "ai-session.message-delta" && event.type !== "ai-session.timeline-item") return true;
  if (!client.subscriptionReceived) return false;
  return aiSessionTransientSubscriptionAccepts(client.aiSessionTransient, event);
}

const NODE_DERIVED_EVENT_TOPICS = new Set([
  "nodes",
  "node.state",
  "node.runtime",
  "instances",
  "app.sessions",
  "ai.sessions",
  "apps",
]);

function authorizedEvent(client: EventSocket, event: EventEnvelope) {
  const authorization = client.authorization;
  if (!authorization) return true;
  if (event.topic === "triggers" && !event.scope?.nodeId && !event.scope?.instanceId) {
    return authorization.permissionIds.includes("triggers:manage");
  }
  if (event.scope?.nodeId) return !authorization.allowedNodeIds || authorization.allowedNodeIds.has(event.scope.nodeId);
  if (event.scope?.instanceId) return !authorization.allowedInstanceIds || authorization.allowedInstanceIds.has(event.scope.instanceId);
  if (!authorization.allowedNodeIds && !authorization.allowedInstanceIds) return true;
  return !NODE_DERIVED_EVENT_TOPICS.has(event.topic);
}

function authorizedInstanceSubscription(client: EventSocket, requested: string[] | undefined) {
  const allowed = client.authorization?.allowedInstanceIds;
  if (!allowed) return requested?.length ? new Set(requested) : undefined;
  const selected = requested?.length ? requested.filter((id) => allowed.has(id)) : [...allowed];
  return new Set(selected);
}

function authorizedMetricInstanceSubscription(client: EventSocket, requested: string[] | undefined) {
  if (requested === undefined) return undefined;
  const allowed = client.authorization?.allowedInstanceIds;
  return new Set(allowed ? requested.filter((id) => allowed.has(id)) : requested);
}

function authorizedTransientSubscription(client: EventSocket, subscription: AiSessionTransientSubscription | undefined) {
  const allowed = client.authorization?.allowedInstanceIds;
  if (!allowed) return subscription;
  if (!subscription) {
    return {
      messageDeltas: { allInstances: false, instanceIds: [...allowed] },
      timelineAllSessions: false,
      timelineSessions: [],
    };
  }
  return {
    ...subscription,
    messageDeltas: {
      allInstances: false,
      instanceIds: subscription.messageDeltas.allInstances
        ? [...allowed]
        : subscription.messageDeltas.instanceIds.filter((id) => allowed.has(id)),
    },
    timelineAllSessions: false,
    timelineSessions: subscription.timelineSessions.filter((entry) => allowed.has(entry.instanceId)),
  };
}

function normalizedEventScope<T>(scope: EventScope | undefined, payload: T): EventScope | undefined {
  if (scope?.nodeId || scope?.instanceId) return scope;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return scope;
  const record = payload as Record<string, unknown>;
  const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
    ? record.meta as Record<string, unknown>
    : {};
  const nodeValue = record.nodeId ?? meta.nodeId;
  const instanceValue = record.instanceId ?? meta.instanceId;
  const nodeId = typeof nodeValue === "string" && nodeValue.trim() ? nodeValue.trim() : undefined;
  const instanceId = typeof instanceValue === "string" && instanceValue.trim() ? instanceValue.trim() : undefined;
  return nodeId || instanceId ? { ...(nodeId ? { nodeId } : {}), ...(instanceId ? { instanceId } : {}) } : scope;
}

function parseClientMessage(value: unknown): { type?: string; sentAt?: string; topics?: string[]; instanceIds?: string[]; metricInstanceIds?: string[]; aiSessionTransient?: AiSessionTransientSubscription; eventEnvelopeVersion?: 1 | typeof COMPACT_EVENT_ENVELOPE_VERSION } | undefined {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const keepalive = EventKeepalivePingSchema.safeParse(parsed);
    if (keepalive.success) return keepalive.data;
    const message = parsed as { type?: string; topics?: unknown; instanceIds?: unknown; metricInstanceIds?: unknown; aiSessionTransient?: unknown; eventEnvelopeVersion?: unknown };
    if (message.metricInstanceIds !== undefined && !Array.isArray(message.metricInstanceIds)) return undefined;
    const transient = message.aiSessionTransient === undefined ? undefined : AiSessionTransientSubscriptionSchema.safeParse(message.aiSessionTransient);
    if (transient && !transient.success) return undefined;
    return {
      type: message.type,
      topics: Array.isArray(message.topics) ? message.topics.map(String).filter(Boolean) : undefined,
      instanceIds: Array.isArray(message.instanceIds) ? message.instanceIds.map(String).map((id) => id.trim()).filter(Boolean) : undefined,
      metricInstanceIds: Array.isArray(message.metricInstanceIds) ? message.metricInstanceIds.map(String).map((id) => id.trim()).filter(Boolean) : undefined,
      ...(transient?.success ? { aiSessionTransient: transient.data } : {}),
      ...(message.eventEnvelopeVersion === COMPACT_EVENT_ENVELOPE_VERSION ? { eventEnvelopeVersion: COMPACT_EVENT_ENVELOPE_VERSION } : {}),
    };
  } catch {
    return undefined;
  }
}

function encodedCompactPublicEvent(event: EventEnvelope) {
  const delta = event.type === AiSessionEventType.MessageDelta
    ? AiSessionMessageDeltaEventSchema.safeParse(event.payload)
    : undefined;
  const projected = projectEventEnvelope(event, COMPACT_EVENT_ENVELOPE_VERSION, {
    publicScope: true,
    ...(delta?.success ? { payload: compactAiSessionMessageDeltaEvent(delta.data) } : {}),
  });
  const encoded = JSON.stringify(projected);
  return { encoded, bytes: Buffer.byteLength(encoded, "utf8") };
}
