import {
  ImagePullTerminalEventType,
  ImagePullTerminalFinishedSchema,
  ImagePullTerminalOutputSchema,
  InstanceLifecycleEventType,
  InstanceLifecycleSnapshotSchema,
  InstanceResourceMetricsEventType,
  InstanceResourceMetricsSchema,
} from "@task-handoff/protocol/control-plane";
import {
  AiSessionEventType,
  AiSessionMessageDeltaEventSchema,
  AiSessionPatchEventSchema,
  AiSessionRemovedEventSchema,
  AiSessionSnapshotEventSchema,
  AiSessionTimelineItemEventSchema,
} from "@task-handoff/protocol/ai-sessions";
import {
  AppSessionEventType,
  AppSessionPatchEventSchema,
  AppSessionRemovedEventSchema,
  AppSessionSnapshotEventSchema,
} from "@task-handoff/protocol/app-sessions";
import { SessionStreamsHelloSchema, type EventEnvelope, type SessionStreamsHello } from "@task-handoff/protocol/events";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";
import type { ControlPlaneEventBus } from "../events/bus.ts";

const SESSION_EVENT_SCHEMAS = {
  [AiSessionEventType.Snapshot]: AiSessionSnapshotEventSchema,
  [AiSessionEventType.Patch]: AiSessionPatchEventSchema,
  [AiSessionEventType.Removed]: AiSessionRemovedEventSchema,
  [AiSessionEventType.MessageDelta]: AiSessionMessageDeltaEventSchema,
  [AiSessionEventType.TimelineItem]: AiSessionTimelineItemEventSchema,
  [AppSessionEventType.Snapshot]: AppSessionSnapshotEventSchema,
  [AppSessionEventType.Patch]: AppSessionPatchEventSchema,
  [AppSessionEventType.Removed]: AppSessionRemovedEventSchema,
} as const;

const SESSION_EVENT_TYPES = new Set<string>(Object.keys(SESSION_EVENT_SCHEMAS));

type TunnelEventRouterOptions = {
  events?: ControlPlaneEventBus;
  onStreamsHello?: (instanceId: string, hello: SessionStreamsHello) => void | Promise<void>;
  onSessionEvent?: (event: EventEnvelope) => boolean;
  validateInstanceScope?: (nodeId: string, instanceId: string) => boolean | Promise<boolean>;
  scopeTtlMs?: number;
};

export class NodeTunnelEventRouter {
  private readonly options: TunnelEventRouterOptions;
  private readonly validatedScopes = new Map<string, { nodeId: string; instanceId: string; expiresAt: number }>();
  private readonly validatingScopes = new Map<string, Promise<boolean>>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly scopeEpochs = new Map<string, object>();

  constructor(options: TunnelEventRouterOptions = {}) {
    this.options = options;
  }

  handle(nodeId: string, message: Record<string, unknown>) {
    const type = typeof message.type === "string" ? message.type : "";
    if (type === "node-agent.streams.hello") {
      const instanceId = typeof message.instanceId === "string" ? message.instanceId : "";
      const hello = safeParseResponse(SessionStreamsHelloSchema, message.payload);
      if (instanceId && hello.success) {
        this.enqueue(nodeId, instanceId, () => this.options.onStreamsHello?.(instanceId, hello.data));
      }
      return true;
    }
    if (!type.startsWith("node-agent.event.")) return false;

    const event = recordValue(message.event);
    const eventType = typeof event?.type === "string" ? event.type : "";
    if (!eventType) return true;
    const payload = "payload" in event ? event.payload : {};
    const scope = recordValue(event.scope) || {};
    const forwardedInstanceId = typeof message.instanceId === "string" ? message.instanceId : undefined;
    const claimedInstanceId = firstString(scope.instanceId, event.instanceId, forwardedInstanceId);

    if (eventType === InstanceResourceMetricsEventType.Snapshot) {
      const parsed = safeParseResponse(InstanceResourceMetricsSchema, payload);
      if (!parsed.success || parsed.data.instanceId !== claimedInstanceId) return true;
      this.enqueue(nodeId, parsed.data.instanceId, () => {
        this.options.events?.publish(eventType, parsed.data, {
          topic: "instances",
          scope: { ...scope, nodeId, instanceId: parsed.data.instanceId },
        });
      });
      return true;
    }
    if (eventType === InstanceLifecycleEventType.Snapshot) {
      const parsed = safeParseResponse(InstanceLifecycleSnapshotSchema, payload);
      if (!parsed.success || parsed.data.instanceId !== claimedInstanceId) return true;
      this.enqueue(nodeId, parsed.data.instanceId, () => {
        this.options.events?.publish(eventType, parsed.data, {
          topic: "instances",
          scope: { ...scope, nodeId, instanceId: parsed.data.instanceId },
        });
      });
      return true;
    }
    if (eventType === ImagePullTerminalEventType.Output || eventType === ImagePullTerminalEventType.Finished) {
      const parsed = eventType === ImagePullTerminalEventType.Output
        ? safeParseResponse(ImagePullTerminalOutputSchema, payload)
        : safeParseResponse(ImagePullTerminalFinishedSchema, payload);
      if (!parsed.success || parsed.data.instanceId !== claimedInstanceId) return true;
      this.enqueue(nodeId, parsed.data.instanceId, () => {
        this.options.events?.publish(eventType, parsed.data, {
          topic: "instances",
          scope: { ...scope, nodeId, instanceId: parsed.data.instanceId },
        });
      });
      return true;
    }

    if (SESSION_EVENT_TYPES.has(eventType)) {
      const sessionEvent = parseSessionEvent(eventType, payload);
      if (!sessionEvent) return true;
      const claimedIds = [scope.instanceId, event.instanceId, forwardedInstanceId]
        .filter((value): value is string => typeof value === "string" && Boolean(value));
      if (claimedIds.some((instanceId) => instanceId !== sessionEvent.instanceId)) return true;
      this.enqueue(nodeId, sessionEvent.instanceId, () => {
        const eventScope = { ...scope, nodeId, instanceId: sessionEvent.instanceId };
        const envelope: EventEnvelope = {
          v: 1,
          id: typeof event.id === "string" ? event.id : `forwarded_${Date.now().toString(36)}`,
          seq: typeof event.seq === "number" ? event.seq : 0,
          type: eventType,
          topic: typeof event.topic === "string"
            ? event.topic
            : eventType.startsWith("app-session.") ? "app.sessions" : "ai.sessions",
          createdAt: typeof event.createdAt === "string" ? event.createdAt : new Date().toISOString(),
          payload: sessionEvent.payload,
          ...(event.replay === true ? { replay: true } : {}),
          scope: eventScope,
        };
        if (this.options.onSessionEvent && !this.options.onSessionEvent(envelope)) return;
        this.options.events?.publish(eventType, sessionEvent.payload, {
          topic: envelope.topic,
          scope: eventScope,
          sourceEvent: { id: envelope.id, createdAt: envelope.createdAt, replay: envelope.replay },
        });
      });
      return true;
    }

    const publishUnknown = () => {
      this.options.events?.publish(eventType, payload, {
        topic: typeof event.topic === "string" ? event.topic : undefined,
        scope: { ...scope, nodeId, ...(claimedInstanceId ? { instanceId: claimedInstanceId } : {}) },
      });
    };
    if (claimedInstanceId) this.enqueue(nodeId, claimedInstanceId, publishUnknown);
    else publishUnknown();
    return true;
  }

