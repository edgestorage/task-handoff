import crypto from "node:crypto";
import {
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
  ControlPlaneProxyErrorCode,
  ProxyEventsReadySchema,
  ProxySnapshotRequiredSchema,
  ProxyTargetEventSchema,
  type ProxyEventStreamMessage,
  type ProxyTargetSnapshot,
  type ProxyTargetEvent,
} from "@task-handoff/protocol/control-plane-proxy";
import type { EventEnvelope } from "@task-handoff/protocol/events";
import type { ControlPlaneEventBus } from "../events/bus.ts";

type TargetStream = {
  streamId: string;
  revision: number;
  history: Array<{ event: StoredProxyTargetEvent; bytes: number }>;
  historyBytes: number;
  subscribers: Set<ProxyEventSubscriber>;
};

type StoredProxyTargetEvent = Omit<ProxyTargetEvent, "bindingId" | "sourceControlPlaneId">;
type ProxyEventSubscriber = {
  bindingId: string;
  sourceControlPlaneId: string;
  send: (message: ProxyEventStreamMessage) => void;
  onDeliveryFailure: () => void;
};

export type ControlPlaneProxyEventHubOptions = {
  historyLimit?: number;
  maxEventBytes?: number;
  maxHistoryBytes?: number;
  createStreamId?: (targetNodeId: string) => string;
  projectTarget: (targetNodeId: string) => ProxyTargetSnapshot["target"] | undefined;
};

export class ControlPlaneProxyEventHub {
  private readonly streams = new Map<string, TargetStream>();
  private readonly historyLimit: number;
  private readonly maxEventBytes: number;
  private readonly maxHistoryBytes: number;
  private readonly createStreamId: (targetNodeId: string) => string;
  private readonly projectTarget: (targetNodeId: string) => ProxyTargetSnapshot["target"] | undefined;
  private readonly unsubscribeBus: () => void;

  constructor(events: Pick<ControlPlaneEventBus, "on">, options: ControlPlaneProxyEventHubOptions) {
    this.historyLimit = Math.max(1, options.historyLimit ?? 256);
    this.maxEventBytes = Math.max(1024, options.maxEventBytes ?? 512 * 1024);
    this.maxHistoryBytes = Math.max(this.maxEventBytes, options.maxHistoryBytes ?? 16 * 1024 * 1024);
    this.createStreamId = options.createStreamId ?? ((targetNodeId) => `proxy_events_${targetNodeId}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`);
    this.projectTarget = options.projectTarget;
    this.unsubscribeBus = events.on((event) => this.accept(event));
  }

  stop() {
    this.unsubscribeBus();
    for (const stream of this.streams.values()) stream.subscribers.clear();
    this.streams.clear();
  }

  cursor(targetNodeId: string) {
    const stream = this.stream(targetNodeId);
    return {
      streamId: stream.streamId,
      revision: stream.revision,
      earliestRetainedRevision: earliestRetainedRevision(stream),
    };
  }

  subscribe(
    identity: { bindingId: string; sourceControlPlaneId: string; targetNodeId: string },
    sinceRevision: number,
    send: (message: ProxyEventStreamMessage) => void,
    onDeliveryFailure: () => void = () => undefined,
  ) {
    const { bindingId, sourceControlPlaneId, targetNodeId } = identity;
    const stream = this.stream(targetNodeId);
    const earliest = earliestRetainedRevision(stream);
    if (sinceRevision > stream.revision || sinceRevision < earliest - 1) {
      send(ProxySnapshotRequiredSchema.parse({
        type: "control-plane-proxy.snapshot-required",
        protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
        streamId: stream.streamId,
        bindingId,
        sourceControlPlaneId,
        targetNodeId,
        sinceRevision,
        latestRevision: stream.revision,
        earliestRetainedRevision: earliest,
        error: {
          code: ControlPlaneProxyErrorCode.SnapshotRequired,
          message: "Proxy target event history cannot continue from the requested revision; fetch a new snapshot.",
          retryable: true,
          details: { targetNodeId },
        },
      }));
      return { kind: "snapshot-required" as const, close: () => undefined };
    }

    send(ProxyEventsReadySchema.parse({
      type: "control-plane-proxy.events.ready",
      protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
      streamId: stream.streamId,
      bindingId,
      sourceControlPlaneId,
      targetNodeId,
      latestRevision: stream.revision,
      earliestRetainedRevision: earliest,
    }));
    for (const entry of stream.history) {
      if (entry.event.revision > sinceRevision) send(hydrateEvent(entry.event, bindingId, sourceControlPlaneId));
    }
    const subscriber = { bindingId, sourceControlPlaneId, send, onDeliveryFailure };
    stream.subscribers.add(subscriber);
    let closed = false;
    return {
      kind: "subscribed" as const,
      close: () => {
        if (closed) return;
        closed = true;
        stream.subscribers.delete(subscriber);
      },
    };
  }

