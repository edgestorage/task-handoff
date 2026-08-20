import { AiSessionTransientSubscriptionSchema, aiSessionTransientSubscriptionAccepts, eventTopic, type AiSessionTransientSubscription, type EventEnvelope, type EventScope } from "@task-handoff/protocol/events";
import { AiSessionEventTopic, AiSessionEventType } from "@task-handoff/protocol/ai-sessions";

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
  close?: (code?: number, reason?: string) => void;
  on: (event: "close" | "message", listener: (value?: unknown) => void) => void;
  topics?: Set<string>;
  instanceIds?: Set<string>;
  aiSessionTransient?: AiSessionTransientSubscription;
  subscriptionReceived?: boolean;
};

const MAX_EVENT_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;

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

  connect(socket: EventSocket, options: { instanceIds?: string[]; expectsTransientSubscription?: boolean } = {}) {
    socket.topics = new Set(["*"]);
    socket.instanceIds = options.instanceIds?.length ? new Set(options.instanceIds) : undefined;
    // Compatibility for v0.0.21: clients without the URL capability hint never
    // send a subscribe frame and therefore retain the prior full stream. A new
    // client declares that it will subscribe so opening its socket cannot cause
    // a temporary full-stream demand spike before the first frame arrives.
    socket.subscriptionReceived = options.expectsTransientSubscription !== true;
    this.clients.add(socket);
    this.publishTransientDemand();
    socket.on("close", () => {
      this.clients.delete(socket);
      this.publishTransientDemand();
    });
    socket.on("message", (value) => {
      const message = parseClientMessage(value);
      if (message?.type === "subscribe") {
        socket.topics = new Set(message.topics === undefined ? ["*"] : message.topics);
        socket.instanceIds = message.instanceIds?.length ? new Set(message.instanceIds) : undefined;
        socket.aiSessionTransient = message.aiSessionTransient;
        socket.subscriptionReceived = true;
        this.publishTransientDemand();
      }
    });
  }

  publish<T>(type: string, payload: T, options: { scope?: EventScope; topic?: string; sourceEvent?: Pick<EventEnvelope, "id" | "createdAt" | "replay"> } = {}): ControlPlaneEvent<T> {
    const event = this.createEvent(type, payload, options);
    const topic = event.topic;
    const encoded = JSON.stringify(event);
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
    for (const client of this.clients) {
      if (client.readyState === client.OPEN && subscribed(client.topics, topic, type) && subscribedInstance(client.instanceIds, event.scope) && subscribedAiSessionTransient(client, event)) {
        if ((client.bufferedAmount ?? 0) + encodedBytes > MAX_EVENT_CLIENT_BUFFERED_BYTES) {
          this.clients.delete(client);
          try { client.close?.(1013, "Event consumer is too slow."); } catch { /* Consumer cleanup is already complete. */ }
          this.publishTransientDemand();
          continue;
        }
        try {
          client.send(encoded);
        } catch {
          this.clients.delete(client);
          this.publishTransientDemand();
        }
      }
    }
    return event;
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
      scope: options.scope,
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

function subscribedAiSessionTransient(client: EventSocket, event: EventEnvelope) {
  if (event.type !== "ai-session.message-delta" && event.type !== "ai-session.timeline-item") return true;
  if (!client.subscriptionReceived) return false;
  return aiSessionTransientSubscriptionAccepts(client.aiSessionTransient, event);
}

function parseClientMessage(value: unknown): { type?: string; topics?: string[]; instanceIds?: string[]; aiSessionTransient?: AiSessionTransientSubscription } | undefined {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const message = parsed as { type?: string; topics?: unknown; instanceIds?: unknown; aiSessionTransient?: unknown };
    const transient = message.aiSessionTransient === undefined ? undefined : AiSessionTransientSubscriptionSchema.safeParse(message.aiSessionTransient);
    if (transient && !transient.success) return undefined;
    return {
      type: message.type,
      topics: Array.isArray(message.topics) ? message.topics.map(String).filter(Boolean) : undefined,
      instanceIds: Array.isArray(message.instanceIds) ? message.instanceIds.map(String).map((id) => id.trim()).filter(Boolean) : undefined,
      ...(transient?.success ? { aiSessionTransient: transient.data } : {}),
    };
  } catch {
    return undefined;
  }
}