  invalidate(input: { nodeId?: string; instanceId?: string } = {}) {
    const affected = new Set<string>();
    for (const [key, entry] of this.validatedScopes) {
      if (input.nodeId && entry.nodeId !== input.nodeId) continue;
      if (input.instanceId && entry.instanceId !== input.instanceId) continue;
      affected.add(key);
    }
    for (const key of new Set([...this.validatingScopes.keys(), ...this.eventQueues.keys()])) {
      const [nodeId, instanceId] = splitScopeKey(key);
      if (input.nodeId && nodeId !== input.nodeId) continue;
      if (input.instanceId && instanceId !== input.instanceId) continue;
      affected.add(key);
    }
    for (const key of affected) {
      this.scopeEpochs.delete(key);
      this.validatedScopes.delete(key);
      this.validatingScopes.delete(key);
      this.eventQueues.delete(key);
    }
  }

  diagnostics() {
    return {
      validatedScopes: this.validatedScopes.size,
      validatingScopes: this.validatingScopes.size,
      queuedScopes: this.eventQueues.size,
      scopeEpochs: this.scopeEpochs.size,
    };
  }

  private enqueue(nodeId: string, instanceId: string, publish: () => void | Promise<void>) {
    const key = scopeKey(nodeId, instanceId);
    const epoch = this.scopeEpoch(key);
    const previous = this.eventQueues.get(key) || Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      if (this.scopeEpochs.get(key) !== epoch) return;
      if (await this.isScopeValid(nodeId, instanceId, epoch) && this.scopeEpochs.get(key) === epoch) await publish();
    });
    this.eventQueues.set(key, queued);
    const cleanup = () => {
      if (this.eventQueues.get(key) === queued) this.eventQueues.delete(key);
      if (this.scopeEpochs.get(key) === epoch && !this.eventQueues.has(key) && !this.validatingScopes.has(key)) {
        this.scopeEpochs.delete(key);
      }
    };
    void queued.then(cleanup, cleanup);
  }

  private async isScopeValid(nodeId: string, instanceId: string, epoch: object) {
    const key = scopeKey(nodeId, instanceId);
    if ((this.validatedScopes.get(key)?.expiresAt || 0) > Date.now()) return true;
    const existing = this.validatingScopes.get(key);
    if (existing) return existing;
    const validation = Promise.resolve(this.options.validateInstanceScope?.(nodeId, instanceId))
      .then(Boolean)
      .catch(() => false)
      .then((valid) => {
        if (valid && this.scopeEpochs.get(key) === epoch) {
          this.validatedScopes.set(key, {
            nodeId,
            instanceId,
            expiresAt: Date.now() + (this.options.scopeTtlMs ?? 30_000),
          });
        }
        return valid;
      });
    this.validatingScopes.set(key, validation);
    return validation.finally(() => {
      if (this.validatingScopes.get(key) === validation) this.validatingScopes.delete(key);
    });
  }

  private scopeEpoch(key: string) {
    const current = this.scopeEpochs.get(key);
    if (current) return current;
    const epoch = {};
    this.scopeEpochs.set(key, epoch);
    return epoch;
  }
}

function parseSessionEvent(eventType: string, payload: unknown) {
  const schema = SESSION_EVENT_SCHEMAS[eventType as keyof typeof SESSION_EVENT_SCHEMAS];
  if (!schema) return undefined;
  const parsed = safeParseResponse(schema, payload);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  return { instanceId: "meta" in data ? data.meta.instanceId : data.instanceId, payload: data };
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string");
}

function scopeKey(nodeId: string, instanceId: string) {
  return JSON.stringify([nodeId, instanceId]);
}

function splitScopeKey(key: string) {
  const parsed = JSON.parse(key) as unknown;
  return Array.isArray(parsed) && parsed.length === 2
    ? [String(parsed[0]), String(parsed[1])]
    : ["", ""];
}