  diagnostics(targetNodeId: string) {
    const stream = this.stream(targetNodeId);
    return {
      targetNodeId,
      streamId: stream.streamId,
      revision: stream.revision,
      earliestRetainedRevision: earliestRetainedRevision(stream),
      historySize: stream.history.length,
      historyBytes: stream.historyBytes,
      subscribers: stream.subscribers.size,
      subscriberBindings: [...stream.subscribers].map(({ bindingId, sourceControlPlaneId }) => ({ bindingId, sourceControlPlaneId })),
    };
  }

  private accept(event: EventEnvelope) {
    const targetNodeId = event.scope?.nodeId;
    if (typeof targetNodeId !== "string" || !targetNodeId) return;
    let target: ProxyTargetSnapshot["target"] | undefined;
    try {
      target = this.projectTarget(targetNodeId);
    } catch {
      return;
    }
    if (!target) return;
    const stream = this.stream(targetNodeId);
    const nextRevision = stream.revision + 1;
    const parsed = ProxyTargetEventSchema.safeParse({
      type: "control-plane-proxy.event",
      protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
      streamId: stream.streamId,
      bindingId: "proxy_projection",
      sourceControlPlaneId: "proxy_projection",
      targetNodeId,
      revision: nextRevision,
      source: { id: event.id, seq: event.seq },
      target,
      event: {
        type: event.type,
        topic: event.topic,
        createdAt: event.createdAt,
      },
    });
    if (!parsed.success) return;
    const { bindingId: _bindingId, sourceControlPlaneId: _sourceControlPlaneId, ...delivery } = parsed.data;
    const bytes = encodedBytes(delivery);
    if (bytes === undefined || bytes > this.maxEventBytes - 512) return;
    stream.revision = nextRevision;
    stream.history.push({ event: delivery, bytes });
    stream.historyBytes += bytes;
    while (stream.history.length > this.historyLimit || stream.historyBytes > this.maxHistoryBytes) {
      const removed = stream.history.shift();
      if (removed) stream.historyBytes -= removed.bytes;
    }
    for (const subscriber of [...stream.subscribers]) {
      try {
        const hydrated = hydrateEvent(delivery, subscriber.bindingId, subscriber.sourceControlPlaneId);
        const hydratedBytes = encodedBytes(hydrated);
        if (hydratedBytes === undefined || hydratedBytes > this.maxEventBytes) throw new Error("Proxy event byte limit exceeded.");
        subscriber.send(hydrated);
      } catch {
        stream.subscribers.delete(subscriber);
        try {
          subscriber.onDeliveryFailure();
        } catch {
          // Delivery has already failed; subscriber cleanup must not escape the authoritative event publisher.
        }
      }
    }
  }

  private stream(targetNodeId: string) {
    const existing = this.streams.get(targetNodeId);
    if (existing) return existing;
    const created = {
      streamId: this.createStreamId(targetNodeId),
      revision: 0,
      history: [],
      historyBytes: 0,
      subscribers: new Set<ProxyEventSubscriber>(),
    };
    this.streams.set(targetNodeId, created);
    return created;
  }
}

function earliestRetainedRevision(stream: TargetStream) {
  return stream.history[0]?.event.revision ?? stream.revision + 1;
}

function hydrateEvent(event: StoredProxyTargetEvent, bindingId: string, sourceControlPlaneId: string) {
  return ProxyTargetEventSchema.parse({ ...event, bindingId, sourceControlPlaneId });
}

function encodedBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}
